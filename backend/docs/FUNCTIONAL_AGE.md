# Functional Age methodology (`functional_age_v1`)

This document describes the reconstructed **Functional Age** and **Pace of Aging**
engine. It is a scientifically defensible reconstruction of WHOOP Healthspan
(WHOOP Age and Pace of Aging) from public methodology and epidemiology.

It is **not** WHOOP’s proprietary algorithm. We do not have WHOOP’s SEM
coefficients, member covariance matrix, or internal dose–response splines.

Legend used throughout:

| Tag | Meaning |
|---|---|
| **WHOOP published** | Stated in the 2025 Healthspan white paper or WHOOP support docs |
| **Epi** | Taken from a cited mortality study (usually a WHOOP citation) |
| **Inference** | Strong, documented inference from those sources |
| **Approximation** | Our continuous reconstruction where the paper is categorical or incomplete |
| **Calibration** | Tuned so published WHOOP population examples stay plausible |

Runtime scoring is deterministic. It never calls an LLM.

---

## 1. What this is

WHOOP maps wearable metrics onto **all-cause mortality hazard ratios**, then
converts those ratios into an **effective age** using the Gompertz law of adult
mortality. Functional Age is chronological age plus the sum of contributor
**Age Impacts** after overlap adjustment.

```text
metric (trailing ~180 days)
  → health-optimized reference
  → mortality hazard ratio (HR)
  → overlap / correlation adjustment
  → AgeImpact = ln(HR) / gompertzRate
  → FunctionalAge = chronologicalAge + Σ AgeImpact
```

A person who exactly meets the health-optimized reference profile has
Functional Age ≈ chronological age. Average US adult behavior is expected to
score **older** than chronological age, because the referent is guidelines, not
population averages (**WHOOP published**).

---

## 2. Effective age mathematics

**WHOOP published** (white paper, Spiegelhalter 2016):

Adult all-cause mortality rises ~10% per year (Gompertz). If a behavior has
hazard ratio `HR` versus the healthy referent:

```text
AgeImpact = ln(HR) / 0.1 = 10 × ln(HR)
```

Implemented as `hazardRatioToAgeImpact(hr, gompertzRate)` with versioned
`gompertzRate = 0.1`.

| HR | Age Impact |
|---|---|
| 1.00 | 0 |
| 1.20 | ≈ +1.82 years |
| 0.90 | ≈ −1.05 years |

Hazard ratios are clamped to `[0.50, 2.50]` per contributor (**Approximation**:
prevents infinite age from extreme wearable values outside study support).

---

## 3. Windows and Pace of Aging

| Quantity | Window | Source |
|---|---|---|
| Functional Age | trailing ~180 days | **WHOOP published** |
| Pace of Aging | trailing ~30 days, projected 6 months | **WHOOP published** |

Pace:

```text
projectedChronologicalAge = chronologicalAge + 0.5
projectedFunctionalAge    = FunctionalAge(recent 30-day profile, projectedChronologicalAge)
Pace                      = (projectedFunctionalAge − currentFunctionalAge) / 0.5
```

Interpretation (**WHOOP published**): +0.50 years of Functional Age over six
months → Pace 1.0×. Display is clamped to `[−1.0, 3.0]`; raw pace is stored
unclamped.

Age-dependent references (steps, zone targets, VO2, lean mass) are evaluated at
the age used for that calculation, including the +0.5 year projection.

---

## 4. The nine contributors

HRV, recovery score, strain, respiratory rate, and skin temperature are **not**
inputs. They may exist in NOOP data and are ignored here (**WHOOP published**
Healthspan component list).

### 4.1 Sleep duration (hours / night)

