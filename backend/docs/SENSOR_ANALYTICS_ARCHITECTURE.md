# Sensor analytics — architecture

The layer between raw sensor records and a number a user acts on. Companion to
[`ENERGY_EXPENDITURE_ARCHITECTURE.md`](./ENERGY_EXPENDITURE_ARCHITECTURE.md), which describes
the same pipeline for calories.

Read [§2 Capability](#2-what-the-backend-can-actually-measure) before planning any metric.
Several designs that look obvious from WHOOP's hardware datasheet are not buildable here,
and the reason is an ingest contract rather than the hardware.

## 1. Data flow

```
WHOOP strap
  │  BLE
  ▼
WhoopBlePlugin.swift (iOS)              frontend/ios/App/App/
  │  parses: heart rate, RR intervals, battery
  │  archives: raw notification frames, as opaque hex
  ▼
POST /api/ble/live                      host/routes.js
  │  { datetime, bpm, rr_ms, motion, battery, sleep_stage }
  ▼
createHourBuffer().append()             ingest/hourBuffer.js
  │  hourly flush → gzip NDJSON → B2 + object_manifests
  ▼
metricsEngine.persistComputed()         metrics/engine.js
  │
  ├─ createOvernightProvider()          metrics/overnight.js
  │    └─ injected into extras.overnight
  │
  ├─ scoreDay() → scoreSleep()          metrics/sleep.js
  │    └─ scoreSession() calls the provider with THIS session's window
  │         ├─ overnightHrv()           hrv/engine.js
  │         └─ nightlyRespiration()     respiration/engine.js
  │              └─ respirationFromRrIntervals()  respiration/estimators.js
  │         ▼
  │       recoveryScore(hrv, resp, …)
  │
  └─ computeEnergy()                    energy/service.js
  ▼
db.upsertPayload({ daily_metrics, metric_runs, … })
  │  hrv_rmssd_ms, resp_rate_bpm        ← scalars
  │  metric_runs.output_refs            ← value + confidence + status + version
  │  derived blob on B2                 ← full envelopes, incl. rejected windows
  ▼
GET /api/days                           the scalars
GET /api/sensors/capability             what is measurable at all
```

Shared foundations, used by every engine above:

| Module | Responsibility |
| --- | --- |
| `signal/capability.js` | Which signals exist, which are reachable, which are absent |
| `signal/constants.js` | Physiological limits and clamps — one source of truth |
| `signal/envelope.js` | The metric envelope, confidence propagation, fusion |
| `signal/quality.js` | Per-channel quality scoring, artifact rejection |
| `baseline/stats.js` | Robust statistics (median, MAD, CUSUM, Pettitt, Theil-Sen) |
| `baseline/service.js` | Conditioned personal baselines and maturity |

`energy/constants.js` and `energy/features.js` re-export from `signal/` rather than holding
their own copies, so there is exactly one definition of the RR artifact rule and the
physiological limits.

## 2. What the backend can actually measure

The strap decodes far more than the backend receives. `signal/capability.js` is the
machine-readable version of this table and is served at `GET /api/sensors/capability`.

| Signal | Status | Notes |
| --- | --- | --- |
| Heart rate | available | Device-reported. Live posts throttled to ≥1.8 s, so ~4 s effective |
| RR intervals | available | Only while the standard Heart Rate Service is the live source |
| Motion magnitude | available | Mostly phone CoreMotion, not the strap's IMU |
| Battery | available | |
| Skin temperature | reachable | Historical offload only; not decoded live |
| Respiratory rate (device) | reachable | Historical offload only |
| SpO2 | reachable | Historical offload only |
| Wear state | reachable | Historical offload only |
| PPG waveform | reachable | Needs `REALTIME_RAW_DATA` enable; battery cost |
| Accelerometer XYZ | reachable | Needs `REALTIME_RAW_DATA` enable |
| Gyroscope XYZ | reachable | Needs `REALTIME_RAW_DATA` enable |
| ECG, EDA, ambient temp | absent | No channel in any decoded layout |

**available** means a decoded field reaches the backend today. **reachable** means the
hardware produces it and a named unlock would deliver it. **absent** means no amount of
client work produces it.

Two consequences worth stating plainly, because they invalidate otherwise reasonable plans:

- **No temperature means no circadian phase estimation and no fever detection.** The
  `daily_metrics.skin_temp_c` column exists and is never populated by the live path.
- **No EDA means published stress models do not transfer.** The WESAD-family accuracy
  figures are obtained with electrodermal activity as a dominant feature.

Raw BLE frames ARE archived to B2 as opaque hex. Anything the strap sent is therefore
recoverable by writing a backend decoder, without touching the iOS client. That is the
cheaper of the two unlock paths and it carries no battery risk.

## 3. The metric envelope

Every derived metric is returned as an envelope, never a bare number.

```js
{
  value: 41.2, unit: 'ms',
  confidence: 0.71,          // trust in THIS value
  dataQuality: 0.88,         // quality of the inputs
  inputCoverage: 0.94,       // fraction of the window actually covered
  algorithm: 'hrv_rmssd_windowed', algorithmVersion: '1.0.0',
  sourceSignals: ['rr_intervals'],
  status: 'ok',              // ok | low_confidence | unavailable
  reason: null,              // why, whenever status is not ok
  startTime, endTime, timestamp,
  detail: { … }              // per-window diagnostics
}
```

Rules the engines follow, each of which exists because the alternative produces a
confidently wrong number:

1. **Unavailable is a status, not a zero.** A metric that cannot be computed returns
   `value: null` with a reason. Nothing substitutes a default.
2. **Implausible values are rejected, not clamped.** A fused 38 brpm during sleep is a
   broken measurement; clamping it to 30 would present a fabrication as a reading.
3. **A missing capability and a missing night are different.** `missingSignals()` is only
   populated when the hardware channel genuinely does not reach the backend. A night with
   no RR data is a data gap and says so.
4. **Confidence propagates from the weakest necessary input**, not the mean, so one clean
   channel cannot launder three broken ones.
5. **A single estimator never earns the agreement bonus.** `fuse()` gives one contributor a
   fixed 0.5 agreement — it is a measurement, but it corroborates nothing.

## 4. Personal baselines

`baseline/service.js`. The central rule: **never compare a measurement against an all-day
average.** Evening skin temperature is legitimately warmer than 04:00; respiratory rate
awake is legitimately higher than asleep. An unconditioned baseline reports the circadian
rhythm as a health anomaly every single evening.

Observations are bucketed by condition — `sleep`, or `awake:<band>[:<activity>]` — and a
query is answered from the bucket matching its own condition, widening through
`awake:evening:exercise → awake:evening → awake → all` when the exact bucket is too thin.
`matchedCondition` and `widened` are reported, and widening reduces confidence, because an
answer from `all` is a weaker claim and must not look identical to an exact match.

Cold start blends toward a population prior with empirical-Bayes shrinkage,
`n/(n+K)` rescaled to reach 1.0 at the personalized threshold:

| Tier | Observation days | Source |
| --- | --- | --- |
| insufficient | < 3 | fewest at which a median and MAD mean anything |
| low | 3–13 | |
| moderate | 14–27 | `energy` `CALIBRATION.minTrainingDays` |
| personalized | ≥ 28 | `vo2` `windows.featureDays` |

The thresholds are the ones the codebase already used, so a user does not cross
"personalized" for one metric and "still learning" for another on different days. The
weight curve is smooth, so the displayed baseline never jumps on the morning a tier
changes, and evidence starts counting from the first observation rather than at day 3.

Everything is median/MAD-based. One contaminated night moves a mature baseline by roughly
one observation's worth instead of by its own magnitude.

**CUSUM must be given a reference period.** `baseline.shift()` centres it on the oldest
third of the window. Left to centre itself on the whole series, a shift occupying half the
window is undetectable at *any* magnitude: the median lands mid-shift and MAD grows in
proportion, pinning the standardised departure near 0.67. `tests/baseline.test.js` asserts
this explicitly so the design reason survives.

## 5. Overnight HRV

`hrv/engine.js`. RMSSD over 300 s windows, night value = **median of window values**.

RMSSD rather than SDNN or a frequency-domain index: it is a difference statistic, so it is
insensitive to the slow drift that dominates an overnight recording, and it is stable on
short windows where LF-band indices are not.

Median of windows rather than RMSSD pooled over the night, because pooling is wrong in a
way that matters — one arousal with a large RR step contributes its square to the total and
can double a pooled value. Per-window medians make that arousal one outlying window.

| Gate | Value | Why |
| --- | --- | --- |
| Window | 300 s | Standard short-term HRV unit |
| Min clean intervals | 30 | ~13% sampling error, at the edge of useful |
| Max artifact fraction | 0.2 | Artifacts inflate RMSSD specifically |
| Min windows | 3 | |
| Plausible range | 3–300 ms | Outside it, the beat detector failed |

Successive differences are taken only between intervals **adjacent in the original series**.
Differencing across a rejected interval would manufacture exactly the step that rejection
was meant to discard. A wild interval also invalidates its successor, since after a missed
beat the next boundary is not trustworthy either.

## 6. Respiratory rate

`respiration/`. Respiratory sinus arrhythmia: breathing modulates vagal outflow, which
modulates beat-to-beat interval, so breathing frequency appears as a peak in the RR
tachogram's spectrum.

**Lomb-Scargle, not resample-then-FFT.** An RR tachogram is inherently unevenly sampled —
one point per heartbeat. Interpolating onto a uniform grid to satisfy an FFT injects power
at the interpolation scale, which lands in the respiratory band and is precisely the thing
being measured.

| Gate | Value | Why |
| --- | --- | --- |
| Band | 0.1–0.5 Hz | 6–30 brpm. Wider than the HRV HF band, which was defined to isolate vagal tone and pushes paced/athlete breathing to its edge |
| Window | 120 s | Shortest that resolves 0.1 Hz |
| Min clean beats | 40 | The tachogram's sampling rate IS the heart rate |
| Min peak prominence | 0.18 | Below it, reporting the argmax would turn noise into a confident number |
| Motion ceiling | 0.12 g | Motion-induced RR jitter is indistinguishable from breathing by spectrum alone, so it is excluded by context |

Validated against synthetic RSA at known rates: recovers 8, 12, 15, 20 and 24 brpm to
within 0.6 brpm, and refuses an aperiodic tachogram rather than reporting its argmax.

The engine is structured as a confidence-weighted **fusion of four mechanisms**, of which
one has inputs. The three PPG-derived estimators (respiratory-induced intensity, amplitude
and frequency variation) are declared in `PPG_ESTIMATORS` with their requirements, not
stubbed. `describeEstimators()` reports 1-of-4 so a caller can tell a one-mechanism
estimate from a corroborated one, and every value carries `experimental: true` while
`usedCount < 2`. A stub returning a plausible number would be the single most damaging
thing in this module.

## 7. Determinism and provenance

Every engine is a pure function of its inputs — no I/O, no globals, no state between calls.
Reprocessing a night from the B2 archive reproduces the original numbers exactly, which is
what makes `recomputeFromStorage` meaningful and what the determinism tests assert.

Provenance is written at three levels of detail:

- `daily_metrics.hrv_rmssd_ms`, `resp_rate_bpm` — the scalars the app reads.
- `metric_runs.output_refs` — value, confidence, status and algorithm version per metric,
  plus `withheld_from_recovery`. A measurement that was taken and *not* used must be
  distinguishable from one never attempted, which a bare null cannot express.
- The derived B2 blob — full envelopes including every rejected window and its reason.

## 8. Recovery input gating

`MIN_RECOVERY_INPUT_CONFIDENCE = 0.4`. Recovery is a single number a user acts on and has no
way to express "this input was weak", so a low-confidence HRV is withheld from it and
recovery falls back to the terms it can trust. The envelope is still returned and still
persisted: the measurement is reported, it just does not drive a score.

An explicitly supplied `extras.hrv` **overrides** the measurement. A historical import
carries WHOOP's own on-device HRV, computed from the full-rate beat series, which is more
authoritative than a reconstruction from throttled RR notifications.

## 9. Fixed bugs

Two latent bugs were found while wiring this layer, both previously invisible.

**Recovery ran without HRV or respiratory rate.** `recoveryScore()` read `extras.hrv` and
`extras.resp`; no live caller ever set them. `daily_metrics.hrv_rmssd_ms` and
`resp_rate_bpm` were therefore always null and recovery ran on its sleep-performance term
alone. The ordering problem that caused it is real — both metrics must be measured inside
the detected sleep window, but recovery is scored while detecting it — and is now solved by
the injected provider in `metrics/overnight.js` rather than by detecting sleep twice.

**`sampleTime()` did not accept the `t` field.** `metrics/sleep.js` read
`datetime || at || ts` while the sleep *detector* and every other sample reader accept `t`
first. A caller passing archive-shaped samples straight to `scoreSleep` got a detected
night whose in-window statistics were computed from an empty set: null resting HR, empty HR
spark, no RR intervals. `persistComputed` masked it by copying `t` into `datetime` before
scoring, which is why nothing had failed.

## 10. Not built, and why

| Metric | Blocker |
| --- | --- |
| Skin-temperature deviation, circadian phase | Temperature is `reachable`, not available |
| SpO2 / desaturation | `reachable` only |
| PPG-based respiration (3 mechanisms) | Needs raw waveform |
| Sleep staging from IMU | Needs accelerometer XYZ; the current motion channel is a collapsed phone-derived magnitude |
| EDA-based stress | Absent from the hardware |

The unblocking work is an ingest change, not an analytics change. Ranked by cost:

1. **Backend frame decoder.** Raw frames are already archived. Decoding banked
   `HISTORICAL_DATA` yields temperature, respiratory rate, SpO2 and wear state at 1 Hz with
   no client change and no battery cost.
2. **Historical offload in the iOS client.** Same signals, live. Touches BLE command flow;
   the strap trims banked history once an offload is acked, so a decoder bug loses data
   permanently.
3. **Raw stream enable.** Unlocks PPG and the full IMU. Largest gain, largest battery cost;
   must be duty-cycled and must not block the HR path.
