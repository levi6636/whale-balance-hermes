"""Ledger kernel for the whale widget: peak/off-peak pricing + observed account.

Pure functions only (no I/O, no clock reads): every entry point takes the values
it must depend on, so the tests can pin a timestamp and get a deterministic
answer. The router in ``plugin_api.py`` is the only place that talks to SQLite
and ``usage_pricing``.

Why the pricing here is re-derived instead of trusting Hermes' stored
``estimated_cost_usd``: that column is computed from the off-peak snapshot rates
and never multiplied by the peak factor (verified on this machine: ratio to the
off-peak recomputation is exactly 1.000 on every settled row, including rows
whose last_seen falls inside a peak window). Charging peak tokens at off-peak
prices understates real spend, so the ledger recomputes from raw tokens.
"""

from __future__ import annotations

import datetime as _dt
from decimal import Decimal, ROUND_HALF_UP

# DeepSeek published pricing, CNY per 1M tokens, [off-peak, peak].
# Source: MeteorNOX/dsh-whale-widget README § 定价表 and D:/hermes/notes/llm-pricing-2026.md.
# The upstream table is the authority for *what DeepSeek charges*; Hermes' own
# snapshot (agent/usage_pricing.py) is USD and off-peak only, so it cannot be
# used to price a peak window.
PRICING_CNY = {
    # User-provided local prices, CNY per 1M tokens, [off-peak, peak].
    "gpt-6.1-sol": {"cache": ("0.02", "0.04"), "input": ("0.4", "0.8"), "output": ("2", "4")},
    "gpt-6-luna": {"cache": ("0.002", "0.004"), "input": ("0.02", "0.04"), "output": ("0.1", "0.2")},
    "claude-haiku-5-5": {"cache": ("0.01", "0.02"), "input": ("0.15", "0.30"), "output": ("0.75", "1.50")},
    "deepseek-flash": {"cache": ("0.02", "0.04"), "input": ("1", "2"), "output": ("4", "8")},
    "deepseek-v4-flash": {"cache": ("0.02", "0.04"), "input": ("1", "2"), "output": ("4", "8")},
    "deepseek-v4-flash-vision-exp": {"cache": ("0.02", "0.04"), "input": ("1", "2"), "output": ("4", "8")},
    "deepseek-chat": {"cache": ("0.02", "0.04"), "input": ("1", "2"), "output": ("4", "8")},
    "deepseek-reasoner": {"cache": ("0.02", "0.04"), "input": ("1", "2"), "output": ("4", "8")},
    "deepseek-v4-pro": {"cache": ("0.15", "0.30"), "input": ("4.5", "9.0"), "output": ("13.5", "27.0")},

    # Public vendor list prices converted at USD/CNY 6.687 (2026-10-17), CNY per
    # 1M tokens. Both columns are equal on purpose: these vendors publish no
    # peak premium, so applying the DeepSeek 2x peak rule would invent money.
    # These are reference rates for models reached through relays/Antigravity,
    # not a receipt of what the current channel bills.
    "claude-sonnet-4-6": {"cache": ("2.0061", "2.0061"), "input": ("20.061", "20.061"), "output": ("100.305", "100.305")},
    "glm-5.3-flash": {"cache": ("0.20061", "0.20061"), "input": ("1.00305", "1.00305"), "output": ("3.3435", "3.3435")},
    "glm-5.3-flashx": {"cache": ("0.501525", "0.501525"), "input": ("2.47419", "2.47419"), "output": ("8.35875", "8.35875")},
    "glm-4-flash": {"cache": ("0", "0"), "input": ("0", "0"), "output": ("0", "0")},
    "gemini-3.8-flash-tiered": {"cache": ("0.501525", "0.501525"), "input": ("5.01525", "5.01525"), "output": ("25.07625", "25.07625")},
    "gemini-3.7-flash-tiered": {"cache": ("0.501525", "0.501525"), "input": ("5.01525", "5.01525"), "output": ("25.07625", "25.07625")},
    "gemini-3.6-flash-low": {"cache": ("0.501525", "0.501525"), "input": ("5.01525", "5.01525"), "output": ("25.07625", "25.07625")},
    "gemini-3.5-flash-lite": {"cache": ("0.20061", "0.20061"), "input": ("2.0061", "2.0061"), "output": ("16.7175", "16.7175")},
    "gemini-3-flash": {"cache": ("0.33435", "0.33435"), "input": ("3.3435", "3.3435"), "output": ("20.061", "20.061")},
}