| | |
|---|---|
| Reference | 7–9 hours → HR = 1.0 (**WHOOP published**) |
| Short sleep | <7 hours increases Functional Age (**WHOOP published**) |
| Long sleep | >9 hours: **no Age Impact** (**WHOOP published**; reverse causality) |
| Epi | Itani 2017: short sleep RR 1.12 (95% CI 1.08–1.16), n ≈ 5.17M; linear mortality increase below 6 hours |
| Epi | Saint-Maurice 2024: objective (actigraphy) short sleep associations are stronger than self-report |
| Approximation | Piecewise log-HR curve: 4h → 1.42, 5h → 1.28, 6h → 1.12, 7–9h → 1.00, >9h → 1.00 |
| Aggregation | Trimmed mean of valid nocturnal sleeps. Naps and `asleepMin < 120` excluded. Missing nights are not zero-filled. |

### 4.2 Sleep consistency (0–100)

| | |
|---|---|
| Reference | 70% → HR = 1.0 (**WHOOP published**) |
| Below 70 | years added; above 70 years subtracted (**WHOOP published**) |
| Epi | Windred 2024: UK Biobank n=60,977, accelerometer SRI. Top SRI quintile vs bottom: fully adjusted ACM HR 0.70 (0.59–0.83). Bottom quintile SRI < 71.6. |
| Inference | WHOOP’s 70% threshold sits near Windred’s Q1/Q2 boundary; WHOOP Consistency is slightly lower than SRI because of a longer baseline. |
| Approximation | Log-linear in (70 − score). At 45 ≈ HR 1.22; at 85 ≈ HR 0.84; saturate ≈ 0.75. Re-anchored so 70 = 1.0, not Windred’s Q1 referent. |
| Aggregation | Trimmed mean of valid scores in (0, 100]. Stored 0 treated as missing. |

### 4.3 Daily steps

| | |
|---|---|
| Reference | ~8,000 / day younger adults; ~5,600 older adults (**WHOOP published**) |
| Plateau | ~8,000–10,000 younger; ~6,000–8,000 age ≥60 (**Epi** Paluch 2022) |
| Epi | Paluch 2022: 15 cohorts, n=47,471. Vs Q1 (~3,553 steps): Q2 HR 0.60, Q3 0.55, Q4 0.47. Age interaction p=0.012. |
| Epi | Stens 2023: n=111,309. Significant benefit from ~2,600 steps; optimal ACM ~8,763 (HR 0.40 vs 2,000). |
| Approximation | Nonlinear curve in **steps / age-specific target**, control points re-anchored so HR(target)=1. Missing step days are not treated as zero. If no valid step days exist, contributor is unavailable (HR 1, impact 0). |

This repository’s local WHOOP day index often **does not include steps**. The
engine will not invent them from calories.

### 4.4 Zone 1–3 minutes / week (HRR)

| | |
|---|---|
| Zones | Z1 40–60% HRR, Z2 60–70%, Z3 70–80%, Z4 80–90%, Z5 90–100% (**WHOOP published**) |
| Reference | 100 min/week young adults; ~70 min/week older (**WHOOP published**) |
| Further benefit | mortality may keep falling toward several hundred min/week, up to ~600 (**WHOOP published**, Lee 2022) |
| Epi | Lee 2022: NHS/HPFS n=116,221. Meeting ~150–299 min MPA vs none ≈ 19–25% lower ACM. Near-max at 300–600 min MPA. |
| Epi | Martinez-Gomez 2024: PA–mortality association stronger at older ages → lower minute targets with age (**Inference**). |
| Approximation | HR(0)≈1.26, HR(target)=1, saturating toward ~0.82 by ~400 min/week. Logged-activity minutes only (WHOOP’s own mapping from guidelines onto logged zone time). Days without a logged workout contribute 0 minutes. |

### 4.5 Zone 4–5 minutes / week

| | |
|---|---|
| Reference | 10 min/week young; ~7 min/week older (**WHOOP published**) |
| Epi | Ahmadi 2022: UK Biobank accelerometry n=71,893. ~15–20 min/week VPA: 16–40% lower mortality HR; optimal ~54 min/week (HR 0.64 vs ~2 min). |
| Epi | Lee 2022: 75–149 min/week VPA vs none, ACM HR 0.81. |
| Approximation | HR(0)≈1.24, HR(target)=1, diminishing returns toward ~0.80 near 50–60 min; little additional Healthspan benefit beyond ~90 min (**Inference** + WHOOP “not indefinitely linear”). |

