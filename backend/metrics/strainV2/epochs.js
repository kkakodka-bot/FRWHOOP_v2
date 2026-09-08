import {
  STRAIN_V2_EPOCHS_VERSION,
  EPOCH_MS,
  HR_MIN_BPM,
  HR_MAX_BPM,
  HR_JUMP_BPM,
  HR_JUMP_WINDOW_MS,
  GAP_TOLERANCE_MS,
  EPOCH_MIN_COVERAGE,
  HR_STABLE_STD_BPM,
  HR_UNSTABLE_STD_BPM,
  MOTION_SUSPECT_THRESHOLD,
  RR_ARTIFACT_FRACTION_FLAG,
  EXPECTED_SAMPLES_MIN,
  EXPECTED_SAMPLES_MAX,
  CADENCE_RUN_MAX_DELTA_MS,
  CADENCE_MIN_RUNS,
} from './constants.js';
import { rrStats } from '../../signal/quality.js';


/**
 * FRWHOOP Strain V2 - Layer 1: canonical epoch builder.
 *
 * Deterministic, deduplicating, gap-aware aggregation of raw HR samples into
 * 60 s scoring epochs with per-epoch signal-quality state. See
 * _strain_v2/ARCHITECTURE_DRAFT.md (D1) and _strain_v2/work_cadence_data.md.
 *
 * Core invariants:
 *  - Missing intervals are UNKNOWN. They never become sedentary, never
 *    receive duration, and are never forward-filled.
 *  - Duplicated timestamps never increase scorable duration.
 *  - The tail after the last observation receives no invented duration (V1
 *    final-sample reuse bug is fixed here by construction).
 *  - Packet frequency alone cannot change coverage or load (duration comes
 *    from wall-clock epoch coverage, not sample counts).
 *  - Low quality never NUMERICALLY reduces load; contaminated epochs become
 *    UNKNOWN (reject-dont-correct) unless the HR is corroborated by clean
 *    neighbors.
 *  - Raw unknown PPG layouts are untouched; this layer only reads validated
 *    HR/RR/motion/connected fields.
 */

