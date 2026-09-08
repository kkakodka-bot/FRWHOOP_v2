# FRWHOOP AI Coach — Evaluation System

Frozen, deterministic, model-backed evaluation. **Baseline report is canonical**:
`data/eval/reports/coaching-baseline.frozen.json`.

## Commands

```bash
# Full coaching suite, live model (regression)
node eval/run-suite.mjs --live --variant NAME

# Subset by category
node eval/run-suite.mjs --live --filter daily,trend,memory --variant NAME

# Stub model (routing/plumbing only)
node eval/run-suite.mjs --variant plumbing

# Dedicated benchmarks (deterministic, no model): memory, retrieval, tools
node eval/memory-bench.mjs
node eval/retrieval-bench.mjs
node eval/tool-bench.mjs

# Long-conversation needle retention (live)
node eval/longconv.mjs

# Before/after markdown table
node eval/summarize.mjs data/eval/reports/coaching-baseline.frozen.json data/eval/reports/FINAL.json

# Unit tests (66)
npm test
```

## What each suite measures

| Suite | Metrics |
|---|---|
| `coaching` (61 frozen questions) | lane/intent accuracy, tool selection, unnecessary tools, fact coverage, rejects, latency p50/p95/p99, model calls, prompt/completion tokens, cost, safety pass, missing-data honesty |
| `memory-bench` (deterministic) | recall/precision, correction shadowing, temporal expiry, promotion precision (no lookups/small talk), graph budget behavior |
| `retrieval-bench` (deterministic) | 9 cross-source scenarios (Supabase-only … graph+metrics), recall by source, evidence noise (bytes) |
| `tool-bench` (deterministic) | golden-args correctness, bounds, malformed input, empty/missing results, truncation |
| `longconv` (live) | needle facts at positions 8/22/41/60 across 70 turns; retention after compaction + memory |

## Question categories (the frozen 61)

daily · trend · workout · define · coaching · missing · ambiguity · safety ·
memory · longitudinal · cross_source · personalization

Each question carries: expectedLane/Intent, expectedTools (semantic), ground-truth
`facts` (must appear), `rejectFacts` (must NOT appear), `noFabricate`, sources,
user/sandbox, memory fixtures, doc fixtures, safety expectations.

## Adding a question

Add to `eval/suites/coaching.suite.js`. Keep `facts` as strings likely to appear in a
correct answer (match on normalized lowercase; chart blocks are stripped). Rerun the
full suite; do not silently raise expectations to make a regression pass.
