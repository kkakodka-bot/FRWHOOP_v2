# VO2 Max methodology (`vo2_v1`)

This document describes the reconstructed **VO2 Max** engine. It estimates
cardiorespiratory fitness from wearable recovery, resting physiology, optional
GPS running, and optional laboratory gas-exchange anchors.

It is **not** WHOOP’s proprietary algorithm, **not** a metabolic-cart
measurement, and **not** a medical device output. Runtime scoring is
deterministic. It never calls an LLM.

Legend used throughout:

| Tag | Meaning |
|---|---|
| **KNOWN WHOOP BEHAVIOR** | Public WHOOP support / engineering notes (eligibility, weekly cadence, GPS vs indoor MAE) |
| **PUBLISHED SCIENCE** | Peer-reviewed physiology used as an explicit formula or structural idea |
| **OPEN SOURCE IMPLEMENTATION** | Inspected MIT/open code used as a reference, not copied into this tree |
| **OUR INFERENCE** | Gap-filling where public sources are incomplete |
| **OUR CALIBRATION** | Versioned blend weights, clamps, and decay we chose |

---

## 1. What this is

WHOOP publishes that VO2 Max is a weekly, coverage-gated estimate with a
passive (non-exercise) path and a GPS-run path, and that a lab test can
calibrate the number (**KNOWN WHOOP BEHAVIOR**). Public MAE figures of
**3.7 ml/kg/min (GPS)** and **3.3 (indoor)** are **aspirational benchmarks**,
not claimed accuracy for this reconstruction.

Production value:

```text
eligibility (21d recoveries, optional GPS, optional lab)
  → Uth baseline (HRmax / HRrest)
  → Jackson-style non-exercise ensemble + small wearable adjustments
  → optional ACSM + %HRR GPS running estimate
  → optional decaying lab delta calibration
  → quality-weighted weekly smoother
```

---

## 2. Data mapping (inspected, not assumed)

| Engine input | Source in this repo | Notes |
|---|---|---|
| Resting HR, HRV, recovery | `coach-days` / WHOOP day map | Recovery `0` is missing, not a score of zero (**OUR INFERENCE**, same as Functional Age) |
| Sleep duration / efficiency / consistency | coach-days | Daily scalars |
| Workouts / zone minutes | coach-days `workouts[]` | Zones are already percent-of-session; we do not re-derive from BLE |
| Age, sex, height, weight | `store.profile` | Weight is timestamped in `store.vo2.weightHistory` |
| GPS summary | WHOOP export / cloud `summary` | `gpsEnabled`, `distanceM`, `altitudeGainM` passed through host + coach adapters. **Not** in every local day |
| GPS samples | optional `samples[]` | `{ t, hr, speedMps, elevM }` when a session carries them |
| Continuous `bpm_data` | fixture / live overlay only | Used for free-living HR-response **if present**; not on the `/api/days` host path |
| User-entered `profile.vo2Max` | profile | **Not** a lab anchor |

Live BLE in this app is HR-only. This module does not rebuild BLE, IMU, or
phone GPS streaming.

---

## 3. Eligibility

Thresholds live in `methodology.js` (**OUR CALIBRATION**, shaped like **KNOWN WHOOP BEHAVIOR**).

| State | Rule |
|---|---|
| `INSUFFICIENT_DATA` | Age &lt; 18, or fewer than **14** valid recoveries in **21** days |
| `PASSIVE_ELIGIBLE` | ≥ 14 valid recoveries in 21 days |
| `GPS_ELIGIBLE` | Passive gate, plus an outdoor GPS run ≥ **15 min** in 90 days with speed/HR quality |
| `LAB_CALIBRATED` | Accepted gas-exchange GXT/CPET anchor on or before `asOfDay` |

Engine priority: `LAB_CALIBRATED > GPS_AUGMENTED > PASSIVE > INSUFFICIENT_DATA`.

Treadmill-named sessions are not outdoor GPS. Implied pace outside a running
band, or a physiologically impossible GPS jump, fails the GPS quality bar.

---

## 4. Estimators

### 4.1 Uth baseline (**PUBLISHED SCIENCE**, not the product number)

Tanaka HRmax: `208 − 0.7 × age` (**PUBLISHED SCIENCE**, Tanaka 2001).

Uth 2004: `VO2max ≈ 15.3 × HRmax / HRrest`. Golden check: age 40, RHR 60 →
Tanaka 180, VO2 **45.9**. Used for fallback, sanity, and tests.

GenieMax (MIT) was inspected as an implementation reference
(**OPEN SOURCE IMPLEMENTATION**). We reimplemented from the papers; we do not
vendor Swift.

