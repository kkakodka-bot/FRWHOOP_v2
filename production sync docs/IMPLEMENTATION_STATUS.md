# Production sync implementation status

Status: IN PROGRESS. Phase 0 source integration reviewed; implementation, device and deployment acceptance remain unproven.

## Authority and bootstrap

- User confirmed on 2026-09-18 that the numbered files are authoritative.
- Original policy: `/Volumes/Untitled/WHOOP NARA-pr16/production sync docs/AGENTS(3).md`, 68 lines, SHA-256 `759d0db4b8156f96ac6fe3bc84058154150f8722b959f73bf8e757cbe0f3660d`.
- Original specification: `/Volumes/Untitled/WHOOP NARA-pr16/production sync docs/spec(3).md`, 266 lines, SHA-256 `cb65bf457a8068c58f8cfcd4f6c09eff16215c74e8e5b97e3544994f8009ba05`.
- Both originals were untracked (no tracked Git blob ID). Copies here retain the exact bytes.
- The older owner-only/local-compute scope is superseded by the user-authorized multiuser/server specification. No production mutations, push, PR publication, deployment, phone reinstall or database reset are authorized.

## Isolation and ancestry

- Worktree: `/Volumes/Untitled/WHOOP NARA-production-sync-2026-09-18`.
- Branch: `codex/production-sync-2026-09-18`.
- Base: live `origin/main` = `34fc950f03199b9d26e5019311394cb49cc34c7c`.
- Live PR15: `331f339bda78cc739c849cf3a43e3ba4a8722696`, base `fix/offload-pipeline-correctness`, open.
- Live PR16: `5caa31689da0023e111beb36850d3f81d67e1be2`, base `main`, open.
- Their merge base is the main SHA above; neither line contains the other. No foundation branch containing both exists in the inspected refs.
- Origin's legacy URL redirects from `kkakodka-bot/FRWHOOP_v2` to the requested `kkakodka-bot/naraWhoop`; GitHub metadata was queried directly on the requested repository.
- Integrated all non-merge commits from both lines with source commit trailers. PR16's resulting tree at `650b993` was identical to its live head. The original checkout and its untracked documents/builds were preserved.
- Conflict resolution retains `v46-rr-source-index`, `v47-server-score-cache`, and `v46-ppg-record-identity` with original migration bodies. Shared schema fixtures include both v46 identifiers.
- Baseline cherry-picks in order: `37b9e42`, `50a7e0d`, `fc6006c`, `650b993`, `35489ec`, `188c2f4`, `7af5e1c`, `138dd11`, `5e930aa`.

## Execution and evidence

Six read-only scouts cover ancestry/migrations, BLE/storage, identity/privacy, server/intake, iOS/readback/performance, and tests/operations. Implementation ownership is assigned only after their findings; the integration lead owns shared contracts and migrations. Independent review and targeted tests precede each phase completion.

Local artifacts: `/Volumes/Untitled/nara-production-sync-evidence-20260918`. Internal disk had only 7.3 GiB free at preflight; builds use the external SSD (500 GiB free). Xcode 26.3 build 17C529 is installed. Deno was absent from PATH at preflight.

| Command | Result / evidence |
|---|---|
| `git fetch origin`; `git fetch origin refs/pull/15/head refs/pull/16/head`; `gh pr view 15/16 --repo kkakodka-bot/naraWhoop --json number,title,state,headRefName,headRefOid,baseRefName,mergeCommit,url` | Passed; heads recorded above |
| `swift test --package-path Packages/WhoopStore --scratch-path /Volumes/Untitled/nara-production-sync-evidence-20260918/store-build` | Initial 555 tests: four failures from inherited cache registries and integrated migration fixture; repaired rerun 555 tests, zero failures, one existing device-copy skip, 3.842 s. Logs phase0-store.log and phase0-store-repaired.log. |
| `swift test --package-path Packages/WhoopProtocol --scratch-path /Volumes/Untitled/nara-production-sync-evidence-20260918/protocol-build` | 735 tests, zero failures, two existing skips, 0.536 s; phase0-protocol.log. First launch failed before execution due to artifact-directory creation race; rerun after directory existed. |
| `swift test --package-path Packages/WhoopStore --scratch-path /Volumes/Untitled/nara-production-sync-evidence-20260918/store-build --filter IntegratedMigrationTests` | Two predecessor-schema/repeated-migration tests passed in 0.025 s; phase0-upgrades.log. These in-memory tests do not establish disk crash/reopen durability. Existing research-schema test separately uses a file-backed database. |
| `git diff --check` | Passed for integrated tracked baseline |
| `Tools/quality-gate.sh` discovery | Absent; no gate claimed. Existing infra acceptance scripts are under inspection. |

