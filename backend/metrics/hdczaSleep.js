
/**
 * Faithful, parameterized HDCZA sleep-period detector.
 *
 * HDCZA = Hees et al. "A Novel, Open Access Method to Assess Sleep Duration
 * Using a Wrist-Worn Accelerometer" (2015), the basis of GGIR's
 * sleep-period detection. This is an independent re-implementation that follows
 * the published method and the modern GGIR behavior, and every key parameter is
 * explicit so it can be benchmarked against alternates instead of trusted from
 * memory.
 *
 * Method (per epoch on a resampled grid):
 *   1. z-angle of the accelerometer relative to the horizon:
 *        angleZ = atan2(gz, sqrt(gx^2 + gy^2))   [degrees]
 *   2. Smooth angleZ with a rolling median (GGIR emphasizes smoothing before
 *      differencing so a single noisy sample cannot register as movement).
 *   3. Movement = |delta angleZ| between adjacent smoothed epochs exceeding a
 *      threshold (GGIR default 5 deg).
 *   4. Sustained inactivity = a contiguous run of epochs whose largest movement
 *      over a `sustainedMin` window stays below the threshold. This is the core
 *      HDCZA "5 minutes of sustained inactivity" test.
 *   5. Nonwear exclusion: any epoch inside a data gap >= `nonwearGapMin` is
 *      marked nonwear and cannot become part of a sleep period.
 *   6. Candidate sleep periods = runs of sustained inactivity; short gaps
 *      (<= `bridgeGapMin`, "awake but brief" / sensor dropout) are bridged.
 *   7. Each candidate becomes a night/nap when it meets `minSleepWindows` and
 *      spans >= `minDurationMin`. The main sleep period is the longest one.
 *
 * GGIR historically used a recording-specific percentile threshold for the
 * angle-change values; current GGIR exposes a configurable fixed threshold
 * (commonly around 0.2 for the *fraction*-based variant, and 5 deg for the
 * angle variant). We keep the angle variant's 5-deg default but make it
 * configurable, and we DO NOT silently adopt any single value — the benchmark
 * harness sweeps it.
 */

export const HDCZA_DEFAULTS = Object.freeze({
  epochSec: 5,
  angleThresholdDeg: 5,
  smoothSec: 10,
  sustainedMin: 5,
  bridgeGapMin: 30,
  nonwearGapMin: 60,
  minDurationMin: 60,
});

function zAngleDeg(x, y, z) {
  return Math.atan2(z, Math.sqrt(x * x + y * y)) * 180 / Math.PI;
}