# Where each non-DeepSeek rate row came from. The UI shows this instead of
# pretending every row is an invoice: "user" is Levi's own price sheet,
# "public-list" is a vendor list price converted at a fixed FX, "estimate" is a
# list price standing in for a routing alias that publishes none.
PRICE_SOURCES = {
    "gpt-6.1-sol": "user",
    "gpt-6-luna": "user",
    "claude-haiku-5-5": "user",
    "claude-sonnet-4-6": "public-list",
    "glm-5.3-flash": "public-list",
    "glm-5.3-flashx": "public-list",
    "glm-4-flash": "public-list",
    "gemini-3.5-flash-lite": "public-list",
    "gemini-3-flash": "public-list",
    "gemini-3.8-flash-tiered": "estimate",
    "gemini-3.7-flash-tiered": "estimate",
    "gemini-3.6-flash-low": "estimate",
}

# Weekend-all-off-peak took effect on this local date (upstream 0.3.x).
WEEKEND_OFF_PEAK_SINCE = _dt.date(2026, 8, 23)

# Peak windows in *local* (Asia/Shanghai) wall-clock time, half-open [start, end).
PEAK_WINDOWS = ((9, 12), (14, 18))

LOCAL_TZ = _dt.timezone(_dt.timedelta(hours=8), "Asia/Shanghai")

EIGHT = Decimal("0.00000001")


def money(value):
    """Quantise to 8 decimals and render as plain fixed point.

    ``quantize`` alone is not enough: ``Decimal("-2.5E-7").quantize(EIGHT)``
    comes back as ``-2.5E-7``, which is still scientific notation and would
    reach the UI verbatim. ``format(..., "f")`` is what forces digits.
    ``Decimal(0)`` would otherwise render as ``0E-8``.
    """

    if value == 0:
        return "0.00000000"
    return format(value.quantize(EIGHT, rounding=ROUND_HALF_UP), "f")


def to_local(epoch_seconds):
    """UTC epoch -> aware datetime in the widget's reference timezone."""

    return _dt.datetime.fromtimestamp(float(epoch_seconds), tz=LOCAL_TZ)


def is_weekend_only(starting):
    """True when the weekend-off-peak rule was already in force on ``starting``.

    A ``starting`` before the cut-over keeps the old behaviour (peak applies on
    weekends) so historical days are not retro-priced against a rule that did
    not exist yet.
    """

    return starting.date() >= WEEKEND_OFF_PEAK_SINCE


def is_peak(moment, *, weekend_off_peak=True):
    """Whether ``moment`` falls in a peak billing window.

    ``moment`` must be tz-aware; a naive datetime is interpreted as local time,
    which is what the callers derive from epoch seconds anyway.
    """

    if moment.tzinfo is None:
        moment = moment.replace(tzinfo=LOCAL_TZ)
    else:
        moment = moment.astimezone(LOCAL_TZ)

    # Saturday/Sunday are off-peak all day once the rule is in force.
    if weekend_off_peak and moment.weekday() >= 5:
        return False

    for start_hour, end_hour in PEAK_WINDOWS:
        start = moment.replace(hour=start_hour, minute=0, second=0, microsecond=0)
        end = moment.replace(hour=end_hour, minute=0, second=0, microsecond=0)
        if start <= moment < end:
            return True
    return False


def next_boundary(moment, *, weekend_off_peak=None):
    """The next instant at which :func:`is_peak` actually changes state.

    Weekend awareness matters for the countdown: on a Saturday the peak windows
    come and go without the rate ever changing, so returning 12:00 would tell
    the user "peak in 2 hours" on a day that is off-peak throughout. The real
    answer there is Monday 09:00. ``weekend_off_peak`` defaults to the rule in
    force at ``moment``.
    """

    if moment.tzinfo is None:
        moment = moment.replace(tzinfo=LOCAL_TZ)
    else:
        moment = moment.astimezone(LOCAL_TZ)

    if weekend_off_peak is None:
        weekend_off_peak = is_weekend_only(moment)

    current = is_peak(moment, weekend_off_peak=weekend_off_peak)

    candidates = []
    for day_offset in range(0, 9):
        base = (moment + _dt.timedelta(days=day_offset)).replace(
            hour=0, minute=0, second=0, microsecond=0
        )
        # Midnight is a candidate because the weekend rule flips there.
        candidates.append(base)
        for start_hour, end_hour in PEAK_WINDOWS:
            candidates.append(base.replace(hour=start_hour))
            candidates.append(base.replace(hour=end_hour))

    for candidate in sorted(set(candidates)):
        if candidate <= moment:
            continue
        if is_peak(candidate, weekend_off_peak=weekend_off_peak) != current:
            return candidate

    return moment + _dt.timedelta(days=1)


