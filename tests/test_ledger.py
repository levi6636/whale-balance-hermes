"""Ledger kernel tests: peak windows, weekend rule, cost math, aggregation.

Every timestamp is constructed explicitly, so these tests do not depend on the
wall clock or the machine timezone.
"""

import datetime as dt
import importlib.util
from decimal import Decimal
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location(
    "whale_ledger", Path(__file__).parents[1] / "dashboard/ledger.py"
)
ledger = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ledger)

TZ = ledger.LOCAL_TZ


def local(year, month, day, hour, minute=0, second=0):
    return dt.datetime(year, month, day, hour, minute, second, tzinfo=TZ)


def epoch(year, month, day, hour, minute=0, second=0):
    return local(year, month, day, hour, minute, second).timestamp()


class PeakWindowTests(unittest.TestCase):
    # 2026-10-16 is a Friday, 2026-10-17 a Saturday.

    def test_peak_window_start_is_inclusive(self):
        self.assertTrue(ledger.is_peak(local(2026, 10, 16, 9, 0)))

    def test_peak_window_end_is_exclusive(self):
        # 12:00 is the first off-peak instant, not the last peak one.
        self.assertFalse(ledger.is_peak(local(2026, 10, 16, 12, 0)))
        self.assertFalse(ledger.is_peak(local(2026, 10, 16, 18, 0)))

    def test_inside_each_window(self):
        for hour in (9, 10, 11, 14, 15, 16, 17):
            self.assertTrue(ledger.is_peak(local(2026, 10, 16, hour, 30)), hour)

    def test_lunch_gap_is_off_peak(self):
        self.assertFalse(ledger.is_peak(local(2026, 10, 16, 12, 30)))
        self.assertFalse(ledger.is_peak(local(2026, 10, 16, 13, 59, 59)))

    def test_early_morning_and_night_are_off_peak(self):
        for hour in (0, 3, 8, 19, 23):
            self.assertFalse(ledger.is_peak(local(2026, 10, 16, hour, 15)), hour)

    def test_weekend_is_off_peak_all_day(self):
        for hour in (9, 10, 15, 17):
            self.assertFalse(ledger.is_peak(local(2026, 10, 17, hour, 0)), hour)
            self.assertFalse(ledger.is_peak(local(2026, 10, 18, hour, 0)), hour)

    def test_weekend_rule_can_be_disabled_for_history(self):
        # Before 2026-08-23 weekends did bill at peak; callers must be able to
        # reproduce that for rows that predate the change.
        self.assertTrue(
            ledger.is_peak(local(2026, 8, 15, 10, 0), weekend_off_peak=False)
        )

    def test_naive_datetime_is_read_as_local(self):
        naive = dt.datetime(2026, 10, 16, 10, 0)
        self.assertTrue(ledger.is_peak(naive))

    def test_utc_datetime_is_converted_not_compared_raw(self):
        # 02:00 UTC == 10:00 Asia/Shanghai, inside the first peak window.
        utc = dt.datetime(2026, 10, 16, 2, 0, tzinfo=dt.timezone.utc)
        self.assertTrue(ledger.is_peak(utc))


class NextBoundaryTests(unittest.TestCase):
    def test_next_boundary_from_early_morning_is_window_start(self):
        self.assertEqual(ledger.next_boundary(local(2026, 10, 16, 7, 0)), local(2026, 10, 16, 9, 0))

    def test_next_boundary_inside_peak_is_window_end(self):
        self.assertEqual(ledger.next_boundary(local(2026, 10, 16, 10, 30)), local(2026, 10, 16, 12, 0))

    def test_next_boundary_in_gap_is_second_window(self):
        self.assertEqual(ledger.next_boundary(local(2026, 10, 16, 12, 30)), local(2026, 10, 16, 14, 0))

    def test_next_boundary_after_last_window_rolls_to_next_day(self):
        # Friday 20:00 -> Saturday is off-peak all day, so the next *change* is
        # Monday 09:00, not Saturday 09:00.
        self.assertEqual(ledger.next_boundary(local(2026, 10, 16, 20, 0)), local(2026, 10, 19, 9, 0))

    def test_next_boundary_on_saturday_skips_to_monday(self):
        # Saturday has peak windows on the clock, but they change nothing.
        self.assertEqual(ledger.next_boundary(local(2026, 10, 17, 8, 0)), local(2026, 10, 19, 9, 0))
        self.assertEqual(ledger.next_boundary(local(2026, 10, 17, 10, 0)), local(2026, 10, 19, 9, 0))

    def test_next_boundary_from_sunday_evening_is_monday_morning(self):
        self.assertEqual(ledger.next_boundary(local(2026, 10, 18, 22, 0)), local(2026, 10, 19, 9, 0))

    def test_next_boundary_before_weekend_rule_uses_old_behaviour(self):
        # 2026-08-15 is a Saturday before the cut-over: it does have a real
        # peak window, so the boundary is that morning's 09:00.
        self.assertEqual(
            ledger.next_boundary(local(2026, 8, 15, 7, 0), weekend_off_peak=False),
            local(2026, 8, 15, 9, 0),
        )


