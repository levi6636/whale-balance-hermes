"""All provider traffic is mocked. No live key or live balance is used."""

import asyncio
import importlib.util
import json
import os
from decimal import Decimal
from pathlib import Path
import unittest

import httpx
from fastapi import FastAPI

spec = importlib.util.spec_from_file_location("whale_api", Path(__file__).parents[1] / "dashboard/plugin_api.py")
api = importlib.util.module_from_spec(spec)
spec.loader.exec_module(api)


def payload(amount="12.3400", available=True, granted="0", topped_up="12.34"):
    return {"is_available": available, "balance_infos": [
        {"currency": "USD", "total_balance": "999", "granted_balance": "0", "topped_up_balance": "999"},
        {"currency": "CNY", "total_balance": amount, "granted_balance": granted, "topped_up_balance": topped_up},
    ]}


class BalanceTests(unittest.IsolatedAsyncioTestCase):
    def make_service(self, responses):
        self.calls = []
        self.options = []
        self.now = 0
        self.key = "mock-only-key"
        self.sleeps = []

        async def handle(request):
            self.calls.append(request)
            item = responses[min(len(self.calls) - 1, len(responses) - 1)]
            if isinstance(item, Exception):
                raise item
            if callable(item):
                return await item(request)
            if isinstance(item, httpx.Response):
                return item
            return httpx.Response(200, json=item)

        def factory(**kwargs):
            self.options.append(kwargs)
            return httpx.AsyncClient(transport=httpx.MockTransport(handle), **kwargs)

        async def sleep(delay):
            self.sleeps.append(delay)

        return api.BalanceService(factory, lambda: self.key, lambda: self.now, sleep)

    def make_neko_service(self, responses, credentials="mock-neko-token"):
        self.calls = []
        self.now = 0
        async def handle(request):
            self.calls.append(request)
            item = responses[min(len(self.calls) - 1, len(responses) - 1)]
            if isinstance(item, Exception):
                raise item
            if isinstance(item, httpx.Response):
                return item
            return httpx.Response(200, json=item)
        def factory(**kwargs):
            return httpx.AsyncClient(transport=httpx.MockTransport(handle), **kwargs)
        return api.NekoBalanceService(factory, lambda: credentials, lambda: self.now)

    def make_cctq_service(self, responses, credentials=("mock-token", "24485")):
        self.calls = []
        self.now = 0
        async def handle(request):
            self.calls.append(request)
            item = responses[min(len(self.calls) - 1, len(responses) - 1)]
            if isinstance(item, Exception):
                raise item
            if isinstance(item, httpx.Response):
                return item
            return httpx.Response(200, json=item)
        def factory(**kwargs):
            return httpx.AsyncClient(transport=httpx.MockTransport(handle), **kwargs)
        return api.CCTQBalanceService(factory, lambda: credentials, lambda: self.now)

    async def test_neko_retries_transient_timeout_then_succeeds(self):
        service = self.make_neko_service([
            httpx.ConnectTimeout("mock tls stall"),
            {"balance": 7.5, "is_active": True},
        ])
        result = await service.get()
        self.assertEqual(result["status"], "ok")
        self.assertEqual(result["balance"], "7.5")
        self.assertEqual(len(self.calls), 2)

    async def test_neko_timeout_exhausts_attempts_and_is_not_cached(self):
        service = self.make_neko_service([httpx.ConnectTimeout("mock tls stall")])
        result = await service.get()
        self.assertEqual(result["code"], "timeout")
        self.assertEqual(len(self.calls), api.ATTEMPTS)
        again = await service.get()
        self.assertEqual(again["code"], "timeout")
        self.assertFalse(again["cached"])
        self.assertEqual(len(self.calls), api.ATTEMPTS * 2)

    async def test_cctq_retries_transient_timeout_then_succeeds(self):
        service = self.make_cctq_service([
            httpx.ConnectTimeout("mock tls stall"),
            {"success": True, "data": {"quota": 6250000, "used_quota": 1250000}},
        ])
        result = await service.get()
        self.assertEqual(result["status"], "ok")
        self.assertEqual(len(self.calls), 2)

    async def test_cctq_parse_request_and_cache(self):
        service = self.make_cctq_service([{"success": True, "data": {"quota": 6250000, "used_quota": 1250000}}])
        result = await service.get()
        self.assertEqual(result["balance"], "12.5")
        self.assertEqual(result["used"], "2.5")
        self.assertEqual(result["currency"], "USD")
        request = self.calls[0]
        self.assertEqual(str(request.url), api.CCTQ_URL)
        self.assertEqual(request.headers["authorization"], "Bearer mock-token")
        self.assertEqual(request.headers["new-api-user"], "24485")
        self.assertNotIn("mock-token", json.dumps(result))
        self.assertTrue((await service.get())["cached"])
        self.assertEqual(len(self.calls), 1)

    async def test_cctq_missing_or_invalid_configuration_does_not_request(self):
        service = self.make_cctq_service([{"success": True, "data": {"quota": 1, "used_quota": 0}}], None)
        result = await service.get()
        self.assertEqual(result["code"], "missing_credentials")
        self.assertEqual(self.calls, [])

    async def test_cctq_rejects_malformed_quota_and_sanitizes_errors(self):
        for quota in [-1, True, None, "NaN", "1e9999", {}]:
            service = self.make_cctq_service([{"success": True, "data": {"quota": quota, "used_quota": 0}}])
            self.assertEqual((await service.get())["code"], "invalid_response")
        service = self.make_cctq_service([httpx.Response(401, text="mock-token 24485")])
        result = await service.get()
        self.assertEqual(result["code"], "provider_auth")
        self.assertNotIn("mock-token", json.dumps(result))
        self.assertNotIn("24485", json.dumps(result))

    async def test_cctq_credentials_reads_only_enabled_newapi_values(self):
        import sqlite3, tempfile
        from pathlib import Path
        with tempfile.TemporaryDirectory() as folder:
            db = Path(folder) / "cc-switch.db"
            conn = sqlite3.connect(db)
            try:
                conn.execute("CREATE TABLE providers (id TEXT, name TEXT, app_type TEXT, meta TEXT)")
                conn.execute("INSERT INTO providers VALUES (?, ?, ?, ?)", ("cctq", "CCTQ", "claude", json.dumps({
                    "usage_script": {"enabled": True, "templateType": "newapi", "accessToken": "mock-token",
                                     "userId": "24485", "code": "{{baseUrl}}/api/user/self"}
                })))
                conn.commit()
            finally:
                conn.close()
            self.assertEqual(api.cctq_credentials(str(db)), ("mock-token", "24485"))

    async def test_cny_not_first_entry_and_exact_decimal(self):
        service = self.make_service([payload()])
        result = await service.get()
        self.assertEqual(result["balance"], "12.3400")
        self.assertEqual(result["currency"], "CNY")
        self.assertEqual(result["status"], "ok")
        # The grant/top-up split is rendered by the bubble as its own modules, so
        # it must survive as an exact decimal string, not a float.
        self.assertEqual(result["granted"], "0")
        self.assertEqual(result["topped_up"], "12.34")
        self.assertEqual(self.options[0]["timeout"], 10)
        self.assertFalse(self.options[0]["follow_redirects"])
        self.assertEqual(str(self.calls[0].url), api.URL)

    async def test_split_balances_are_exact_and_sum_to_total(self):
        service = self.make_service([payload(
            amount="100.10", granted="0.03", topped_up="100.07")])
        result = await service.get()
        self.assertEqual(result["granted"], "0.03")
        self.assertEqual(result["topped_up"], "100.07")
        total = Decimal(result["balance"])
        self.assertEqual(Decimal(result["granted"]) + Decimal(result["topped_up"]), total)

    async def test_malformed_numbers_and_structure(self):
        for bad in ["NaN", "Infinity", "-1", "", "garbage", None, True, {}, [], "1e9999"]:
            with self.subTest(bad=bad):
                service = self.make_service([payload(bad)])
                result = await service.get()
                self.assertEqual(result["code"], "invalid_response")
                self.assertIsNone(result["balance"])
        for field in ("granted_balance", "topped_up_balance"):
            data = payload()
            data["balance_infos"][1][field] = "-0.01"
            service = self.make_service([data])
            self.assertEqual((await service.get())["code"], "invalid_response")
        for data in [{}, [], {"is_available": True, "balance_infos": [payload()["balance_infos"][0]]}]:
            service = self.make_service([data])
            self.assertEqual((await service.get())["code"], "invalid_response")

    async def test_missing_key_never_sends_request(self):
        service = self.make_service([payload()])
        self.key = ""
        self.assertEqual((await service.get())["status"], "unavailable")
        self.assertEqual(len(self.calls), 0)

    async def test_cache_and_expiry(self):
        service = self.make_service([payload()])
        await service.get()
        self.now = 59.9
        self.assertTrue((await service.get())["cached"])
        self.assertEqual(len(self.calls), 1)
        self.now = 60
        await service.get()
        self.assertEqual(len(self.calls), 2)

    async def test_concurrent_and_cancelled_waiter_deduplication(self):
        gate = asyncio.Event()
        async def wait(request):
            await gate.wait()
            return httpx.Response(200, json=payload())
        service = self.make_service([wait])
        one = asyncio.create_task(service.get())
        two = asyncio.create_task(service.get())
        await asyncio.sleep(0)
        await asyncio.sleep(0)
        one.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await one
        gate.set()
        self.assertEqual((await two)["status"], "ok")
        self.assertEqual(len(self.calls), 1)

    async def test_zero_bounded_three_extra_reads(self):
        service = self.make_service([payload("0")])
        result = await service.get()
        self.assertEqual(len(self.calls), 4)
        self.assertEqual(len(self.sleeps), 3)
        self.assertEqual(result["status"], "zero_unconfirmed")
        self.assertTrue(result["zero_unconfirmed"])
        self.assertEqual(result["balance"], "0")
        await service.get()
        self.assertEqual(len(self.calls), 4)

    async def test_zero_recovers_without_fabrication(self):
        service = self.make_service([payload("0"), payload("0"), payload("3.21")])
        self.assertEqual((await service.get())["balance"], "3.21")
        self.assertEqual(len(self.calls), 3)

    async def test_timeout_preserves_stale_and_timestamp(self):
        service = self.make_service([payload(), httpx.ReadTimeout("SECRET mock-only-key")])
        original = await service.get()
        self.now = 60
        result = await service.get()
        self.assertEqual(result["status"], "error")
        self.assertEqual(result["code"], "timeout")
        self.assertTrue(result["stale"])
        self.assertEqual(result["balance"], original["balance"])
        self.assertEqual(result["updated_at"], original["updated_at"])
        self.assertNotIn("SECRET", json.dumps(result))

    async def test_http_errors_json_and_exceptions_sanitized(self):
        for response, code in [
            (httpx.Response(401, text="SECRET mock-only-key"), "provider_auth"),
            (httpx.Response(500, text="SECRET mock-only-key"), "provider_http"),
            (httpx.Response(302, headers={"location": "https://example.invalid"}), "provider_http"),
            (httpx.Response(200, text="SECRET mock-only-key"), "invalid_response"),
            (httpx.ConnectError("SECRET mock-only-key"), "request_failed"),
            (RuntimeError("SECRET mock-only-key"), "request_failed"),
        ]:
            service = self.make_service([response])
            result = await service.get()
            self.assertEqual(result["code"], code)
            self.assertNotIn("SECRET", json.dumps(result))
            self.assertNotIn("mock-only-key", json.dumps(result))
            self.assertEqual(len(self.calls), 1)

    async def test_provider_unavailable(self):
        service = self.make_service([payload(available=False)])
        self.assertEqual((await service.get())["status"], "unavailable")

    async def test_key_rotation_clears_cache(self):
        service = self.make_service([payload(), payload("6")])
        await service.get()
        self.key = "another-mock-key"
        self.assertEqual((await service.get())["balance"], "6")
        self.assertEqual(len(self.calls), 2)
        self.key = ""
        self.assertIsNone((await service.get())["balance"])

    async def test_real_router_contract_with_mock_provider(self):
        service = self.make_service([payload()])
        original = api.service
        api.service = service
        try:
            app = FastAPI()
            app.include_router(api.router, prefix="/api/plugins/whale-balance-hermes")
            async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
                response = await client.get("/api/plugins/whale-balance-hermes/balance")
            self.assertEqual(response.status_code, 200)
            self.assertEqual(response.headers["cache-control"], "no-store")
            self.assertNotIn("access-control-allow-origin", response.headers)
            self.assertEqual(response.json()["balance"], "12.3400")
        finally:
            api.service = original


