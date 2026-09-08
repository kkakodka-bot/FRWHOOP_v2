/**
 * FRWHOOP Steps V3 shadow runtime.
 *
 * This module is deterministic and side-effect free. It consumes decoded
 * frwhoop_imu_raw_v1 records plus optional day samples. Only accelerometer
 * arrays are required; all other streams are diagnostic evidence.
 */
import { createHash } from 'node:crypto';
import { sampleTime } from './steps.js';

export const STEPS_V3_VERSION = 'frwhoop-steps-v3-runtime-1';
export const STEPS_V3_ARTIFACT_SCHEMA = 'frwhoop_steps_v3_artifact_v1';
export const STEPS_V3_PUBLIC_MODEL_SCHEMA = 'frwhoop_steps_public_model_v3';

const ACCEL_SCALE_G_PER_LSB = 1 / 4096;
const GYRO_SCALE_DPS_PER_LSB = 2000 / 32768;
const IMU_ARCHIVE_SCHEMA = 'frwhoop_imu_raw_v1';
const FEATURE_NAMES = new Set([
  'mean_abs', 'std', 'rms', 'range', 'jerk_rms',
  'zero_crossing_rate', 'peak_rate_hz', 'autocorr_strength', 'dominant_hz',
]);
const MODEL_TYPES = new Set(['peak_baseline', 'logistic', 'cnn']);
const SMOOTHING_TYPES = new Set(['none', 'hysteresis', 'hmm']);

function finite(value) {
  return value != null && value !== '' && Number.isFinite(Number(value));
}

function finiteArray(value, length = null) {
  return Array.isArray(value)
    && (length == null || value.length === length)
    && value.every(finite);
}

function fail(reason) {
  return { ok: false, reason };
}

