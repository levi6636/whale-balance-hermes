"""DeepSeek/CCTQ/Neko balance router; provider credentials are read only from CC Switch."""

import asyncio
import json
import os
import time
from datetime import datetime, timezone
from decimal import Decimal, InvalidOperation

import httpx
from fastapi import APIRouter, Response

URL = "https://api.deepseek.com/user/balance"
CCTQ_URL = "https://www.cctq.ai/api/user/self"
NEKO_URL = "https://nekoapi.ai/user/balance"
NEKO_BASE = "https://nekoapi.ai"
CC_SWITCH_DB = os.path.join(os.path.expanduser("~"), ".cc-switch", "cc-switch.db")
TTL = 60
ZERO_RETRIES = 3
ATTEMPT_TIMEOUT = 4.0
ATTEMPTS = 3
RETRY_DELAY = 0.4


class InvalidBalance(ValueError):
    pass


def cctq_credentials(db_path=CC_SWITCH_DB):
    """Read only the enabled CCTQ NewAPI usage-query credentials; never return config/scripts."""
    import json
    import sqlite3

    if not db_path or not os.path.isfile(db_path):
        return None
    try:
        uri = "file:" + db_path.replace("\\", "/") + "?mode=ro"
        conn = sqlite3.connect(uri, uri=True, timeout=1)
        try:
            row = conn.execute(
                "SELECT meta FROM providers WHERE lower(name) = 'cctq' AND app_type = 'claude' LIMIT 1"
            ).fetchone()
        finally:
            conn.close()
        if not row:
            return None
        meta = json.loads(row[0] or "{}")
        usage = meta.get("usage_script")
        if not isinstance(usage, dict) or usage.get("enabled") is not True or usage.get("templateType") != "newapi":
            return None
        token = usage.get("accessToken")
        user_id = usage.get("userId")
        script = usage.get("code")
        if not isinstance(token, str) or not token.strip() or not isinstance(user_id, str) or not user_id.strip():
            return None
        if not isinstance(script, str) or "{{baseUrl}}/api/user/self" not in script:
            return None
        return token.strip(), user_id.strip()
    except Exception:
        return None


def _neko_base_url(value):
    """Accept only the fixed Neko base URL, with an optional single trailing slash."""
    if not isinstance(value, str):
        return False
    return value == NEKO_BASE or value == NEKO_BASE + "/"


def neko_credentials(db_path=CC_SWITCH_DB):
    """Read only the enabled Neko usage-query credentials; never return config/scripts."""
    import json
    import sqlite3

    if not db_path or not os.path.isfile(db_path):
        return None
    try:
        uri = "file:" + db_path.replace("\\", "/") + "?mode=ro"
        conn = sqlite3.connect(uri, uri=True, timeout=1)
        try:
            row = conn.execute(
                "SELECT meta, settings_config FROM providers WHERE lower(name) = 'neko' AND app_type = 'claude' LIMIT 1"
            ).fetchone()
        finally:
            conn.close()
        if not row:
            return None
        meta = json.loads(row[0] or "{}")
        settings = json.loads(row[1] or "{}")
        usage = meta.get("usage_script")
        if not isinstance(usage, dict) or usage.get("enabled") is not True:
            return None
        if usage.get("templateType") != "general":
            return None
        script = usage.get("code")
        if not isinstance(script, str) or "{{baseUrl}}/user/balance" not in script:
            return None
        env = settings.get("env") if isinstance(settings, dict) else None
        if not isinstance(env, dict) or not _neko_base_url(env.get("ANTHROPIC_BASE_URL")):
            return None
        token = env.get("ANTHROPIC_AUTH_TOKEN")
        if not isinstance(token, str) or not token.strip():
            token = env.get("ANTHROPIC_API_KEY")
        if not isinstance(token, str) or not token.strip():
            return None
        return token.strip()
    except Exception:
        return None


def parse_cctq(payload):
    if not isinstance(payload, dict) or payload.get("success") is not True:
        raise InvalidBalance()
    data = payload.get("data")
    if not isinstance(data, dict):
        raise InvalidBalance()
    values = []
    for field in ("quota", "used_quota"):
        raw = data.get(field)
        if isinstance(raw, bool) or not isinstance(raw, (int, str)) or len(str(raw)) > 128:
            raise InvalidBalance()
        try:
            number = Decimal(str(raw))
        except (InvalidOperation, ValueError):
            raise InvalidBalance() from None
        if not number.is_finite() or number < 0 or abs(number.adjusted()) > 128:
            raise InvalidBalance()
        values.append(number / Decimal(500000))
    return values[0], values[1]


