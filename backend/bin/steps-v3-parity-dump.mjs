#!/usr/bin/env node
/**
 * Dump Steps V3 pipeline stages from Node for Python ↔ Node parity.
 * Reads JSON { accel_g: Nx3 } and writes the same keys as parity_dump.py.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { _internal } from '../metrics/stepsV3.js';

const gait = {
  min_interval_s: 0.28,
  max_interval_s: 1.2,
  min_steps: 2,
  min_peak_g: 0.018,
  adaptive_mad_multiplier: 0.5,
  minimum_width_seconds: 0.03,
  maximum_width_seconds: 0.5,
  interval_cv_max: 0.45,
  threshold_window_s: 1.2,
  threshold_mean_factor: 0.85,
  threshold_std_factor: 0.55,
};
const artifact = {
  sample_rate_hz: 100,
  preprocess: { highpass_hz: 0.7, lowpass_hz: 3.5 },
};

const inputPath = process.argv[2];
const outputPath = process.argv[3];
if (!inputPath || !outputPath) {
  process.stderr.write('usage: node steps-v3-parity-dump.mjs <input.json> <output.json>\n');
  process.exit(2);
}
const payload = JSON.parse(readFileSync(inputPath, 'utf8'));
const accel = payload.accel_g;
const xyz = accel;
const dynamic = _internal.bandpass(xyz.map(
  (sample) => Math.sqrt(sample[0] ** 2 + sample[1] ** 2 + sample[2] ** 2) - 1,
), artifact);
const published = _internal.publishedStyleSignal(xyz);
const width = 1000;
const stride = 100;
const features = [];
const temporal = [];
for (let start = 0; start + width <= dynamic.length; start += stride) {
  const slice = dynamic.slice(start, start + width);
  const feats = _internal.windowFeatures(slice, 100);
  features.push([
    feats.mean_abs, feats.std, feats.rms, feats.range, feats.jerk_rms,
    feats.zero_crossing_rate, feats.peak_rate_hz, feats.autocorr_strength, feats.dominant_hz,
  ]);
  temporal.push(1);
}
const adaptive = _internal.adaptivePeaks(dynamic, 100, gait).map((peak) => peak.index);
const publishedPeaks = _internal.publishedPeaks(published, 100, gait).map((peak) => peak.index);
const gate = _internal.gaitStateAtSamples(temporal, dynamic.length, {
  hopSamples: stride,
  windowSamples: width,
});
const gated = adaptive.filter((index) => gate[index]);
const dump = {
  n_samples: dynamic.length,
  dynamic: dynamic.map((value) => Math.round(value * 1e8) / 1e8),
  published_signal: published.map((value) => Math.round(value * 1e8) / 1e8),
  features,
  candidate_peaks_adaptive: adaptive,
  candidate_peaks_published: publishedPeaks,
  temporal_state: temporal,
  accepted_peak_indices: gated,
  final_count: gated.length,
};
writeFileSync(outputPath, `${JSON.stringify(dump, null, 2)}\n`);
