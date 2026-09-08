/**
 * Explicit sample-gap accounting. Sleep/recovery must not treat a hole as rest.
 */

export const EXPECTED_SAMPLE_MS = 4000;
export const GAP_MS = 10_000;

export function detectSampleGaps(samples, {
  expectedMs = EXPECTED_SAMPLE_MS,
  gapMs = GAP_MS,
} = {}) {
  const sorted = [...(samples || [])]
    .map((s) => ({
      ...s,
      _t: Date.parse(s.datetime || s.at || s.t || ''),
    }))
    .filter((s) => Number.isFinite(s._t))
    .sort((a, b) => a._t - b._t);
  const gaps = [];
  for (let i = 1; i < sorted.length; i += 1) {
    const dt = sorted[i]._t - sorted[i - 1]._t;
    if (dt < gapMs) continue;
    const expected = Math.max(0, Math.round(dt / expectedMs) - 1);
    gaps.push({
      kind: 'missing_interval',
      start_at: new Date(sorted[i - 1]._t).toISOString(),
      end_at: new Date(sorted[i]._t).toISOString(),
      expected_samples: expected,
      received_samples: 0,
      sample_seq_start: sorted[i - 1].seq ?? null,
      sample_seq_end: sorted[i].seq ?? null,
    });
  }
  return gaps;
}

export function summarizeCoverage(samples, gaps, { expectedMs = EXPECTED_SAMPLE_MS } = {}) {
  const received = (samples || []).length;
  const missing = (gaps || []).reduce((n, g) => n + (Number(g.expected_samples) || 0), 0);
  const spanMs = (() => {
    const times = (samples || [])
      .map((s) => Date.parse(s.datetime || s.at || s.t || ''))
      .filter(Number.isFinite)
      .sort((a, b) => a - b);
    if (times.length < 2) return 0;
    return times[times.length - 1] - times[0];
  })();
  const expected = spanMs > 0 ? Math.round(spanMs / expectedMs) + 1 : received;
  return {
    expected_samples: expected,
    received_samples: received,
    missing_samples: missing,
    gap_count: (gaps || []).length,
    complete: missing === 0 && received > 0,
  };
}
