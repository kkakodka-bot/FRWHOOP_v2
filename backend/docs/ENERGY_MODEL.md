# Energy expenditure — the model

What is computed, from what, with which equations, and where it is known to be weak.
Architecture is in [`ENERGY_EXPENDITURE_ARCHITECTURE.md`](./ENERGY_EXPENDITURE_ARCHITECTURE.md);
measured accuracy in [`ENERGY_EVALUATION.md`](./ENERGY_EVALUATION.md).

## 1. Definitions

These are enforced in the schema and asserted in tests, not merely documented.

| Term | Definition |
|---|---|
| **Resting energy** | The cost of being alive for that minute: RMR/1440, or RMR/1440 × 0.95 while asleep. |
| **Active energy** | `total − resting`, floored at zero. Energy above the resting baseline. |
| **Workout energy** | The subset of active energy on minutes inside an identified workout. A *filter*, not a third quantity. |
| **Total** | `resting + active`. A generated column in Postgres, so it cannot disagree with its parts. |

Workout calories are therefore a subset of active calories and can never be added on top
of them. `total = resting + active` holds whether or not a workout occurred.

## 2. What the model can actually see

This is the constraint that shaped every decision below. Per the audit, the backend
receives **HR, RR intervals, a scalar motion intensity, strap sleep stage, sample coverage,
detected-workout context, and the user profile.**

It does **not** receive raw tri-axial accelerometry, gyroscope, raw PPG, steps, GPS, or
skin temperature. The `noop` app decodes some of these on-device but they are research-
gated and never uploaded.

Consequences, stated plainly:

- A wrist-accelerometer MET regression (the WristBased-EE-Estimation approach) **cannot be
  ported**. It needs per-axis signal we do not have. A scalar magnitude is not a
  substitute for a feature vector.
- A learned activity classifier (the ActiNet approach) has nothing to learn from, and that
  repository is licence-blocked for commercial use anyway.
- Therefore **cardiovascular physiology is the primary channel** and motion is a gate and
  a fallback. That is what the available data supports. Claiming otherwise would be
  architecture theatre.

## 3. Internal currency

The model's internal unit is **VO₂ in mL·kg⁻¹·min⁻¹** throughout. Not kcal, not MET.
Both channels produce a VO₂ estimate; fusion happens in VO₂ space; conversion to kcal
happens once, at the end.

VO₂ → kcal uses 5.0 kcal per litre of O₂ (a mixed-substrate RER of ~0.85). MET is reported
in conventional Compendium units (VO₂ / 3.5) for display only — it is never an
intermediate.

### RMR-anchored METs, not the 3.5 constant

The 3.5 mL·kg⁻¹·min⁻¹ "1 MET" convention overstates resting metabolism for heavy, older,
and female subjects (Byrne et al. 2005). Using it as the floor inflates every single
minute of the day.

So the *floor* of each activity band is read as a multiple of **this subject's own resting
VO₂**, derived from their RMR — "sedentary is at least 1 MET" means at least their resting
rate. The *ceiling* is read in absolute Compendium units, because a ceiling represents a
capacity limit rather than a personal baseline.

## 4. Subject constants

`energy/physiology.js`. All resolved once per computation, all recorded on the output.

| Quantity | Method | Source |
|---|---|---|
| RMR | Mifflin–St Jeor | Mifflin et al. 1990 |
| RMR (preferred when body composition known) | Katch–McArdle, `370 + 21.6 × LBM` | Katch & McArdle |
| HRmax | measured if available, else Tanaka `208 − 0.7 × age` | Tanaka et al. 2001 |
| VO₂max | measured if available, else Uth–Sørensen `15.3 × HRmax/RHR` | Uth et al. 2004 |
| Resting VO₂ | derived from RMR, clamped 2.0–4.5 | Byrne et al. 2005 |
| Flex HR | `RHR + max(20, 0.20 × HRR)` | Spurr et al. 1988 |

HRmax and weight are resolved through the **existing** `resolveHrMax` and
`resolveWeightKg` so the energy model and the VO₂ max model agree. `resolveWeightKg`
brings its quality gating with it, so a rejected scale reading does not become a
metabolic input.

Where a required input is missing, the channel that needs it **returns null**. Without a
resting HR there is no reserve to take a fraction of, and inventing one would silently
invent a metabolic rate.

## 5. Channel 1 — cardiovascular

`estimateVo2FromHr`. A flex-HR piecewise function.

**Below the flex HR** — HR maps onto a narrow band between 1.0× and 1.25× resting VO₂.