def _interval_bounds(first_seen, last_seen):
    """Coerce a usage row's seen-range into a pair of aware local datetimes."""

    start = to_local(first_seen)
    end = to_local(last_seen) if last_seen and last_seen > first_seen else start
    return start, end


def _peak_seconds(start, end):
    """Seconds of ``[start, end)`` billed at peak, walking window boundaries."""

    if end <= start:
        return 0.0

    peak_seconds = 0.0
    cursor = start
    guard = 0
    while cursor < end and guard < 100_000:
        guard += 1
        boundary = next_boundary(cursor)
        segment_end = min(boundary, end)
        if is_peak(cursor, weekend_off_peak=is_weekend_only(cursor)):
            peak_seconds += (segment_end - cursor).total_seconds()
        cursor = segment_end
    return peak_seconds


def second_split(start, end):
    """``(peak_seconds, off_peak_seconds)`` for an aware-datetime interval.

    This is the primitive every cost calculation is built on: a token total is
    apportioned by seconds, so a row that straddles a window boundary pays the
    peak rate only for the peak part. Using one primitive for both the whole
    row and its per-day slices keeps the two views summing to the same money.
    """

    total = max(0.0, (end - start).total_seconds())
    if total <= 0:
        # A zero-length interval is a single instant: give it one unit of
        # weight at that instant's rate, otherwise the token total would
        # silently vanish from every view.
        hit = is_peak(start, weekend_off_peak=is_weekend_only(start))
        return (1.0, 0.0) if hit else (0.0, 1.0)
    peak = _peak_seconds(start, end)
    return peak, total - peak


def peak_fraction(first_seen, last_seen):
    """Share of the ``[first_seen, last_seen)`` interval that bills at peak.

    ``session_model_usage`` stores one row per (session, model, route) with a
    token total that grew over ``[first_seen, last_seen]``. There is no
    per-call timestamp, so the interval is the only defensible basis for
    apportioning: assume the tokens accrued uniformly, then weight by how much
    of the wall-clock window was peak. A zero-length interval is a single
    instant and takes that instant's rate.

    Returns ``(fraction, classification)`` where classification is one of
    ``peak`` / ``off_peak`` / ``mixed``.
    """

    start, end = _interval_bounds(first_seen, last_seen)

    if end == start:
        hit = is_peak(start, weekend_off_peak=is_weekend_only(start))
        return (Decimal(1) if hit else Decimal(0)), ("peak" if hit else "off_peak")

    total = (end - start).total_seconds()
    peak_seconds = _peak_seconds(start, end)

    fraction = Decimal(str(peak_seconds / total))
    if fraction <= 0:
        return Decimal(0), "off_peak"
    if fraction >= 1:
        return Decimal(1), "peak"
    return fraction, "mixed"


def price_source_for(model, priced):
    """Provenance label for one model's rate row: user / public-list / estimate.

    DeepSeek rows come from the upstream price table, everything else says
    where its number came from so the UI never presents a converted public list
    price as if it were a receipt.
    """

    key = str(model or "").strip().lower()
    if key in PRICE_SOURCES:
        return PRICE_SOURCES[key]
    return "deepseek-list" if priced else "unpriced"


def _rates_for(model):
    """Rate row for ``model``, or ``None`` when the model has no known pricing."""

    key = str(model or "").strip().lower()
    if key in PRICING_CNY:
        return PRICING_CNY[key]
    # Sub-provider ids like ``deepseek-ai/deepseek-v4.1-flash`` keep the tail.
    if "/" in key:
        tail = key.rsplit("/", 1)[-1]
        if tail in PRICING_CNY:
            return PRICING_CNY[tail]
    # ``deepseek-v4.1-flash`` -> the pageless flash family.
    if key.startswith("deepseek") and "pro" not in key:
        return PRICING_CNY["deepseek-flash"]
    return None


