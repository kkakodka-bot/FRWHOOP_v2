# Energy expenditure — architecture

How calories get from a BLE packet to a number on the phone. The model itself is in
[`ENERGY_MODEL.md`](./ENERGY_MODEL.md); measured accuracy is in
[`ENERGY_EVALUATION.md`](./ENERGY_EVALUATION.md).

## 1. Data flow

```
WHOOP strap
  │  BLE (existing noop decoder — untouched)
  ▼
POST /api/ble/live                          host/routes.js
  │  { datetime, bpm, rr_ms, sleep_stage, motion, … }
  ├──────────────► workout detector          metrics/workoutDetector.js
  ▼
createHourBuffer().append()                  ingest/hourBuffer.js
  │  in-memory ring + per-day NDJSON on local disk
  ▼  hourly flush (or forced flush on shutdown)
  ├──► encodeArchive() ──► gzip NDJSON ──► Backblaze B2   storage/s3.js
  │                                    └──► object_manifests row (sha256, counts)
  ▼
metricsEngine.persistComputed()              metrics/engine.js
  ├──► buckets / sleep / physiology series    (pre-existing)
  └──► computeEnergy()                        energy/service.js
         ├─ resolvePhysiology()               energy/physiology.js
         ├─ minuteFeatures() + signalQuality()energy/features.js
         ├─ classifyActivity()                energy/activity.js
         ├─ routeEstimate()                   energy/estimators.js
         └─ aggregateDay/Workouts()           energy/engine.js
  ▼
db.upsertPayload({ energy_minutes })         metrics/repository.js
  │  routed through the RPC, never a bare table write
  ▼
engine_ingest_energy(p_secret, p_payload)    Postgres, one transaction
  ├─ upsert energy_minutes
  ├─ energy_rollup_day()      → energy_daily
  └─ energy_rollup_workout()  → energy_workouts
  ▼
get_energy_day / _range / _workout           SECURITY INVOKER, RLS applies
  ▼
GET /api/energy/{day,range,workout/:id}      energy/routes.js
  ▼
lib/energyReads.js → useEnergy.js → EnergyCards.jsx
```

Nothing in this chain requires the phone to stay open. The hour buffer persists to local
disk on every append and flushes on a timer, so a killed app or a dead battery costs at
most the unflushed tail, which the next flush picks up.

## 2. What was reused rather than rebuilt

The audit's central conclusion was that most of this pipeline already existed. Reused
unchanged: the BLE decoder, `/api/ble/live` ingress, the hour buffer, the B2 client and
key builder, `object_manifests`, the sync queue with its retry/offline semantics,
`upsertPayload`, the metric engine's flush hook, the workout detector and its `sessions`
rows, `resolveHrMax`, `uthVo2Max`, and `resolveWeightKg`.

Reusing `resolveHrMax` and `resolveWeightKg` in particular is load-bearing: the energy
model and the VO₂ max model now agree on this subject's HRmax and weight, rather than
each resolving them separately and disagreeing on the two most important inputs either of
them has.

Genuinely new: the `energy/*` modules, five Supabase tables, four RPCs, three HTTP routes,
and the frontend cards.

### One pre-existing bug had to be fixed first

`hourBuffer.append()` built an allow-list row that omitted `motion`, so the motion scalar
reached the workout detector but never reached B2. A motion-aware model built on a channel
that is not archived is unreproducible by construction, so `motion` (and `sleep_stage`)
were added to the archive schema, and `ARCHIVE_SCHEMA_VERSION` was bumped. Archives
written before that bump have no motion channel and will recompute HR-only — this is
recorded per-row in `quality_flags`, not hidden.

## 3. Storage split

| Where | What | Why |
|---|---|---|
| Backblaze B2 | hourly gzip NDJSON of raw samples | high-frequency, immutable, cheap; the only thing that makes recomputation possible |
| Postgres `energy_minutes` | one row per minute per user | the smallest unit anything queries; ~1440 rows/user/day |
| Postgres `energy_daily` / `energy_workouts` | rollups | recomputed from minutes, never incremented |
| Postgres `energy_model_versions` | one row per shipped model | reproducibility |
| Postgres `energy_user_calibration` | per-user parameters | personalization, versioned |

