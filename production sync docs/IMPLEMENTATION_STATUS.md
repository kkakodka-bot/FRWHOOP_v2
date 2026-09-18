# Production sync implementation status

Status: IN PROGRESS. Integrated baseline, scoring durability and compression checkpoints are committed. Remaining client integration, full historical computation and independent reviews are active. Device and deployment acceptance remain unproven.

## Authority and bootstrap

- User confirmed on 2026-09-18 that the numbered files are authoritative.
- Original policy: `/Volumes/Untitled/WHOOP NARA-pr16/production sync docs/AGENTS(3).md`, 68 lines, SHA-256 `759d0db4b8156f96ac6fe3bc84058154150f8722b959f73bf8e757cbe0f3660d`.
- Original specification: `/Volumes/Untitled/WHOOP NARA-pr16/production sync docs/spec(3).md`, 266 lines, SHA-256 `cb65bf457a8068c58f8cfcd4f6c09eff16215c74e8e5b97e3544994f8009ba05`.
- Both originals were untracked (no tracked Git blob ID). Copies here retain the exact bytes.
- Committed copy blob IDs: policy `c3c608068ec392d38f3ad8975944c813d3e4d8ab`; specification `7f02464a81a617b267fae7843ba89129d15a1da5`.
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

### Phase 1 integration in progress

- Root registered additive GRDB migrations v48 scoped result cache, v49 durable ingest/receipt associations and v50 immutable local account ownership. Both schema-oracle copies and all three cloud-registry copies include these tables; deployed migration bodies remain unchanged.
- AccountStorageLayout uses separate project/user directories and preference suites. Existing unowned stores are preserved and are not silently assigned to a signed-in account. Repository writers validate a persisted owner before use; a different account or project cannot rebind one.
- AccountAppRuntime replaces the model/storage/BLE/HealthKit presentation runtime on identity generation changes. Widget snapshots carry an owner stamp and are hidden on logout. Lifecycle integration and app compilation remain in progress, not accepted.
- Root command: `swift test --package-path Packages/WhoopStore --scratch-path /Volumes/Untitled/nara-production-sync-evidence-20260918/store-build --filter 'AccountOwnershipTests|IntegratedMigrationTests|SchemaOracleTests|CloudIngestionRegistryTests'`: 15 tests passed, 0 failures, 0.142 s test run. Artifact: phase1-owner-schema-tests.log. An earlier new-test compile failed because the async store initializer was called without await; fixed without changing assertions.
- Readback worker reports 10 cache tests passed in its isolated build. Root integration rerun and independent review are still required. No UI cutover or device result is claimed from those tests.
- `xcodegen generate` passed. First unsigned Release iOS build exposed three integration compile errors (raw IMU table inference, missing readback context, capability-set reference); repaired rerun passed (`phase1-ios-build-rerun.log`). Later source changes still require a final exact-candidate rebuild. No physical installation or performance evidence is inferred.
- Receipt-backed pruning requires actual validated server receipts, not just the new local schema. Quarantine transport, server contracts, lifecycle recovery and full metric ownership are still being integrated.
- Root full WhoopStore run initially reported 574 tests, 22 failures and one existing device-copy skip (`phase1-store-full.log`). Failures include retention fixtures expecting unacknowledged deletion, pending-job counts and registry adoption coverage. The ingest owner is repairing fixtures with real receipt preconditions, preserving both prune-positive and unsent-retention assertions; final rerun is required.
- Root NoopPush full suite initially failed six assertions/errors because the inherited Apple Compression raw algorithm 9 is not Zstandard. Replaced it with the existing native libzstd shim on macOS and a bounded RFC 8878 raw-block frame encoder on iOS. Fixed the gzip output-pointer lifetime and empty input. Native libzstd independently decodes both paths in new tests (empty, boundary, multi-block and 4 MiB inputs); portable encoding does not claim a compression-ratio benefit. Full rerun: **46 tests, zero failures, 2.908 s**, `root-push-codec-repaired.log`. Independent review pending.
- Root reran `JAVA_HOME=/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home W3_TEST_ARTIFACTS=/Volumes/Untitled/nara-production-sync-evidence-20260918 ./gradlew :analytics-kernel:test :service:test :service:installDist --no-daemon --continue --rerun-tasks` from `scoring-service`: service **51 passed, zero skipped**; kernel **741 passed, five pre-existing skips**, zero failures. Build successful, 15 s, `root-w3-native-suite.log`; XML totals independently parsed. Disposable native PostgreSQL tests are included, not deployed evidence. Independent review identified four P1 findings; repair remains required before checkpoint.
- Root reran the exact sanitized, loopback-only Deno command documented in `supabase/functions/tests/README.md`: **59 passed (12 real PostgreSQL/PostgREST/HTTP integration steps), zero failed, 1 s**, `root-edge-native-suite.log`. No production credentials, external object bucket, device or deployment used. Independent intake review pending.
- Independent account-runtime review identified six source-traced P1 findings; root is repairing them before acceptance. W4 server history/computation and full Android runtime parity are still implementation work, not external blockers. Android API 35 SDK was located under `/Volumes/Untitled/physiology-v2-baseline.ROUXBD/android-sdk` after the initial scout.
- Local operational gate validator: `node --test infra/vps/scripts/verify-sync-evidence.test.mjs` passed seven synthetic tests. `bash -n` passed for all three acceptance scripts. `bash infra/vps/scripts/phase3-acceptance-checks.sh --preflight` exits 1/NOT_READY without the required evidence manifest, before secret or remote access; that expected rejection is not deployment acceptance.