def parse_neko(payload):
    if not isinstance(payload, dict):
        raise InvalidBalance()
    if not isinstance(payload.get("is_active"), bool):
        raise InvalidBalance()
    raw = payload.get("balance")
    if isinstance(raw, bool) or not isinstance(raw, (int, float, Decimal)):
        raise InvalidBalance()
    if len(str(raw)) > 128:
        raise InvalidBalance()
    try:
        number = Decimal(str(raw))
    except (InvalidOperation, ValueError):
        raise InvalidBalance() from None
    if not number.is_finite() or number < 0 or abs(number.adjusted()) > 128:
        raise InvalidBalance()
    return number, payload["is_active"]


class NekoBalanceService:
    def __init__(self, client_factory=httpx.AsyncClient, credentials_getter=neko_credentials,
                 clock=time.monotonic):
        self.client_factory = client_factory
        self.credentials_getter = credentials_getter
        self.clock = clock
        self._identity = None
        self._cached = None
        self._cached_at = 0
        self._task = None

    async def get(self):
        credentials = self.credentials_getter()
        if not credentials:
            self._identity = self._cached = self._task = None
            return {"status": "unavailable", "code": "missing_credentials", "currency": "USD",
                    "balance": None, "updated_at": None, "stale": False, "cached": False}
        token = credentials
        # Account changes must never serve another credential's cached balance.
        if token != self._identity:
            self._identity, self._cached, self._task = token, None, None
        if self._cached is not None and self.clock() - self._cached_at < TTL:
            return dict(self._cached, cached=True)
        if self._task is None:
            task = asyncio.create_task(self._fetch(token))
            self._task = task
            task.add_done_callback(lambda done: self._clear_task(done))
        return await asyncio.shield(self._task)

    def _clear_task(self, task):
        if self._task is task:
            self._task = None

    @staticmethod
    def _error(code):
        return {"status": "error", "code": code, "currency": "USD", "balance": None,
                "updated_at": None, "stale": False, "cached": False}

    async def _fetch(self, token):
        for attempt in range(ATTEMPTS):
            try:
                async with self.client_factory(timeout=ATTEMPT_TIMEOUT, follow_redirects=False,
                                               trust_env=False) as client:
                    response = await client.get(NEKO_URL, headers={
                        "Authorization": "Bearer " + token,
                        "Accept": "application/json",
                        "User-Agent": "whale-balance-hermes/0.1",
                    })
                if response.status_code != 200:
                    code = "provider_auth" if response.status_code in (401, 403) else "provider_http"
                    result = self._error(code)
                else:
                    balance, active = parse_neko(json.loads(response.text, parse_float=Decimal))
                    if active is not True:
                        result = {"status": "unavailable", "code": "provider_unavailable", "currency": "USD",
                                  "balance": None, "updated_at": None, "stale": False, "cached": False}
                    else:
                        result = {"status": "ok", "code": None, "currency": "USD",
                                  "balance": format(balance, "f"),
                                  "updated_at": datetime.now(timezone.utc).isoformat(),
                                  "stale": False, "cached": False}
                break
            except httpx.TimeoutException:
                if attempt + 1 < ATTEMPTS:
                    await asyncio.sleep(RETRY_DELAY)
                    continue
                result = self._error("timeout")
            except (InvalidBalance, ValueError, TypeError):
                result = self._error("invalid_response")
            except httpx.TransportError:
                if attempt + 1 < ATTEMPTS:
                    await asyncio.sleep(RETRY_DELAY)
                    continue
                result = self._error("request_failed")
            except Exception:
                result = self._error("request_failed")
        if self._identity == token and result["status"] in ("ok", "unavailable"):
            self._cached, self._cached_at = result, self.clock()
        return result