class PeakFractionTests(unittest.TestCase):
    def test_fully_peak_interval(self):
        fraction, kind = ledger.peak_fraction(
            epoch(2026, 10, 16, 9, 30), epoch(2026, 10, 16, 11, 30)
        )
        self.assertEqual(fraction, Decimal(1))
        self.assertEqual(kind, "peak")

    def test_fully_off_peak_interval(self):
        fraction, kind = ledger.peak_fraction(
            epoch(2026, 10, 16, 19, 0), epoch(2026, 10, 16, 21, 0)
        )
        self.assertEqual(fraction, Decimal(0))
        self.assertEqual(kind, "off_peak")

    def test_half_peak_interval(self):
        # 08:00-10:00 spans one hour off-peak then one hour peak.
        fraction, kind = ledger.peak_fraction(
            epoch(2026, 10, 16, 8, 0), epoch(2026, 10, 16, 10, 0)
        )
        self.assertEqual(fraction, Decimal("0.5"))
        self.assertEqual(kind, "mixed")

    def test_zero_length_interval_uses_that_instant(self):
        moment = epoch(2026, 10, 16, 10, 0)
        fraction, kind = ledger.peak_fraction(moment, moment)
        self.assertEqual(fraction, Decimal(1))
        self.assertEqual(kind, "peak")

    def test_weekend_interval_is_never_peak(self):
        fraction, kind = ledger.peak_fraction(
            epoch(2026, 10, 17, 9, 0), epoch(2026, 10, 17, 11, 0)
        )
        self.assertEqual(fraction, Decimal(0))
        self.assertEqual(kind, "off_peak")

    def test_multi_day_interval_terminates(self):
        # A row spanning days must still terminate and stay within [0, 1].
        fraction, _ = ledger.peak_fraction(
            epoch(2026, 10, 12, 0, 0), epoch(2026, 10, 16, 0, 0)
        )
        self.assertGreaterEqual(fraction, Decimal(0))
        self.assertLessEqual(fraction, Decimal(1))
        # Mon 00:00 -> Fri 00:00 = 96h; each weekday contributes 3h (09-12) +
        # 4h (14-18) = 7h of peak, so 4 days = 28h peak out of 96h. The kernel
        # builds the fraction from a float ratio, so compare with tolerance
        # instead of pretending the Decimal is exact.
        self.assertAlmostEqual(float(fraction), 28 / 96, places=12)