### 4.6 Strength minutes / week

| | |
|---|---|
| Reference | ≥40 min/week begins a favorable Age Impact (**WHOOP published**) |
| Saturation | no additional Healthspan benefit above ~2 hours/week (**WHOOP published**) |
| Epi | Momma 2022: 10–17% lower ACM; J-shape with max reduction ~30–60 min/week. |
| Epi | Shailendra 2022: resistance training associated with lower mortality. |
| Approximation | HR(0)≈1.18, HR(40)=1.00, HR(60)≈0.95, flat from 120 min (WHOOP does not apply the J-shape *penalty* at high volume; it only withholds extra benefit). |
| Activity list | Strength Trainer, weightlifting, powerlifting, Barre / Barre3, pilates, yoga / hot yoga, functional fitness, Barry’s, F45, box fitness, HIIT, baby/toddler wearing, rucking, solidcore (**WHOOP published**). |

HIIT is on WHOOP’s strength list **and** produces zone minutes. Overlap
adjustment is what prevents double counting.

### 4.7 VO2 max (ml/kg/min)

| | |
|---|---|
| Reference | Age- and sex-specific table in the white paper (**WHOOP published**) |
| Epi | ~13% lower ACM per +1 MET (~3.5 ml/kg/min) (**WHOOP published**; Mandsager 2018 context) |
| Epi | Mandsager 2018: n=122,007 treadmill tests. Low vs elite fitness adjusted HR 5.04; no upper limit of benefit in that cohort. |
| Approximation | `HR = 0.87 ^ ((vo2 − ref) / 3.5)` with ΔMET clamped to `[−5, +4]` (**Approximation**: study support; elite extrapolation is noisy). |
| Missing VO2 | **Not estimated inside the score.** Age Impact = 0, `available: false`, `source: unavailable`. An HR-ratio estimate may be attached as diagnostics only. |

Pulse/Vitals both lean on VO2 *fitness age* plus HRV. That is a different
model; we do not use it.

### 4.8 Resting heart rate (sleep)

| | |
|---|---|
| Reference | Male 60 bpm, female 64 bpm → neutral (**WHOOP published**) |
| Epi | Zhang 2016: n=1.25M. +10 bpm → ACM RR 1.09 (1.07–1.12). Linear ACM from ~45 bpm. RHR >80 vs lowest category RR 1.45. |
| Approximation | `HR = 1.09 ^ ((rhr − ref) / 10)`, saturated below 42 bpm and above 100 bpm. |

### 4.9 Lean body mass %

| | |
|---|---|
| Reference | Age 30: female ≥67%, male ≥80% (**WHOOP published**); target changes with age |
| Missing | Age Impact = 0; not penalized (**WHOOP published**) |
| Epi | Jayedi 2022: +10% body fat → ACM HR 1.11; J-shaped, lowest risk near BF% 25%. |
| Approximation | `HR = 1.11 ^ ((target − lbm%) / 10)`. Modest benefit above target, saturating. Age slope for the target is **Approximation** (WHOOP did not publish the full LBM table). |

---

## 5. Correlation adjustment

**WHOOP published:** metrics are correlated; unadjusted HRs double-count
fitness. WHOOP used SEM on member covariance. Those coefficients are
proprietary.

This application is effectively **single-user**. There is not a population
longitudinal panel here from which to estimate a stable SEM. v1 therefore uses
a **configuration-driven overlap model** (`CorrelationAdjustmentModel`):

```text
λ_i = unique_i + (1 − unique_i) × (1 − partnerFraction_i)
ln(HR_adj_i) = λ_i × ln(HR_raw_i)
```

`partnerFraction` is the share of same-sign, available partners in overlapping
pathway groups (sleep / activity / fitness / body). If a contributor is the
only active member of its groups, λ = 1 (no shrinkage).

Unique-variance priors (v1, **Approximation**, not WHOOP’s SEM):