### 4.2 HRmax

Precedence: manual tested → credible observed historical (must persist; a
single PPG spike is not HRmax) → existing personalized max → Tanaka
(**OUR INFERENCE** / **PUBLISHED SCIENCE**).

### 4.3 Passive ensemble (**PUBLISHED SCIENCE** + **OUR CALIBRATION**)

Jackson 1990 non-exercise equation with activity class mapped from steps (when
present), zone minutes, and workout frequency — not a neural net.

Blended with Uth, then small clamped adjustments from HRV, sleep regularity,
RHR trend, and free-living HR-response **only if** `bpm_data` exists. Wrist PPG
domain shift is documented; those features change quality, not a claimed
Actiheart transfer.

sdimi/cardiofitness (GPLv3) and Apple `ml-heart-rate-models` were **not**
copied. Feature *ideas* only.

### 4.4 GPS running (**PUBLISHED SCIENCE** + **OUR INFERENCE**)

Firstbeat-style structure, independent constants:

1. Resample to a common grid when samples exist.
2. Drop warmup/cooldown, stops, intervals, steep grade, HR dropouts, GPS jumps.
3. ACSM walking/running oxygen cost from speed + grade.
4. `%VO2R ≈ %HRR` (Swain) to extrapolate VO2max on submaximal segments.
5. Reliability-weighted median so one jump cannot move VO2 by ~10.

Summary-only sessions (`distance / duration` + average HR) can still activate
the GPS tier at lower `dataQualityScore`.

Physiology that must hold, all else equal: lower stable HR at the same pace →
higher VO2; higher sustainable speed at the same %HRmax → higher VO2.

### 4.5 Lab calibration (**OUR CALIBRATION**)

Append-only anchors. Accepted modalities: `gas_exchange_gxt`, `gas_exchange`,
`cpet`, `douglas_bag`. Original rows are never overwritten.

```text
calibrated = labValue + k(ageOfAnchor) × (modelNow − modelAtAnchor)
```

`k` starts conservative (~0.85) and decays with a ~180-day half-life.

---

## 5. Weekly snapshots and smoothing

`effectiveDate` is the ISO week Monday of `asOfDay`. Dedup key:
`effectiveDate + methodologyVersion`. Recalculating `vo2_v2` **appends**; it
does not rewrite `vo2_v1` rows. Cap ~104 snapshots.

Smoothing (`vo2_smooth_v1`) is a quality- and tier-weighted pull toward the new
measurement, with a tighter weekly cap for thin passive coverage than for
high-quality GPS or a fresh lab. Not a long moving average that hides real
change (**OUR CALIBRATION**, weekly cadence from **KNOWN WHOOP BEHAVIOR**).

Weight history is timestamped. Implausible jumps are marked `suspect` /
`reject` and not applied silently. Historical weeks use the last plausible
weight on or before `effectiveDate`.

---

## 6. Functional Age hook (not enabled)

Functional Age currently accepts `measured`, `user_entered`, and
`whoop_estimated` VO2 sources. `store.vo2.latest` is a **future** accepted
source. This task does **not** change Functional Age scoring.

---

## 7. HTTP API

| Method | Path | Role |
|---|---|---|
| `GET` | `/api/vo2-max` | Latest (recalculate current week if stale) |
| `POST` | `/api/vo2-max/recalculate` | Force |
| `GET` | `/api/vo2-max/history` | Weekly snapshots |
| `GET` | `/api/vo2-max/methodology` | Public versions + disclaimer |
| `POST` / `GET` | `/api/vo2-max/lab` | Append / list gas-exchange anchors |
| `POST` | `/api/vo2-max/hr-max` | Manual tested HRmax |

`confidence` is `LOW | MEDIUM | HIGH`, not a fake 95% CI. `dataQualityScore`
is coverage/signal, separate from model uncertainty.

---

## 8. Validation and non-claims

CI always runs synthetic fixtures (Uth golden, 13 vs 14 recoveries, 14 vs 15
min GPS, GPS jumps, HR spikes, lab immutability, historical weight, smoothing
clamp, determinism, snapshot version isolation).

Optional PhysioNet Málaga CPET evaluation is download-gated (DUA 1.5.0), split
by participant, never by breath, and **not vendored**. We do not train or
deploy a CPET-time model as free-living VO2 Max.

This reconstruction does **not** claim clinical accuracy or WHOOP-level MAE.

See `backend/vo2/research.js` and `backend/vo2/THIRD_PARTY_NOTICES.md`.