class CCTQBalanceService:
    def __init__(self, client_factory=httpx.AsyncClient, credentials_getter=cctq_credentials,
                 clock=time.monotonic):
        self.client_factory = client_factory
        self.credentials_getter = credentials_getter
        self.clock = clock
        self._identity = None
        self._cached = None
        self._cached_at = 0
        self._task = None

    async def get(self):
        credentials = self.credentials_getter()
        if not credentials:
            self._identity = self._cached = self._task = None
            return {"status": "unavailable", "code": "missing_credentials", "currency": "USD",
                    "balance": None, "updated_at": None, "stale": False, "cached": False}
        token, user_id = credentials
        identity = (token, user_id)
        if identity != self._identity:
            self._identity, self._cached, self._task = identity, None, None
        if self._cached is not None and self.clock() - self._cached_at < TTL:
            return dict(self._cached, cached=True)
        if self._task is None:
            task = asyncio.create_task(self._fetch(token, user_id))
            self._task = task
            task.add_done_callback(lambda done: self._clear_task(done))
        return await asyncio.shield(self._task)

    def _clear_task(self, task):
        if self._task is task:
            self._task = None

    async def _fetch(self, token, user_id):
        for attempt in range(ATTEMPTS):
            try:
                async with self.client_factory(timeout=ATTEMPT_TIMEOUT, follow_redirects=False,
                                               trust_env=False) as client:
                    response = await client.get(CCTQ_URL, headers={
                        "Authorization": "Bearer " + token,
                        "New-Api-User": user_id,
                        "Accept": "application/json",
                        "User-Agent": "whale-balance-hermes/0.1",
                    })
                if response.status_code != 200:
                    code = "provider_auth" if response.status_code in (401, 403) else "provider_http"
                    result = {"status": "error", "code": code, "currency": "USD", "balance": None,
                              "updated_at": None, "stale": False, "cached": False}
                else:
                    remaining, used = parse_cctq(response.json())
                    result = {"status": "ok", "code": None, "currency": "USD",
                              "balance": format(remaining, "f"), "used": format(used, "f"),
                              "updated_at": datetime.now(timezone.utc).isoformat(),
                              "stale": False, "cached": False}
                break
            except httpx.TimeoutException:
                if attempt + 1 < ATTEMPTS:
                    await asyncio.sleep(RETRY_DELAY)
                    continue
                result = {"status": "error", "code": "timeout", "currency": "USD", "balance": None,
                          "updated_at": None, "stale": False, "cached": False}
            except (InvalidBalance, ValueError, TypeError):
                result = {"status": "error", "code": "invalid_response", "currency": "USD", "balance": None,
                          "updated_at": None, "stale": False, "cached": False}
            except httpx.TransportError:
                if attempt + 1 < ATTEMPTS:
                    await asyncio.sleep(RETRY_DELAY)
                    continue
                result = {"status": "error", "code": "request_failed", "currency": "USD", "balance": None,
                          "updated_at": None, "stale": False, "cached": False}
            except Exception:
                result = {"status": "error", "code": "request_failed", "currency": "USD", "balance": None,
                          "updated_at": None, "stale": False, "cached": False}
        if self._identity == (token, user_id) and result["status"] in ("ok", "unavailable"):
            self._cached, self._cached_at = result, self.clock()
        return result


def parse_balance(payload):
    if not isinstance(payload, dict) or not isinstance(payload.get("is_available"), bool):
        raise InvalidBalance()
    rows = payload.get("balance_infos")
    if not isinstance(rows, list):
        raise InvalidBalance()
    cny = [row for row in rows if isinstance(row, dict) and row.get("currency") == "CNY"]
    if len(cny) != 1:
        raise InvalidBalance()
    result = {}
    for field in ("total_balance", "granted_balance", "topped_up_balance"):
        raw = cny[0].get(field)
        if isinstance(raw, bool) or not isinstance(raw, (str, int, float, Decimal)):
            raise InvalidBalance()
        if len(str(raw)) > 128:
            raise InvalidBalance()
        try:
            number = Decimal(str(raw))
        except (InvalidOperation, ValueError):
            raise InvalidBalance() from None
        if not number.is_finite() or number < 0 or abs(number.adjusted()) > 128:
            raise InvalidBalance()
        result[field] = number
    return result, payload["is_available"]