**Above the flex HR** — fractional heart-rate reserve proxies fractional VO₂ reserve
(Swain & Leutholtz 1997), anchored at the flex VO₂ so the branches meet continuously:

```
frac  = (HR − flexHR) / (HRmax − flexHR)
VO₂   = flexVO₂ + frac × (VO₂max − flexVO₂) × corrections
```

### Why the flex point matters more than anything else here

This is the single most important correction in the model, and it was wrong twice during
development.

`%HRR ≈ %VO₂R` is validated in the **exercise** range, roughly 40–90% of reserve. Below
that, HR moves with posture, caffeine, stress, and thermal load while VO₂ barely changes.
Applying the reserve relation across the resting range turns everyday HR drift into
hundreds of phantom active kcal per day — the failure mode of every naive HR-based calorie
formula, and visible in this document's own Keytel baseline (+1163 kcal/day bias).

The flex point must sit **above the entire awake-and-seated band**. With a resting HR of
48, sitting at a desk is commonly 65–75 bpm. An earlier `RHR + max(15, 0.12 × HRR)` put
the flex point at 64.5 — *inside* that band — so ordinary desk minutes were priced on the
exercise line, which runs at ~0.11 MET/bpm. A few bpm of ordinary drift became half a MET,
sustained across the whole waking day: a synthetic day came out at 3465 kcal against a
defensible ~2900.

`RHR + max(20, 0.20 × HRR)` puts it at 75.5 and the resulting curve is:

| HR | MET |
|---|---|
| 60 | 1.01 |
| 70 | 1.09 |
| 80 | 1.78 |
| 100 | 4.65 |
| 120 | 7.52 |
| 140 | 10.38 |
| 160 | 13.25 |

Sitting is priced as sitting; running is priced as running. Locked in by
`tests/energyE2E.test.js`.

### Corrections on the exercise branch

- **Resistance pressor response, ×0.60.** Raised peripheral resistance and reduced stroke
  volume mean HR runs high for a given VO₂, and inter-set recovery keeps it there after
  VO₂ has already fallen. Uncorrected, the reserve relation drives lifting minutes into
  the top of the band. See §9 for how this number was chosen.
- **Cardiovascular drift.** After ~20 min of sustained effort HR climbs several percent at
  constant VO₂, so the excess is discounted ~0.4%/min beyond 20, floored at 0.9. Applied
  to the excess, not the absolute value, and reset by a fresh bout.

## 6. Channel 2 — motion

`estimateVo2FromMotion`. Scalar motion intensity through per-activity Compendium MET
anchors (Ainsworth et al. 2011), piecewise-linear interpolated. This is the only channel
that survives optical HR corruption, which is exactly what happens under grip load.

Anchors are per activity class because the same wrist motion means very different things:
0.1 while cycling is a braced wrist on a 7 MET effort; 0.1 while walking is a slow amble.

## 7. Activity classification

`energy/activity.js`. Rule-based and context-driven, in priority order: an explicit sport
label on a detected workout, then workout context, then HR-and-motion rules, then time of
day and sleep stage. Classes: `sleep`, `sedentary`, `standing`, `walking`, `running`,
`cycling`, `strength`, `workout_other`, `daily_activity`, `unknown`.

It integrates with the **existing** workout detector rather than competing with it: a
confirmed session and its sport label are inputs, not something re-derived.

Sport labels match as **prefixes**, so "Weightlifting" resolves to strength. An earlier
trailing `\b` in the pattern meant compound names silently fell through to the generic
estimator with a higher MET ceiling.

## 8. Fusion, and its deliberate asymmetry

Weights are `activity_channel_weight × this_minute's_signal_quality`, then:

```
VO₂ = (VO₂_hr × w_hr + VO₂_motion × w_motion) / (w_hr + w_motion)
```

If both weights are zero the minute produces **no estimate at all** rather than a
resting-shaped guess.

Wrist motion fails asymmetrically, so the corrections are asymmetric:

- **Low motion + high HR → discount motion (×0.15).** A quiet wrist is not evidence of low
  energy: it is the signature of cycling, rowing, a stair machine, or a loaded carry, where
  the wrist is braced while the legs work. Averaging in the quiet wrist halves a genuine
  11 MET effort.
- **Any motion + resting HR → cap at 1.35× the HR channel.** Sustained whole-body work at
  2 MET raises heart rate. If it has not risen, the wrist is moving but the body is not
  working: typing, gesturing, driving, washing up. The 1.35 headroom exists because HR
  lags movement onset by 30–60 s, so a walk that genuinely just started is not clipped;
  once underway, HR clears flex and the cap stops applying.