class RowCostTests(unittest.TestCase):
    def row(self, **overrides):
        base = {
            "model": "deepseek-flash",
            "input_tokens": 0,
            "cache_read_tokens": 0,
            "cache_write_tokens": 0,
            "output_tokens": 0,
            "reasoning_tokens": 0,
            "api_call_count": 0,
            "first_seen": epoch(2026, 10, 16, 20, 0),
            "last_seen": epoch(2026, 10, 16, 20, 0),
        }
        base.update(overrides)
        return base

    def test_off_peak_input_miss(self):
        cost = ledger.row_cost_cny(self.row(input_tokens=1_000_000))
        self.assertTrue(cost["known"])
        self.assertEqual(cost["cost_cny"], Decimal("1.00000000"))
        self.assertEqual(cost["off_peak_cost_cny"], Decimal("1.00000000"))

    def test_peak_input_miss_is_double(self):
        cost = ledger.row_cost_cny(
            self.row(input_tokens=1_000_000, first_seen=epoch(2026, 10, 16, 10, 0),
                     last_seen=epoch(2026, 10, 16, 10, 0))
        )
        self.assertEqual(cost["cost_cny"], Decimal("2.00000000"))
        self.assertEqual(cost["peak_cost_cny"], Decimal("2.00000000"))

    def test_cache_hit_is_cheaper_than_miss(self):
        miss = ledger.row_cost_cny(self.row(input_tokens=1_000_000))
        hit = ledger.row_cost_cny(self.row(cache_read_tokens=1_000_000))
        self.assertLess(hit["cost_cny"], miss["cost_cny"])
        self.assertEqual(hit["cost_cny"], Decimal("0.02000000"))

    def test_cache_write_bills_at_miss_rate(self):
        # A cache write is a cache miss plus storage: same rate as input here.
        write = ledger.row_cost_cny(self.row(cache_write_tokens=1_000_000))
        miss = ledger.row_cost_cny(self.row(input_tokens=1_000_000))
        self.assertEqual(write["cost_cny"], miss["cost_cny"])

    def test_reasoning_tokens_are_not_double_billed(self):
        # DeepSeek reports reasoning inside output_tokens; charging both would
        # inflate the bill.
        with_reasoning = ledger.row_cost_cny(
            self.row(output_tokens=1_000_000, reasoning_tokens=1_000_000)
        )
        output_only = ledger.row_cost_cny(self.row(output_tokens=1_000_000))
        self.assertEqual(with_reasoning["cost_cny"], output_only["cost_cny"])

    def test_pro_model_uses_pro_rates(self):
        flash = ledger.row_cost_cny(self.row(input_tokens=1_000_000))
        pro = ledger.row_cost_cny(self.row(model="deepseek-v4-pro", input_tokens=1_000_000))
        self.assertGreater(pro["cost_cny"], flash["cost_cny"])
        self.assertEqual(pro["cost_cny"], Decimal("4.50000000"))

    def test_provider_prefixed_id_resolves(self):
        cost = ledger.row_cost_cny(self.row(model="deepseek-ai/deepseek-v4-flash", input_tokens=1_000_000))
        self.assertTrue(cost["known"])
        self.assertEqual(cost["cost_cny"], Decimal("1.00000000"))

    def test_user_supplied_model_prices_are_applied(self):
        cases = [
            ("gpt-6.1-sol", "0.40000000", "2.00000000", "0.02000000"),
            ("gpt-6-luna", "0.02000000", "0.10000000", "0.00200000"),
            ("claude-haiku-5-5", "0.15000000", "0.75000000", "0.01000000"),
        ]
        for model, input_price, output_price, cache_price in cases:
            with self.subTest(model=model):
                cost = ledger.row_cost_cny(self.row(
                    model=model,
                    input_tokens=1_000_000,
                    output_tokens=1_000_000,
                    cache_read_tokens=1_000_000,
                ))
                self.assertTrue(cost["known"])
                self.assertEqual(
                    cost["cost_cny"],
                    Decimal(input_price) + Decimal(output_price) + Decimal(cache_price),
                )

    def test_public_list_prices_are_applied_per_component(self):
        # USD list prices at 6.687 CNY/USD; both peak columns are equal because
        # these vendors publish no peak premium.
        cases = {
            "claude-sonnet-4-6": ("20.06100000", "100.30500000", "2.00610000"),
            "glm-5.3-flash": ("1.00305000", "3.34350000", "0.20061000"),
            "glm-5.3-flashx": ("2.47419000", "8.35875000", "0.50152500"),
            "glm-4-flash": ("0.00000000", "0.00000000", "0.00000000"),
            "gemini-3.8-flash-tiered": ("5.01525000", "25.07625000", "0.50152500"),
            "gemini-3.7-flash-tiered": ("5.01525000", "25.07625000", "0.50152500"),
            "gemini-3.6-flash-low": ("5.01525000", "25.07625000", "0.50152500"),
            "gemini-3.5-flash-lite": ("2.00610000", "16.71750000", "0.20061000"),
            "gemini-3-flash": ("3.34350000", "20.06100000", "0.33435000"),
        }
        for model, (input_price, output_price, cache_price) in cases.items():
            with self.subTest(model=model):
                self.assertEqual(
                    ledger.money(ledger.row_cost_cny(self.row(model=model, input_tokens=1_000_000))["cost_cny"]),
                    input_price,
                )
                self.assertEqual(
                    ledger.money(ledger.row_cost_cny(self.row(model=model, output_tokens=1_000_000))["cost_cny"]),
                    output_price,
                )
                self.assertEqual(
                    ledger.money(ledger.row_cost_cny(self.row(model=model, cache_read_tokens=1_000_000))["cost_cny"]),
                    cache_price,
                )

    def test_public_list_prices_do_not_charge_a_peak_premium(self):
        off = ledger.row_cost_cny(self.row(model="claude-sonnet-4-6",
                                           input_tokens=1_000_000,
                                           first_seen=epoch(2026, 10, 16, 20, 0),
                                           last_seen=epoch(2026, 10, 16, 20, 0)))
        peak = ledger.row_cost_cny(self.row(model="claude-sonnet-4-6",
                                            input_tokens=1_000_000,
                                            first_seen=epoch(2026, 10, 16, 10, 0),
                                            last_seen=epoch(2026, 10, 16, 10, 0)))
        self.assertEqual(off["cost_cny"], peak["cost_cny"])

    def test_deepseek_still_charges_peak_premium(self):
        off = ledger.row_cost_cny(self.row(model="deepseek-flash", input_tokens=1_000_000,
                                           first_seen=epoch(2026, 10, 16, 20, 0),
                                           last_seen=epoch(2026, 10, 16, 20, 0)))
        peak = ledger.row_cost_cny(self.row(model="deepseek-flash", input_tokens=1_000_000,
                                            first_seen=epoch(2026, 10, 16, 10, 0),
                                            last_seen=epoch(2026, 10, 16, 10, 0)))
        self.assertEqual(peak["cost_cny"], off["cost_cny"] * 2)

    def test_unknown_model_is_flagged_not_silently_free(self):
        cost = ledger.row_cost_cny(self.row(model="gpt-6-luna-unknown", input_tokens=1_000_000))
        self.assertFalse(cost["known"])
        self.assertEqual(cost["classification"], "unpriced")