class BalanceService:
    def __init__(self, client_factory=httpx.AsyncClient, key_getter=None,
                 clock=time.monotonic, sleep=asyncio.sleep):
        self.client_factory = client_factory
        self.key_getter = key_getter or (lambda: os.environ.get("DEEPSEEK_API_KEY", ""))
        self.clock = clock
        self.sleep = sleep
        self._task = None
        self._cached = None
        self._cached_at = 0
        self._last_good = None
        self._identity = None

    async def get(self):
        key = self.key_getter()
        key = key.strip() if isinstance(key, str) else ""
        # Account changes must never serve another credential's cached balance.
        if key != self._identity:
            self._identity = key
            self._cached = self._last_good = None
            self._task = None
        if not key:
            return self._failure("unavailable", "missing_key")
        if self._cached is not None and self.clock() - self._cached_at < TTL:
            return dict(self._cached, cached=True)
        if self._task is None:
            task = asyncio.create_task(self._fetch(key))
            self._task = task
            task.add_done_callback(lambda done: self._clear_task(done))
        return await asyncio.shield(self._task)

    def _clear_task(self, task):
        if self._task is task:
            self._task = None

    def _failure(self, status, code):
        previous = self._last_good
        return {
            "status": status, "code": code, "currency": "CNY",
            "balance": previous["balance"] if previous else None,
            # The split must travel (or stay absent) with the total it came from:
            # a stale grant paired with a fresh total would show a wrong breakdown.
            "granted": previous.get("granted") if previous else None,
            "topped_up": previous.get("topped_up") if previous else None,
            "updated_at": previous["updated_at"] if previous else None,
            "stale": previous is not None, "cached": False,
            "zero_unconfirmed": False,
        }

    async def _fetch(self, key):
        try:
            async with self.client_factory(timeout=10.0, follow_redirects=False,
                                          trust_env=False) as client:
                for attempt in range(ZERO_RETRIES + 1):
                    response = await client.get(URL, headers={"Authorization": "Bearer " + key})
                    if response.status_code != 200:
                        code = "provider_auth" if response.status_code in (401, 403) else "provider_http"
                        result = self._failure("error", code)
                        break
                    values, available = parse_balance(response.json())
                    if values["total_balance"] == 0 and attempt < ZERO_RETRIES:
                        await self.sleep(0.25)
                        continue
                    zero = values["total_balance"] == 0
                    result = {
                        "status": "zero_unconfirmed" if zero else ("ok" if available else "unavailable"),
                        "code": "zero_unconfirmed" if zero else (None if available else "provider_unavailable"),
                        "currency": "CNY", "balance": format(values["total_balance"], "f"),
                        # Split balances stay Decimal-precise like the total: the
                        # bubble modules render them separately, and round-tripping
                        # through float would invent cents.
                        "granted": format(values["granted_balance"], "f"),
                        "topped_up": format(values["topped_up_balance"], "f"),
                        "updated_at": datetime.now(timezone.utc).isoformat(),
                        "stale": False, "cached": False, "zero_unconfirmed": zero,
                    }
                    break
        except httpx.TimeoutException:
            result = self._failure("error", "timeout")
        except (InvalidBalance, ValueError, TypeError):
            result = self._failure("error", "invalid_response")
        except Exception:
            result = self._failure("error", "request_failed")
        if self._identity == key:
            if result["status"] == "ok":
                self._last_good = result
            self._cached = result
            self._cached_at = self.clock()
        return result


router = APIRouter()
service = BalanceService()
cctq_service = CCTQBalanceService()
neko_service = NekoBalanceService()


# --- local ledger ---------------------------------------------------------
# Reads Hermes' own usage table (read-only) and re-prices it with peak/off-peak
# rates. Nothing here writes to state.db.

LEDGER_MAX_ROWS = 20000


def _ledger_db_path():
    """Path to Hermes' state.db, or None when it cannot be located.

    Prefers the runtime helper so a relocated HERMES_HOME still resolves; the
    literal fallback keeps this importable from tests without hermes_constants.
    """

    try:
        from hermes_constants import get_hermes_home

        return os.path.join(str(get_hermes_home()), "state.db")
    except Exception:
        return os.path.join(os.path.expanduser("~"), "AppData", "Local", "hermes", "state.db")


def read_usage_rows(db_path=None, limit=LEDGER_MAX_ROWS):
    """Read usage rows from state.db, newest first.

    Returns ``(rows, error)``: ``error`` is a short code instead of an
    exception so the widget can show a degraded state rather than a blank card.
    """

    import sqlite3

    path = db_path or _ledger_db_path()
    if not path or not os.path.isfile(path):
        return [], "no_database"
    try:
        conn = sqlite3.connect("file:" + path.replace("\\", "/") + "?mode=ro", uri=True, timeout=2)
        conn.row_factory = sqlite3.Row
        try:
            cursor = conn.execute(
                "SELECT model, api_call_count, input_tokens, cache_read_tokens,"
                " cache_write_tokens, output_tokens, reasoning_tokens,"
                " first_seen, last_seen, estimated_cost_usd, actual_cost_usd"
                " FROM session_model_usage WHERE last_seen IS NOT NULL"
                " ORDER BY last_seen DESC LIMIT ?",
                (limit,),
            )
            return [dict(row) for row in cursor.fetchall()], None
        finally:
            conn.close()
    except sqlite3.Error:
        return [], "read_failed"