B2 object layout is inherited, not invented:

```
v3/{retention_class}/users/{uid}/devices/{did}/{stream}/{yyyy}/{mm}/{dd}/{hh}/{objectId}.ndjson.gz
```

Every object has an `object_manifests` row carrying `sha256`, `sample_count`, and byte
counts, and `reconcileObjects()` already verifies manifest-against-bucket on a timer. No
new bucket, prefix scheme, or reconciliation job was added.

## 4. Aggregates are recomputed, never incremented

`energy_rollup_day()` deletes nothing and counts nothing incrementally — it re-aggregates
that day's minute rows and upserts the result. The same for `energy_rollup_workout()`. The
consequence is that late-arriving data, a corrected workout, a re-uploaded batch, and a
model rerun all converge on the same answer without a repair job, because there is no
counter that can drift.

`energy_minutes.total_kcal` is a **generated column** (`resting_kcal + active_kcal`). The
writer cannot send a total, so a row where the parts disagree with the whole is not
representable. This is asserted in `tests/energyE2E.test.js`.

### No double counting, by construction

`workout_kcal` is defined as the subset of `active_kcal` on minutes whose
`workout_session_id` is non-null. It is a *filter over the same column*, not a third
quantity, so `total = resting + active` holds whether or not a workout happened.
Phase 7's semantics are enforced by the schema rather than by discipline.

## 5. Idempotency and ordering

- **Minute identity** is `(user_id, minute_at)`, a unique constraint. A re-upload upserts
  the same rows.
- **Determinism**: `computeEnergy` is a pure function of `(samples, physiology, workouts,
  timeZone)`. Two runs over the same input produce byte-identical RPC arguments, asserted
  in `tests/energyE2E.test.js`.
- **Out-of-order batches** converge, because each minute is derived only from its own
  samples plus a bounded backward-looking context window.
- **Gaps stay gaps.** A disconnected hour produces *no rows*, not zero-valued rows.
  `energy_daily.gap_minutes` records the shortfall and `projected_total_kcal` carries the
  resting-rate extrapolation, kept in a separate column so `total_kcal` remains
  measurement-only.

## 6. Timezones

Day assignment uses `localDateKey` from the existing `time/dayBoundary.js`, which resolves
via the IANA zone on the profile. A DST spring-forward day is 23 local hours and a
fall-back day is 25, and each minute lands in exactly one local day either way — both
cases are tested. `energy_daily` stores `timezone_name` alongside the date so a historical
row is interpretable after the user moves.

## 7. Provisional vs confirmed

The backend is authoritative, but its authority arrives on an hourly flush, which is too
slow for a screen the user is looking at during a workout.

| State | Source | Meaning |
|---|---|---|
| `confirmed` | `get_energy_day` | rollup over minutes already archived and persisted |
| `mixed` | confirmed + local tail | a past-and-present day: confirmed body, live tail |
| `provisional` | same engine, live buffer | real estimate, not yet archived |
| `empty` | — | no coverage |

The provisional path runs the **same engine over the same samples** — it is not a
simplified phone-side approximation. So when the confirmed value lands it agrees to within
rounding, and the UI does not jump. `state` is returned on every response so the client
never has to guess.

## 8. API

| Endpoint | Returns |
|---|---|
| `GET /api/energy/day?day=YYYY-MM-DD` | daily totals, 15-minute buckets, workouts, live rate |
| `GET /api/energy/range?window=7d\|30d\|3m\|6m\|1y` | daily totals only |
| `GET /api/energy/workout/:id` | one session's energy |

A day is 1440 minutes but a phone chart is a few hundred pixels wide, so the day endpoint
returns 96 fifteen-minute buckets. Minute rows are never shipped to the client, and B2
objects are never exposed.

