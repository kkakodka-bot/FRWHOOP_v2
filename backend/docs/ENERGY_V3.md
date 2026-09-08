# Energy V3 — activity-aware shadow candidate

**Verdict: `FIXES REQUIRED`.** Do not set `ENERGY_MODEL_V3=on`. V1 remains canonical. This is not a production high-rate IMU claim.

Default is `ENERGY_MODEL_V3=off`. Shadow (`ENERGY_MODEL_V3=shadow`) computes the V3 candidate beside V1 and writes it only to `daily_metrics.extras.energy_v3_shadow`. Persisted `energy_minutes` stay V1 (`algorithm_version` 1.0.0). Frontend `energyReads` / `daySnapshotModel` read `active_kcal` / `basal_kcal` / `total_kcal`, never the shadow extras.

WEEE and HAbits were used to choose the architecture. They are **development / transfer** datasets, not a pristine external validation set. Oracle-family MAE is an estimator upper bound. End-to-end V3 is `runtime_router` only (`energy/v3/artifact/runtime-router-eval.json`).

Promotion remains blocked: there is still no WHOOP strap + indirect calorimetry (and no bicep calorimetry). Public-data MAE is not a WHOOP accuracy claim.

---

## 1. WHOOP v21 IMU lineage (what is actually true)

**iOS product path** (`HistoricalSample` / `decodePuffinV21`) still keeps **mean gravity** (offsets 28/228/428). It does not ship 6×100 arrays to the cloud as samples.

**Server path (this is the V3 producer):**

Level-A B2 notify → `redecode/derive.js` `deriveRecords` (deterministic reassembly + CRC) → CRC-valid type 47/52 v21 frame → `imuRecordFromFrame` (six 100-sample accel/gyro arrays, scale `1/4096` g and `2000/32768` dps) → identity `{source_frame_hash, decoder_version, layout, kind, derived_id}` → gzip NDJSON `imu_raw` → `selectImuForEnergyV3` (replay/finalized: manifest-verified only; live may be provisional) → 60 s window → features → shadow candidate.

In-process unverified IMU is diagnostic/provisional. Finalized/replay shadow consumes only `_manifest_verified` + `_manifest_sha256`. Live derivation and verified replay must share `derived_id`.

Fixture proof: `tests/energyV3.test.js` Level-A split → derive → encode/decode → identical features and candidate. Real deployed B2 evidence is reported by `energy/v3/research/proveWhoopImuPath.mjs`. **Do not claim production high-rate IMU readiness until that diagnostic finds v21 `imu_raw`.** Type-43 realtime flood is not enabled.

---

## Architecture actually implemented

Activity context chooses the estimator. Classifier scores are **heuristic**, not a calibrated probability. Abstention uses deterministic evidence (sport labels, HR vs flex/HRR, HR quality, IMU coverage). No fixed BPM gates (95/110) and no `activity_confidence < 0.35` cutoff.

| Context | Estimator | Inputs |
|---|---|---|
| validated sedentary / standing, quiet wrist, HR below flex | `v3-imu-sedentary` | 20 Hz accel (optional gyro if in gyro domain) |
| explicit cycling workout + exercising HR (flex / HRR) | `v3-hr-cycling` | HR-dominant; IMU supporting |
| high-confidence running (sport label or `high_motion_high_hr`) + exercising HR | `v3-hr-imu-locomotion` | HR/HRR + 20 Hz accel |
| walking | `v1-fallback:walking_unvalidated_model` | exact V1 |
| `workout_other` + quiet wrist + elevated HR | `v1-fallback:unvalidated_activity_family` | exact V1; **not** cycling |
| daily_activity / unknown | `v1-fallback:unvalidated_activity_family` | exact V1 |
| strength | `v1-fallback:ood_strength` | exact V1 |
| sleep | `v1-fallback:ood_sleep` | exact V1 |
| bicep | `v1-fallback:bicep_unvalidated` | exact V1; no multiplier |
| missing IMU / coverage < 0.25 | `v1-fallback:missing_imu` | exact V1 |
| OOD / missing required group | `v1-fallback:ood_or_insufficient_domain` | exact V1 |

Runtime models are **family ridge** (`energy-v3-ridge-1`, `feat-v3-2`, `energy-v3.1.1-unvalidated`) in `energy/v3/artifact/energy-v3-runtime.json`. The V2 LightGBM artifact is untouched.

IMU preprocess: native rate retained (WHOOP 100 Hz stays 100 Hz); anti-alias then resample a **copy** to 20 Hz; mixed rates are not concatenated (dominant rate only); gyro is all-or-nothing, never zero-filled; accel completeness required; units → g and deg/s. Motion-band feature is `bandpass_motion_auc_20hz` (1-pole 0.2–5 Hz at 20 Hz). **Not** NHANES MIMS (no 100 Hz cubic spline, no 4th-order Butterworth, no per-axis integrated summary, no monitor-independence).

Provenance on every V3 minute: `activity_model`, `input_feature_groups`, `router_reason`, `criterion_uncertainty: unavailable`. No calibrated WHOOP interval is exposed. Domain distance/threshold/reference are logged; OOD is a safety gate, not an accuracy probability.

Gross MET → total kcal (`vo2 = MET × 3.5`, `kcal = vo2 × weight × 5.0 / 1000`) once; `active = max(0, total − resting)` once. The 5 kcal/L O2 factor is a **production conversion approximation**. Training targets are oxygen MET (`VO2 ml/kg/min / 3.5`), not Weir, and are not mixed with the 5 kcal/L convention.

---

## Ground truth and target harmonization