- **Degraded HR during strength (quality < 0.45) → discount HR (×0.3).** Hand the minute
  to motion rather than averaging in a corrupted value.

Only applied when the HR reading is itself trustworthy — a corrupted spike must not be
able to declare an exercise bout and thereby silence the channel that would have
contradicted it.

## 9. Plausibility clamping

Every estimate is clamped to `[metMin × subject_resting_VO₂, metMax × 3.5]` for its
activity class. This is what stops a single corrupted signal from producing a physically
impossible minute. Sleep is clamped hardest, because it is bounded most tightly by
physiology and a noisy spike must not turn a sleeping minute into exercise.

Strength is the interesting case. Its band is `[1.5, 7.0]` MET: the floor is a long
inter-set rest (sitting on a bench is ~1.5 MET, and a 2.0 floor priced every such minute
as light work), and the ceiling is left above the Compendium's 6.0 "vigorous" value for
circuits, but not open-ended — the HR channel will happily claim 10+ MET from the pressor
response, which no resistance protocol actually costs.

The ×0.60 pressor correction was chosen by evaluation, not taste. Against the Compendium's
own resistance-training anchors (3.5 MET for "multiple exercises, 8–15 reps"; 5.0 for
slow/explosive squats; 6.0 for vigorous effort), a logged session is mostly inter-set rest,
so its *median* minute must sit below the vigorous anchor. At ×0.72 the median was 5.89
MET — above the vigorous anchor, which is not defensible as a session average — with p90
pinned at the clamp. At ×0.60 the median is 5.10, essentially on the 5.0 anchor.

## 10. Signal quality and confidence

`energy/features.js`. Each minute scores HR quality, motion quality, and coverage:

- **Coverage** against the expected ~15 samples/minute at 4 s cadence.
- **HR quality** — sample count, staleness (fresh ≤30 s, carried ≤120 s, unusable >300 s),
  and optical-relock spike detection.
- **RR quality** — intervals outside 300–2000 ms, or jumping >20% beat-to-beat, are
  rejected as artefacts.
- **Impossible values are treated as absent, not clamped into range.** Clamping an HR of
  400 to 240 would fabricate a plausible-looking number from a broken sensor.

`model_confidence` combines overall signal quality (0.45), activity-classifier confidence
(0.25), inter-channel agreement (0.20), and a small bonus for having two channels rather
than one. Nothing is ever reported above 0.97.

Channel disagreement is the most honest confidence signal available: when HR and motion
say different things, the estimate is less trustworthy, and that shows up in the number.

## 11. Personalization

`energy/calibration.js`. A global population model plus a per-user layer, versioned and
reversible. The global model is never mutated.

Parameters: `hrEfficiency`, `walkingEconomy`, `runningEconomy`, `strengthCorrection`,
`restingAdjustment`.

Safety properties, all tested:

- **Inert until there is evidence.** Below the minimum training days the parameters are
  exactly 1.0.
- **Strength ramps with data** and never exceeds `CALIBRATION.maxBlend`, so a fortnight of
  noisy data cannot swing estimates.
- **Every parameter is clamped**, so one wild reference day cannot move the model far.
- **A new fit is a new version in `shadow` status**, never an in-place edit. Promotion is
  explicit.
- Insufficient evidence returns "insufficient", not a bad parameter set.

## 12. Versioning and recomputation

Every minute row carries `algorithm_version`, `feature_version`, `model_version`,
`calibration_version`, and `generated_at`. `energy_model_versions` holds one row per
shipped model.

Because the raw samples are in B2 and `computeEnergy` is pure, any historical day can be
recomputed by re-reading its archives and re-running the engine. Rollups follow
automatically since they are recomputed rather than incremented.

The limit, stated honestly: archives written before the `motion`/`sleep_stage` schema bump
have no motion channel and will recompute HR-only. That is recorded in `quality_flags`.

## 13. Attribution

No external source file or model weight is used. Every algorithm is implemented from
primary literature. Licence analysis (§7 of the pre-implementation audit,
recoverable from git history) concluded the short version is that ActiNet is academic-use-only and Slade's `EnergyExpenditure` has no
licence at all, so both are excluded entirely, and the MIT/Apache repositories informed
architecture only.