Reads go through `SECURITY INVOKER` RPCs called with **the caller's own JWT**, not the
service role. RLS therefore remains the enforcement boundary: a bug in a route handler
cannot leak another user's rows, because Postgres would refuse to return them. The service
role is used only on the ingest path, only inside the backend.

## 9. Security

- RLS on all five tables: `user_id = auth.uid()` for select; writes only via RPC.
- `engine_ingest_energy` is `SECURITY DEFINER` and asserts the shared ingest secret before
  touching a row.
- `workout_session_id` is resolved through `sessions` with an ownership check rather than
  trusted from the payload. This drops a tag whose session does not exist — manually
  created activities never get a `sessions` row, and a raw insert would fail the whole
  batch on the foreign key — and prevents a caller attributing its minutes to another
  user's session.
- Identity always comes from the session, never from a query parameter. Tested.
- Route inputs are validated before any work: a malformed date is a 400, not a silent
  substitution of today; a non-UUID session id is a 400, not a forwarded cast.
- Service-role keys and B2 credentials stay server-side. The client only ever sees
  `/api/energy/*`.

## 10. Performance

Per minute of wall-clock data the engine does a fixed amount of arithmetic — no model
inference, no allocation-heavy feature vectors, no per-sample neural evaluation. Measured
on the 179-day evaluation dataset: **248,710 minutes in ~16 s**, about 15,500 minutes/s
single-threaded, so a user-day costs roughly 90 ms and is dominated by JSON parsing.

Write volume per user-day: 1440 minute rows, 1 daily row, one row per workout. The RPC
sends minutes in a single JSONB payload, one round trip per flush.

The one deliberate ceiling: the offline `/api/energy/range` fallback recomputes from raw
samples and is capped at 62 days, because an uncapped year would be a multi-second
request. Longer windows require Supabase, which is what the confirmed path is for.

## 11. Files

| Path | Role |
|---|---|
| `energy/constants.js` | activity classes, MET anchors, thresholds, versions |
| `energy/physiology.js` | subject constants: RMR, HRmax, VO₂max, flex HR, resting VO₂ |
| `energy/features.js` | per-minute features + signal quality |
| `energy/activity.js` | rule-based activity classification |
| `energy/estimators.js` | HR and motion channels, fusion, clamping |
| `energy/engine.js` | minute series, daily/workout aggregation, live rate |
| `energy/service.js` | wiring: physiology → engine → row shaping |
| `energy/routes.js` | HTTP surface |
| `energy/baselines.js` | the three evaluation baselines |
| `energy/calibration.js` | per-user parameter fitting |
| `energy/evaluate.js` | evaluation harness |
| `supabase/migrations/20260825120000_energy_expenditure.sql` | tables, RLS, RPCs |
| `tests/energy.test.js` | 50 unit tests |
| `tests/energyE2E.test.js` | 15 integration/route tests |

## New subsystems (Phase 6/14 + accounting)

Two independent modules were added on top of the engine, both pure and tested:

- **`energy/accounting.js`** — canonical energy accounting specification. Enforces
  `total = resting + active + tef`, `workout ⊆ active`, gross/net workout, NEAT,
  and single-counting of TEF. See `ENERGY_ACCOUNTING.md`.
- **`energy/longitudinal.js`** — the *independent* food+weight TDEE estimator: a
  linear Kalman filter over state `[trend_kg, fluid_kg, tdee_kcal]` with slow TDEE
  drift and a robust-observation outlier gate so one anomalous weigh-in cannot jerk
  TDEE by hundreds of kcal. Intake and scale weight only; it never consumes the
  sensor estimate, so it stays an auditable shadow (no circular evaluation).
- **`energy/metrics.js`** + **`energy/rollingOrigin.js`** — richer evaluation
  metrics (Pearson/Spearman/CCC, calibration slope, Bland-Altman, bootstrap CI,
  within-person) and a chronological rolling-origin frame for personalization.

Supporting schema: `supabase/migrations/20260825140000_weight_nutrition_longitudinal.sql`
(body_weight_measurements, nutrition_days, energy_balance_estimates with RLS).
