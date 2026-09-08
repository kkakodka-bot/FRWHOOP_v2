/**
 * Narrowband spectral primitives.
 *
 * Scope: these are ARCHIVE VERIFICATION instruments, plus the shared Goertzel kernel the PPG quality
 * gate already used. Recovering the dominant frequency of a stored waveform is how a round-trip test
 * proves the bytes that came out of the bucket are the bytes that went in — a checksum proves the
 * blob is intact, this proves it still decodes to the signal it claims to be. Nothing here is a
 * feature extractor for event detection, and nothing downstream consumes it to score anything.
 *
 * ponytail: a Goertzel sweep rather than an FFT. O(bands x n) is fine for the window sizes here
 * (seconds of 24-100 Hz signal); swap in an FFT if windows grow past ~10 s at 437 Hz.
 */

/** Power at one frequency via Goertzel, mean-removed. */
export function goertzelPower(xs, freqHz, rateHz, mean) {
  const w = (2 * Math.PI * freqHz) / rateHz;
  const coeff = 2 * Math.cos(w);
  let s1 = 0;
  let s2 = 0;
  for (const v of xs) {
    const s0 = (v - mean) + coeff * s1 - s2;
    s2 = s1;
    s1 = s0;
  }
  return s1 * s1 + s2 * s2 - coeff * s1 * s2;
}

/**
 * Dominant frequency in a band, by peak Goertzel power over a linear sweep.
 *
 * Returns `null` for a signal with no usable variance rather than reporting the first bin, so a
 * flatlined channel cannot masquerade as a reading at `minHz`. `concentration` is the peak's power
 * relative to the sweep mean: 1.0 is what a flat (noise) spectrum gives, so a value near 1 means
 * "no peak here" even when `freqHz` is populated.
 */
export function dominantFrequencyHz({
  samples = [],
  rateHz,
  minHz = 0.5,
  maxHz = null,
  stepHz = 0.05,
} = {}) {
  const xs = (samples || []).map(Number).filter(Number.isFinite);
  if (!rateHz || xs.length < 8) return null;
  const nyquist = rateHz * 0.45;
  const hi = Math.min(maxHz == null ? nyquist : maxHz, nyquist);
  if (!(hi > minHz)) return null;

  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  const spread = xs.reduce((a, b) => a + (b - mean) * (b - mean), 0) / xs.length;
  if (spread <= 0) return null;

  let bestFreq = null;
  let bestPower = -Infinity;
  let total = 0;
  let bins = 0;
  for (let f = minHz; f <= hi + 1e-9; f += stepHz) {
    const p = goertzelPower(xs, f, rateHz, mean);
    total += p;
    bins += 1;
    if (p > bestPower) {
      bestPower = p;
      bestFreq = f;
    }
  }
  if (bestFreq == null || !bins) return null;
  const meanPower = total / bins;
  return {
    freqHz: Math.round(bestFreq * 1000) / 1000,
    power: bestPower,
    concentration: meanPower > 0 ? bestPower / meanPower : 0,
  };
}