class BubbleImageTests(unittest.IsolatedAsyncioTestCase):
    """The artwork route: it must serve the built-in gifs and nothing else."""

    def make_client(self):
        app = FastAPI()
        app.include_router(api.router, prefix="/api/plugins/whale-balance-hermes")
        return httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test")

    async def test_both_built_in_pictures_are_served_as_data_urls(self):
        # Public builds ship no bubble images (README 'Licensing'), so each id is
        # verified against the file that actually exists: present -> real bytes,
        # absent -> the documented asset_missing degrade path.
        for asset_id in ("petpet", "money1"):
            filename = api.BUBBLE_IMAGES[asset_id]
            present = os.path.isfile(os.path.join(api.BUBBLE_ASSET_DIR, filename))
            async with self.make_client() as client:
                response = await client.get(f"/api/plugins/whale-balance-hermes/bubble-image/{asset_id}")
                self.assertEqual(response.status_code, 200)
                self.assertEqual(response.headers["cache-control"], "no-store")
                body = response.json()
            if not present:
                self.assertFalse(body["ok"], asset_id)
                self.assertEqual(body["code"], "asset_missing", asset_id)
                continue
            self.assertTrue(body["ok"], asset_id)
            self.assertEqual(body["mime"], "image/gif")
            self.assertTrue(body["data_url"].startswith("data:image/gif;base64,"))
            # The bytes must be the real file, not a placeholder.
            self.assertGreater(body["bytes"], 1000)
            self.assertEqual(len(body["data_url"]), 22 + 4 * ((body["bytes"] + 2) // 3))

    async def test_unknown_and_traversal_ids_are_refused(self):
        async with self.make_client() as client:
            # Ids that reach the route at all must be rejected by the allowlist.
            for asset_id in ("nope", "bubble-petpet.gif", "BUBBLE-IMAGES"):
                response = await client.get(f"/api/plugins/whale-balance-hermes/bubble-image/{asset_id}")
                self.assertEqual(response.status_code, 200, asset_id)
                body = response.json()
                self.assertFalse(body["ok"], asset_id)
                self.assertEqual(body["code"], "unknown_asset", asset_id)
                self.assertNotIn("data_url", body)

            # Ids containing a slash or dot-segment never reach the handler at all:
            # the router answers 404 before the allowlist is consulted. Either way
            # no file outside assets/ can be read, which is the property that matters.
            for asset_id in ("..", "../../../../etc/passwd", "..%2F..%2Fplugin_api.py"):
                response = await client.get(f"/api/plugins/whale-balance-hermes/bubble-image/{asset_id}")
                self.assertEqual(response.status_code, 404, asset_id)
                self.assertNotIn(b"root:", response.content)

    async def test_a_missing_file_is_reported_not_crashed(self):
        # An id that is allowlisted but whose file was deleted must degrade to a
        # code, not a 500 -- the bubble simply shows nothing.
        original = dict(api.BUBBLE_IMAGES)
        api.BUBBLE_IMAGES["ghost"] = "does-not-exist.gif"
        try:
            async with self.make_client() as client:
                response = await client.get("/api/plugins/whale-balance-hermes/bubble-image/ghost")
                self.assertEqual(response.status_code, 200)
                self.assertEqual(response.json()["code"], "asset_missing")
        finally:
            api.BUBBLE_IMAGES.clear()
            api.BUBBLE_IMAGES.update(original)
