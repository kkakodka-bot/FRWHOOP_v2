# FRWHOOP/NOOP backend retirement — MIGRATION.md (scratch)

Decision record verified (D1-D4) — no contradicting in-tree consumer found.

## Phase 0 — Receiver conformance harness
- [x] Extract base-URL conformance suite  -> Tools/push-conformance/ (+ backend/tests/conformance/run-node-leg.mjs)
- [x] Node leg: CONFORMANCE PASS (18/18)
- [x] Edge leg (local serve): capabilities/auth/protocol/object-intent pass; inline accept archive-put limited by local https-only config (documented; unit-covered); token gap confirmed
- [x] Parity report + gap list -> docs/PUSH_CONFORMANCE.md
Gate status: Node green; Edge gap list explicit (tokens routes, object-complete HEAD check, DDL audit).

## Phase 1 — Edge receiver closed, Node receiver deleted
- [x] Edge token lifecycle routes (mint/list/revoke) in supabase/functions/push/index.ts + _shared/tokens.ts; tests in supabase/functions/tests/tokens_test.ts
- [x] Object-complete parity audited (byte-for-byte identical; no gap)
- [x] CLOUD_INGESTION DDL audit -> migration 20260911120000_noop_remaining_append_projections.sql (applies clean on local stack)
- [x] Delete Node push receiver (routes/push*, ingest/push{Objects,Wal,WalStore,Ingest,ReplacementStaging,Delete,Archive,IngestQuota}, their tests). Retained: ingest/pushRegistry.js (projectionWindow dep). index.js wiring removed; `grep -r api/push backend/` = NONE; surviving projection tests 23/23 green.
Gate status: complete (verified).

## Phase 2 — Scheduled workers: Node intervals -> pg_cron + Edge functions
- [x] Port reconcileObjects, sweepExpiredManifests, createDeletionService -> supabase/functions/_shared/workers.ts
- [x] s3.ts additions: deleteObject, listPrefix, ListObjectsV2 XML parser. keys.ts: userPrefix / userPrefixV2 / allUserPrefixes. rest.ts: adminDeleteAuthUser
- [x] Functions: supabase/functions/{retention-sweep,reconcile,account-deletion}/index.ts (auth: WORKER_SECRET env or service-role bearer)
- [x] pg_cron migration 20260911140000_scheduled_workers_pg_cron.sql: hourly retention, 6-hourly reconcile, 15-min deletion via net.http_post (+ Vault secret placeholders edge_worker_secret / edge_worker_base_url — ops must fill via vault.update_secret)
- [x] Removed Node 6-hourly reconcile+sweep interval in backend/index.js (±line 1421); kept reconcileOvernightFinalization + flushDueAll intervals (Phase 3 / Lane-2 scope)
- [x] Tests: workers_test.ts (4), s3_test.ts (4, mirrors backend s3.listPrefix.test.js + deleteObject); full suite 38/38 green (type fix: makeMemRest gained adminDeleteAuthUser)
Gate status: complete — 3 cron jobs active on local stack (frwhoop-retention-sweep hourly, frwhoop-reconcile 6-hourly, frwhoop-account-deletion 15-min); Node timers for ported workers stopped.

## Phase 3 — Lane-2 live lane retired (option B: trim already-dead live endpoints; finalization writers deferred)
Scope confirmed by mission: trim the already-dead live endpoints + modules now; defer
finalization / engine / cloudSync / healthkit daily_metrics writers to a later phase.
Answered Q3: /api/metrics/finalization (GET) stays — backed by finalizer stateOf/allStates, no live-lane
dependency; it is a kept-feature route (verified: only backend references it, no app client).

Deleted (live lane, no in-tree app consumer — apps are BLE-local):
- Modules: ingest/hourBuffer.js, ingest/historyBuffer.js, ingest/scoreScheduler.js,
  metrics/workoutDetectionService.js, identity/userRuntime.js, scripts/replayDrainFix.mjs
- Endpoints: /api/ble/live GET+POST (host/routes.js + auth mount), /api/workout-detection/* (routes/workout.js)
- Wiring: userRuntimes instantiation/callbacks in index.js (bufferOf/historyBufferOf/liveOf/detectorOf/
  dayCompleteness/onLive*/onHistory*/replay-acks/haptic/range-evidence/gap-persist), 5-min flushDueAll interval,
  live-sample merge in /api/days, observability pending_samples field, energy live sample feeds (empty now)
