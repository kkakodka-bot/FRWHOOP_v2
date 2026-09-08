# Energy expenditure — evaluation

Measured results. Run it yourself with `npm run eval:energy`
(`node energy/evaluate.js`).

## 1. What is being compared, and against what

**Dataset.** `frontend/src/data/day_wise_whoop_data.json` — 182 days of one subject's real
WHOOP export already in the repository. 173 days evaluated; 9 skipped for insufficient
coverage or missing resting HR. 248,710 minutes estimated, 0 unestimable.

**Reference values are WHOOP's own numbers, which are a benchmark and not ground truth.**
This is the most important caveat in this document. WHOOP's calorie figures are themselves
model output from a proprietary model with its own biases, and resistance training is a
class where it is widely reported to read low. A model that matched WHOOP exactly would
have reproduced WHOOP's biases, not achieved accuracy. Where our estimate and WHOOP's
disagree, §5 states which one has the better justification rather than assuming WHOOP is
right.

**No indirect calorimetry was available.** Nothing here is validated against a metabolic
cart. That single fact governs the readiness recommendation in §7.

### An important structural limitation of this dataset

This export contains **heart rate and sleep stage but no per-sample motion**, because
motion was not archived before this work fixed that (see the architecture doc). Every
number below is therefore the **HR-only** behaviour of the model. The motion channel, the
fusion logic, and the asymmetric channel corrections are exercised by the unit and
integration tests but are *not* exercised by this evaluation.

Practically: these results are a floor, not a projection. They are what the model does with
one channel.

## 2. Baselines

| Model | What it is |
|---|---|
| `bmr_multiplier` | Mifflin–St Jeor RMR × an activity multiplier. Phase 16 Baseline 1. |
| `keytel` | Keytel et al. 2005 HR-based equation, floored at resting. Phase 16 Baseline 2. |
| `fixed_met` | The legacy FRWHOOP `estimateCalories(duration, sport)` table, preserved exactly including its 70 kg assumption. Phase 16 Baseline 3 (the Whoordan-style naive formula). |
| `candidate` | This model. |

## 3. Daily total kcal

| model | n | MAE | MAPE | RMSE | bias | R² |
|---|---|---|---|---|---|---|
| **candidate** | 173 | **303.4** | **17.75%** | **436.9** | −109.3 | −0.136 |
| bmr_multiplier | 173 | 314.0 | 20.09% | 447.5 | +90.4 | −0.191 |
| keytel | 173 | 1182.1 | 67.71% | 1439.3 | +1163.0 | −11.33 |
| fixed_met | 173 | 1951.7 | 94.85% | 1997.5 | −1951.7 | −22.74 |

Mean actual: 2061 kcal/day.

The candidate wins on every error metric, but the honest reading is that it beats
`bmr_multiplier` only narrowly on a dataset where it has no motion channel — 303 vs 314 MAE
is not a decisive margin. Its advantage over the demographic baseline is currently the
better MAPE and the fact that it degrades gracefully rather than being structurally unable
to respond to activity.

`keytel` demonstrates exactly the failure mode the flex-HR correction exists to prevent:
applying an HR-based equation across the resting range adds **+1163 kcal/day** of phantom
energy. `fixed_met` is off by −1952 because it only ever counts logged workouts and never
the other 23 hours.

### Negative R² is the notable result

**Every** model, including ours, has negative R² against WHOOP's daily totals — meaning
none of them tracks WHOOP's day-to-day variation better than simply predicting the mean
would. Two readings, and we cannot currently distinguish them:

1. WHOOP's daily variance is driven by inputs we do not receive (raw accelerometry, its own
   activity classification), so it is partly unpredictable from HR alone.
2. WHOOP's daily total is itself largely RMR-dominated, and its residual variance is
   substantially model noise.

Either way: **do not claim this model reproduces WHOOP's daily trend.** It reproduces the
daily *level* to within ~18%.

## 4. Per-workout kcal