class AggregateTests(unittest.TestCase):
    def row(self, model="deepseek-flash", **overrides):
        base = {
            "model": model,
            "input_tokens": 1_000_000,
            "cache_read_tokens": 0,
            "cache_write_tokens": 0,
            "output_tokens": 0,
            "reasoning_tokens": 0,
            "api_call_count": 1,
            "first_seen": epoch(2026, 10, 16, 20, 0),
            "last_seen": epoch(2026, 10, 16, 20, 0),
        }
        base.update(overrides)
        return base

    def test_sums_across_rows(self):
        result = ledger.aggregate([self.row(), self.row()])
        self.assertEqual(result["totals"]["cost_cny"], "2.00000000")
        self.assertEqual(result["totals"]["input_tokens"], 2_000_000)
        self.assertEqual(result["totals"]["rows"], 2)

    def test_by_model_is_sorted_by_cost(self):
        result = ledger.aggregate([
            self.row(model="deepseek-flash"),
            self.row(model="deepseek-v4-pro"),
        ])
        self.assertEqual([m["model"] for m in result["by_model"]], ["deepseek-v4-pro", "deepseek-flash"])

    def test_window_filter_excludes_old_rows(self):
        result = ledger.aggregate(
            [self.row(last_seen=epoch(2026, 10, 1, 12, 0))],
            since=epoch(2026, 10, 16, 0, 0),
        )
        self.assertEqual(result["totals"]["rows"], 0)
        self.assertEqual(result["totals"]["cost_cny"], "0.00000000")

    def test_priced_models_are_not_reported_as_unpriced(self):
        result = ledger.aggregate([self.row(model="gpt-6-luna")])
        self.assertNotIn("gpt-6-luna", result["unpriced_models"])
        self.assertEqual(result["totals"]["cost_cny"], "0.02000000")
        self.assertTrue(result["by_model"][0]["priced"])

    def test_price_source_is_reported_per_model(self):
        result = ledger.aggregate([
            self.row(model="gpt-6.1-sol"),
            self.row(model="claude-sonnet-4-6"),
            self.row(model="gemini-3.8-flash-tiered"),
            self.row(model="deepseek-flash"),
            self.row(model="gpt-6-luna-unknown"),
        ])
        sources = {m["model"]: m["price_source"] for m in result["by_model"]}
        self.assertEqual(sources["gpt-6.1-sol"], "user")
        self.assertEqual(sources["claude-sonnet-4-6"], "public-list")
        self.assertEqual(sources["gemini-3.8-flash-tiered"], "estimate")
        self.assertEqual(sources["deepseek-flash"], "deepseek-list")
        self.assertEqual(sources["gpt-6-luna-unknown"], "unpriced")

    def test_unknown_models_are_reported(self):
        result = ledger.aggregate([self.row(model="gpt-6-luna-unknown")])
        self.assertIn("gpt-6-luna-unknown", result["unpriced_models"])
        self.assertEqual(result["totals"]["cost_cny"], "0.00000000")
        self.assertFalse(result["by_model"][0]["priced"])

    def test_reasoning_tokens_still_count_in_totals(self):
        result = ledger.aggregate([self.row(reasoning_tokens=500)])
        self.assertEqual(result["totals"]["reasoning_tokens"], 500)