def row_cost_cny(row):
    """Itemised CNY cost for one usage row, split by peak and off-peak.

    ``row`` needs ``model``, ``input_tokens``, ``cache_read_tokens``,
    ``cache_write_tokens``, ``output_tokens``, ``first_seen``, ``last_seen``.

    Cache writes are charged at the miss rate (DeepSeek bills cache creation as
    normal input). Reasoning tokens are already inside ``output_tokens`` in the
    DeepSeek accounting, so they are NOT added again.

    Returns a dict with ``known`` False when the model has no price row; the
    caller must then exclude the row from totals rather than treating it as
    free.
    """

    model = row.get("model")
    rates = _rates_for(model)
    if rates is None:
        return {
            "known": False,
            "model": model,
            "peak_fraction": None,
            "peak_cost_cny": Decimal(0),
            "off_peak_cost_cny": Decimal(0),
            "cost_cny": Decimal(0),
            "classification": "unpriced",
        }

    fraction, classification = peak_fraction(row.get("first_seen"), row.get("last_seen"))

    def per_million(kind, index):
        return Decimal(rates[kind][index]) / Decimal(1_000_000)

    cache_read = int(row.get("cache_read_tokens") or 0)
    cache_write = int(row.get("cache_write_tokens") or 0)
    input_miss = int(row.get("input_tokens") or 0)
    output = int(row.get("output_tokens") or 0)

    def cost_at(index):
        return (
            cache_read * per_million("cache", index)
            + cache_write * per_million("input", index)
            + input_miss * per_million("input", index)
            + output * per_million("output", index)
        )

    peak_cost = cost_at(1) * fraction
    off_peak_cost = cost_at(0) * (Decimal(1) - fraction)

    # Quantise the two halves *first* and make the row cost their sum. The
    # other order (quantise the sum of unrounded halves) is off by 1e-8 in a
    # way that breaks "peak + off-peak = cost" once both sides are added up
    # across a bucket, which is visible in the UI.
    peak_part = peak_cost.quantize(EIGHT, rounding=ROUND_HALF_UP)
    off_part = off_peak_cost.quantize(EIGHT, rounding=ROUND_HALF_UP)

    return {
        "known": True,
        "model": model,
        "peak_fraction": fraction,
        "peak_cost_cny": peak_part,
        "off_peak_cost_cny": off_part,
        "cost_cny": peak_part + off_part,
        "classification": classification,
    }


def aggregate(rows, *, since=None, until=None):
    """Sum a list of usage rows into the shape the widget renders.

    Rows outside ``[since, until)`` (epoch seconds, by ``last_seen``) are
    skipped; ``None`` means unbounded on that side. Unpriced models are counted
    separately so the UI can say "N models without a price row" instead of
    quietly under-reporting.
    """

    totals = {
        "cost_cny": Decimal(0),
        "peak_cost_cny": Decimal(0),
        "off_peak_cost_cny": Decimal(0),
        "input_tokens": 0,
        "cache_read_tokens": 0,
        "cache_write_tokens": 0,
        "output_tokens": 0,
        "reasoning_tokens": 0,
        "api_calls": 0,
        "rows": 0,
    }
    by_model = {}
    unpriced = {}

    for row in rows:
        last_seen = row.get("last_seen")
        if since is not None and (last_seen is None or last_seen < since):
            continue
        if until is not None and last_seen is not None and last_seen >= until:
            continue

        item = row_cost_cny(row)
        model = str(row.get("model") or "")

        bucket = by_model.get(model)
        if bucket is None:
            bucket = by_model[model] = {
                "model": model,
                "cost_cny": Decimal(0),
                "peak_cost_cny": Decimal(0),
                "off_peak_cost_cny": Decimal(0),
                "input_tokens": 0,
                "cache_read_tokens": 0,
                "cache_write_tokens": 0,
                "output_tokens": 0,
                "reasoning_tokens": 0,
                "rows": 0,
                "priced": item["known"],
                "price_source": price_source_for(model, item["known"]),
            }

        for key in ("input_tokens", "cache_read_tokens", "cache_write_tokens",
                    "output_tokens", "reasoning_tokens"):
            value = int(row.get(key) or 0)
            totals[key] += value
            bucket[key] += value
        totals["api_calls"] += int(row.get("api_call_count") or 0)
        totals["rows"] += 1
        bucket["rows"] += 1

        if item["known"]:
            totals["cost_cny"] += item["cost_cny"]
            totals["peak_cost_cny"] += item["peak_cost_cny"]
            totals["off_peak_cost_cny"] += item["off_peak_cost_cny"]
            bucket["cost_cny"] += item["cost_cny"]
            bucket["peak_cost_cny"] += item["peak_cost_cny"]
            bucket["off_peak_cost_cny"] += item["off_peak_cost_cny"]
        else:
            unpriced[model] = unpriced.get(model, 0) + 1

    return {
        "totals": _jsonable(totals),
        "by_model": [_jsonable(v) for v in sorted(
            by_model.values(), key=lambda x: x["cost_cny"], reverse=True
        )],
        "unpriced_models": unpriced,
    }