function num(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function parseTs(row) {
  const raw = row?.t ?? row?.datetime ?? row?.at;
  if (raw == null) return null;
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? ms : null;
}

function parseBpm(row) {
  const n = num(row?.bpm ?? row?.hr ?? row?.heartRate);
  return n != null && n >= HR_MIN_BPM && n <= HR_MAX_BPM ? n : null;
}

function parseMotion(row) {
  const n = num(row?.motion ?? row?.mot);
  return n != null && n >= 0 ? n : null;
}

function parseRr(row) {
  const rr = row?.rr_ms ?? row?.rrIntervals ?? row?.rr;
  if (Array.isArray(rr)) return rr.map(num).filter((n) => n != null);
  const n = num(rr);
  return n != null ? [n] : [];
}

function median(sorted) {
  if (!sorted.length) return null;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function stddevOf(values, mean) {
  if (values.length < 2 || mean == null) return null;
  const v = values.reduce((acc, x) => acc + (x - mean) ** 2, 0) / (values.length - 1);
  return Math.sqrt(v);
}

function infoScore(row) {
  // Preference order for dedup: more observed fields wins.
  let score = 0;
  if (row.bpm != null) score += 8;
  if (row.rr?.length) score += 4;
  if (row.motion != null) score += 2;
  if (row.connected != null) score += 1;
  return score;
}

function sourceRank(row) {
  // Deterministic tiebreak: prefer archive/offload samples over live echoes.
  const src = String(row?.source || '');
  if (src.includes('history') || src === 'offload') return 2;
  if (src === 'live') return 1;
  return 0;
}

/**
 * Normalize + dedupe + sort raw samples.
 * Dedup key = exact timestamp; keep the highest-information row.
 */
function normalizeSamples(samples) {
  const rows = [];
  let outOfRangeDropped = 0;
  for (const row of samples || []) {
    const t = parseTs(row);
    if (t == null) { outOfRangeDropped += 1; continue; }
    const bpm = parseBpm(row);
    const bpmPresent = row?.bpm != null || row?.hr != null || row?.heartRate != null;
    if (bpmPresent && bpm == null) outOfRangeDropped += 1;
    rows.push({
      t,
      bpm,
      rr: parseRr(row),
      motion: parseMotion(row),
      connected: row?.connected === false ? false : (row?.connected === true ? true : null),
      source: row?.source ?? null,
    });
  }
  rows.sort((a, b) => a.t - b.t);
  const seen = new Map();
  for (const row of rows) {
    const prev = seen.get(row.t);
    if (!prev) { seen.set(row.t, row); continue; }
    const keepNew = infoScore(row) > infoScore(prev)
      || (infoScore(row) === infoScore(prev) && sourceRank(row) > sourceRank(prev));
    if (keepNew) seen.set(row.t, row);
  }
  const deduped = [...seen.values()].sort((a, b) => a.t - b.t);
  return { deduped, duplicatesRemoved: rows.length - deduped.length, outOfRangeDropped };
}

/**
 * Observed cadence: median inter-sample delta across contiguous runs
 * (delta <= CADENCE_RUN_MAX_DELTA_MS). Returns expected samples per 60 s epoch.
 */
export function expectedSamplesPerEpoch(deduped) {
  const med = medianOfDeltas(deduped);
  if (med == null) return 15;
  const perEpoch = Math.round(EPOCH_MS / Math.max(med, 1));
  return Math.min(Math.max(perEpoch, EXPECTED_SAMPLES_MIN), EXPECTED_SAMPLES_MAX);
}

/**
 * Observed inter-sample interval. Preferred: median delta of CONTIGUOUS runs
 * (d <= CADENCE_RUN_MAX_DELTA_MS) when enough exist; otherwise the median of
 * ALL inter-sample deltas clamped to [200 ms, 30 s] so sparse-but-uniform
 * cadences (e.g. 8 s offload records) still yield a truthful coverage radius;
 * null only when nothing measurable remains (callers fall back to 4 s).
 */
export function medianOfDeltas(deduped) {
  const runDeltas = [];
  const allDeltas = [];
  for (let i = 1; i < deduped.length; i += 1) {
    const d = deduped[i].t - deduped[i - 1].t;
    if (d <= 0) continue;
    allDeltas.push(d);
    if (d <= CADENCE_RUN_MAX_DELTA_MS) runDeltas.push(d);
  }
  if (runDeltas.length >= CADENCE_MIN_RUNS) {
    return median(runDeltas.slice().sort((a, b) => a - b));
  }
  if (allDeltas.length) {
    return Math.min(30_000, Math.max(200, median(allDeltas.slice().sort((a, b) => a - b))));
  }
  return null;
}

function neighborsCorroborate(index, epochs) {
  const self = epochs[index];
  for (const off of [-1, 1]) {
    const other = epochs[index + off];
    if (!other) continue;
    if (other.flags.includes('high_motion')) continue;
    if (other.hr == null) continue;
    if (Math.abs(self.hr - other.hr) <= 10) return true;
  }
  return false;
}
/**
 * Build canonical epochs for one day.
 *
 * @param {object} args
 * @param {Array}  args.samples   raw sample rows (t/datetime/at, bpm/hr/heartRate, rr, motion, connected, source)
 * @param {object} [args.profile] resolved physiology { restingHr, hrMax } - numbers or {value} objects
 * @param {object} [args.opts]    { dayStartMs, dayEndMs } explicit window; defaults to the UTC day of the first sample
 * @returns {{ epochs: Array, dayStats: object }}
 */
export function buildCanonicalEpochs({ samples, profile, opts } = {}) {
  const { deduped, duplicatesRemoved, outOfRangeDropped } = normalizeSamples(samples);

  const pRhr = num(profile?.restingHr?.value ?? profile?.restingHr);
  const pHrMax = num(profile?.hrMax?.value ?? profile?.hrMax);

  const dayStartMs = Number.isFinite(opts?.dayStartMs)
    ? opts.dayStartMs
    : (deduped.length ? Math.floor(deduped[0].t / EPOCH_MS) * EPOCH_MS : 0);
  const dayEndMs = Number.isFinite(opts?.dayEndMs)
    ? opts.dayEndMs
    : (deduped.length ? dayStartMs + 24 * 3_600_000 : 0);

  const daySpanMinutes = dayEndMs > dayStartMs ? Math.round((dayEndMs - dayStartMs) / EPOCH_MS) : 0;

  if (!deduped.length || daySpanMinutes <= 0) {
    return {
      epochs: [],
      dayStats: {
        version: STRAIN_V2_EPOCHS_VERSION,
        scorableMinutes: 0,
        unknownMinutes: 0,
        missingMinutes: daySpanMinutes,
        coveragePct: 0,
        duplicatesRemoved,
        outOfRangeDropped,
        expectedSamplesPerEpoch: null,
        observedCadenceMs: null,
        gaps: [],
        state: 'INSUFFICIENT',
      },
    };
  }

  const expectedSamples = expectedSamplesPerEpoch(deduped);
  const observedCadenceMs = medianOfDeltas(deduped) ?? (EPOCH_MS / expectedSamples);
  const firstT = deduped[0].t;
  const lastT = deduped[deduped.length - 1].t;
  const epochStart = Math.max(dayStartMs, Math.floor(firstT / EPOCH_MS) * EPOCH_MS);
  const epochEnd = Math.min(dayEndMs, Math.ceil((lastT + 1) / EPOCH_MS) * EPOCH_MS);
  const nEpochs = Math.max(0, Math.round((epochEnd - epochStart) / EPOCH_MS));

  // Index samples into their epochs (single pass).
  const byEpoch = new Map();
  for (const row of deduped) {
    if (row.t < dayStartMs || row.t >= dayEndMs) continue;
    const key = Math.floor(row.t / EPOCH_MS) * EPOCH_MS;
    const bucket = byEpoch.get(key);
    if (bucket) bucket.push(row);
    else byEpoch.set(key, [row]);
  }

  const epochs = [];
  let prevHr = null;
  let prevHrTs = null;

  for (let i = 0; i < nEpochs; i += 1) {
    const t0 = epochStart + i * EPOCH_MS;
    const rows = byEpoch.get(t0) || [];
    const hrVals = [];
    const hrTss = [];
    const motions = [];
    const rrAll = [];
    let disconnected = 0;
    let implausibleJumps = 0;

    for (const row of rows) {
      if (row.bpm != null) {
        // Optical-relock guard (same rule as energy/features.js): a >25 bpm
        // step within <=10 s of the previous VALID sample is artifact.
        if (prevHr != null && prevHrTs != null && row.t - prevHrTs <= HR_JUMP_WINDOW_MS
          && Math.abs(row.bpm - prevHr) > HR_JUMP_BPM) {
          implausibleJumps += 1;
        } else {
          hrVals.push(row.bpm);
          hrTss.push(row.t);
        }
        prevHr = row.bpm;
        prevHrTs = row.t;
      }
      if (row.motion != null) motions.push(row.motion);
      if (row.rr.length) rrAll.push(...row.rr);
      if (row.connected === false) disconnected += 1;
    }

    const hrSorted = hrVals.slice().sort((a, b) => a - b);
    const hrTs = hrTss.slice();
    const hr = hrSorted.length ? Math.round(median(hrSorted) * 10) / 10 : null;
    const hrMean = hrSorted.length ? hrVals.reduce((a, b) => a + b, 0) / hrSorted.length : null;
    const hrStdRaw = stddevOf(hrVals, hrMean);
    const hrStd = hrStdRaw == null ? null : Math.round(hrStdRaw * 100) / 100;
    const motion = motions.length
      ? Math.round((motions.reduce((a, b) => a + b, 0) / motions.length) * 1000) / 1000
      : null;
    const rr = rrAll.length ? rrStats(rrAll) : null;
    const rrArtifactFraction = rr ? Math.round(rr.artifactFraction * 100) / 100 : null;

    const validSamples = hrVals.length;
    // Time-coverage: valid samples x observed interval vs the epoch wall clock.
    // This estimates the wall-clock time the HR channel actually represented,
    // and is invariant to packet frequency AND phase alignment: a uniform 8 s
    // cadence covers the epoch fully (7-8 samples x 8 s ~= 60 s), a 1 Hz
    // stream covers it fully (58-60 x 1 s), while 5 samples of a 1 Hz day
    // represent only ~5 s (coverage 0.08 -> UNKNOWN, never invented duration).
    const cadenceCap = Math.min(observedCadenceMs, 30_000);
    const coverage = Math.round(Math.min(1, (validSamples * cadenceCap) / EPOCH_MS) * 1000) / 1000;

    const flags = [];
    if (implausibleJumps > 0) flags.push('hr_jumps');
    if (hrStd != null && hrStd > HR_UNSTABLE_STD_BPM) flags.push('hr_unstable');
    if (motion != null && motion > MOTION_SUSPECT_THRESHOLD) flags.push('high_motion');
    if (disconnected > 0) flags.push('disconnected');
    if (rrArtifactFraction != null && rrArtifactFraction > RR_ARTIFACT_FRACTION_FLAG) flags.push('rr_artefacts');

    const hrrFrac = hr != null && pRhr != null && pHrMax != null
      ? Math.max(0, Math.min(1, (hr - pRhr) / Math.max(pHrMax - pRhr, 20)))
      : null;

    epochs.push({
      t: t0,
      hr,
      hrrFrac: hrrFrac == null ? null : Math.round(hrrFrac * 10_000) / 10_000,
      coverage,
      validSamples,
      expectedSamples,
      quality: 'PENDING',
      motion,
      hrStd,
      rrArtifactFraction,
      flags,
      _jumps: implausibleJumps,
    });
  }

  // Two-pass quality assignment + motion corroboration.
  for (let i = 0; i < epochs.length; i += 1) {
    const e = epochs[i];
    if (e._jumps > 0 || e.hr == null || e.coverage < EPOCH_MIN_COVERAGE) {
      e.quality = 'UNKNOWN';
      continue;
    }
    if (e.flags.includes('high_motion') && !neighborsCorroborate(i, epochs)) {
      e.quality = 'UNKNOWN';
      e.flags.push('motion_uncorroborated');
      continue;
    }
    if (e.flags.includes('high_motion')) e.flags.push('motion_corroborated');
    const suspect = e.flags.includes('high_motion')
      || e.flags.includes('hr_unstable')
      || e.flags.includes('disconnected');
    const stable = (e.hrStd ?? 0) <= HR_STABLE_STD_BPM;
    if (!suspect && e.coverage >= 0.9 && stable) {
      e.quality = 'HIGH';
    } else if (!suspect && e.coverage >= 0.75) {
      e.quality = 'MODERATE';
    } else {
      e.quality = 'LOW';
    }
    // RR artifacts degrade the quality label but never the load increment.
    if (e.flags.includes('rr_artefacts') && e.quality === 'HIGH') e.quality = 'MODERATE';
  }
  for (const e of epochs) delete e._jumps;

  // Day statistics.
  let scorable = 0;
  let unknown = 0;
  for (const e of epochs) {
    if (e.quality === 'UNKNOWN' || e.hr == null) unknown += 1;
    else scorable += 1;
  }
  const gaps = [];
  for (let i = 1; i < deduped.length; i += 1) {
    const gap = deduped[i].t - deduped[i - 1].t;
    if (gap > GAP_TOLERANCE_MS) {
      gaps.push({ start: new Date(deduped[i - 1].t).toISOString(), end: new Date(deduped[i].t).toISOString(), ms: gap });
    }
  }
  const emittedMinutes = epochs.length;
  const missing = Math.max(0, daySpanMinutes - emittedMinutes);
  const coveragePct = daySpanMinutes > 0 ? Math.round((scorable / daySpanMinutes) * 1000) / 10 : 0;
  const state = coveragePct >= 80 ? 'HIGH'
    : coveragePct >= 50 ? 'MODERATE'
    : coveragePct >= 25 ? 'LOW'
    : 'INSUFFICIENT';

  return {
    epochs,
    dayStats: {
      version: STRAIN_V2_EPOCHS_VERSION,
      scorableMinutes: scorable,
      unknownMinutes: unknown,
      missingMinutes: missing,
      coveragePct,
      duplicatesRemoved,
      outOfRangeDropped,
      expectedSamplesPerEpoch: expectedSamples,
      observedCadenceMs: medianOfDeltas(deduped),
      gaps,
      state,
    },
  };
}