| model | n | MAE | MAPE | RMSE | bias | R² |
|---|---|---|---|---|---|---|
| candidate | 66 | 168.9 | 125.8% | 227.3 | +140.8 | −7.83 |
| **bmr_multiplier** | 66 | **86.3** | **53.6%** | **108.3** | −85.4 | −1.00 |
| keytel | 66 | 389.3 | 283.4% | 514.7 | +365.5 | −44.26 |
| fixed_met | 66 | 138.8 | 104.5% | 218.5 | +125.9 | −7.16 |

Mean actual: 151 kcal/workout.

**The candidate loses to the demographic baseline here, and this must not be glossed over.**
We overestimate workouts by ~141 kcal against WHOOP.

## 5. Reading the workout gap honestly

Nearly all 66 workouts are strength sessions (2418 of 2841 labelled workout minutes).

Do the arithmetic on the benchmark. 151 kcal over an average 36.6-minute session is
4.1 kcal/min gross. This subject's resting rate is ~1.34 kcal/min. So **WHOOP is implying a
strength session averages ~3.1 MET total**, which sits at the very bottom of the
Compendium's resistance-training range (3.5 MET for "multiple exercises, 8–15 reps").

Our median strength minute is **5.10 MET**, which sits essentially on the Compendium's 5.0
anchor for slow/explosive squats, below its 6.0 vigorous anchor.

So this is not straightforwardly our error. It is a disagreement in which:

- WHOOP's implied value is below the Compendium's lightest resistance-training anchor;
- ours is between the Compendium's middle and vigorous anchors.

We tuned toward the Compendium and stopped, rather than continuing to tune toward WHOOP.
The pressor correction was strengthened from ×0.72 to ×0.60 on exactly this evidence, which
moved the median from 5.89 (above the vigorous anchor — indefensible) to 5.10, and improved
workout MAE from 201 to 169. Going further would mean abandoning the published Compendium
values to chase a proprietary number that the task brief explicitly designates a benchmark
rather than truth.

**This is unresolvable without indirect calorimetry.** It is the single strongest argument
for the staged rollout in §7. If a metabolic cart later shows WHOOP is right, the fix is
one constant and a recomputation — which the architecture supports by design.

Also note `bmr_multiplier`'s "win" is a −85 bias on a mean of 151: it predicts ~66 kcal per
session, well under even WHOOP. It is not tracking workouts; it is small in a way that
happens to be closer to a small benchmark.

## 6. Per-activity behaviour

Per-minute distributions by the dataset's own activity labels:

| activity | minutes | MET p10 | MET p50 | MET p90 | kcal/min p50 | mean confidence |
|---|---|---|---|---|---|---|
| sleep | 82,628 | 0.85 | 0.85 | 0.94 | 1.161 | 0.529 |
| rest | 163,241 | 0.94 | 0.98 | 1.03 | 1.340 | 0.349 |
| strength | 2,418 | 3.72 | 5.10 | 6.52 | 6.955 | 0.485 |
| running | 268 | 5.16 | 7.24 | 10.44 | 9.877 | 0.485 |
| general | 155 | 1.79 | 1.79 | 1.79 | 2.441 | 0.336 |

Sleep at 0.85 MET and rest at 0.98 MET are physiologically correct, and this is the result
that matters most for a daily total — those two classes are 99% of all minutes, so a small
bias there dominates everything else. This is what the flex-HR correction bought.

Running at a 7.24 MET median is plausible but rests on only 268 minutes. **Walking,
cycling, and general daily activity are effectively unevaluated** — the dataset has 155
minutes of "general" and no labelled walking or cycling at all. Their estimators are
covered by unit tests against Compendium values, which is not the same as validation.

### Activity classifier

| label | minutes | agreement | predictions |
|---|---|---|---|
| sleep | 82,628 | 0.649 | sleep 64.9%, sedentary 35.1% |
| rest | 163,241 | 1.000 | sedentary 100% |
| strength | 2,418 | 1.000 | strength 100% |
| running | 268 | 1.000 | running 100% |
| general | 155 | 1.000 | workout_other 99.4% |