Never used as labels: Apple / WHOOP / Fitbit / Google Fit calories, Freedson, VM3, Ainsworth / Compendium, `Study_Information` MET_*, in-wild estimates, public `in-lab.py` clamp-below-1.0.

- **WEEE** Zenodo `6420886` (CC BY 4.0). md5 `23e411c566f1c734e74e23fa76bd1ab0`. Empatica E4 32 Hz wrist accel + HR. `criterion_vo2_ml_kg_min` = mean `VO2[mL/kg/min]` from `PXX/VO2/DataAverage.csv`; `criterion_met = criterion_vo2_ml_kg_min / 3.5`.
- **HAbitsLab in-lab** Zenodo `14858226` (CC BY 4.0). md5 `1840803700111c0a1871e9af3eacc9be`. MetCart 60 s `VO2/kg` column is oxygen uptake, not Weir (VCO2 unused). Printer `METS ≈ round(VO2/kg / 3.5, 1)`. We train on unrounded `criterion_met = VO2/kg / 3.5`. Same definition as WEEE → pooling sit/stand is valid. First 2 minutes of each activity are warmup (protocol), not residual-based.

Paper: 26 analyzed participants / 1,838 in-lab minutes. Release folders are P1000, P1002–P1026 (no P1001). **P1007** Metcart raw only, no 60 s file. **P1011** no Metcart folder. **P1009 / P1014** 60 s cart present, no `Wrist Data/.../acc_resample.csv`. Missingness is in the release, not an extraction bug. Inventory: `energy/v3/research/cache/habits_release_inventory.json`.

Exclusion ledger (machine-readable, no residual-based drops): `energy/v3/research/cache/exclusion_ledger.csv`. Sensor QC is predefined (`vm_mean` in [0.7, 2.5] g, `dyn_enmo` in [0, 5]); P1013 extreme accel is retained in `minutes_qc_dropped.csv`.

Manifests: `energy/v3/artifact/manifests/` and `training-manifest.json`.

Design split was frozen before transfer was scored: nested LOSO (ridge λ grid) inside WEEE; LOPO inside HAbits; WEEE ↔ HAbits scored **once** on the frozen CORE accel subset. Held-out participant is absent from classifier, scalers, regression, OOD, and residual-band calibration. Leakage sentinel is in `train_eval.py`. Public HAbits `in-lab.py` concatenates all subjects inside LOSO for the sedentary classifier; we do **not** copy that leak. `habits_reference_corrected` is a genuinely participant-disjoint two-stage.

---

## Evaluation kinds

| Kind | What it measures |
|---|---|
| `oracle_family` | Criterion activity selects the family. Estimator upper bound only. |
| `runtime_router` | Real `classifyActivity` + `routeV3Minute` with runtime signals only. This is E2E V3. |

Never report oracle-family MAE as end-to-end V3 performance.

INTERLIVE-style fields (per family / overall, oracle LOPO): participant count, minute count, MAE, RMSE, MAPE, bias, Bland–Altman 95% LoA with SE, least-products / proportional bias, per-participant error, coverage/fallback (runtime eval), criterion/index sync method. WEEE also reports a predefined **last 3 minutes** of sufficiently long exercise bouts (`steady_state`).

Numbers live in `energy/v3/artifact/eval-summary.json` and `runtime-router-eval.json` after `train_eval.py` + `evalRuntime.mjs`. They will differ from older tables that treated walking as locomotion and daily_activity as sedentary, and that used oracle labels as if they were the router.

---

## Selected vs rejected

**Selected:** CORE accel (`enmo_mean`, `dyn_enmo_mean`, `bandpass_motion_auc_20hz`, `vm_mean`, `accel_std`, `enmo_mad`, `jerk_mean`, `movement_intermittency`, `cadence_band_power_frac`, `periodicity_strength`) plus HR/HRR on **running** and cycling. Sedentary ridge trained on sit/stand only. Optional gyro ridge for sedentary only.

**Rejected / not shipped:**

- Walking family (no defensible model; V1).
- daily_activity on the sedentary ridge (not independently validated; V1).
- Orientation (`gravity_z_mean`, `ax_ay_corr`, `tilt_estimate`): device axes are not a common frame.
- Random forest / gradient boosting: no tree runtime.
- Neural / temporal: not trained.
- Strength: V1 fallback.
- Vendor calories as labels.
- Ordinary split-conformal coverage for the all-data shipped model (no untouched calibration cohort). Stored bands are `research_residual_band`. WHOOP remains `criterion_uncertainty: unavailable`.

OOD: Ledoit-Wolf (or diagonal robust-Z if n/conditioning is poor). Center/scale/covariance from training participants. Distance threshold from held-out participant distances, never WHOOP. WHOOP fixture data may only measure domain shift (`compareWhoopDomain.mjs`).

---

## Bicep

`v1-fallback:bicep_unvalidated`. Append-only placement log. No IMU coefficient transform, no calorie multiplier. Placement may affect HR quality scoring; physiology equations are unchanged.

---

## Blockers for `on`

1. No WHOOP strap + indirect calorimetry with participant-held-out testing.
2. No bicep + calorimetry.
3. No deployed-evidence claim for production high-rate IMU until `proveWhoopImuPath.mjs` finds real v21 `imu_raw`.
4. Walking and daily_activity remain V1.
5. Quiet-wrist cycling without an explicit sport label remains V1 by design.

**SHADOW READY / FIXES REQUIRED / BLOCK:** **`FIXES REQUIRED`**. Server v21 IMU lineage is fixture-proven; no deployed B2 `imu_raw` was found, so production high-rate IMU is not claimed. Never set `ENERGY_MODEL_V3=on`.
