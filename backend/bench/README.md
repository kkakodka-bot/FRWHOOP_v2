# FRWHOOP Sleep Benchmark

Deterministic, labeled benchmark for the sleep detection + staging pipeline.

## Why this exists

The shipped tests prove *software consistency* (the golden hypnogram is a frozen
output, not ground truth). They say nothing about physiological accuracy. This
harness instead generates **labeled** 30-second epoch scenarios from a
physiology-consistent simulator, then measures how well each detector/stager
recovers the known labels using standard agreement metrics.

It is deliberately honest: these are SYNTHETIC scenarios, NOT PSG. They validate
software correctness, relative algorithm changes, boundary behaviour, nap
detection and wake-specificity — not absolute wrist-vs-PSG accuracy. That can
only come from a real WHOOP + PSG cohort (Phase 19), which does not exist yet.

## Scenarios (`scenarios.mjs`)

Every scenario is an explicit stage sequence (wake/light/deep/rem):
normal8, short4, long10, late, early, fragmented, overnight_wake, athlete,
high_resting, motionless_awake nights, and nap20 / nap45 / nap90 day naps.

## Simulator (`simulator.mjs`)

`simulateScenario` turns a stage sequence into 1 Hz gravity + HR + RR with a
**deterministic seeded PRNG** (mulberry32, default seed 20260810) so runs and
frozen baselines are reproducible. Gravity stays near 1 g and near-static in
sleep, moving in wake; HR has per-stage means + circadian drift; RR carries a
stage-dependent respiratory sinusoid.

## Metrics (`metrics.mjs`)

Per-epoch confusion matrix, Cohen kappa, macro F1, balanced accuracy, overall
accuracy, per-stage precision/recall/F1, sleep-wake confusion (sleep sensitivity
/ wake specificity), TST/wake/light/deep/rem minute errors, and window
onset/wake-time errors.

## Running

```
node bench/harness.mjs --freeze bench/frozen/baseline_v2.json   # all scenarios, freeze baseline
node bench/harness.mjs --variant hdcza --scenario normal8        # compare a detector variant
node bench/harness.mjs --all --variant current
```

## Frozen baseline

`frozen/baseline_v2.json` captures the CURRENT `SleepStagerV2` + rule detection
across all scenarios. Any future algorithm change is compared against it, and no
result may regress wake specificity without a written justification.

## Result summary (deterministic, synthetic, 10 nights + 3 naps)

| model | overall acc | kappa | macro F1 | staging wake spec | det wake spec | onset err (min) | wake err (min) |
|---|---|---|---|---|---|---|---|
| current (Van Hees + rules) | 0.822 | 0.618 | 0.714 | 0.966 | 0.910 | 30.7 | -9.7 |
| HDCZA | 0.808 | 0.595 | 0.730 | 0.958 | 0.633 | 4.7 | -38.2 |

HDCZA pinpoints sleep onset dramatically better but sacrifices wake specificity
because it bridges too permissively. The current detector's HR-confirm /
off-wrist / daytime / morning guards are what protect wake specificity — the
mission's stated priority. The production-recommended direction (Phase 6) is a
hybrid: HDCZA-style boundary refinement *inside* the current wake-specific
guards, not a wholesale replacement.

Naps: nap45 and nap90 are now detected by the dedicated nap detector (2/3 with
nap20 too short to separate sleep from sedentary rest). Both `current` and
`hdcza` detect 2/3.