Labelled workouts classify perfectly, because the classifier uses the sport label from the
existing workout detector — that is integration working as designed, not independent
recognition skill. The 35% of sleep minutes falling to `sedentary` are minutes where the
strap reported no sleep stage; the MET gap is ~0.13, about 35 kcal/night.

## 7. Test and performance results

**Tests: 311 passing, 0 failing** (`npm test`). 50 energy unit tests, 15 energy
integration/route tests, 246 pre-existing tests still green — no regressions.

Edge cases covered by passing tests: no HR · corrupted HR · impossible sensor values ·
missing motion · device disconnect mid-day · sleep · full 24-hour recording · midnight
crossing · DST spring-forward · workout crossing midnight · overlapping workouts · weight
updated mid-day · duplicate batches · out-of-order batches · unauthenticated access ·
cross-user access attempts · malformed date and session-id inputs.

**Performance:** 248,710 minutes in 16.1 s single-threaded ≈ **15,400 minutes/s**, so a
user-day costs ~90 ms and is dominated by JSON parsing. No per-sample inference anywhere.
Write volume is 1440 minute rows + 1 daily row + one row per workout per user-day, sent as
one JSONB payload per flush.

## 8. Recommendation

**Ship the daily and resting numbers. Do not ship the workout number as authoritative yet.**

Ready:

- Daily total, resting, and active energy. 17.8% MAPE against WHOOP with correct resting
  physiology, beating all three baselines, and this is the number the Overview card shows.
- The pipeline: idempotent, transactional, RLS-enforced, versioned, recomputable, tested
  end to end, and fast enough with three orders of magnitude of headroom.
- Storage, API, and frontend integration.

Not ready to be called authoritative:

- **Workout calories**, especially strength. +141 kcal bias against WHOOP, and the
  disagreement cannot be adjudicated without calorimetry. Recommend showing it, since it is
  Compendium-anchored and better justified than the `estimateCalories` table it replaces,
  but not presenting it as a precise measurement.
- **Walking, cycling, and general activity**, which this dataset does not evaluate.
- **Anything motion-dependent**, which this dataset cannot evaluate at all. This is the
  largest gap between what was built and what has been measured.
- **Daily trend**, as opposed to daily level: negative R² for every model.

Required before calling the whole engine production-validated:

1. Re-run this harness on data collected *after* the motion archival fix, so the fusion
   path is actually measured.
2. Obtain indirect calorimetry for at least a few sessions, prioritising strength, to
   settle §5.
3. Evaluate walking and cycling on real labelled data.
4. Watch `energy_daily.model_confidence` in production; the mean confidence of 0.349 on
   resting minutes is low and worth understanding.

The architecture is production-ready. The model is production-ready for daily energy and
provisional for workout energy, and the honest summary is that the pipeline has been
verified more thoroughly than the estimates flowing through it.

## Addendum (this session)

- **Negative R² is now decomposed.** See the negative-R² diagnosis (addendum, recoverable from git history): the
  reference (WHOOP) daily variance is strain-driven (r=0.66 with Day Strain) and the
  model's daily SD is only ~170 kcal vs the reference's ~410. Residual anti-correlates
  with our own workout energy (strength over-pricing), and the reference itself has
  implausible outliers (7 days <1000 kcal). Chasing R² with a global multiplier would
  trade a correct daily level for a noisy benchmark we cannot reproduce from HR alone.
- **Richer metric suite** now available via `energy/metrics.js` (Pearson, Spearman,
  CCC, calibration slope/intercept, Bland-Altman, bootstrap CI) and a chronological
  rolling-origin frame in `energy/rollingOrigin.js`.
- **New tested subsystems**: canonical accounting (`energy/accounting.js`) and the
  longitudinal food+weight TDEE Kalman estimator (`energy/longitudinal.js`). See
  `ENERGY_ACCOUNTING.md` and the architecture doc.

## Addendum (session 2)