### Reviewed checkpoints and current integration evidence

- `a1f12dc`: scoring generation/lease-fenced publication, deterministic source selection, independent archive retry and additive migrations 010000/030000. Mill's final native suite: 63 service tests and 741 kernel passes (five existing skips), zero failures. Rawls independently rebuilt and ran all 12 repair regressions against fresh native PostgreSQL: passed, zero skips. `W3-repair-independent-closure.md` closes legacy overwrite, version-registration race and future-RR leakage at the recorded source hashes. Historical W4 computation is not included in this checkpoint.
- `bedf3cf`: native macOS Zstandard, bounded RFC 8878 raw-block iOS frames and gzip pointer-lifetime/empty-input repair. The 46-test NoopPush run above and independent native decoder review cover interoperability, not compression ratio or device energy.
- Root full protocol rerun: 735 tests, zero failures, two pre-existing skips, 0.466 s (`root-protocol-durability-final.log`). Root WhoopStore initially had one old foreign-database expectation failure; repaired full rerun: **583 tests, zero failures, one existing device-copy skip, 4.269 s** (`root-store-durability-repaired.log`). The new policy intentionally preserves unknown populated stores in place. Fixtures verify repeated refusal, original rows and exact DB/WAL preservation, no rename and separate-path fresh creation. The shared oracle now pins Room 40 and explicit unknown-PPG default divergence; nine focused Swift schema/upgrade tests pass after that fixture update (`root-room40-shared-schema.log`). Android integration is a following checkpoint.
- Real writer durability review found GRDB's WAL setup reset `synchronous` after `prepareDatabase`. The actual writer now sets and checks FULL after pool initialization; reader-only assertions were replaced with writer-connection checks before/after commit and reopen. Seven targeted real-file/fence/origin tests passed (`root-writer-review-repaired.log`).
- Root Edge rerun of the exact sanitized command in `supabase/functions/tests/README.md`: 59 passed, including 23 native PostgreSQL/PostgREST/HTTP steps, zero failures, 5 s (`root-edge-projection-final.log`). Includes additive 040000 durable archive-to-projection replay. Maxwell independently reran 59/23 with zero failures and closed the bounded P1-4 repair (`PROJECTION-040000-INDEPENDENT-REVIEW.md`). No actual B2 or deployment is involved.
- `root-mac-account-history-build.log`: ad-hoc signed, hermetic macOS build-for-testing succeeded. Products were copied unchanged to `/private/tmp/nara-app-tests.NUgt6a` because external-SSD dynamic loading/debug symbol lookup stalled earlier attempts. These are test binaries, not a physical-device Release build.
- `root-account-history-focused.log/.xcresult`: 98 actual app-host tests passed, zero failures, 3.693 s. Covers BackfillActor (11), repaired watchdog (8), account caffeine/log isolation, real Repository single-flight revocation barriers, server-owned null/empty results, real-file scoring-input journal, initial upload queue, raw manifests, snapshot decoding and widgets. Later upload/input source changes require rerun.
- `root-ai-account-focused.log/.xcresult`: 70 actual app-host tests passed, zero failures, 0.839 s: 45 AI/privacy/provider regressions, 19 IMU tests and six capture/account binding tests. Synthetic keychain/network fixtures are used; real credentials or provider requests were not exercised. The separate app-module harness failed compilation due duplicate imported/source declarations; its failed log is retained and not counted as acceptance.
- New durable account-scoped `history-inputs.sqlite` retains profile/configuration/sleep-edit inputs, expected revisions, retries and conflicts. Four native real-file tests passed both standalone and in the app-host run. Server-owned sleep edit/delete/undo/manual-nap integration is being tested; controls remain gated until that contract is verified. It never calls local restaging for owned sessions.
- Account runtime now scopes log tails, debug exports, caffeine, AI preferences/keys/sessions and writer lifetimes. Repository overlays are presentation-only: authoritative nulls remove old values, complete empty sleep replaces the prior set, and rollback restores retained local source rows. HealthKit/widget/watch consumers use the same presentation state. Physical HealthKit/watch/device behavior is unexecuted.
- Open review repairs: W5 capability binding, verified-key versus staging-key handling, complete durability receipts and source-commit spool cleanup; W1 sender 1.3 negotiation and manifest bounds; Android runtime/parity; W4 complete history/metric contract. These are local implementation work, not external acceptance blockers.

