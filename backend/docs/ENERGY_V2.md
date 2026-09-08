# Energy v2 — learned-layer architecture and deployment state

Status: **IMPLEMENTED, FLAG-OFF (shadow-ready)**. The learned layer is committed,
parity-proven, and NOT authorized to price production minutes until device-
specific validation exists. The audit-driven substrate repairs are live.

## What ships enabled (semantically justified, measured)
1. Source-aware motion substrate (energy/v2/features.js): strap minutes price
   from the strap's own gravity-removed magnitude (`dyn_accel`, v18 history);
   phone motion (`mot`) is a labeled fallback, never silently mixed.
   Measured effect on the real WHOOP 5 day: −43.9 kcal phantom active energy
   (quiet-wrist caps engage on 96 previously-HR-only minutes).
2. Optical-relock exclusion from model HR features (a 183 bpm relock inside a
   60 bpm minute previously corrupted learned inputs).
3. WHOOP band sleep-state -> classifier stage (state 2 = asleep); was 0/276
   sleep minutes priced as sleep.
4. Observed resting-HR resolver (energy/v2/restingHr.js): daily 5th-pct floor,
   >=3 days, median across days; fills the dead HR channel when the profile
   lacks a resting HR. Provenance recorded on the row.

## The learned layer (energy/v2/model.js + gbm.js + engine2.js)
- Primary: LightGBM runtime artifact (energy-v2-lgb-runtime-1, 400 trees,
  18 features, conformal q=2.545, coverage 0.907 @ 90%).
- Fallback artifact: ridge (energy-v2-ridge-runtime-1).
- Serve contract: fill-then-compare — null features are replaced by the
  per-feature training minimum (`missing.replacement_min`); verified 12/12
  exact (0.0 error) against sklearn via energy/v2/artifact/parity_fixture.json.
- Source policy: the learned model prices ONLY strap-sourced minutes. Phone-
  sourced and HR-only minutes fall back to the v1 physiological estimator
  (no phone+calorimetry training data exists; measured: the GBM extrapolating
  on phone minutes over-priced a real day by ~4x).
- Strength minutes bypass the learned model (pressor response; no strength
  training data). Sleep keeps the flat 0.95x rate.

## Why flag-off
Person-held-out accuracy on the training sensor (E4-like inputs) is
GBM 0.926 vs v1 1.157 MET minute MAE (LOO 0.877 vs 1.239) — the architecture
works. But the transfer to real WHOOP data fails quantifiably on the only
available real day: +180 kcal/day (down from +957 before domain-gap fixes),
with resting strap minutes at ~2.6 MET instead of ~1.0-1.2. Remaining causes:
(1) 8x dynamic-range gap (E4 max ENMO 0.57 g vs WHOOP dynAccel 4.8 g) —
calibration cannot fix this; (2) residual feature-distribution shifts. Until a
WHOOP + indirect-calorimetry dataset exists, the number must come from the
physiological estimator.

## Modes (ENERGY_MODEL_V2)
- `off` (default): v1 behavior, byte-identical outputs.
- `shadow`: v1 authoritative; v2 computed side by side, returned in
  `result.shadow` (prod vs candidate totals + inputs hash), never persisted.
- `on`: v2 minutes authoritative (learned on strap minutes, v1 elsewhere);
  v1 remains loadable for rollback. Requires explicit activation + the
  on-device validation evidence below.

## On-device validation checklist (blocks promotion)
1. WHOOP strap + calorimetry (metabolic cart or VO2 Master) paired protocol,
   >=10 participants, >=6 activity classes incl. strength and free-living.
2. Person-separated eval through THIS harness (weeeLoader-compatible export;
   participant-held-out folds; Weir ground truth).
3. The learned layer must beat the physiological estimator on-device by a
   margin that survives participant-held-out splits, and show no resting-minute
   bias (the current transfer failure mode).
4. Runtime/battery: the GBM costs ~1.2 MB artifact + microseconds per minute;
   negligible vs the BLE stack.

## Provenance & replay
- Every v2 minute row carries algorithm_version 2.0.0, feature_version
  feat-v2-1, model_version (artifact id), calibration_version, estimator tag,
  and a conformal interval. computeEnergyV2 is a pure function of
  (samples, physiology, workouts, timezone, model artifact); archived days
  recompute identically via the existing recomputeFromStorage path.
