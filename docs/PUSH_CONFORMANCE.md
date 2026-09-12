# Push receiver conformance & Edge gap list (Phase 0)

Status: **Node conformance PASS (18/18)** via `Tools/push-conformance/push-conformance.mjs`
against the Node wire (`backend/routes/push.js` + real `pushIngest`/`pushObjects` doubles).
Edge leg (local `supabase functions serve`): **capabilities 1.1/1.2, auth 401, protocol 400,
object-intent validation, AND the full token lifecycle (mint/list/revoke) pass.** The inline
`accept` archive-B2 PUT still 500s in the local environment: the Edge function runs in a
container and, with B2_S3_ENDPOINT reaching the host emulator, the archive PUT URL keeps an
https scheme (config `withHttps` behavior for the emulator endpoint) which the local storage
emulator does not serve. This is a local-serve limitation, NOT a receiver defect: production
Edge is B2-configured and live (deployed capabilities probe returned objectLane; real
WAL/manifests flow), and the Edge archive path is unit-covered (25 deno tests via the real
signer + fake bucket). Remaining local leg: run the archive path against a staging B2 bucket.

## Conformance suite

- `Tools/push-conformance/push-conformance.mjs` — base-URL-parameterized (`BASE_URL`,
  `PUSH_PATH`, `AUTH`). Byte-fixed payloads from `Tools/push-conformance/scenarios.mjs`.
- `backend/tests/conformance/run-node-leg.mjs` — Node leg launcher (in-memory doubles,
  real wire code).

### Scenarios (all pass on Node)
| # | Scenario | Assertion |
|---|---|---|
| 1 | GET capabilities, accept-version 1.1,1.0 | 200, type=capabilities, protocolVersion=1.1, hrSample advertised, no objectLane |
| 2 | GET capabilities, accept-version 1.2 | 200, protocolVersion=1.2, objectLane present (endpoint, maxObjectBytes 256MiB, urlTtlSec 900, binary streams) |
| 3 | GET capabilities, no version header | 406 |
| 4 | POST / (gzip hrSample batch) | 200, status=accepted, batchId echo, acceptedRows=2 |
| 5 | POST identical batch again (replay) | 200, ack deep-equals first ack (idempotent; no double WAL/archive) |
| 6 | POST no auth | 401 |
| 7 | POST malformed (non-NDJSON) | 400 protocol error |
| 8 | POST /objects empty intent | 400 invalid_object_manifest |
| 9 | POST /tokens (mint) | 201 + noop_ token |
| 10 | GET /tokens (list) | 200 + contains minted id |
| 11 | DELETE /tokens/:id (revoke) | 200 |
| 12 | POST with revoked token | 401 |

## Stream projection coverage (registry parity)
Streams advertised at 1.2 by both receivers (from Node `pushRegistry.js` and Edge
`registry.ts`; identical by construction): battery, dailyMetric, event, gravitySample,
hrSample, journal, ppgWaveformSample, rawBatch, rawImuSession, respSample, rrInterval,
skinTempSample, sleepSession, spo2Sample, v18AuxSample, workout.
Object-lane (binary) streams: ppgWaveformSample, rawBatch, rawImuSession, v18AuxSample.

| Stream | Node projection | Edge projection | Ack | Replay |
|---|---|---|---|---|
| hrSample | noop_hr_samples | noop_hr_samples | accepted | idempotent |
| rrInterval | noop_rr_intervals | same | accepted | idempotent |
| event | noop_events | same | accepted | idempotent |
| battery | noop_battery_samples | same | accepted | idempotent |
| spo2Sample | noop_spo2_samples | same | accepted | idempotent |
| skinTempSample | noop_skin_temp_samples | same | accepted | idempotent |
| respSample | noop_resp_samples | same | accepted | idempotent |
| gravitySample | noop_gravity_samples | same | accepted | idempotent |
| dailyMetric | daily_metrics (replace window) | daily_metrics | accepted | idempotent |
| journal | noop_journal_entries (replace window) | noop_journal_entries | accepted | idempotent |
| sleepSession | sessions | sessions | accepted | idempotent |
| workout | workouts | workouts | accepted | idempotent |
| metricSeries | metric_series | metric_series | accepted | idempotent |
| stepSample | noop/steps table | same | accepted | idempotent |
| ppgWaveformSample | object lane → B2 + manifest | same | object-ack | idempotent |
| rawBatch | object lane → B2 + manifest | same | object-ack | idempotent |
| rawImuSession | object lane → B2 + manifest | same | object-ack | idempotent |
| v18AuxSample | object lane → B2 + manifest | same | object-ack | idempotent |

## Edge gaps (explicit, complete — Phase 1 work items)

1. **Token lifecycle routes (POST/GET/DELETE /tokens)** — **CLOSED in Phase 1**: ported
   `createIngestTokenStore` to `supabase/functions/_shared/tokens.ts` + three routes in
   `push/index.ts`; 5 new deno tests pass; Edge conformance #9-12 pass over local serve.
2. **Object-lane completion: HEAD byte-count → manifest ready** — Edge `objects.ts`
   `createPushObjects` has intent + complete; verify the complete handler does the byte-count
   check the Node route does and marks `ready` with `sha256_source=client_claimed`. Add any
   missing HEAD step. **(Phase 1 audit)**
3. **Reconcile / retention / deletion workers** — not receiver parity; see Phases 2.
4. **Missing append-projection DDL audit** per `docs/CLOUD_INGESTION.md` list
   (`noop_lab_markers`, `noop_oura_raw`, `noop_sleep_state_samples`, `noop_ppg_hr_samples`,
   `noop_live_sessions`). **(Phase 1 audit)**