class DaySliceTests(unittest.TestCase):
    def row(self, **overrides):
        base = {
            "model": "deepseek-flash",
            "input_tokens": 900,
            "cache_read_tokens": 0,
            "cache_write_tokens": 0,
            "output_tokens": 0,
            "reasoning_tokens": 0,
            "api_call_count": 3,
            "first_seen": epoch(2026, 10, 16, 20, 0),
            "last_seen": epoch(2026, 10, 16, 20, 0),
        }
        base.update(overrides)
        return base

    def test_single_day_row_yields_one_slice(self):
        pieces = ledger.day_slices(self.row())
        self.assertEqual(len(pieces), 1)
        self.assertEqual(pieces[0]["day"], "2026-10-16")
        self.assertEqual(pieces[0]["input_tokens"], 900)

    def test_cross_midnight_row_yields_two_days(self):
        # 22:00 -> 02:00 spans the 2026-10-16 / 10-17 boundary.
        pieces = ledger.day_slices(self.row(
            first_seen=epoch(2026, 10, 16, 22, 0),
            last_seen=epoch(2026, 10, 17, 2, 0),
        ))
        self.assertEqual([p["day"] for p in pieces], ["2026-10-16", "2026-10-17"])

    def test_token_split_sums_back_exactly(self):
        # 900 does not divide evenly by 4h/4h, so integer rounding must still
        # preserve the total.
        pieces = ledger.day_slices(self.row(
            input_tokens=901, output_tokens=333,
            first_seen=epoch(2026, 10, 16, 22, 0),
            last_seen=epoch(2026, 10, 17, 2, 0),
        ))
        self.assertEqual(sum(p["input_tokens"] for p in pieces), 901)
        self.assertEqual(sum(p["output_tokens"] for p in pieces), 333)

    def test_api_calls_are_not_double_counted(self):
        pieces = ledger.day_slices(self.row(
            first_seen=epoch(2026, 10, 16, 22, 0),
            last_seen=epoch(2026, 10, 17, 2, 0),
        ))
        self.assertEqual(sum(p["api_call_count"] for p in pieces), 3)

    def test_zero_length_row_keeps_its_tokens(self):
        pieces = ledger.day_slices(self.row(input_tokens=0, output_tokens=0))
        self.assertEqual(len(pieces), 1)


