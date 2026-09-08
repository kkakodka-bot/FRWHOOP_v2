# FRWHOOP AI Coach — Architecture

**Status:** implementation guide · **Model:** `deepseek-ai/DeepSeek-V4-Flash-0731` (production, via DeepInfra) · **Last updated:** 2026-08-20

## 1. Mission framing

The objective is a persistent AI health coach that makes a small, cheap model punch
far above its weight. DeepSeek reasons about *user intent*; deterministic
infrastructure resolves *data locations, schemas, storage systems, indexes, caching,
query construction, parallel retrieval, authorization, and source resolution*.

The production model is **never** switched to a more expensive model. A stronger model
may be used offline (judge/teacher/trajectory generator), never in the request path.

## 2. Request path (user message → response)

```mermaid
flowchart LR
    A[React Coach UI] -->|POST /api/ai-coach| B[Express server index.js]
    B --> C[resolveUserId: JWT > dev id > shared demo]
    B --> D[load memory + document stores (per user)]
    B --> E[runCoachTurn]
    E --> F[screenInput: safety triage]
    F -->|emergency| G[deterministic 911/988 guidance]
    F -->|blocked| H[deterministic refusal, zero model calls]
    F -->|clean| I[classify: lane 1/2/3]
    I --> J[context builder: system + memory + patterns + episodes + recent turns]
    I --> K[lane 2: one deterministic evidence fetch + one model call]
    I --> L[lane 3: bounded tool loop (<=2 rounds) + final call]
    K --> M[DeepSeek V4 Flash 0731 via DeepInfra]
    L --> M
    M --> N[screenOutput]
    N --> O[promoteTurn: durable facts -> memory, supersession]
    O --> P[JSON response + telemetry]
```

### Layers

| Layer | Lives in | Responsibility |
|---|---|---|
| Routing | `coach/lanes.js` | Deterministic intent/lane classification (`define`, `evidence`, `agentic`), memory-aspect routing, time-range resolution |
| Tool surface | `coach/tools.js` | 12 typed semantic tools; bundles per intent; args/results validated; results capped and summarized |
| Evidence resolver | `coach/tools.js` `fetchEvidence` | One complete cross-cutting slice: day + recovery + sleep + strain + relevant documents; local index **and** Supabase cloud reader are interchangeable sources |
| Memory | `memory/store.js` + `manager.js` | Temporal, supersession-aware, graph-capable per-user store; promotion policy; prompt block rendering |
| Documents | `documents/store.js` | Per-user uploaded file adapter (training plans, physio/coach notes); content search |
| Patterns | `coach/pattern.js` | Deterministic correlational analysis (HRV after hard days, sleep on rest days, time-of-day, HRV crash contexts) |
| Context/compaction | `context/compactor.js` | Recent turns verbatim; older turns → structured checkpointed episodes; bounded buffer |
| Safety | `coach/guardrails.js` | Emergency triage (911/988), PED/medical/disorder-boundary refusals, data-exfiltration/SQL/path/injection rules, output screening |
| Storage | `storage/*` | Supabase (profiles/devices/daily_metrics/sessions/events/sensor_objects) + Backblaze B2 manifests + short-lived signed URLs; server-only keys |
| Observability | inline telemetry in eval runner + `analysis.*` fields | model calls, tokens, latency, tools, prompts per request |

## 3. Storage separation (what answers what)

| Question | Canonical source |
|---|---|
| "What happened?" (metrics, sleep, workouts, HRV) | Supabase `dashboard_days`/`session_list` (or local cohort index when cloud absent) |
| "Where are my raw files?" | Backblaze B2 manifests (`sensor_objects`) |
| "What does this user prefer/care about/usually do?" | Memory store (temporal, supersession) |
| "How are those related?" | Memory relationship graph (`search_user_graph`) |
| "What does document X say?" | Document store |

Memory is **never** the canonical store for exact health measurements; it summarizes or
points at them. Measured data beats conversational guesses; explicit user corrections
supersede old preference memories.

## 4. Memory model

Record fields: `id, userId, type (13 classes), topic, content, entities, createdAt,
validFrom, validUntil, supersededBy, status, confidence, provenance (user_supplied |
inferred), lastConfirmedAt, stable, sourceTurnIds, sourceDocId, keywords`.

- **Supersession:** `correct()` supersedes matching active records; the contradicted
  record is retained but *shadowed* — queries phrased with old wording resolve to the
  live corrected fact (`scorable()` + `effective()`). Contradicted content is never
  surfaced.
- **Precision floor:** lexical recall has a relative floor so weak matches don't pollute
  the memory block; strong topic-anchored signals get a recall fallback without opening
  the door to unrelated memories.
- **Graph:** lightweight entity-relation triples with hop/node/expansion budgets
  (anti-runaway). `search_user_graph` awards bounded BFS from query-anchored seeds.
- **Promotion:** deterministic, O(1), run after the response — never blocks the reply.
  Promotes preferences/goals/injuries/routines/constraints/corrections/feedback;
  drops pure lookups and small talk; dedups by content+topic; corrections supersede.

## 5. Tool layer

12 tools: `get_day, get_range, get_recovery, get_sleep, get_strain, get_workouts,
prepare_chart, get_relevant_memories, search_user_graph, search_user_documents,
get_document, remember`.

- Exposed per-lane **bundles**; the agentic bundle is the full surface, evidence lanes
  inject data deterministically instead of forcing tool calls.
- Trend tools now return compact `summary {latest, avg, min, max, trend}` + bounded rows
  instead of dumping 90 verbose rows — the smallest payload that can answer.
- Concurrent independent calls (`Promise.all`), tool results pop up to 3.2 KB.

## 6. Compaction

- Recent 14 turns verbatim; older turns grouped into ~10-turn episodes → structured
  summaries with source refs; trivial turns dropped; buffer hard-bounded.
- Durable facts from older turns pass through the same promotion policy so they survive
  in memory even after leaving the window.

## 7. Safety

- Emergency triage is deterministic and model-free (911/988 guidance).
- Boundary refusals (diagnosis, PEDs, disordered eating, self-harm) — model-free.
- Data exfiltration rules: another user's data, user-id substitution, SQL injection,
  path traversal, system-prompt reveal, medication dosage — model-free.
- Wellness questions deliberately stay open (muscle soreness, sleep, zone 2, OTC
  ibuprofen nuance). Guardrail calibration measured in the eval suite.

## 8. Observability & privacy

- Every turn records lane, tools exposed, tools called, tool latency, model calls,
  tokens (incl. cached), time, errors, memory writes, context token estimate.
- No raw BPM/RR/PPG, no journal text, no exact user health values are logged; the eval
  runner never forwards Supabase/B2 secrets.