/** Validate the dependency-free inference contract before any input is read. */
export function validateStepsV3Artifact(artifact) {
  if (!artifact || typeof artifact !== 'object') return fail('artifact_missing');
  if (artifact.schema !== STEPS_V3_PUBLIC_MODEL_SCHEMA) return fail('artifact_public_schema_unsupported');
  if (artifact.schema_version !== STEPS_V3_ARTIFACT_SCHEMA) return fail('artifact_schema_unsupported');
  if (typeof artifact.artifact_version !== 'string' || !artifact.artifact_version.trim()) {
    return fail('artifact_version_missing');
  }
  if (artifact.sample_rate_hz !== 100) return fail('artifact_sample_rate_unsupported');
  const preprocess = artifact.preprocess || {};
  if (!finite(preprocess.highpass_hz) || !finite(preprocess.lowpass_hz)
      || Number(preprocess.highpass_hz) <= 0
      || Number(preprocess.lowpass_hz) <= Number(preprocess.highpass_hz)
      || Number(preprocess.lowpass_hz) >= artifact.sample_rate_hz / 2) {
    return fail('artifact_preprocess_invalid');
  }

  const window = artifact.window;
  if (!window || !Number.isInteger(window.size_samples) || window.size_samples < 20
      || !Number.isInteger(window.stride_samples) || window.stride_samples < 1
      || window.stride_samples > window.size_samples) {
    return fail('artifact_window_invalid');
  }
  if (!finite(window.decision_threshold)
      || Number(window.decision_threshold) <= 0
      || Number(window.decision_threshold) >= 1) {
    return fail('artifact_threshold_invalid');
  }

  const coverage = artifact.coverage;
  if (!coverage || !finite(coverage.min_imu_seconds) || Number(coverage.min_imu_seconds) < 0
      || !Number.isInteger(coverage.min_windows) || coverage.min_windows < 1
      || !finite(coverage.min_day_ratio) || Number(coverage.min_day_ratio) < 0
      || Number(coverage.min_day_ratio) > 1) {
    return fail('artifact_coverage_invalid');
  }

  const gait = artifact.gait;
  if (!gait || !finite(gait.min_interval_s) || !finite(gait.max_interval_s)
      || Number(gait.min_interval_s) <= 0
      || Number(gait.max_interval_s) <= Number(gait.min_interval_s)
      || !Number.isInteger(gait.min_steps) || gait.min_steps < 2
      || !finite(gait.min_peak_g) || Number(gait.min_peak_g) <= 0
      || !finite(gait.interval_cv_max) || Number(gait.interval_cv_max) <= 0
      || ![gait.threshold_window_s ?? 1.2, gait.threshold_mean_factor ?? 0.85,
        gait.threshold_std_factor ?? 0.55].every((value) => finite(value) && Number(value) >= 0)) {
    return fail('artifact_gait_invalid');
  }
  if (![gait.adaptive_mad_multiplier ?? 0.5, gait.minimum_width_seconds ?? 0,
    gait.maximum_width_seconds ?? 1].every((value) => finite(value) && Number(value) >= 0)
      || Number(gait.maximum_width_seconds ?? 1) <= Number(gait.minimum_width_seconds ?? 0)) {
    return fail('artifact_gait_invalid');
  }

  const model = artifact.model;
  if (!model || !MODEL_TYPES.has(model.type)) return fail('artifact_model_unsupported');
  if (model.type === 'peak_baseline'
      && (!finite(model.minimum_interval_seconds ?? gait.min_interval_s)
        || Number(model.minimum_interval_seconds ?? gait.min_interval_s) <= 0
        || !finite(model.minimum_rms_g ?? gait.min_peak_g)
        || Number(model.minimum_rms_g ?? gait.min_peak_g) <= 0)) {
    return fail('artifact_peak_baseline_parameters_invalid');
  }
  if (model.type === 'logistic') {
    if (!Array.isArray(model.features) || !model.features.length
        || !model.features.every((name) => FEATURE_NAMES.has(name))) {
      return fail('artifact_logistic_features_invalid');
    }
    const n = model.features.length;
    if (!finiteArray(model.weights, n) || !finiteArray(model.mean, n)
        || !finiteArray(model.scale, n) || model.scale.some((v) => Number(v) <= 0)
        || !finite(model.bias)) {
      return fail('artifact_logistic_parameters_invalid');
    }
  }
  if (model.type === 'cnn') {
    if (model.input === 'xyz_g' && Array.isArray(model.layers)) {
      let channels = 3;
      let outputSamples = window.size_samples;
      let pooled = false;
      for (const layer of model.layers) {
        if (layer?.type === 'Conv1d') {
          const weights = layer.weight;
          const bias = layer.bias;
          const stride = Number(layer.stride?.[0] ?? 1);
          const padding = Number(layer.padding?.[0] ?? 0);
          const kernelSize = Number(layer.kernel_size?.[0] ?? weights?.[0]?.[0]?.length);
          if (!Array.isArray(weights) || !weights.length || !finiteArray(bias, weights.length)
              || !Number.isInteger(stride) || stride < 1
              || !Number.isInteger(padding) || padding < 0
              || !Number.isInteger(kernelSize) || kernelSize < 1
              || !weights.every((filter) => Array.isArray(filter)
                && filter.length === channels
                && filter.every((kernel) => finiteArray(kernel, kernelSize)))) {
            return fail('artifact_cnn_layer_invalid');
          }
          outputSamples = Math.floor((outputSamples + 2 * padding - kernelSize) / stride) + 1;
          if (outputSamples < 1) return fail('artifact_cnn_receptive_field_invalid');
          channels = weights.length;
        } else if (layer?.type === 'ReLU' || layer?.type === 'Flatten') {
          // Shape-preserving.
        } else if (layer?.type === 'AdaptiveAvgPool1d') {
          pooled = true;
          outputSamples = 1;
        } else if (layer?.type === 'Linear') {
          const inputSize = pooled ? channels : channels * outputSamples;
          if (!Array.isArray(layer.weight) || layer.weight.length !== 1
              || !finiteArray(layer.weight[0], inputSize)
              || !finiteArray(layer.bias, 1)) {
            return fail('artifact_cnn_output_invalid');
          }
          channels = 1;
          outputSamples = 1;
          pooled = true;
        } else {
          return fail('artifact_cnn_layer_invalid');
        }
      }
      if (channels !== 1 || outputSamples !== 1) return fail('artifact_cnn_output_invalid');
    } else {
      if (!Array.isArray(model.conv_layers) || !model.conv_layers.length
          || !finite(model.input_mean) || !finite(model.input_scale)
          || Number(model.input_scale) <= 0) {
        return fail('artifact_cnn_input_invalid');
      }
    let inChannels = 1;
    let outputSamples = window.size_samples;
    for (const layer of model.conv_layers) {
      if (!Array.isArray(layer?.weights) || !layer.weights.length
          || !finiteArray(layer.bias, layer.weights.length)
          || !['relu', 'tanh', 'linear'].includes(layer.activation || 'linear')) {
        return fail('artifact_cnn_layer_invalid');
      }
      const kernelSize = layer.weights[0]?.length;
      if (!Number.isInteger(kernelSize) || kernelSize < 1) return fail('artifact_cnn_kernel_invalid');
      outputSamples -= kernelSize - 1;
      if (outputSamples < 1) return fail('artifact_cnn_receptive_field_invalid');
      for (const filter of layer.weights) {
        if (!Array.isArray(filter) || filter.length !== kernelSize
            || !filter.every((tap) => finiteArray(tap, inChannels))) {
          return fail('artifact_cnn_weights_invalid');
        }
      }
      inChannels = layer.weights.length;
    }
    if (!model.output || !finiteArray(model.output.weights, inChannels)
        || !finite(model.output.bias)) {
      return fail('artifact_cnn_output_invalid');
    }
    }
  }

  const smoothing = artifact.smoothing || { type: 'none' };
  if (!SMOOTHING_TYPES.has(smoothing.type)) return fail('artifact_smoothing_unsupported');
  if (![smoothing.minimum_bout_windows ?? 1, smoothing.bridge_gap_windows ?? 0]
    .every((value) => Number.isInteger(Number(value)) && Number(value) >= 0)) {
    return fail('artifact_smoothing_parameters_invalid');
  }
  if (smoothing.type === 'hysteresis'
      && (!finite(smoothing.enter) || !finite(smoothing.exit)
        || Number(smoothing.enter) < Number(smoothing.exit)
        || Number(smoothing.enter) > 1 || Number(smoothing.exit) < 0)) {
    return fail('artifact_hysteresis_invalid');
  }
  if (smoothing.type === 'hmm') {
    const transition = smoothing.transition;
    if (!Array.isArray(transition) || transition.length !== 2
        || !transition.every((row) => finiteArray(row, 2)
          && row.every((v) => Number(v) > 0 && Number(v) < 1)
          && Math.abs(Number(row[0]) + Number(row[1]) - 1) < 1e-6)
        || !finiteArray(smoothing.initial, 2)
        || smoothing.initial.some((v) => Number(v) <= 0 || Number(v) >= 1)
        || Math.abs(Number(smoothing.initial[0]) + Number(smoothing.initial[1]) - 1) >= 1e-6) {
      return fail('artifact_hmm_invalid');
    }
  }
  if (!/^[a-f0-9]{64}$/i.test(String(artifact.artifact_sha256 || ''))) {
    return fail('artifact_sha256_missing_or_invalid');
  }
  if (stepsV3ArtifactSha(artifact) !== String(artifact.artifact_sha256).toLowerCase()) {
    return fail('artifact_sha256_mismatch');
  }
  return { ok: true, artifact };
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(
      (key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`,
    ).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function stepsV3ArtifactSha(artifact) {
  if (!artifact || typeof artifact !== 'object') return null;
  const {
    artifact_sha256: _claimed,
    created_at_utc: _buildTimestamp,
    ...payload
  } = artifact;
  return createHash('sha256').update(canonicalJson(payload)).digest('hex');
}

function clamp01(value) {
  return Math.max(0, Math.min(1, value));
}

function sigmoid(value) {
  if (value >= 0) {
    const z = Math.exp(-value);
    return 1 / (1 + z);
  }
  const z = Math.exp(value);
  return z / (1 + z);
}

function mean(values) {
  if (!values.length) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function median(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function std(values) {
  const m = mean(values);
  return Math.sqrt(mean(values.map((value) => (value - m) ** 2)));
}

function dominantPeriodS(series, fs, minS, maxS) {
  const n = series.length;
  if (n < fs * 2) return null;
  const minLag = Math.max(1, Math.round(minS * fs));
  const maxLag = Math.min(Math.floor(n / 2), Math.round(maxS * fs));
  const center = mean(series);
  let bestLag = 0;
  let best = -1;
  for (let lag = minLag; lag <= maxLag; lag += 1) {
    let numerator = 0;
    let denominatorA = 0;
    let denominatorB = 0;
    for (let index = 0; index < n - lag; index += 1) {
      const first = series[index] - center;
      const second = series[index + lag] - center;
      numerator += first * second;
      denominatorA += first * first;
      denominatorB += second * second;
    }
    const denominator = Math.sqrt(denominatorA * denominatorB);
    if (!(denominator > 0)) continue;
    const correlation = numerator / denominator;
    if (correlation > best) {
      best = correlation;
      bestLag = lag;
    }
  }
  if (best < 0.25 || !bestLag) return null;
  return {
    periodS: bestLag / fs,
    strength: best,
    freqHz: fs / bestLag,
  };
}

function rms(values) {
  return Math.sqrt(mean(values.map((value) => value * value)));
}

function cv(values) {
  const m = mean(values);
  return m > 0 ? std(values) / m : Infinity;
}

function iirHighPass(values, fc, fs) {
  const out = new Array(values.length).fill(0);
  if (!values.length) return out;
  const dt = 1 / fs;
  const rc = 1 / (2 * Math.PI * fc);
  const alpha = rc / (rc + dt);
  let prevX = values[0];
  for (let i = 1; i < values.length; i += 1) {
    out[i] = alpha * (out[i - 1] + values[i] - prevX);
    prevX = values[i];
  }
  return out;
}

function iirLowPass(values, fc, fs) {
  const out = new Array(values.length).fill(0);
  if (!values.length) return out;
  const dt = 1 / fs;
  const rc = 1 / (2 * Math.PI * fc);
  const alpha = dt / (rc + dt);
  out[0] = values[0];
  for (let i = 1; i < values.length; i += 1) {
    out[i] = out[i - 1] + alpha * (values[i] - out[i - 1]);
  }
  return out;
}

function bandpass(values, artifact) {
  const high = Number(artifact.preprocess?.highpass_hz ?? 0.45);
  const low = Number(artifact.preprocess?.lowpass_hz ?? 3.6);
  return iirLowPass(iirHighPass(values, high, artifact.sample_rate_hz), low, artifact.sample_rate_hz);
}

function accelMagnitude(segment) {
  const n = Math.min(segment.ax.length, segment.ay.length, segment.az.length);
  const values = new Array(n);
  for (let i = 0; i < n; i += 1) {
    const x = Number(segment.ax[i]) * segment.accelScale;
    const y = Number(segment.ay[i]) * segment.accelScale;
    const z = Number(segment.az[i]) * segment.accelScale;
    values[i] = Math.sqrt(x * x + y * y + z * z);
  }
  return values;
}

function accelXyz(segment) {
  const n = Math.min(segment.ax.length, segment.ay.length, segment.az.length);
  return Array.from({ length: n }, (_, index) => [
    Number(segment.ax[index]) * segment.accelScale,
    Number(segment.ay[index]) * segment.accelScale,
    Number(segment.az[index]) * segment.accelScale,
  ]);
}

function localPeaks(values, minHeight = 0) {
  const peaks = [];
  for (let i = 1; i < values.length - 1; i += 1) {
    if (values[i] > minHeight && values[i] > values[i - 1] && values[i] >= values[i + 1]) {
      peaks.push(i);
    }
  }
  return peaks;
}

function windowFeatures(values, fs) {
  const m = mean(values);
  const centered = values.map((value) => value - m);
  const jerk = [];
  let crossings = 0;
  for (let i = 1; i < centered.length; i += 1) {
    jerk.push((centered[i] - centered[i - 1]) * fs);
    if ((centered[i] >= 0) !== (centered[i - 1] >= 0)) crossings += 1;
  }
  const dominant = dominantPeriodS(values, fs, 0.28, 1.2);
  const peaks = localPeaks(values, Math.max(0.02, std(values) * 0.35));
  return {
    mean_abs: mean(values.map(Math.abs)),
    std: std(values),
    rms: rms(values),
    range: values.length ? Math.max(...values) - Math.min(...values) : 0,
    jerk_rms: rms(jerk),
    zero_crossing_rate: centered.length > 1 ? crossings * fs / (centered.length - 1) : 0,
    peak_rate_hz: values.length ? peaks.length * fs / values.length : 0,
    autocorr_strength: dominant?.strength ?? 0,
    dominant_hz: dominant?.freqHz ?? 0,
  };
}

function logisticProbability(values, model, fs) {
  const features = windowFeatures(values, fs);
  let score = Number(model.bias);
  for (let i = 0; i < model.features.length; i += 1) {
    const normalized = (features[model.features[i]] - Number(model.mean[i])) / Number(model.scale[i]);
    score += normalized * Number(model.weights[i]);
  }
  return sigmoid(score);
}

function activate(value, name) {
  if (name === 'relu') return Math.max(0, value);
  if (name === 'tanh') return Math.tanh(value);
  return value;
}

function conv1d(input, layer) {
  const kernelSize = layer.weights[0].length;
  const outLength = input.length - kernelSize + 1;
  if (outLength <= 0) return [];
  const output = new Array(outLength);
  for (let t = 0; t < outLength; t += 1) {
    output[t] = layer.weights.map((filter, outChannel) => {
      let sum = Number(layer.bias[outChannel]);
      for (let k = 0; k < kernelSize; k += 1) {
        for (let c = 0; c < input[t + k].length; c += 1) {
          sum += input[t + k][c] * Number(filter[k][c]);
        }
      }
      return activate(sum, layer.activation || 'linear');
    });
  }
  return output;
}

function cnnProbability(values, model) {
  let activation = values.map((value) => [
    (value - Number(model.input_mean)) / Number(model.input_scale),
  ]);
  for (const layer of model.conv_layers) activation = conv1d(activation, layer);
  if (!activation.length) return 0;
  const pooled = activation[0].map((_, channel) => mean(activation.map((row) => row[channel])));
  let score = Number(model.output.bias);
  for (let i = 0; i < pooled.length; i += 1) score += pooled[i] * Number(model.output.weights[i]);
  return sigmoid(score);
}

function pytorchConv1d(input, layer) {
  const stride = Number(layer.stride?.[0] ?? 1);
  const padding = Number(layer.padding?.[0] ?? 0);
  const kernelSize = Number(layer.kernel_size?.[0] ?? layer.weight[0][0].length);
  const outputLength = Math.floor((input.length + 2 * padding - kernelSize) / stride) + 1;
  return Array.from({ length: Math.max(0, outputLength) }, (_, outputIndex) => (
    layer.weight.map((filter, outputChannel) => {
      let sum = Number(layer.bias[outputChannel]);
      for (let inputChannel = 0; inputChannel < filter.length; inputChannel += 1) {
        for (let kernelIndex = 0; kernelIndex < kernelSize; kernelIndex += 1) {
          const inputIndex = outputIndex * stride + kernelIndex - padding;
          if (inputIndex >= 0 && inputIndex < input.length) {
            sum += Number(input[inputIndex][inputChannel])
              * Number(filter[inputChannel][kernelIndex]);
          }
        }
      }
      return sum;
    })
  ));
}

function pytorchCnnProbability(windowXyz, model) {
  let activation = windowXyz.map((sample) => sample.map(Number));
  for (const layer of model.layers) {
    if (layer.type === 'Conv1d') {
      activation = pytorchConv1d(activation, layer);
    } else if (layer.type === 'ReLU') {
      activation = activation.map((row) => row.map((value) => Math.max(0, value)));
    } else if (layer.type === 'AdaptiveAvgPool1d') {
      activation = [activation[0].map(
        (_, channel) => mean(activation.map((row) => row[channel])),
      )];
    } else if (layer.type === 'Flatten') {
      activation = [activation.flat()];
    } else if (layer.type === 'Linear') {
      const input = activation.flat();
      activation = [layer.weight.map(
        (weights, output) => Number(layer.bias[output])
          + weights.reduce((sum, weight, index) => sum + Number(weight) * input[index], 0),
      )];
    }
  }
  return sigmoid(Number(activation.flat()[0] ?? 0));
}

function peakBaselineProbability(values, artifact) {
  const features = windowFeatures(values, artifact.sample_rate_hz);
  const minimumInterval = Number(
    artifact.model?.minimum_interval_seconds ?? artifact.gait.min_interval_s,
  );
  const minimumRms = Number(artifact.model?.minimum_rms_g ?? artifact.gait.min_peak_g);
  const inBand = features.dominant_hz >= 1 / Number(artifact.gait.max_interval_s)
    && features.dominant_hz <= 1 / minimumInterval;
  const enough = features.peak_rate_hz >= 0.8 && features.rms >= minimumRms;
  return inBand && enough ? 0.95 : 0.05;
}

export function inferGaitProbability(values, artifact, windowXyz = null) {
  if (artifact.model.type === 'logistic') {
    return logisticProbability(values, artifact.model, artifact.sample_rate_hz);
  }
  if (artifact.model.type === 'cnn') {
    if (artifact.model.input === 'xyz_g') return pytorchCnnProbability(windowXyz || [], artifact.model);
    return cnnProbability(values, artifact.model);
  }
  return peakBaselineProbability(values, artifact);
}

/** Convert per-window probabilities to deterministic gait labels. */
export function smoothGaitProbabilities(probabilities, smoothing, threshold) {
  if (!probabilities.length) return [];
  if (!smoothing || smoothing.type === 'none') {
    return probabilities.map((probability) => probability >= threshold);
  }
  if (smoothing.type === 'hysteresis') {
    let active = false;
    return probabilities.map((probability) => {
      if (!active && probability >= Number(smoothing.enter)) active = true;
      else if (active && probability < Number(smoothing.exit)) active = false;
      return active;
    });
  }

  const transition = smoothing.transition.map((row) => row.map((value) => Math.log(Number(value))));
  const initial = smoothing.initial.map((value) => Math.log(Number(value)));
  const score = probabilities.map(() => [Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY]);
  const back = probabilities.map(() => [0, 0]);
  const emission = (probability, state) => Math.log(Math.max(1e-12, state ? probability : 1 - probability));
  score[0][0] = initial[0] + emission(probabilities[0], 0);
  score[0][1] = initial[1] + emission(probabilities[0], 1);
  for (let i = 1; i < probabilities.length; i += 1) {
    for (let state = 0; state < 2; state += 1) {
      const from0 = score[i - 1][0] + transition[0][state];
      const from1 = score[i - 1][1] + transition[1][state];
      back[i][state] = from1 > from0 ? 1 : 0;
      score[i][state] = Math.max(from0, from1) + emission(probabilities[i], state);
    }
  }
  const labels = new Array(probabilities.length);
  labels[labels.length - 1] = score.at(-1)[1] > score.at(-1)[0] ? 1 : 0;
  for (let i = labels.length - 1; i > 0; i -= 1) labels[i - 1] = back[i][labels[i]];
  return labels.map(Boolean);
}

function smoothWindowBouts(labels, smoothing) {
  const output = labels.map(Boolean);
  const bridge = Number(smoothing?.bridge_gap_windows ?? 0);
  const minimum = Number(smoothing?.minimum_bout_windows ?? 1);
  for (const [value, limit, replacement] of [
    [false, bridge, true],
    [true, minimum - 1, false],
  ]) {
    let start = 0;
    while (start < output.length) {
      let end = start + 1;
      while (end < output.length && output[end] === output[start]) end += 1;
      const bounded = start > 0 && end < output.length;
      if (output[start] === value && end - start <= limit && (value || bounded)) {
        for (let index = start; index < end; index += 1) output[index] = replacement;
      }
      start = end;
    }
  }
  return output;
}

function parseTime(value) {
  if (finite(value)) {
    const n = Number(value);
    return n > 1e12 ? n : n * 1000;
  }
  const parsed = Date.parse(value || '');
  return Number.isFinite(parsed) ? parsed : null;
}

function sensorRecordTime(record) {
  const raw = record?.sensor_ts ?? record?.unix ?? record?.timestamp;
  const base = parseTime(raw);
  if (!Number.isFinite(base)) return null;
  const numeric = Number(raw);
  const subsec = Number(record?.subsec ?? record?.subseconds);
  return base + (numeric <= 1e12 && Number.isFinite(subsec) && subsec >= 0 && subsec < 32768
    ? subsec / 32768 * 1000
    : 0);
}

function correctedRecordTime(record) {
  const corrected = [
    record?.corrected_at, record?.corrected_timestamp, record?.corrected_sensor_ts,
  ].map(parseTime).find(Number.isFinite);
  if (Number.isFinite(corrected)) return { timeMs: corrected, corrected: true };
  const direct = [
    record?.event_at, record?.t, record?.datetime,
  ].map(parseTime).find(Number.isFinite);
  if (Number.isFinite(direct)) return { timeMs: direct, corrected: false };
  const sensor = sensorRecordTime(record);
  const offset = Number(record?.clock_offset_sec);
  if (Number.isFinite(sensor) && finite(record?.clock_offset_sec)) {
    return { timeMs: sensor + offset * 1000, corrected: true };
  }
  return { timeMs: sensor, corrected: false };
}

function prepareRecords(records) {
  const clock = {
    records: 0,
    corrected_records: 0,
    timestamp_verified_records: 0,
    verified_records: 0,
    unverified_records: 0,
    manifest_verified_records: 0,
    manifest_unverified_records: 0,
  };
  const manifestShas = new Set();
  const prepared = [];
  for (const record of records || []) {
    const resolved = correctedRecordTime(record);
    if (!Number.isFinite(resolved.timeMs)) continue;
    const timestampVerified = record?.timestamp_verified === true;
    const verified = record?.clock_verified === true
      || record?.time?.verified === true;
    clock.records += 1;
    if (resolved.corrected) clock.corrected_records += 1;
    if (timestampVerified) clock.timestamp_verified_records += 1;
    if (verified) clock.verified_records += 1;
    else clock.unverified_records += 1;
    const manifestSha = String(record?._manifest_sha256 || '').trim().toLowerCase();
    if (record?._manifest_verified === true && /^[a-f0-9]{64}$/.test(manifestSha)) {
      manifestShas.add(manifestSha);
      clock.manifest_verified_records += 1;
    } else {
      clock.manifest_unverified_records += 1;
    }
    prepared.push({ ...record, sensor_ts: resolved.timeMs });
  }
  clock.quality = clock.records > 0 && clock.verified_records === clock.records
    ? 'verified'
    : (clock.corrected_records === clock.records && clock.records > 0 ? 'corrected_unverified' : 'unverified');
  return { records: prepared, clock, manifestShas: [...manifestShas].sort() };
}

function recordDigest(record, timeMs) {
  return createHash('sha256').update(canonicalJson({
    time_ms: timeMs,
    sample_rate_hz: record?.sample_rate_hz ?? 100,
    accel_x: record?.accel_x,
    accel_y: record?.accel_y,
    accel_z: record?.accel_z,
    gyro_x: record?.gyro_x ?? null,
    gyro_y: record?.gyro_y ?? null,
    gyro_z: record?.gyro_z ?? null,
    accel_scale: record?.accel?.scale_g_per_lsb ?? ACCEL_SCALE_G_PER_LSB,
    gyro_scale: record?.gyro?.scale_dps_per_lsb ?? GYRO_SCALE_DPS_PER_LSB,
  })).digest('hex');
}

function interpolateSeries(times, values, grid) {
  const output = new Array(grid.length);
  let left = 0;
  for (let index = 0; index < grid.length; index += 1) {
    const target = grid[index];
    while (left + 1 < times.length && times[left + 1] < target) left += 1;
    if (left + 1 >= times.length || times[left] === target) {
      output[index] = values[left];
      continue;
    }
    const width = times[left + 1] - times[left];
    const fraction = width > 0 ? (target - times[left]) / width : 0;
    output[index] = values[left] + (values[left + 1] - values[left]) * fraction;
  }
  return output;
}

/**
 * Convert archive records to deterministic calibrated-g 100 Hz segments.
 * Small timing jitter/dropouts are interpolated only up to 250 ms; material
 * gaps reset filter, classifier, and bout state.
 */
function imuRecordsToV3Segments(records, {
  startMs = null,
  endMs = null,
  sampleRateHz = 100,
  gapThresholdMs = 250,
} = {}) {
  const integrity = {
    input_records: 0,
    accepted_records: 0,
    unsupported_rate_records: 0,
    duplicate_records: 0,
    conflicting_records: 0,
    overlap_samples_dropped: 0,
  };
  const normalized = [];
  for (const record of records || []) {
    if (!record || (record.schema != null && record.schema !== IMU_ARCHIVE_SCHEMA)) continue;
    const n = Array.isArray(record.accel_x) ? record.accel_x.length : 0;
    if (n < 20 || !Array.isArray(record.accel_y) || !Array.isArray(record.accel_z)
        || record.accel_y.length !== n || record.accel_z.length !== n) continue;
    const t0 = Number(record.sensor_ts);
    if (!Number.isFinite(t0)) continue;
    integrity.input_records += 1;
    const explicitRate = Number(record.sample_rate_hz);
    if (!Number.isFinite(explicitRate)
        || explicitRate <= 0
        || Math.abs(explicitRate - sampleRateHz) > 1e-6) {
      integrity.unsupported_rate_records += 1;
      continue;
    }
    const rate = explicitRate;
    const durationMs = n / rate * 1000;
    if (startMs != null && t0 + durationMs <= Number(startMs)) continue;
    if (endMs != null && t0 >= Number(endMs)) continue;
    normalized.push({
      record,
      t0,
      rate,
      n,
      digest: recordDigest(record, t0),
      accelScale: finite(record?.accel?.scale_g_per_lsb)
        ? Number(record.accel.scale_g_per_lsb) : ACCEL_SCALE_G_PER_LSB,
      gyroScale: finite(record?.gyro?.scale_dps_per_lsb)
        ? Number(record.gyro.scale_dps_per_lsb) : GYRO_SCALE_DPS_PER_LSB,
      hasGyro: Array.isArray(record.gyro_x) && record.gyro_x.length === n
        && Array.isArray(record.gyro_y) && record.gyro_y.length === n
        && Array.isArray(record.gyro_z) && record.gyro_z.length === n,
    });
  }
  normalized.sort((a, b) => a.t0 - b.t0 || a.digest.localeCompare(b.digest));

  const seenRecords = new Map();
  const unique = [];
  for (const row of normalized) {
    const key = `${row.t0}:${row.n}`;
    const previous = seenRecords.get(key);
    if (previous === row.digest) {
      integrity.duplicate_records += 1;
      continue;
    }
    if (previous) integrity.conflicting_records += 1;
    else seenRecords.set(key, row.digest);
    unique.push(row);
  }

  const sourceSegments = [];
  let current = null;
  const flush = () => {
    if (current?.times.length) sourceSegments.push(current);
    current = null;
  };
  for (const row of unique) {
    const dtMs = 1000 / row.rate;
    let used = false;
    for (let index = 0; index < row.n; index += 1) {
      const timestamp = row.t0 + index * dtMs;
      if (startMs != null && timestamp < Number(startMs)) continue;
      if (endMs != null && timestamp >= Number(endMs)) break;
      const last = current?.times.at(-1);
      if (Number.isFinite(last) && timestamp <= last + dtMs * 0.5) {
        integrity.overlap_samples_dropped += 1;
        continue;
      }
      if (Number.isFinite(last) && timestamp - last > gapThresholdMs) flush();
      if (!current) {
        current = {
          times: [], ax: [], ay: [], az: [], gx: [], gy: [], gz: [],
          gyroPresent: true, layouts: new Set(),
        };
      }
      current.times.push(timestamp);
      current.ax.push(Number(row.record.accel_x[index]) * row.accelScale);
      current.ay.push(Number(row.record.accel_y[index]) * row.accelScale);
      current.az.push(Number(row.record.accel_z[index]) * row.accelScale);
      current.gx.push(row.hasGyro ? Number(row.record.gyro_x[index]) * row.gyroScale : 0);
      current.gy.push(row.hasGyro ? Number(row.record.gyro_y[index]) * row.gyroScale : 0);
      current.gz.push(row.hasGyro ? Number(row.record.gyro_z[index]) * row.gyroScale : 0);
      current.gyroPresent = current.gyroPresent && row.hasGyro;
      current.layouts.add(row.record.layout || row.record.kind || 'unknown');
      used = true;
    }
    if (used) integrity.accepted_records += 1;
  }
  flush();

  const stepMs = 1000 / sampleRateHz;
  const segments = sourceSegments.map((source) => {
    const first = source.times[0];
    const last = source.times.at(-1);
    const gridStart = Math.ceil((first - 1e-6) / stepMs) * stepMs;
    const gridEnd = Math.floor((last + 1e-6) / stepMs) * stepMs;
    const count = gridEnd >= gridStart ? Math.floor((gridEnd - gridStart) / stepMs) + 1 : 0;
    const grid = Array.from({ length: count }, (_, index) => gridStart + index * stepMs);
    return {
      t0: gridStart,
      endMs: gridStart + count * stepMs,
      ax: interpolateSeries(source.times, source.ax, grid),
      ay: interpolateSeries(source.times, source.ay, grid),
      az: interpolateSeries(source.times, source.az, grid),
      gx: interpolateSeries(source.times, source.gx, grid),
      gy: interpolateSeries(source.times, source.gy, grid),
      gz: interpolateSeries(source.times, source.gz, grid),
      fs: sampleRateHz,
      gyroPresent: source.gyroPresent,
      accelScale: 1,
      gyroScale: 1,
      layouts: source.layouts,
    };
  }).filter((segment) => segment.ax.length);
  return { segments, integrity };
}

function adaptivePeaks(values, fs, gait) {
  const peaks = [];
  const radius = Math.max(5, Math.round(Number(gait.threshold_window_s ?? 1.2) * fs));
  const refractory = Math.max(1, Math.round(Number(gait.min_interval_s) * fs));
  let last = -refractory;
  for (let i = 2; i < values.length - 2; i += 1) {
    if (i - last < refractory || values[i] <= values[i - 1] || values[i] < values[i + 1]) continue;
    const lo = Math.max(0, i - radius);
    const hi = Math.min(values.length, i + radius + 1);
    const localValues = values.slice(lo, hi);
    const localAbs = localValues.map(Math.abs);
    const localMedian = median(localValues);
    const robustSigma = median(
      localValues.map((value) => Math.abs(value - localMedian)),
    ) / 0.67448975;
    const prominence = values[i] - Math.max(
      Math.min(...values.slice(lo, i + 1)),
      Math.min(...values.slice(i, hi)),
    );
    const minimumProminence = Math.max(
      Number(gait.min_peak_g),
      Number(gait.adaptive_mad_multiplier ?? 0.5) * robustSigma,
    );
    const amplitudeThreshold = mean(localAbs) * Number(gait.threshold_mean_factor ?? 0.85)
      + std(localAbs) * Number(gait.threshold_std_factor ?? 0.55);
    if (values[i] < amplitudeThreshold || prominence < minimumProminence) continue;
    const halfProminence = values[i] - prominence / 2;
    let left = i;
    let right = i;
    while (left > lo && values[left] > halfProminence) left -= 1;
    while (right + 1 < hi && values[right] > halfProminence) right += 1;
    const widthSeconds = (right - left) / fs;
    if (widthSeconds < Number(gait.minimum_width_seconds ?? 0)
        || widthSeconds > Number(gait.maximum_width_seconds ?? Number.POSITIVE_INFINITY)) continue;
    peaks.push({
      index: i,
      amplitude: values[i],
      prominence,
      width_s: widthSeconds,
    });
    last = i;
  }
  return peaks;
}

function mergeIntervals(windows, labels) {
  const intervals = [];
  for (let i = 0; i < windows.length; i += 1) {
    if (!labels[i]) continue;
    const current = { start_ms: windows[i].startMs, end_ms: windows[i].endMs };
    const previous = intervals.at(-1);
    if (previous && current.start_ms <= previous.end_ms) {
      previous.end_ms = Math.max(previous.end_ms, current.end_ms);
    } else {
      intervals.push(current);
    }
  }
  return intervals;
}

/** Banker's rounding so Node matches numpy rint used by gait_state_at_samples. */
function rint(value) {
  const floor = Math.floor(value);
  const fraction = value - floor;
  if (fraction < 0.5) return floor;
  if (fraction > 0.5) return floor + 1;
  return floor % 2 === 0 ? floor : floor + 1;
}

/**
 * Assign gait to the 1 s window-center timeline. A peak is gated by the
 * gait state at its timestamp, not by unioning the full 10 s support of
 * every positive window.
 */
function gaitStateAtSamples(labels, sampleCount, {
  hopSamples = 100,
  windowSamples = 1000,
} = {}) {
  const gate = new Array(Math.max(0, sampleCount)).fill(false);
  const n = labels.length;
  if (!n || sampleCount <= 0) return gate;
  const half = Math.trunc(windowSamples / 2);
  const stride = Math.max(1, hopSamples);
  for (let i = 0; i < sampleCount; i += 1) {
    const nearest = Math.min(n - 1, Math.max(0, rint((i - half) / stride)));
    gate[i] = Boolean(labels[nearest]);
  }
  return gate;
}

const PUBLISHED_BUTTERWORTH_SOS = [
  [4.1659920440659937e-04, 8.3319840881319873e-04, 4.1659920440659937e-04, 1.0, -1.4796742169311934, 0.5558215432824889],
  [1.0, 2.0, 1.0, 1.0, -1.7009643319435257, 0.7884997398152979],
];

function sosfilt(sos, values) {
  let current = values.slice();
  for (const [b0, b1, b2, , a1, a2] of sos) {
    let z1 = 0;
    let z2 = 0;
    const next = new Array(current.length);
    for (let i = 0; i < current.length; i += 1) {
      const x = current[i];
      const y = b0 * x + z1;
      z1 = b1 * x - a1 * y + z2;
      z2 = b2 * x - a2 * y;
      next[i] = y;
    }
    current = next;
  }
  return current;
}

function oddPad(values, pad) {
  if (!values.length) return values.slice();
  const left = [];
  const right = [];
  for (let i = 0; i < pad; i += 1) {
    const li = Math.min(values.length - 1, i + 1);
    const ri = Math.max(0, values.length - 2 - i);
    left.push(2 * values[0] - values[li]);
    right.push(2 * values.at(-1) - values[ri]);
  }
  return [...left.reverse(), ...values, ...right];
}

function publishedStyleSignal(xyz, { clipG = 2, sos = PUBLISHED_BUTTERWORTH_SOS } = {}) {
  const magnitude = xyz.map((sample) => {
    const norm = Math.sqrt(sample[0] ** 2 + sample[1] ** 2 + sample[2] ** 2) - 1;
    return Math.max(-clipG, Math.min(clipG, norm));
  });
  const pad = 3 * (2 * sos.length);
  const padded = oddPad(magnitude, pad);
  const forward = sosfilt(sos, padded);
  const backward = sosfilt(sos, forward.slice().reverse()).reverse();
  return backward.slice(pad, pad + magnitude.length);
}

function publishedPeaks(signal, fs, gait) {
  const prominence = Number(gait.min_peak_g ?? 0.1);
  const distance = Math.max(1, Math.round(Number(gait.min_interval_s ?? 0.2) * fs));
  const minWidth = Math.max(1, Math.round(Number(gait.minimum_width_seconds ?? 0.01) * fs));
  const maxWidth = Math.max(minWidth, Math.round(Number(gait.maximum_width_seconds ?? 1) * fs));
  const peaks = [];
  let last = -distance;
  for (let i = 2; i < signal.length - 2; i += 1) {
    if (i - last < distance) continue;
    if (signal[i] <= signal[i - 1] || signal[i] < signal[i + 1]) continue;
    const lo = Math.max(0, i - Math.max(5, distance));
    const hi = Math.min(signal.length, i + Math.max(5, distance) + 1);
    const leftMin = Math.min(...signal.slice(lo, i + 1));
    const rightMin = Math.min(...signal.slice(i, hi));
    const peakProminence = signal[i] - Math.max(leftMin, rightMin);
    if (peakProminence < prominence) continue;
    const half = signal[i] - peakProminence / 2;
    let left = i;
    let right = i;
    while (left > lo && signal[left] > half) left -= 1;
    while (right + 1 < hi && signal[right] > half) right += 1;
    const width = right - left;
    if (width < minWidth || width > maxWidth) continue;
    peaks.push({
      index: i,
      amplitude: signal[i],
      prominence: peakProminence,
      width_s: width / fs,
    });
    last = i;
  }
  return peaks;
}

function regularEvents(candidates, fs, gait) {
  const credited = [];
  let rejected = 0;
  let run = [];
  const flush = () => {
    if (run.length >= Number(gait.min_steps)) {
      const intervals = run.slice(1).map((peak, index) => (peak.index - run[index].index) / fs);
      if (cv(intervals) <= Number(gait.interval_cv_max)) credited.push(...run);
      else rejected += run.length;
    } else {
      rejected += run.length;
    }
    run = [];
  };
  for (const peak of candidates) {
    if (!run.length) {
      run.push(peak);
      continue;
    }
    const gap = (peak.index - run.at(-1).index) / fs;
    if (gap < Number(gait.min_interval_s) || gap > Number(gait.max_interval_s)) flush();
    run.push(peak);
  }
  flush();
  return { credited, rejected };
}

function gyroDiagnostics(segments, eventCadence) {
  const dominant = [];
  for (const segment of segments) {
    const n = Math.min(segment.gx.length, segment.gy.length, segment.gz.length);
    const magnitude = new Array(n);
    let nonZero = false;
    for (let i = 0; i < n; i += 1) {
      const x = Number(segment.gx[i]) * segment.gyroScale;
      const y = Number(segment.gy[i]) * segment.gyroScale;
      const z = Number(segment.gz[i]) * segment.gyroScale;
      magnitude[i] = Math.sqrt(x * x + y * y + z * z);
      if (magnitude[i] > 1e-6) nonZero = true;
    }
    if (!nonZero) continue;
    const periodicity = dominantPeriodS(
      bandpass(magnitude, {
        sample_rate_hz: segment.fs,
        preprocess: { highpass_hz: 0.45, lowpass_hz: 3.6 },
      }),
      segment.fs,
      0.28,
      2.4,
    );
    if (periodicity) dominant.push(periodicity.freqHz);
  }
  const dominantHz = dominant.length ? mean(dominant) : null;
  const eventHz = finite(eventCadence) ? Number(eventCadence) / 60 : null;
  const agrees = dominantHz != null && eventHz != null && eventHz > 0
    ? Math.min(
      Math.abs(dominantHz - eventHz) / eventHz,
      Math.abs(dominantHz * 2 - eventHz) / eventHz,
      Math.abs(dominantHz - eventHz * 2) / (eventHz * 2),
    ) < 0.35
    : null;
  return {
    available: dominantHz != null,
    dominant_hz: dominantHz,
    agrees_with_event_cadence: agrees,
  };
}

function auxiliaryDiagnostics(samples, events, segments) {
  const activity = { walking: 0, unclassified: 0, unknown: 0 };
  let cadenceSamples = 0;
  let cadenceSum = 0;
  const counters = [];
  for (const sample of samples || []) {
    const cls = Number(sample?.activity_class);
    if (cls === 0) activity.unclassified += 1;
    else if (cls === 1 || cls === 2) activity.walking += 1;
    else activity.unknown += 1;
    const cadence = Number(sample?.step_cadence);
    if (Number.isFinite(cadence) && cadence >= 0) {
      cadenceSamples += 1;
      cadenceSum += cadence;
    }
    const counter = Number(sample?.step_cumulative ?? sample?.stepCounter);
    const t = sampleTime(sample);
    if (Number.isFinite(counter) && Number.isFinite(t)) counters.push({ counter, t });
  }
  counters.sort((a, b) => a.t - b.t);
  const durationMin = events.length > 1
    ? Math.max(1 / 60, (events.at(-1).timestamp_ms - events[0].timestamp_ms) / 60000)
    : null;
  const eventCadence = durationMin ? events.length / durationMin : null;
  return {
    activity,
    cadence: {
      sample_count: cadenceSamples,
      reported_mean_spm: cadenceSamples ? cadenceSum / cadenceSamples : null,
      event_mean_spm: eventCadence,
    },
    gyro: gyroDiagnostics(segments, eventCadence),
    counter: {
      available: counters.length >= 2,
      observed_delta: counters.length >= 2
        ? Math.max(0, counters.at(-1).counter - counters[0].counter)
        : null,
      event_delta: events.length,
    },
  };
}

function eventBuckets(events, bucketSeconds = 60) {
  const widthMs = bucketSeconds * 1000;
  const buckets = new Map();
  for (const event of events) {
    const start = Math.floor(event.timestamp_ms / widthMs) * widthMs;
    buckets.set(start, (buckets.get(start) || 0) + 1);
  }
  return [...buckets.entries()].sort((a, b) => a[0] - b[0]).map(([start, count]) => ({
    start_at: new Date(start).toISOString(),
    end_at: new Date(start + widthMs).toISOString(),
    count,
  }));
}

export function unavailableStepsV3(reason, artifact = null) {
  return {
    total: null,
    status: 'unavailable',
    confidence: 0,
    algorithm_version: STEPS_V3_VERSION,
    artifact_version: artifact?.artifact_version ?? null,
    artifact_sha256: artifact ? stepsV3ArtifactSha(artifact) : null,
    unavailable_reason: reason || 'steps_v3_unavailable',
    events: [],
    gait_windows: [],
    candidate_events: [],
    rejected_candidates: [],
    buckets_60s: [],
    accepted_gait_intervals: [],
    coverage: { imu_seconds: 0, day_ratio: 0, windows: 0, accepted_windows: 0 },
    rejected: {},
    auxiliary_agreement: null,
    clock: {
      quality: 'unavailable',
      records: 0,
      corrected_records: 0,
      timestamp_verified_records: 0,
      verified_records: 0,
      unverified_records: 0,
    },
    manifest_sha256: [],
    manifest_load_integrity: null,
    input_integrity: {
      input_records: 0,
      accepted_records: 0,
      unsupported_rate_records: 0,
      duplicate_records: 0,
      conflicting_records: 0,
      overlap_samples_dropped: 0,
    },
    evidence_eligibility: {
      accuracy_eligible: false,
      reason: 'no_verified_imu_evidence',
    },
  };
}

/**
 * Compute a V3 shadow result. It never uses V1/V2 totals as a fallback.
 */
export function computeStepsV3({
  imuRecords = [],
  samples = [],
  artifact = null,
  artifactError = null,
  dayStartMs = null,
  dayEndMs = null,
  loadIntegrity = null,
} = {}) {
  const validation = validateStepsV3Artifact(artifact);
  if (!validation.ok) return unavailableStepsV3(artifactError || validation.reason, artifact);

  const prepared = prepareRecords(imuRecords);
  const segmented = imuRecordsToV3Segments(prepared.records, {
    startMs: dayStartMs,
    endMs: dayEndMs,
    sampleRateHz: artifact.sample_rate_hz,
    gapThresholdMs: Number(artifact.training_provenance?.gap_threshold_ms ?? 250),
  });
  const { segments } = segmented;
  const imuSeconds = segments.reduce((sum, segment) => sum + segment.ax.length / segment.fs, 0);
  const daySeconds = finite(dayStartMs) && finite(dayEndMs) && Number(dayEndMs) > Number(dayStartMs)
    ? (Number(dayEndMs) - Number(dayStartMs)) / 1000
    : imuSeconds;
  const dayRatio = daySeconds > 0 ? Math.min(1, imuSeconds / daySeconds) : 0;
  if (segmented.integrity.unsupported_rate_records > 0) {
    const result = unavailableStepsV3('imu_sample_rate_unsupported', artifact);
    result.clock = prepared.clock;
    result.manifest_sha256 = prepared.manifestShas;
    result.manifest_load_integrity = loadIntegrity;
    result.input_integrity = segmented.integrity;
    return result;
  }
  if (imuSeconds < Number(artifact.coverage.min_imu_seconds)) {
    const result = unavailableStepsV3(
      imuSeconds > 0 ? 'imu_coverage_below_minimum' : 'no_imu_records',
      artifact,
    );
    result.coverage = { ...result.coverage, imu_seconds: imuSeconds, day_ratio: dayRatio };
    result.clock = prepared.clock;
    result.manifest_sha256 = prepared.manifestShas;
    result.manifest_load_integrity = loadIntegrity;
    result.input_integrity = segmented.integrity;
    return result;
  }
  if (dayRatio < Number(artifact.coverage.min_day_ratio)) {
    const result = unavailableStepsV3('imu_day_coverage_below_minimum', artifact);
    result.coverage = { ...result.coverage, imu_seconds: imuSeconds, day_ratio: dayRatio };
    result.clock = prepared.clock;
    result.manifest_sha256 = prepared.manifestShas;
    result.manifest_load_integrity = loadIntegrity;
    result.input_integrity = segmented.integrity;
    return result;
  }

  const allWindows = [];
  const acceptedIntervals = [];
  const events = [];
  const candidateEvents = [];
  const rejectedCandidates = [];
  let rejectedIsolated = 0;
  let acceptedWindows = 0;
  for (let segmentIndex = 0; segmentIndex < segments.length; segmentIndex += 1) {
    const segment = segments[segmentIndex];
    const xyz = accelXyz(segment);
    const dynamic = bandpass(xyz.map(
      (sample) => Math.sqrt(sample[0] ** 2 + sample[1] ** 2 + sample[2] ** 2) - 1,
    ), artifact);
    const windows = [];
    for (let start = 0; start + artifact.window.size_samples <= dynamic.length;
      start += artifact.window.stride_samples) {
      const end = start + artifact.window.size_samples;
      windows.push({
        start,
        end,
        startMs: segment.t0 + start / artifact.sample_rate_hz * 1000,
        endMs: segment.t0 + end / artifact.sample_rate_hz * 1000,
        probability: inferGaitProbability(
          dynamic.slice(start, end),
          artifact,
          xyz.slice(start, end),
        ),
        segment_index: segmentIndex,
      });
    }
    const labels = smoothWindowBouts(
      smoothGaitProbabilities(
        windows.map((window) => window.probability),
        artifact.smoothing,
        Number(artifact.window.decision_threshold),
      ),
      artifact.smoothing,
    );
    labels.forEach((label, index) => {
      windows[index].accepted = label;
      if (label) acceptedWindows += 1;
    });
    allWindows.push(...windows);
    const unionIntervals = mergeIntervals(windows, labels);
    const centerGate = gaitStateAtSamples(labels, dynamic.length, {
      hopSamples: artifact.window.stride_samples,
      windowSamples: artifact.window.size_samples,
    });
    const centerIntervals = [];
    let centerRun = null;
    for (let i = 0; i < centerGate.length; i += 1) {
      if (centerGate[i] && !centerRun) {
        centerRun = { start_ms: segment.t0 + i / artifact.sample_rate_hz * 1000 };
      } else if (!centerGate[i] && centerRun) {
        centerRun.end_ms = segment.t0 + i / artifact.sample_rate_hz * 1000;
        centerIntervals.push(centerRun);
        centerRun = null;
      }
    }
    if (centerRun) {
      centerRun.end_ms = segment.t0 + centerGate.length / artifact.sample_rate_hz * 1000;
      centerIntervals.push(centerRun);
    }
    acceptedIntervals.push(...centerIntervals);

    const peaks = artifact.gait?.counter === 'published'
      ? publishedPeaks(publishedStyleSignal(xyz), artifact.sample_rate_hz, artifact.gait)
      : adaptivePeaks(dynamic, artifact.sample_rate_hz, artifact.gait);
    const creditedPeakIndexes = new Set();
    for (const peak of peaks) {
      const timestampMs = segment.t0 + peak.index / artifact.sample_rate_hz * 1000;
      candidateEvents.push({
        timestamp_ms: Math.round(timestampMs),
        timestamp: new Date(timestampMs).toISOString(),
        amplitude: peak.amplitude,
        prominence: peak.prominence ?? null,
        width_s: peak.width_s ?? null,
        segment_index: segmentIndex,
        sample_index: peak.index,
      });
    }
    const gatedPeaks = peaks.filter((peak) => centerGate[peak.index] === true);
    const regular = regularEvents(gatedPeaks, artifact.sample_rate_hz, artifact.gait);
    rejectedIsolated += regular.rejected + (peaks.length - gatedPeaks.length);
    for (const peak of regular.credited) {
      creditedPeakIndexes.add(peak.index);
      const timestampMs = segment.t0 + peak.index / artifact.sample_rate_hz * 1000;
      events.push({
        timestamp_ms: Math.round(timestampMs),
        timestamp: new Date(timestampMs).toISOString(),
      });
    }
    for (const peak of peaks) {
      if (creditedPeakIndexes.has(peak.index)) continue;
      const timestampMs = segment.t0 + peak.index / artifact.sample_rate_hz * 1000;
      rejectedCandidates.push({
        timestamp_ms: Math.round(timestampMs),
        timestamp: new Date(timestampMs).toISOString(),
        amplitude: peak.amplitude,
        prominence: peak.prominence ?? null,
        width_s: peak.width_s ?? null,
        reason: centerGate[peak.index] ? 'isolated_or_irregular' : 'classifier_gate',
      });
    }
    segment.gating_diagnostic = {
      union_10s_hours: unionIntervals.reduce((sum, interval) => (
        sum + Math.max(0, interval.end_ms - interval.start_ms)
      ), 0) / 3_600_000,
      center_timeline_hours: centerGate.filter(Boolean).length / artifact.sample_rate_hz / 3600,
    };
  }

  if (allWindows.length < Number(artifact.coverage.min_windows)) {
    const result = unavailableStepsV3('inference_window_coverage_below_minimum', artifact);
    result.coverage = {
      imu_seconds: imuSeconds,
      day_ratio: dayRatio,
      windows: allWindows.length,
      accepted_windows: acceptedWindows,
    };
    result.clock = prepared.clock;
    result.manifest_sha256 = prepared.manifestShas;
    result.manifest_load_integrity = loadIntegrity;
    result.input_integrity = segmented.integrity;
    return result;
  }

  events.sort((a, b) => a.timestamp_ms - b.timestamp_ms);
  const uniqueEvents = events.filter((event, index) => index === 0
    || event.timestamp_ms !== events[index - 1].timestamp_ms);
  const acceptedRatio = allWindows.length ? acceptedWindows / allWindows.length : 0;
  const manifestEligible = prepared.clock.manifest_verified_records === prepared.clock.records
    && prepared.clock.records > 0;
  const clockEligible = prepared.clock.quality === 'verified';
  const overlapEligible = segmented.integrity.conflicting_records === 0
    && segmented.integrity.overlap_samples_dropped === 0;
  const loadEligible = loadIntegrity == null || loadIntegrity.complete === true;
  const confidence = clamp01(
    0.35 + Math.min(0.35, imuSeconds / Math.max(1, Number(artifact.coverage.min_imu_seconds)) * 0.2)
      + Math.min(0.2, acceptedRatio * 0.2),
  );
  return {
    total: uniqueEvents.length,
    status: dayRatio < 0.15 && daySeconds > 1800 ? 'partial' : 'ok',
    confidence: Math.round(confidence * 1000) / 1000,
    algorithm_version: STEPS_V3_VERSION,
    artifact_version: artifact.artifact_version,
    artifact_sha256: stepsV3ArtifactSha(artifact),
    unavailable_reason: null,
    model_type: artifact.model.type,
    smoothing_type: artifact.smoothing?.type || 'none',
    events: uniqueEvents,
    gait_windows: allWindows.map((window) => ({
      start_ms: Math.round(window.startMs),
      end_ms: Math.round(window.endMs),
      probability: window.probability,
      accepted: window.accepted,
    })),
    candidate_events: candidateEvents,
    rejected_candidates: rejectedCandidates,
    buckets_60s: eventBuckets(uniqueEvents, 60),
    accepted_gait_intervals: acceptedIntervals.map((interval) => ({
      start_at: new Date(interval.start_ms).toISOString(),
      end_at: new Date(interval.end_ms).toISOString(),
    })),
    coverage: {
      imu_seconds: Math.round(imuSeconds * 10) / 10,
      day_ratio: Math.round(dayRatio * 10000) / 10000,
      windows: allWindows.length,
      accepted_windows: acceptedWindows,
      accepted_window_ratio: Math.round(acceptedRatio * 10000) / 10000,
    },
    rejected: {
      classifier_windows: allWindows.length - acceptedWindows,
      isolated_or_irregular_peaks: rejectedIsolated,
    },
    auxiliary_agreement: auxiliaryDiagnostics(samples, uniqueEvents, segments),
    clock: prepared.clock,
    manifest_sha256: prepared.manifestShas,
    manifest_load_integrity: loadIntegrity,
    input_integrity: segmented.integrity,
    evidence_eligibility: {
      accuracy_eligible: manifestEligible && clockEligible && overlapEligible && loadEligible,
      reason: !loadEligible
        ? 'imu_manifest_load_incomplete'
        : (!manifestEligible
        ? 'imu_manifest_sha_unverified'
        : (!clockEligible
          ? 'imu_clock_unverified'
          : (!overlapEligible ? 'imu_conflicting_overlap' : null))),
    },
  };
}

export function stepsV3Provenance(result) {
  if (!result) return null;
  return {
    algorithm_version: result.algorithm_version,
    artifact_version: result.artifact_version,
    artifact_sha256: result.artifact_sha256,
    model_type: result.model_type ?? null,
    smoothing_type: result.smoothing_type ?? null,
    status: result.status,
    unavailable_reason: result.unavailable_reason,
    accel_required: true,
    auxiliary_inputs_canonical: false,
    coverage: result.coverage,
    clock: result.clock,
    manifest_sha256: result.manifest_sha256,
    manifest_load_integrity: result.manifest_load_integrity,
    input_integrity: result.input_integrity,
    evidence_eligibility: result.evidence_eligibility,
  };
}

export const _internal = {
  adaptivePeaks,
  accelMagnitude,
  bandpass,
  cnnProbability,
  eventBuckets,
  gaitStateAtSamples,
  logisticProbability,
  imuRecordsToV3Segments,
  mergeIntervals,
  prepareRecords,
  publishedPeaks,
  publishedStyleSignal,
  regularEvents,
  rint,
  smoothWindowBouts,
  windowFeatures,
};
