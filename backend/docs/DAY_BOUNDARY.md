# FRWHOOP day-boundary contract

## Timestamps

Raw sensor timestamps are UTC instants.

Session `start_at` / `end_at` are absolute UTC.

## Physiological day

A FRWHOOP **day** is the calendar date in the user's IANA timezone on which
the main overnight sleep episode **ended** (local wake date).

When no sleep episode exists, the day is the local calendar date of the
request instant.

This is **not** a 16:00–16:00 WHOOP cycle. Local midnight is the range bound
for snapshots and physiology buckets. Sleep association uses wake date.

## Stored day fields

`daily_metrics` stores:

- `day` — `YYYY-MM-DD` physiological day key
- `day_start_at` — UTC instant of local midnight at the start of `day`
- `day_end_at` — UTC instant of the next local midnight
- `timezone_name` — IANA zone used when the row was computed
- `timezone_offset_seconds` — offset at `day_start_at`

Travel: historical rows keep the timezone they were stored with. New
computations use the profile timezone at compute time.

DST: `day_start_at` → `day_end_at` is 23, 24, or 25 hours depending on the
local transition. Implementation: `backend/time/dayBoundary.js`.

## Frontend queries

- `get_day_snapshot(day)` / `get_days(from, to)` / `GET /api/days/snapshot?day=` use IANA local midnight bounds for sessions, events, and sleep attribution.
- Sleep rows are attributed by `local_calendar_date(wake_at, timezone)`.
- `get_range(from, to)` returns compact daily projections keyed by stored `daily_metrics.day`.

Postgres implements the same bounds as JS:

```sql
(p_day::timestamp AT TIME ZONE tz)
((p_day + 1)::timestamp AT TIME ZONE tz)
```

See `public.day_bounds` and `backend/time/dayBoundary.js`. Chicago 2026-03-08 is 23 hours; 2026-11-01 is 25 hours.