class AggregateUsageTests(unittest.TestCase):
    def row(self, **overrides):
        base = {
            "model": "deepseek-flash",
            "input_tokens": 1_000_000,
            "cache_read_tokens": 0,
            "cache_write_tokens": 0,
            "output_tokens": 0,
            "reasoning_tokens": 0,
            "api_call_count": 1,
            "first_seen": epoch(2026, 10, 16, 20, 0),
            "last_seen": epoch(2026, 10, 16, 20, 0),
        }
        base.update(overrides)
        return base

    def test_has_all_three_views(self):
        result = ledger.aggregate_usage([self.row()])
        self.assertIn("totals", result)
        self.assertIn("by_model", result)
        self.assertIn("by_day", result)

    def test_daily_costs_sum_to_grand_total(self):
        # The daily view must not quietly lose money relative to the total.
        rows = [
            self.row(),
            self.row(first_seen=epoch(2026, 10, 15, 10, 0), last_seen=epoch(2026, 10, 15, 10, 0)),
            self.row(first_seen=epoch(2026, 10, 16, 23, 0), last_seen=epoch(2026, 10, 17, 1, 0)),
        ]
        result = ledger.aggregate_usage(rows)
        daily = sum(Decimal(d["cost_cny"]) for d in result["by_day"])
        self.assertEqual(daily, Decimal(result["totals"]["cost_cny"]))

    def test_every_day_peak_plus_offpeak_equals_its_cost(self):
        # A day must not show a cost while its peak and off-peak parts are both
        # zero: that is what a rounding plug used to produce.
        rows = [
            self.row(),
            self.row(first_seen=epoch(2026, 10, 16, 23, 0), last_seen=epoch(2026, 10, 17, 1, 0)),
            self.row(first_seen=epoch(2026, 10, 15, 10, 0), last_seen=epoch(2026, 10, 15, 10, 0)),
        ]
        for day in ledger.aggregate_usage(rows)["by_day"]:
            self.assertEqual(
                Decimal(day["peak_cost_cny"]) + Decimal(day["off_peak_cost_cny"]),
                Decimal(day["cost_cny"]),
                msg=f"day {day['day']} does not add up",
            )

    def test_totals_peak_plus_offpeak_equals_cost(self):
        rows = [self.row(), self.row(first_seen=epoch(2026, 10, 16, 23, 0),
                                     last_seen=epoch(2026, 10, 17, 1, 0))]
        totals = ledger.aggregate_usage(rows)["totals"]
        self.assertEqual(
            Decimal(totals["peak_cost_cny"]) + Decimal(totals["off_peak_cost_cny"]),
            Decimal(totals["cost_cny"]),
        )

    def test_no_rounding_plug_key_is_emitted(self):
        # The plug was a symptom; the views are now derived from one sum.
        rows = [self.row(input_tokens=999983, first_seen=epoch(2026, 10, 16, 23, 0),
                         last_seen=epoch(2026, 10, 17, 1, 0))]
        self.assertNotIn("rounding_plug_cny", ledger.aggregate_usage(rows))

    def test_daily_costs_sum_exactly_with_many_rows(self):
        # 508 real rows used to drift; synthetic volume must stay exact too.
        rows = [
            self.row(input_tokens=123457, output_tokens=987,
                     first_seen=epoch(2026, 10, 10 + (i % 6), 22, 0),
                     last_seen=epoch(2026, 10, 11 + (i % 6), 3, 0))
            for i in range(40)
        ]
        result = ledger.aggregate_usage(rows)
        daily = sum(Decimal(d["cost_cny"]) for d in result["by_day"])
        self.assertEqual(daily, Decimal(result["totals"]["cost_cny"]))

    def test_cross_midnight_row_appears_on_both_days(self):
        result = ledger.aggregate_usage([self.row(
            first_seen=epoch(2026, 10, 16, 23, 0),
            last_seen=epoch(2026, 10, 17, 1, 0),
        )])
        self.assertEqual([d["day"] for d in result["by_day"]], ["2026-10-17", "2026-10-16"])

    def test_entries_carry_model_and_time(self):
        result = ledger.aggregate_usage([self.row()])
        entry = result["by_day"][0]["entries"][0]
        self.assertEqual(entry["model"], "deepseek-flash")
        self.assertEqual(entry["at"], "20:00:00")

    def test_by_day_is_newest_first(self):
        result = ledger.aggregate_usage([
            self.row(first_seen=epoch(2026, 10, 14, 12, 0), last_seen=epoch(2026, 10, 14, 12, 0)),
            self.row(first_seen=epoch(2026, 10, 16, 12, 0), last_seen=epoch(2026, 10, 16, 12, 0)),
        ])
        self.assertEqual([d["day"] for d in result["by_day"]], ["2026-10-16", "2026-10-14"])


if __name__ == "__main__":
    unittest.main()