- **Model defect fixed (adbverted): quiet-wrist + modest-HR phantom calories.**
  A full hour at HR 90 with a still wrist priced at 2.49 MET / ~131 active kcal
  before; now 1.37 MET / ~39 active kcal (correct resting/standing band). Implemented
  by capping the HR channel at flex VO2 and cutting its weight when hrr<0.45 with a
  quiet wrist in free living. WHOOP daily benchmark is byte-identical (303.44 / 17.75%),
  so this is a pure removal of a real defect, no accuracy tradeoff.
- **New subsystems, all tested**: IMU features (Phase 3), temporal activity
  smoothing / HMM (Phase 4), raw-stream archival contract + storage sizing (Phase 0),
  and an 8-case adversarial suite (Phase 16). Test count rose 496 -> 521, all pass.

## Addendum (session 3) — public dataset validation (Phase 9)

Built a full WEEE validation pipeline (`energy/weeeLoader.js`, `groundTruth.js`,
`weeeExperiments.js`, `weeeExperiment.mjs`, `npm run eval:weee`) on the WEEE
dataset (17 participants, Empatica wrist 3-axis ACC 32 Hz + HR + VO2 Master
indirect calorimetry, CC BY 4.0). Participant-held-out results (10 repeats):

- ridge IMU-only:  MAE 0.83 MET, MAPE 31.6%, R2 0.71
- ridge HR-only:   MAE 1.32 MET, MAPE 55.9%, R2 0.18
- ridge IMU+HR:    MAE 0.94 MET, MAPE 37.8%, R2 0.65
- baseline: train global-mean 1.76 | train activity-median **0.68** MET

Honest conclusions: (1) wrist IMU beats loosely-derived wrist HR; (2) HR adds
little on top of wrist kinematics; (3) a simple activity-conditional median
outperforms the learned ridge — the mission's core "don't add complexity unless it
clearly beats simpler out of sample" test is FAILED by the ridge here, so it is NOT
promoted. By-activity: sit/stand ~0.3-0.5 MET, cycling 0.7-1.2, running 1.2-1.3.
Full detail in the WEEE validation addendum (recoverable from git history).


## Addendum (session 4) - Phase 8 uncertainty + Phase 12 currency

- **Phase 8 (uncertainty calibration):** `energy/uncertainty.js` + `energy/uncertaintyExperiment.mjs`
  (`npm run eval:weee:uncertainty`). Split-conformal prediction intervals, verified
  empirically on WEEE calorimetry: a nominal 90% interval achieves **97.1%** empirical
  coverage (homogeneous) - conservative/over-wide, the safe direction. Adaptive
  by-activity widths did not beat it here (too few calibration segments). See
  the uncertainty/currency experiment record (recoverable from git history).
- **Phase 12 (VO2-currency re-evaluation):** `energy/currencyExperiment.mjs`
  (`npm run eval:weee:currency`). Fitting the same model to MET / VO2 / kcal targets
  gives identical MET-equivalent MAE (0.90). The currencies are exact scalar
  multiples and the model is scale-covariant, so the internal currency is
  mathematically free - VO2 is neither the source of accuracy nor a cost. What
  matters is the physiological structure on top.


## Addendum (session 5) - Phase 16 ablation

`npm run eval:weee:ablation` on WEEE calorimetry (participant-held-out):

| Component | MAE (MET) | R2 |
|---|---|---|
| baseline (global mean) | 1.775 | -0.04 |
| IMU-only ridge | 0.868 | 0.661 |
| IMU+HR ridge | 0.868 | 0.673 |
| +activity routing (oracle) | 0.890 | 0.640 |
| +locomotion (ACSM, cadence) | 2.599 | 0.473 |

Verdicts: (1) IMU is the main win; (2) wrist HR adds ~nothing to MAE here;
(3) activity routing does not help out-of-sample (reject complexity without
evidence); (4) cadence-derived ACSM locomotion is much worse - wrist-cadence
harmonics make cadence->speed->VO2 unreliable, confirming use GPS speed when
available. Full write-up in the Phase 16 ablation record (recoverable from git history).