### Phase 0 review and repair

Independent reviewer Pauli (01a0b36f-3c9f-7293-a602-360f989e7007) found no blocking baseline integration defect. Confirmed the 48 migration identifiers and unchanged migration bodies, fixture byte parity and cache classification. Fixed the review finding that an incomplete migration list could trap the oracle test; added explicit PR15 waveform-byte preservation. No existing test was deleted or skipped. The old numeric-prefix assumption was replaced with exact preserved deployed identifiers and sequential checks for future migrations; renaming deployed identifiers would violate W0.

### Dependency order and ownership

1. Baseline integration and migration fixtures (root; phase 0).
2. In parallel: BLE durability/retention (Maxwell), account credentials/upload admission (Banach), JVM queue/result/archive durability (Mill), Edge intake/ownership/object repair (Rawls). Root owns shared GRDB registrations, storage lifecycle and integration.
3. Readback/metric ownership/cache/Today/Sleep (Bacon) consumes the agreed account and result contracts. Background file transfer (Pauli) has exclusive transport ownership after phase-0 review.
4. Root integrates lifecycle, source ownership, performance instrumentation and operational gates. Re-run relevant suites and independent reviews after each phase, repair findings, then checkpoint.

No agent may modify another owner's files. Server and Edge changes use separate additive migration files, integrated by root. Schema migrations already shipped remain unchanged.

## Requirement ledger

Each row remains open until implementation paths, migrations, behavior tests and evidence are attached. Native builds alone cannot satisfy runtime or device requirements.

