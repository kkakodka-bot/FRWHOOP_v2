# Strain V2 — Shadow-Mode Layered Load System

Status: **shadow** (FRWHOOP_STRAIN_V2=off default | shadow). V1 (`metrics/sleep.js strainFromHr`)
remains canonical: V1 columns/keys are never modified by V2.

## Layers

| Layer | Module | Contract |
|---|---|---|
| L1 canonical epochs | `metrics/strainV2/epochs.js` | 60 s deterministic epochs from raw rows; dedup (t,source best-info); gaps >90 s → UNKNOWN; no forward fill; no tail invention; per-epoch coverage = wall-clock represented; quality HIGH/MODERATE/LOW/UNKNOWN with reject-don't-correct |
| L2 profile | `metrics/strainV2/profile.js` | HRmax hierarchy (lab_measured > validated_field_test > manual > observed-spike-guarded > profile > Tanaka), rolling 14 d overnight-RHR baseline (today's acute RHR = recovery context only), provenance-gated thresholds |
| L3 cardio models | `metrics/strainV2/models/*` | One interface `scoreModel(name,{epochs,profile,thresholds,config})`: Edwards (V1 parity), Banister continuous (m/f), Stagno discontinuous (lactate-anchored, DEFAULT pending replay evidence), Lucia (needs thresholds), individualized (needs curve). Unknown/gap epochs = 0 AU and excluded from duration |
| L4 resistance | `metrics/strainV2/resistance.js` | EXPERIMENTAL. Transparent features only (volume load, %1RM, body-mass-adjusted effective mass, Foster sRPE). NO universal muscular AU; never merged into canonical strain |
| L5 display | `metrics/strainV2/display.js` | `v2.display.1`: 21·min(1,au/480)^0.5, monotone, versioned; 7201-log retired |
| Orchestrator | `metrics/strainV2/score.js` | `computeStrainV2({samples,profile,prefs,days,activities,opts})` → D6 envelope: {strain(null|0-21), au, coveragePct, scorableMinutes, missingMinutes, qualityState, hrMax, restingHr, thresholds, cardioModel, muscular, strainSeries(5-min), activities, notes} |

## Unification (D7)
Daily AU = sum of per-epoch increments. Activity AU = window over the SAME increments.
Frontend curve = `strain_series` 5-min buckets from the SAME increments. There is no second formula.

## Shadow wiring (engine)
`persistComputed` (mirrors the hr2 dual-run pattern): when `FRWHOOP_STRAIN_V2=shadow`,
V2 computes on the same `normalizedSamples` and writes ONLY additive keys:
- `daily_metrics.strain_score_v2` + `daily_metrics.strain_v2` (provenance envelope)
- `daily_physiology_series.strain_series` (5-min AU buckets)
- a `metric_runs` row `algorithm='strain_v2'`
- derived blob `daily.strain_v2`
- API: `dailyToWhoopDay` adds `physiological_summary['Day Strain V2']`
Default mode `off`: zero new keys, zero behavior change. V2 failure is isolated (counter + console.error, V1 unaffected).
Schema: `supabase/migrations/20260828120000_strain_v2_shadow.sql` (nullable columns, coalesce-preserving on-conflict).

## Tooling
- `bin/strainV2-compare.mjs` — READ-ONLY V1-vs-V2 replay over `data/live/<user>/<day>.ndjson`
  with cause attribution (coverage, hrmax source, rhr source, zero-band, model).
- `scripts/strainV2WeeeCompare.mjs` — chest-strap ground-truth comparison (17-subject staged
  protocol with MET labels) for the default-model decision.

## Properties (tested)
dup timestamps cannot increase load; packet frequency invariance; gaps receive no invented duration;
no final-sample tail invention; implausible HR creates no load; no data → INSUFFICIENT (null strain,
never 0); uncorroborated high-motion epochs cannot create strain; determinism; activity == window over
daily increments; single PPG spike cannot redefine HRmax; replay idempotency at the engine seam.

## Default model (closed by ground truth)
`DEFAULT_MODEL='banister'` — 17-subject chest-strap staged protocol vs MET-minutes
(`scripts/strainV2WeeeCompare.mjs`): banister best tracks MET load in every pool
(r=0.663/rho=0.803, n=96); stagno zeroes sub-50% HRR light activity (worst for a daily
construct) and remains available for intermittent session scoring. Edwards = V1 parity only.