- Tests (subjects deleted): historyBuffer, hourBuffer, hourBufferDerived, liveAckContract, type40LiveIngest,
  workoutDetectionService, workoutDetectV2(.beta), workoutE2E.check, tier2ScoreAsync, liveArchiveRecompute,
  identityIngest, historySleepWear, replicationDurability, puffin54 hourBuffer-replay block, type40Rr
  contiguous-frontier block, continuity WAL-recovery block, host /api/ble/live block

Reworked (kept subjects, deleted fixtures -> in-memory stubs):
- overnightFinalization (24/24), continuityAccounting (22/22), continuity (5/5), dayFinalizeGate (4/4),
  productionAcceptance (2/2), host (12/12), sessionAuth (4/4, probe repointed), changes (8/8, live=null),
  ingestVerify (1/1, runtime dep removed), sleep.noop (15/15), pipelineUtilization (fixture-normalizer),
  type40Rr (8/8). New gitignored fixtures: tests/fixtures/memHourBuffer.mjs, normalizeHistoricalSample.mjs.

Kept deliberately (deferred): metrics/finalization.js, hrv/engine.js, metrics/overnight.js,
time/clockCorrection.js (engine uses it), metrics/engine.js, continuityAccounting.js, repository.js,
cloudSync.js, healthkit/routes.js, reconcileOvernightFinalization + its 30-min interval, /api/metrics/
finalize|finalization|recompute. User enumeration for reconcilers now reads object_manifests distinct
user_id (fallback localUserId) instead of userRuntimes.userIds().

Q3 evidence: /api/metrics/finalization consumers are backend-only (host/routes.js:787, index.js:793 auth
mount); finalization.js uses historyStatsOf/liveOf only in diagnoseDay (optional, defaulted null);
stateOf/allStates have no live-lane dependency.

Verification (Phase 3):
- Edge suite stays 38/38 (deno test --allow-all tests/)
- Affected backend tests green: overnightFinalization 24/24, continuityAccounting 22/22, dayCompleteness
  27/27, sleep.noop 15/15, puffin54 17/17, host 12/12, ingestLifecycle 11/11, changes 8/8, type40Rr 8/8,
  continuity 5/5, dayFinalizeGate 4/4, sessionAuth 4/4, productionAcceptance 2/2, ingestVerify 1/1,
  s3.listPrefix 1/1