def day_slices(row):
    """Split one usage row into per-local-day slices of its token totals.

    A row's tokens accrued over ``[first_seen, last_seen]``; splitting by the
    same seconds primitive used for peak/off-peak keeps the daily view and the
    row total consistent to the last decimal. Each slice carries the row's
    identity so the UI can show model + time per entry.

    Returns a list of dicts shaped like a usage row, one per touched day.
    """

    start, end = _interval_bounds(row.get("first_seen"), row.get("last_seen"))
    total = (end - start).total_seconds()

    base = {
        "model": row.get("model"),
        "api_call_count": int(row.get("api_call_count") or 0),
        "input_tokens": int(row.get("input_tokens") or 0),
        "cache_read_tokens": int(row.get("cache_read_tokens") or 0),
        "cache_write_tokens": int(row.get("cache_write_tokens") or 0),
        "output_tokens": int(row.get("output_tokens") or 0),
        "reasoning_tokens": int(row.get("reasoning_tokens") or 0),
    }

    if total <= 0:
        # Single instant: one slice on that day, all tokens intact.
        day = start.replace(hour=0, minute=0, second=0, microsecond=0)
        return [dict(base, first_seen=start.timestamp(), last_seen=end.timestamp(),
                     day=day.date().isoformat(), _weight=1.0)]

    slices = []
    cursor = start
    guard = 0
    while cursor < end and guard < 100_000:
        guard += 1
        day_end = cursor.replace(hour=0, minute=0, second=0, microsecond=0) + _dt.timedelta(days=1)
        segment_end = min(day_end, end)
        weight = (segment_end - cursor).total_seconds() / total
        slices.append(dict(
            base,
            first_seen=cursor.timestamp(),
            last_seen=segment_end.timestamp(),
            day=cursor.date().isoformat(),
            _weight=weight,
        ))
        cursor = segment_end

    if not slices:
        day = start.replace(hour=0, minute=0, second=0, microsecond=0)
        return [dict(base, first_seen=start.timestamp(), last_seen=end.timestamp(),
                     day=day.date().isoformat(), _weight=1.0)]

    # Distribute the integer token counts so the slices sum back to the row
    # exactly; naive float multiplication loses tokens to rounding.
    for key in ("input_tokens", "cache_read_tokens", "cache_write_tokens",
                "output_tokens", "reasoning_tokens"):
        whole = base[key]
        if whole == 0:
            for item in slices:
                item[key] = 0
            continue
        running = 0
        for index, item in enumerate(slices):
            if index == len(slices) - 1:
                item[key] = whole - running
            else:
                item[key] = int(round(whole * item["_weight"]))
                running += item[key]

    # The calls happened once; attribute them to the slice that holds the
    # row's midpoint so per-day call counts do not double.
    midpoint = start + (end - start) / 2
    holder = min(slices, key=lambda s: abs(s["first_seen"] - midpoint.timestamp()))
    for item in slices:
        item["api_call_count"] = base["api_call_count"] if item is holder else 0

    return slices