**Equations:** Mifflin et al. 1990 (RMR) · Katch & McArdle (LBM-based RMR) · Tanaka et al.
2001 (HRmax) · Uth et al. 2004 (VO₂max) · Swain & Leutholtz 1997 (%HRR ≈ %VO₂R) · Spurr et
al. 1988 (flex-HR) · Ainsworth et al. 2011 (Compendium METs) · Byrne et al. 2005 (RMR-
anchored METs) · Keytel et al. 2005 (HR-based baseline).

**Architectural influence:** HAbitsLab/WristBased-EE-Estimation (MIT) — activity-gated
wrist EE structure · HealthSciTech/E2E-PPG (MIT) — signal-quality-then-confidence layering
· Harvard-Slade-Lab/OpenMetabolics (MIT) — biomechanically-informed estimation ·
W4rd2/whoordan (Apache-2.0) — WHOOP reverse-engineering reference, reimplemented as an
evaluation baseline.

## 14. Known limitations

1. **No raw accelerometry.** A scalar motion magnitude cannot distinguish walking from
   cycling from an arm-only movement. Activity classification leans on HR context, and
   accuracy for wrist-quiet activities depends on the workout detector labelling them.
2. **VO₂max is estimated, and Uth overestimates at low resting HR.** For a subject with
   RHR 48 it returns ~59 mL·kg⁻¹·min⁻¹, which sets the top of the reserve range too high.
   The flex anchoring makes the exercise branch slightly conservative in %VO₂R terms,
   which partially offsets this, but a measured VO₂max is materially better and the model
   uses one when available.
3. **Strength training remains the weakest class**, and is the one where an HR-based
   channel is least applicable. The remaining disagreement with WHOOP is documented in
   the evaluation.
4. **No thermal, altitude, hydration, or substrate modelling.** RER is assumed 0.85.
5. **EPOC is not modelled.** Post-exercise elevated metabolism appears only insofar as it
   shows up in HR.
6. **Sleep-stage dependence.** Sleeping metabolic rate is a flat 0.95× RMR rather than
   varying by stage.
7. **35% of reference-labelled sleep minutes classify as sedentary** when the strap
   reports no sleep stage. The MET difference is ~0.13, so roughly 35 kcal/night.

## 15. Quiet-wrist + modest-HR correction (adversarial-hardening fix)

New correction in `routeEstimate` (free-living, no confirmed workout): when the
wrist is quiet (`motion < fidget`) and the HR-reserve fraction is below the
clearly-exercising threshold (`hrr < 0.45`), the HR channel is **capped at its
flex (light-activity) VO₂** and its fusion weight cut to 0.35×. This targets the
caffeine/anxiety/posture failure mode: an HR of 90 with a still wrist is cheap to
produce non-metabolically, so `%HRR≈%VO₂R` must not turn it into exercise.

Measured effect (adversarial test): a full hour at HR 90 / motion 0.02 previously
priced at **2.49 MET / ~131 active kcal**; after the fix it is **1.37 MET /
~39 active kcal** — a resting/standing-band read, not phantom exercise. Genuine
undetected cycling/rowing (hrr ≥ 0.45) is unaffected and keeps full HR weight; the
workout labeller still overrides within confirmed sessions. This is why the WHOOP
benchmark is byte-identical (the change only touches mispriced resting minutes)
while a real defect (hundreds of phantom active kcal/week from stimulant-
elevated resting HR) is removed.

## 16. New subsystems this session

- **IMU features** (`energy/imuFeatures.js`, Phase 3): raw 6-axis → ENMO, MAD, SMA,
  VM, jerk, cadence/dominant-frequency, band-power, periodicity, entropy, tilt/
  posture proxy, movement intermittency, axis correlations, gyro energy. Tested on
  synthetic waveforms that verify physiological behaviour (rest vs motion,
  frequency recovery, tilt). Ready for when NOOP 100 Hz IMU is uploaded (Phase 0).
- **Temporal activity smoothing** (`energy/smoothing.js`, Phase 4): HMM filtering
  forward pass over per-minute classifier outputs with a transition matrix that
  blocks implausible jumps (sleep<->running), so labels stop flickering. Filtering
  (causal) default + optional full smoothing for analytics.
- **Raw-stream archival contract + volume model** (`docs/RAW_SIGNAL_ARCHIVAL.md`,
  `energy/rawStreamVolume.js`): B2 streams `imu_raw`, `ppg_raw`, `rri_raw`,
  `sensor_quality`, `derived_motion_features`; sizing = 24 h IMU ≈ 11 MB/day
  compressed, ~0.34 MB for a 45-min session → recommends derived-features+RR
  continuously and high-rate IMU/PPG only in bounded windows (workouts +
  calibration) by default.