| Contributor | Unique fraction |
|---|---|
| sleep_duration | 0.88 |
| sleep_consistency | 0.88 |
| steps | 0.58 |
| moderate_activity | 0.52 |
| vigorous_activity | 0.55 |
| strength | 0.72 |
| vo2_max | 0.48 |
| rhr | 0.55 |
| lean_body_mass | 0.80 |

This is labeled, versioned, and replaceable when multi-user covariance exists.

---

## 6. Calibration / coverage states

**WHOOP published / support material (as reported):** ~21 valid recoveries in
the first 31 days to unlock Healthspan; ~90 days for better calibration;
6 months is the WHOOP Age horizon.

| State | Rule (v1) |
|---|---|
| `INSUFFICIENT` | Never achieved ≥21 valid recoveries in any 31-day window |
| `PROVISIONAL` | Unlocked, but <90 distinct valid observation days |
| `CALIBRATING` | 90–179 valid days |
| `CALIBRATED` | ≥180 valid days and overall contributor coverage ≥ 0.45 |

Overall coverage averages only feeds that actually have observations. Missing
steps, VO2, or lean mass (common on local WHOOP day indexes) are omitted from
the average rather than scored as 0% coverage. Logged activity minutes of 0
still count as observed activity.

Valid recovery: stored recovery in `[1, 100]` (0 in this dataset means missing,
not a true 0% recovery). Data are never fabricated to fill gaps.

Total Functional Age delta is clamped to `[−20, +20]` years so stacked extremes
cannot explode. Per-contributor Age Impact is clamped to `[−8, +10]`.

---

## 7. What we did not copy

| Project | Useful for | Not used as the score |
|---|---|---|
| **NOOP / this app** | Day schema, sleep, RHR, workouts, zones, strength logs, Supabase `daily_metrics` | Recovery/strain formulas |
| **DocStream Vitals** | Pure engine vs persistence, coverage gates, historical snapshots | Body age = fitness age + HRV/sleep penalties |
| **Pulse AgeEngine** | Age interpolation, missing-metric behavior, RHR skip when VO2 is estimated | 0.7 VO2 + 0.3 HRV blend |

---

## 8. Data mapping (this repo)

| Contributor | Local coach-days | Cloud `daily_metrics` / sessions | Gaps |
|---|---|---|---|
| Sleep duration | `asleepMin` | `sleep_total_min` | Filter naps / short sleeps |
| Sleep consistency | `sleepConsistency` | not always present | 0 = missing |
| Steps | rarely present (`steps` / `Steps`) | `steps` | **Often missing locally** |
| Z1–Z3 / Z4–Z5 | workout `zones` % × `durationMin` | session `summary.zones` / `duration_min` | Logged activities only |
| Strength | workout `name` + duration | session `summary.sport` | Name matching |
| VO2 max | absent | `vo2max` | **Usually missing**; user-entered allowed |
| RHR | `rhr` | `resting_hr_bpm` | Drop 0 |
| Lean mass | profile `leanBodyMassPct` | `body_fat_pct` / `lean_mass_kg` + `weight_kg` | Optional |

---

## 9. Persistence and versioning

Snapshots store `methodologyVersion`, inputs, raw and adjusted HRs, Age
Impacts, coverage, and pace. Historical charts read **stored** snapshots so a
later methodology change does not rewrite the past.

Versioned together: reference curves, hazard curves, Gompertz rate, overlap
model, aggregation rules, pace formula.

---

## 10. Validation

The engine is tested against:

1. Neutral health-optimized profile → Age Impact ≈ 0
2. Monotonicity within physiological regions
3. Saturation at extremes
4. Missing LBM / missing VO2 policies
5. Overlap (excellent VO2+RHR+steps+zones does not explode negative)
6. White paper Table 2 US vs WHOOP-member 30-year-old profiles (directional
   and magnitude-plausible, **not** exact equality)
7. Pace = 1.0 when projected Functional Age rises 0.5 years in 6 months
8. Bit-identical output for identical inputs + version

A black-box harness (`scoreObservations`) accepts later paired WHOOP Age / Pace
observations without mixing those corrections into the scientific prior curves.