function median(values) {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** Rolling median over symmetric window width (in indices). */
function rollingMedian(values, width) {
  if (width <= 1) return [...values];
  const half = Math.floor(width / 2);
  return values.map((v, i) => {
    if (v == null) return null;
    const lo = Math.max(0, i - half);
    const hi = Math.min(values.length - 1, i + half);
    const seg = [];
    for (let k = lo; k <= hi; k += 1) if (values[k] != null) seg.push(values[k]);
    return seg.length ? median(seg) : null;
  });
}

/**
 * Detect sleep periods on a gravity vector series.
 * @param {Array<{ts:number,x:number,y:number,z:number}>} gravity ascending ts.
 * @param {Object} opts overrides.
 * @returns {Array<{onsetSec,offsetSec,durationSec,confidence,detector}>}
 */
export function hdczaSleepPeriods(gravity, opts = {}) {
  const cfg = { ...HDCZA_DEFAULTS, ...opts };
  if (!gravity || gravity.length < 2) return [];
  const sorted = [...gravity].sort((a, b) => a.ts - b.ts);
  const t0 = sorted[0].ts;
  const t1 = sorted.at(-1).ts;
  const span = t1 - t0 + 1;
  if (span < 5 * 60) return [];

  // Resample to the epoch grid, marking gaps (nonwear).
  const n = Math.ceil(span / cfg.epochSec);
  const angleRaw = Array(n).fill(null);
  const xyz = Array(n).fill(null);
  for (const s of sorted) {
    const idx = Math.floor((s.ts - t0) / cfg.epochSec);
    if (idx < 0 || idx >= n) continue;
    // last writer wins within an epoch
    xyz[idx] = s;
    angleRaw[idx] = zAngleDeg(s.x, s.y, s.z);
  }

  // Nonwear: an epoch is nonwear if the nearest valid sample is farther than
  // nonwearGapMin away on either side.
  const nonwear = Array(n).fill(false);
  let lastValid = -Infinity;
  const prevValid = Array(n).fill(-Infinity);
  for (let i = 0; i < n; i += 1) {
    prevValid[i] = lastValid;
    if (angleRaw[i] != null) lastValid = i;
  }
  let nextValid = Infinity;
  const nextValidIdx = Array(n).fill(Infinity);
  for (let i = n - 1; i >= 0; i -= 1) {
    nextValidIdx[i] = nextValid;
    if (angleRaw[i] != null) nextValid = i;
  }
  const nonwearGap = Math.round((cfg.nonwearGapMin * 60) / cfg.epochSec);
  for (let i = 0; i < n; i += 1) {
    if (angleRaw[i] != null) continue;
    const dist = Math.min(i - prevValid[i], nextValidIdx[i] - i);
    if (dist > nonwearGap) nonwear[i] = true;
  }

  // Smooth angle with rolling median (fill nulls as null).
  const smoothWidth = Math.max(1, Math.round(cfg.smoothSec / cfg.epochSec));
  const smooth = rollingMedian(angleRaw, Math.max(1, smoothWidth));

  // Movement = |delta| of smoothed angle > threshold.
  const moving = Array(n).fill(false);
  for (let i = 1; i < n; i += 1) {
    if (smooth[i] == null || smooth[i - 1] == null) continue;
    if (Math.abs(smooth[i] - smooth[i - 1]) > cfg.angleThresholdDeg) moving[i] = true;
  }

  // Sustained inactivity: a window of length sustainedSec where max movement
  // stays below the threshold.
  const sustSamples = Math.round((cfg.sustainedMin * 60) / cfg.epochSec);
  const inactive = Array(n).fill(false);
  for (let i = 0; i < n; i += 1) {
    if (nonwear[i]) continue;
    const hi = Math.min(n, i + sustSamples);
    let maxMove = 0;
    for (let k = i; k < hi; k += 1) {
      if (nonwear[k]) { maxMove = Infinity; break; }
      if (moving[k]) { maxMove = Infinity; break; }
      if (angleRaw[k] == null) { maxMove = Infinity; break; }
    }
    inactive[i] = maxMove < Infinity;
  }

  // Chain inactive epochs into candidate periods, bridging short gaps.
  const bridge = Math.round((cfg.bridgeGapMin * 60) / cfg.epochSec);
  const periods = [];
  let i = 0;
  while (i < n) {
    if (!inactive[i]) { i += 1; continue; }
    let j = i;
    while (j < n) {
      if (inactive[j]) { j += 1; continue; }
      let k = j;
      while (k < n && !inactive[k] && (k - j) < bridge && !nonwear[k]) k += 1;
      if (k < n && inactive[k] && (k - j) < bridge) j = k;
      else break;
    }
    const len = j - i;
    const durationSec = len * cfg.epochSec;
    if (len >= sustSamples && durationSec >= cfg.minDurationMin * 60) {
      periods.push({
        onsetSec: t0 + i * cfg.epochSec,
        offsetSec: t0 + j * cfg.epochSec,
        durationSec,
        confidence: Math.min(0.95, Math.max(0.35, durationSec / (7 * 3600))),
        detector: 'hdcza',
      });
    }
    i = j + 1;
  }
  return periods;
}

/** Main sleep period = longest detected period. */
export function hdczaMainSleep(gravity, opts = {}) {
  const periods = hdczaSleepPeriods(gravity, opts);
  return periods.reduce((b, p) => (!b || p.durationSec > b.durationSec ? p : b), null);
}