def _ledger_service():
    """Load the sibling ledger module without relying on the process cwd."""
    import importlib.util
    import sys

    name = "whale_balance_ledger"
    cached = sys.modules.get(name)
    if cached is not None:
        return cached
    path = os.path.join(os.path.dirname(__file__), "ledger.py")
    spec = importlib.util.spec_from_file_location(name, path)
    if spec is None or spec.loader is None:
        raise ImportError(f"cannot load ledger module from {path}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


@router.get("/ledger")
async def ledger_usage(response: Response, days: int = 7):
    """Itemised local spend with peak/off-peak split (CNY).

    ``days`` bounds the daily view; totals always cover everything read so the
    two do not disagree.
    """

    response.headers["Cache-Control"] = "no-store"

    module = _ledger_service()
    rows, error = read_usage_rows()
    if error:
        return {"status": "degraded", "code": error, "totals": {}, "by_model": [], "by_day": []}

    now = datetime.now(timezone.utc).timestamp()
    window_days = max(1, min(int(days or 7), 365))
    since = now - window_days * 86400

    result = module.aggregate_usage(rows)
    windowed = module.aggregate_usage(rows, since=since)
    result["window"] = {
        "days": window_days,
        "since": datetime.fromtimestamp(since, timezone.utc).isoformat(),
        "totals": windowed["totals"],
        "by_day": windowed["by_day"],
    }
    result["status"] = "ok"
    result["updated_at"] = datetime.now(timezone.utc).isoformat()
    result["peak_now"] = module.is_peak(datetime.now(module.LOCAL_TZ))
    result["next_boundary"] = module.next_boundary(
        datetime.now(module.LOCAL_TZ)
    ).isoformat()
    return result


@router.get("/balance")
async def balance(response: Response):
    response.headers["Cache-Control"] = "no-store"
    return await service.get()


@router.get("/balance/cctq")
async def cctq_balance(response: Response):
    response.headers["Cache-Control"] = "no-store"
    return await cctq_service.get()


@router.get("/balance/neko")
async def neko_balance(response: Response):
    response.headers["Cache-Control"] = "no-store"
    return await neko_service.get()


# ---------------------------------------------------------------------------
# Bubble artwork.
#
# The desktop half cannot read its own assets: the host's `loadPluginAsset`
# door is hard-wired to the two upstream mp3s (filename allowlist + an
# audio/mpeg MIME check + 100 KB cap), so a gif can never come through it. The
# Python half can read files, so it serves them instead and the frontend pulls
# them over the authenticated plugin REST door as a data URL.
#
# The allowlist is a dict, not a path join on user input: a request can only
# ever name one of these ids, so there is no traversal surface to sanitise.
# ---------------------------------------------------------------------------
BUBBLE_ASSET_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "assets")
BUBBLE_IMAGES = {
    "petpet": "bubble-petpet.gif",
    "money1": "bubble-money1.gif",
}
BUBBLE_IMAGE_MIME = {
    ".gif": "image/gif",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
}
# A generous but finite ceiling: these are decorative bubble pictures, and the
# renderer holds the whole thing as a base64 string.
BUBBLE_IMAGE_MAX_BYTES = 8 * 1024 * 1024


@router.get("/bubble-image/{asset_id}")
async def bubble_image(asset_id: str, response: Response):
    """Return one built-in bubble picture as a data URL.

    ``asset_id`` is looked up in a fixed table, never joined onto a path, so a
    caller cannot reach a file outside ``assets/``.
    """

    response.headers["Cache-Control"] = "no-store"

    filename = BUBBLE_IMAGES.get(asset_id)
    if not filename:
        return {"ok": False, "code": "unknown_asset", "id": asset_id}

    path = os.path.join(os.path.abspath(BUBBLE_ASSET_DIR), filename)
    mime = BUBBLE_IMAGE_MIME.get(os.path.splitext(filename)[1].lower())
    if not mime or not os.path.isfile(path):
        return {"ok": False, "code": "asset_missing", "id": asset_id}

    try:
        size = os.path.getsize(path)
        if size > BUBBLE_IMAGE_MAX_BYTES:
            return {"ok": False, "code": "asset_too_large", "id": asset_id}

        import base64

        with open(path, "rb") as handle:
            payload = base64.b64encode(handle.read()).decode("ascii")
    except OSError:
        return {"ok": False, "code": "asset_unreadable", "id": asset_id}

    return {"ok": True, "id": asset_id, "mime": mime, "bytes": size,
            "data_url": f"data:{mime};base64,{payload}"}