| Requirement | Required outcome | Status | Files / migrations / tests / evidence / next action |
|---|---|---|---|
| W0.1 | Integrate live PR14/15/16 with migration history preserved | SOURCE VERIFIED | Nine cherry-picks above; Database.swift preserves both migration lines; SchemaOracleTests/IntegratedMigrationTests/PpgSchemaCompatibilityTests; protocol/store tests and phase-0 review. App/Android integration build still required. |
| W0.2 | Capture affected and unaffected deployment/install identity | OPEN | Scout and map; implement and verify |
| W0.3 | Trace first stalled boundary on physical phone | OPEN | Scout and map; implement and verify |
| W0.4 | Fail acceptance when deployment evidence is skipped | OPEN | Scout and map; implement and verify |
| W1.1 | Session/ACK fences, schema compatibility and disable unsafe range skip | OPEN | Scout and map; implement and verify |
| W1.2 | Preserve record index through export/object/replay | OPEN | Scout and map; implement and verify |
| W1.3 | Gate offload on subscriptions/store and select restored source | OPEN | Scout and map; implement and verify |
| W1.4 | Lossless rejected-frame quarantine separate from diagnostics | OPEN | Scout and map; implement and verify |
| W1.5 | Bound ingestion and progress; offload optional work | OPEN | Scout and map; implement and verify |
| W1.6 | Receipt-aware waveform/aux/raw/IMU retention | OPEN | Scout and map; implement and verify |
| W2.1 | User/device upload credentials; quarantine legacy ownership | OPEN | Scout and map; implement and verify |
| W2.2 | Validated identity and same-project readback/RLS | OPEN | Scout and map; implement and verify |
| W2.3 | Scope sessions, cursors, pending files and caches | OPEN | Scout and map; implement and verify |
| W2.4 | Fence logout/account/project switch and retain old debt | OPEN | Scout and map; implement and verify |
| W2.5 | Serialize token refresh and retry transient failures | OPEN | Scout and map; implement and verify |
| W2.6 | Document identity-preserving endpoint migration | OPEN | Scout and map; implement and verify |
| W3.1 | Generation-scoped failure budget/backoff/dead letter/repair | OPEN | Scout and map; implement and verify |
| W3.2 | Atomic token-fenced claims and bounded concurrency | OPEN | Scout and map; implement and verify |
| W3.3 | Fence result publication and preserve arrivals | OPEN | Scout and map; implement and verify |
| W3.4 | Transactional invalidation and dependency-window reconciliation | OPEN | Scout and map; implement and verify |
| W3.5 | Verified object completion and resumable index repair | OPEN | Scout and map; implement and verify |
| W3.6 | Device result grain, deterministic source and sleep replacement | OPEN | Scout and map; implement and verify |
| W3.7 | Independent durable derived archive retries | OPEN | Scout and map; implement and verify |
| W3.8 | Fair bounded backlog, metrics and query plans | OPEN | Scout and map; implement and verify |
| W4.1 | Inventory all derived metrics and consumers | OPEN | Scout and map; implement and verify |
| W4.2 | Server computation and ordered historical dependencies | OPEN | Scout and map; implement and verify |
| W4.3 | Per-metric capability and activation gate | OPEN | Scout and map; implement and verify |
| W4.4 | Lifecycle/sign-in/day/upload-driven readback | OPEN | Scout and map; implement and verify |
| W4.5 | Observable immutable snapshots and bounded async cache | OPEN | Scout and map; implement and verify |
| W4.6 | Complete sleep/stages/charts and server-visible edits | OPEN | Scout and map; implement and verify |
| W4.7 | Input/result revisions, provenance and freshness | OPEN | Scout and map; implement and verify |
| W4.8 | Canonical RR selection and cross-platform fixtures | OPEN | Scout and map; implement and verify |
| W4.9 | Sleep fallback/grouping/timezone/DST parity | OPEN | Scout and map; implement and verify |
| W4.10 | Version negotiation and explicit reprocessing | OPEN | Scout and map; implement and verify |
| W5.1 | CoreBluetooth launch/restoration state machine | OPEN | Scout and map; implement and verify |
| W5.2 | Durable file-backed background URLSession jobs and delegates | OPEN | Scout and map; implement and verify |
| W5.3 | Receipt-safe task/file/cursor crash recovery | OPEN | Scout and map; implement and verify |
| W5.4 | Concurrent bounded catch-up upload preparation | OPEN | Scout and map; implement and verify |
| W5.5 | Explicit wait reasons and network policy | OPEN | Scout and map; implement and verify |
| W5.6 | Opportunistic BGTask expiry and power/force-quit handling | OPEN | Scout and map; implement and verify |
| W6.1 | Remove large reads/analytics from rendering | OPEN | Scout and map; implement and verify |
| W6.2 | Bound live publication and diagnostic writers | OPEN | Scout and map; implement and verify |
| W6.3 | Correlated privacy-safe stage signposts | OPEN | Scout and map; implement and verify |
| W6.4 | Instruments/MetricKit gates and approximate counter labeling | OPEN | Scout and map; implement and verify |
| W6.5 | Thermal/power adaptations and physical device comparison | OPEN | Scout and map; implement and verify |
| W7.1 | Additive staged rollout/canary/rollback runbooks | OPEN | Scout and map; implement and verify |
| W7.2 | Cohort, overnight and multi-day gates with separate readiness claims | OPEN | Scout and map; implement and verify |

## Cross-cutting acceptance

- Section 4 stream matrix required: HR, RR, respiration, temperature, SpO2/provenance, gravity, steps, PPG, v18 auxiliary, raw IMU, events and undecoded frames. Producer/identity/time/units/transport/receipt/storage/scorer/retention inventory remains open.
- Every W0-W6 acceptance paragraph requires adversarial evidence, including >100 generations, stale workers, account changes, duplicate/out-of-order chunks, partial object completion and stale readback.
- Section 6 performance targets remain UNMEASURED: 60/120 Hz deadlines, aggregate Hitches <=10 ms/s, no reproducible main-thread stalls >=250 ms, warm cache <=100 ms p95, cold cache <=1 s p95, commit-to-display <=120 s p95, ready-result readback <=5 s or <=60 s fallback.
- The 72-hour backlog capacity, two-hour locked reconnect, overnight wake and matched energy/thermal comparisons require physical-device artifacts.
- No actual endpoint, device/account mapping, installed build/schema, server image, migration ledger, advancing heartbeat or canary has been verified. Device/staging/production gates remain explicit and cannot be inferred from source tests.
- Acceptance requiring production writes is outside current authorization. Prepare procedures locally without executing them.