## Requirement ledger

Each row remains open until implementation paths, migrations, behavior tests and evidence are attached. Native builds alone cannot satisfy runtime or device requirements.

| Requirement | Required outcome | Status | Files / migrations / tests / evidence / next action |
|---|---|---|---|
| W0.1 | Integrate live PR14/15/16 with migration history preserved | SOURCE VERIFIED | Nine cherry-picks above; Database.swift preserves both migration lines; SchemaOracleTests/IntegratedMigrationTests/PpgSchemaCompatibilityTests; protocol/store tests and phase-0 review. App/Android integration build still required. |
| W0.2 | Capture affected and unaffected deployment/install identity | EXTERNAL GATE | VALIDATION_RUNBOOK.md defines immutable build/account/endpoint/migration/image evidence. No affected or unaffected physical installation has been inspected in this implementation. Obtain authorized device/staging evidence. |
| W0.3 | Trace first stalled boundary on physical phone | EXTERNAL GATE | SyncPipelineTrace.swift and evidence validator distinguish commit/accept/archive/index/compute/display. Actual physical record trace remains unexecuted; procedure in VALIDATION_RUNBOOK.md. |
| W0.4 | Fail acceptance when deployment evidence is skipped | IMPLEMENTED; REVIEW PENDING | Three infra/vps/scripts acceptance scripts and verify-sync-evidence.mjs/tests; seven local tests and missing-manifest rejection above. Validate a real authorized manifest before any release claim. |
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
| W3.1 | Generation-scoped failure budget/backoff/dead letter/repair | IN REVIEW/REPAIR | ScoringWorkQueue.kt, migration 20260918010000, ScoringDurabilityIntegrationTest; root native run above includes >100 updates. Independent findings must close. |
| W3.2 | Atomic token-fenced claims and bounded concurrency | IN REVIEW/REPAIR | ScoringWorkQueue, LeaseHeartbeat, ScoringPoller; concurrency/durability PostgreSQL integration tests. Final integrated review required. |
| W3.3 | Fence result publication and preserve arrivals | IN REVIEW/REPAIR | EngineIngestWriter and SQL atomic publication; ScoringConcurrencyIntegrationTest. Legacy-write compatibility and review findings remain under repair. |
| W3.4 | Transactional invalidation and dependency-window reconciliation | PARTIAL | 010000 projection invalidation/repair and native tests. Ordered historical metric dependencies/profile/edits are W4 work in progress. |
| W3.5 | Verified object completion and resumable index repair | IN REVIEW | Edge durability/objects/workers plus 020000 migration; 59 tests/12 native steps verified above. DURABILITY_RECEIPT.md defines exact hash/size/owner/resource contract; actual B2 permissions/schedule unverified. |
| W3.6 | Device result grain, deterministic source and sleep replacement | IN REVIEW/REPAIR | 010000 device-keyed snapshots/RPC, EngineIngestWriter, durability integration fixtures; edits/history extensions pending W4. |
| W3.7 | Independent durable derived archive retries | IN REVIEW/REPAIR | SnapshotArchiveWorker, DerivedArtifactWriter, 010000 archive jobs; ArchiveDurabilityIntegrationTest. External B2 deployment remains unverified. |
| W3.8 | Fair bounded backlog, metrics and query plans | PARTIAL | Queue claim bounds, HeartbeatReporter and native tests; representative fleet query plans/throughput remain unmeasured. |
| W4.1 | Inventory all derived metrics and consumers | INVENTORIED | METRIC_OWNERSHIP.md maps visible fields/producers/consumers and historical dependencies. Inventory is not migration or parity acceptance. |
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
| W6.4 | Instruments/MetricKit gates and approximate counter labeling | SOURCE IMPLEMENTED; DEVICE GATE | SyncMetricKitCollector.swift retains bounded local raw payloads; DisplayPerformanceMonitor labels 33 ms counter approximate; VALIDATION_RUNBOOK and evidence validator require actual aggregate Hitches/60/120 Hz artifacts. Final build and physical traces still required. |
| W6.5 | Thermal/power adaptations and physical device comparison | OPEN | Scout and map; implement and verify |
| W7.1 | Additive staged rollout/canary/rollback runbooks | DOCUMENTED; REVIEW PENDING | VALIDATION_RUNBOOK.md plus hardened infra acceptance scripts. No deployment authorized or performed. |
| W7.2 | Cohort, overnight and multi-day gates with separate readiness claims | EXTERNAL GATE | Runbook specifies fresh/research/affected cohort, locked reconnect, overnight wake, multi-day transitions and separate readiness verdicts. Real artifacts required; unexecuted. |

## Cross-cutting acceptance

- Section 4 stream matrix required: HR, RR, respiration, temperature, SpO2/provenance, gravity, steps, PPG, v18 auxiliary, raw IMU, events and undecoded frames. Producer/identity/time/units/transport/receipt/storage/scorer/retention inventory remains open.
- Every W0-W6 acceptance paragraph requires adversarial evidence, including >100 generations, stale workers, account changes, duplicate/out-of-order chunks, partial object completion and stale readback.
- Section 6 performance targets remain UNMEASURED: 60/120 Hz deadlines, aggregate Hitches <=10 ms/s, no reproducible main-thread stalls >=250 ms, warm cache <=100 ms p95, cold cache <=1 s p95, commit-to-display <=120 s p95, ready-result readback <=5 s or <=60 s fallback.
- The 72-hour backlog capacity, two-hour locked reconnect, overnight wake and matched energy/thermal comparisons require physical-device artifacts.
- No actual endpoint, device/account mapping, installed build/schema, server image, migration ledger, advancing heartbeat or canary has been verified. Device/staging/production gates remain explicit and cannot be inferred from source tests.
- Acceptance requiring production writes is outside current authorization. Prepare procedures locally without executing them.