def aggregate_usage(rows, *, since=None, until=None):
    """Aggregate rows into totals, per-model and per-day views.

    All three views are summed from the *same* per-slice costs, so they agree
    to the last decimal by construction. An earlier version summed the grand
    total from whole rows and the days from slices, which drifted by ~1e-7 and
    needed a rounding plug -- a balancing line can make a day's cost positive
    while its peak and off-peak parts are both zero, which reads as a bug. One
    source, no plug.

    Only rows whose window touches ``[since, until)`` are considered. A row is
    included whole (never clipped) because the DB gives no per-day token
    breakdown; clipping would invent tokens.
    """

    totals = {
        "cost_cny": Decimal(0),
        "peak_cost_cny": Decimal(0),
        "off_peak_cost_cny": Decimal(0),
        "input_tokens": 0,
        "cache_read_tokens": 0,
        "cache_write_tokens": 0,
        "output_tokens": 0,
        "reasoning_tokens": 0,
        "api_calls": 0,
        "rows": 0,
    }
    days = {}
    by_model = {}
    unpriced = {}

    for row in rows:
        last_seen = row.get("last_seen")
        if since is not None and (last_seen is None or last_seen < since):
            continue
        if until is not None and last_seen is not None and last_seen >= until:
            continue

        model = str(row.get("model") or "")
        totals["rows"] += 1
        totals["api_calls"] += int(row.get("api_call_count") or 0)

        bucket = by_model.get(model)
        if bucket is None:
            bucket = by_model[model] = {
                "model": model,
                "cost_cny": Decimal(0),
                "peak_cost_cny": Decimal(0),
                "off_peak_cost_cny": Decimal(0),
                "input_tokens": 0,
                "cache_read_tokens": 0,
                "cache_write_tokens": 0,
                "output_tokens": 0,
                "reasoning_tokens": 0,
                "rows": 0,
            }

        for key in ("input_tokens", "cache_read_tokens", "cache_write_tokens",
                    "output_tokens", "reasoning_tokens"):
            value = int(row.get(key) or 0)
            totals[key] += value
            bucket[key] += value
        bucket["rows"] += 1

        priced_any = False
        for piece in day_slices(row):
            item = row_cost_cny(piece)
            day = piece["day"]

            day_bucket = days.get(day)
            if day_bucket is None:
                day_bucket = days[day] = {
                    "day": day,
                    "cost_cny": Decimal(0),
                    "peak_cost_cny": Decimal(0),
                    "off_peak_cost_cny": Decimal(0),
                    "input_tokens": 0,
                    "cache_read_tokens": 0,
                    "cache_write_tokens": 0,
                    "output_tokens": 0,
                    "reasoning_tokens": 0,
                    "api_calls": 0,
                    "entries": [],
                }
            for key in ("input_tokens", "cache_read_tokens", "cache_write_tokens",
                        "output_tokens", "reasoning_tokens"):
                day_bucket[key] += piece[key]
            day_bucket["api_calls"] += piece["api_call_count"]

            if item["known"]:
                priced_any = True
                for target, key in ((totals, "cost_cny"), (bucket, "cost_cny"), (day_bucket, "cost_cny")):
                    target[key] += item["cost_cny"]
                for target in (totals, bucket, day_bucket):
                    target["peak_cost_cny"] += item["peak_cost_cny"]
                    target["off_peak_cost_cny"] += item["off_peak_cost_cny"]

            day_bucket["entries"].append({
                "model": piece["model"],
                "at": to_local(piece["first_seen"]).strftime("%H:%M:%S"),
                "cost_cny": money(item["cost_cny"]) if item["known"] else None,
                "peak_fraction": str(item["peak_fraction"]) if item["peak_fraction"] is not None else None,
                "known": item["known"],
            })

        if not priced_any:
            unpriced[model] = unpriced.get(model, 0) + 1

    for model, bucket in by_model.items():
        bucket["priced"] = model not in unpriced
        bucket["price_source"] = price_source_for(model, bucket["priced"])

    return {
        "totals": _jsonable(totals),
        "by_model": [_jsonable(v) for v in sorted(
            by_model.values(), key=lambda x: x["cost_cny"], reverse=True
        )],
        "by_day": [
            _jsonable(bucket) for bucket in sorted(days.values(), key=lambda x: x["day"], reverse=True)
        ],
        "unpriced_models": unpriced,
    }


def _jsonable(mapping):
    """Decimal -> str so the payload survives JSON without float drift.

    Recurses into dicts and lists: ``by_day`` buckets carry an ``entries`` list
    whose items hold Decimals, and a Decimal that leaks into the response would
    fail FastAPI's encoder.
    """

    out = {}
    for key, value in mapping.items():
        out[key] = _plain(value)
    return out


def _plain(value):
    """Convert one value, recursing through containers."""

    if isinstance(value, Decimal):
        # ``Decimal(0).quantize(8dp)`` stringifies as ``0E-8``; the UI needs
        # a plain fixed-point zero, so normalise that one case explicitly.
        return money(value)
    if isinstance(value, dict):
        return {k: _plain(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [_plain(v) for v in value]
    return value
