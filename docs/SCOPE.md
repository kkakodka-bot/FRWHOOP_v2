# FRWHOOP_v2 scope

This repository is a **fork** of upstream [NOOP](https://github.com/ryanbr/NOOP). The cross-platform
apps (Swift packages, Android, macOS/iOS targets) remain **offline-by-default, on-device** companions
for WHOOP straps — same as upstream.

## What differs from upstream NOOP

FRWHOOP_v2 operates a **hosted Supabase + Backblaze B2 receiver** for the owner's own devices. This is
not a public multi-tenant product; it is the durability lane behind the Experimental one-way push export
(#1314 pattern). Upstream NOOP's hard "no server" rule does **not** govern this fork's `supabase/`
tree, Edge functions, or hosted migrations.

| Layer | Path | Role |
|---|---|---|
| On-device apps | `Strand/`, `StrandiOS/`, `android/`, `Packages/` | BLE, SQLite, local analytics (authoritative for UI) |
| Push wire | `Tools/push-conformance/`, `docs/PUSH_PROTOCOL.md` | Contract between apps and receiver |
| Hosted receiver | `supabase/functions/push` + workers | WAL → B2 → Postgres projections |
| Ops | `Tools/monitor-fleet-push.mjs`, `supabase/functions/ingest-verify` | Fleet health, pipeline verification |

There is **no Node API** in this fork. The retired Node server tree was removed in Phase 6
(see `MIGRATION.md`).

## Privacy

The hosted stack stores only what the owner's devices push. No third-party telemetry is added beyond
what Supabase/B2 hosting inherently logs. Account deletion is a resumable worker (`account-deletion`)
that wipes B2 prefixes and Postgres rows before Auth.