- Full backend suite: 20 failing tests, ALL pre-existing missing-fixture class (frontend/src/*,
  ml/steps_v3/artifacts/*, docs/research/fixtures/* — those dirs do not exist in this checkout). No new
  failures introduced. backend/index.js imports cleanly (IMPORT_OK).
- Backend no longer references /api/ble/live or /api/workout-detection anywhere (grep = NONE).

## Phase 4 — Backend coach/ai stack retired (backend/coach, memory, documents, context, /api/coach/*)
- [x] Deleted backend/coach/ (loop, heuristic, streaming, tools, lanes, guardrails, pattern, prompt, cloud),
      backend/memory/, backend/documents/, backend/context/, backend/eval/ (coach evaluation tooling)
- [x] Relocated backend/coach/days.js -> backend/metrics/dayIndex.js (loadDayIndex/cloudRowToDay/addDays are
      general-purpose; consumed by backfill.js, host/whoopDays.js, routes/observability.js, vo2/functionalAge
      tests). Importers updated; paths verified by import smoke.
- [x] Deleted /api/ai-coach, /api/ai-coach/stream, /api/coach/insight routes + llm/COACH_MODEL/completeChat/
      embedSession/persistMemory + coach_memory/coach_session sync-op cases from index.js. Health label updated.
- [x] Deleted coach-family tests: coach.test.js, memory.test.js, context.test.js, safety.test.js (all tested
      the deleted guardrails/loop/memory/context)
- [x] Keep: Strand/AI/ (app-side), Supabase coach_sessions/coach_messages/coach_memories tables + RLS + indexes
      (untouched), coachMessage stream
Verification: backend/index.js imports cleanly (IMPORT_OK); grep coach-family imports across tree = NONE;
kept tests green: vo2 14/14, functionalAge 24/24, functionalAge.service 1/1, vo2.service 1/1. One pre-existing
functionalAge.benchmarks failure (missing backend/data/coach-days.json, an untracked data fixture).

## Phase 5 — Key simplification (recorded deviation)

The original Phase 5 plan proposed relocating `vo2/`, `math/`, `methodology/`, `baseline/` into
`metrics/` and fixing `hrMax.js` / `uth.js` imports. **Abandoned.** Nothing outside `backend/` consumed
those HTTP endpoints (zero `/api/` references in `StrandiOS/` or Android main; `Strand/` has exactly one
cloud wire — push transport). Backend test suites are not gates; they die with the backend.

**Test gates for cutover:**
- Edge: `cd supabase/functions && deno test --allow-all tests/` — baseline **38/38** before Phase A edits.
- Conformance: `Tools/push-conformance/push-conformance.mjs` against live Edge — **18/18** target.

## Phase 6 — Edge hardening (Phase A, pre-delete)

- [x] `config.toml`: `verify_jwt = false` for `retention-sweep`, `reconcile`, `account-deletion`, `ingest-verify` (push already set).
- [x] Fail-closed auth: `_shared/workerAuth.ts`; tests in `tests/worker_auth_test.ts` (4) + `ingest_verify_test.ts` auth case.
- [x] `ingest-verify` slim rewrite (`supabase/functions/ingest-verify/` + `_shared/ingestVerify.ts`):
  - **Keeps:** push receipts (`noop_push_wal` / `noop_push_acks`), manifest statuses, B2 HEAD presence, projection row presence, `first_incomplete_stage`.
  - **Dropped:** `diagnoseDay` chain, replay accounting (`redecode` / `continuityAccounting` / `finalization`), `persistSidecars` write side-effect.
  - **Auth change:** ops-only (`WORKER_SECRET` or service-role bearer) — not user-scoped like Node `GET /api/ingest/verify`.
- [x] Cron/Vault trap: option **(a)** — `http_post_worker()` returns `0` when `edge_worker_secret` or `edge_worker_base_url` vault placeholders are empty (no HTTP call; fail-quiet). Documented in migration `20260911140000_scheduled_workers_pg_cron.sql`.
- [x] `account-deletion` cron fix: empty POST body sweeps pending/blocked `deletion_jobs` (was 400 `invalid_user_id`).
- [x] Account-deletion enqueue documented below.
- [x] Edge suite after Phase A: **45/45** (38 baseline + 4 worker auth + 3 ingest-verify).

### Account-deletion trigger (no new enqueue invented)

| Path | Status after cutover |
|---|---|
| `POST /api/account/delete` (user JWT, Node) | **Removed** with `backend/` |
| `POST /functions/v1/account-deletion` + `user_id` (WORKER_SECRET / service-role) | **Ops-only** on-demand |
| pg_cron every 15 min (empty body) | Retries pending/blocked `deletion_jobs` |
| App / Auth hook enqueue | **None in tree** — ops must call the Edge function or insert a `deletion_jobs` row |

### Projection parity (`daily_metrics`)

**Edge push writer** (`structuredSync.dailyMetricRow` + `registry.dailyMetric`): `charge`, `effort`, `rest`,
`hrv_rmssd_ms`, `hrv_sdnn_ms`, `resting_hr_bpm`, `resp_rate_bpm`, `skin_temp_dev_c`, `skin_temp_c` (1.1),
`spo2_pct`, `steps`, `active_kcal`, sleep minute columns, `sleep_efficiency`, `exercise_count`, `extras`,
`provenance`, `algorithm_version` (`noop-client`), `computed_at`.

**Stopped updating after Node teardown** (engine / `engine_replace_sleep_day` / finalization / HealthKit routes):
`recovery_score`, `strain_score`, `sleep_performance_pct`, `day_start_at`, `day_end_at`, `timezone_*`,
`record_class`, `latest_metric_run_id`, extended sleep physiology columns (`sleep_in_bed_min`, `sleep_need_min`, …),
`overnight_hr_bpm`, `avg_hr_bpm`, `max_hr_bpm`, `basal_kcal`, `vo2max`, body-composition columns,
stress/debt columns, `strain_score_v2` / `strain_v2` shadow. **Decision:** apps read scores from on-device SQLite;
these cloud columns were FRWHOOP-engine outputs only.

## Phase 7 — Salvage, delete, scrub (Phases B–C)

### Pre-flight (verified)

- `require`/`import` of `backend/` paths outside `backend/`: **NONE**
- `package.json` workspaces/scripts: only `backend/package.json` (deleted with tree)
- CI workflows (`.github/workflows/`): **no backend references**
- `Tools/`: only historical comment in push-conformance (scrubbed)
- Repointed: `Config/CloudPushSecrets.example.*`, `docs/CLOUD_INGESTION.md`, `docs/PUSH_PROTOCOL.md`

### Salvage (Phase B)

| Script | Decision |
|---|---|
| `Tools/push-conformance/` | **Keep** |
| `Tools/monitor-fleet-push.mjs` | **Salvaged** from `backend/bin/` (direct Supabase REST) |
| `clockCharacterize.mjs`, `recomputeDays.mjs`, `history-census.mjs` | **Deleted** with `backend/` (depend on Node protocol/engine or local WAL files) |

### Delete (Phase C)

- [x] `rm -rf backend/` (includes broken Phase-5 state, all backend tests, `backend/docs/ARCHITECTURE.md`)
- [x] `docker-compose.yml`, `backend/Dockerfile`, `.dockerignore` removed
- [x] Scrubbed editable refs; **immutable exceptions:** `supabase/migrations/*.sql` and `supabase/history/*.sql` comment lines (never mutate applied migrations)
- [x] Coach tables: **kept** (no data deletion); dead schema — future drop migration TBD

### Rollback

Last deployed Node backend git SHA: `310614e538ec940a4c09fca6af565ca049c7b9bf` ("Gate post-offload drain…").
Recoverable from git history; Docker image tag is environment-specific (record at deploy time).

## Phase 8 — Cutover runbook (Phase D — executed 2026-09-11)

| Step | Status | Evidence |
|---|---|---|
| Deploy five Edge functions | **DONE** | `supabase functions deploy push retention-sweep reconcile account-deletion ingest-verify` → all ACTIVE on `sgoyxzcagqyxexmsidtk` |
| Apply migrations `20260911120000`–`20260911170000` | **DONE** | Applied via `supabase db query --linked -f …` (history repair required due to remote-only migration drift); `20260911160000` fixes `http_post_worker` return type; `20260911170000` raises pg_net timeout to 120s for reconcile |
| Fill Vault + `WORKER_SECRET` | **DONE** | `WORKER_SECRET` set via `supabase secrets set`; vault `edge_worker_secret` + `edge_worker_base_url` updated |
| 3 cron schedules present | **DONE** | `cron.job`: `frwhoop-retention-sweep`, `frwhoop-reconcile`, `frwhoop-account-deletion` (all `active=true`) |
| Cron successful invocation | **PARTIAL (1/3)** | `frwhoop-account-deletion` → `succeeded` at 2026-09-12 01:15 UTC (`cron.job_run_details`). `retention-sweep` (hourly `:00`) and `reconcile` (6-hourly) not yet ticked. Manual `http_post_worker`: all three → HTTP 200 after `20260911170000` (reconcile req ids 5–6). |
| Conformance PROD 18/18 | **PASS** | After deploy + `PUSH_PATH=` fix in conformance harness (`process.env.PUSH_PATH != null` guard) |
| `ingest-verify` live | **PASS** | HTTP 200 for fleet user; 67 `ready` manifests + B2 HEAD hits on 2026-09-10 |
| End-to-end device push | **PARTIAL** | B2 objects + manifest rows verified via ingest-verify; `daily_metrics` row absent for 2026-09-10 (device may not have pushed `dailyMetric` that day) |
| Stop Node backend process | **DONE** | Killed PID 2287 (`node` from `/Users/kapilkakodkar/convexia/FRWHOOP/backend`); unloaded launchd `com.rahulvijayan.frwhoop.ingest` (`supervise-ingest.mjs` on PORT=8080). `curl :8080/health` → unreachable. |
| Android push endpoint | **DONE** | `Config/CloudPushSecrets.properties` + `./gradlew assembleFullDebug` → `app-full-debug.apk` (39 MB); `BuildConfig.NOOP_PUSH_ENDPOINT` = Edge URL |
| Apple | **DONE** | `Config/CloudPushSecrets.xcconfig` → Edge |

### Conformance harness fix

`Tools/push-conformance/push-conformance.mjs`: `PUSH_PATH=` (empty) was treated as unset because `|| '/api/push'` is falsy on `''`. Fixed to `process.env.PUSH_PATH != null ? …`.

### Migration drift note

Prod had remote-only migration versions not in git. Repaired with `supabase migration repair --status reverted` for orphan remote versions, then `repair --status applied` for noop/cron migrations whose DDL already existed or was applied via `-f`. **Never** `db reset`.

**Never** `supabase db reset` on the linked prod project.
