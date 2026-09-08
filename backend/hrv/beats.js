/**
 * Canonical RR beat reconstruction.
 *
 * A Type-40 / GATT / historical sample may carry several RR intervals that
 * END at the sample timestamp. Walking them backward keeps beat-end instants
 * ordered. Equal consecutive values are distinct beats.
 */

import { num } from '../signal/constants.js';
import { observationsFromSamples, SRC_CLASS_PRIORITY } from '../hr2/observation.js';

export function beatsFromRrArray(endMs, rrMs, extra = {}) {
  if (!Number.isFinite(endMs) || !Array.isArray(rrMs) || !rrMs.length) return [];
  let cursor = endMs;
  const ordered = [];
  for (let i = rrMs.length - 1; i >= 0; i -= 1) {
    const v = num(rrMs[i]);
    if (v == null) continue;
    ordered.push({ ts: cursor, rrMs: v, ...extra });
    cursor -= v;
  }
  ordered.reverse();
  return ordered;
}

/**
 * Keep every same-source sample in a second (two 812 ms beats are two beats).
 * Drop lower-priority sources in that second so Type-40/GATT/history overlap
 * cannot double HRV/respiration.
 */
export function canonicalRrSamples(samples) {
  const obs = observationsFromSamples(samples);
  const bySec = new Map();
  for (const o of obs) {
    const sec = Math.floor(o.tMs / 1000);
    if (!bySec.has(sec)) bySec.set(sec, []);
    bySec.get(sec).push(o);
  }
  const out = [];
  for (const group of bySec.values()) {
    const classes = [...new Set(group.map((g) => g.src_class))];
    let winners = group;
    if (classes.length > 1) {
      const domains = new Set(group.map((g) => g.clock_domain));
      const liveVsGatt = classes.every((c) => c === 'live' || c === 'gatt');
      if (!(domains.size > 1 && !liveVsGatt)) {
        const best = Math.max(...group.map((g) => SRC_CLASS_PRIORITY[g.src_class] ?? 0));
        winners = group.filter((g) => (SRC_CLASS_PRIORITY[g.src_class] ?? 0) === best);
      }
    }
    const exact = new Map();
    for (const o of winners) {
      const key = `${o.tMs}|${o.src_class}|${o.connection_epoch ?? ''}`;
      const prev = exact.get(key);
      // Late history often restarts seq at 0; keep the richer RR, else last-write.
      if (!prev || (o.rr_ms?.length || 0) >= (prev.rr_ms?.length || 0)) exact.set(key, o);
    }
    out.push(...exact.values());
  }
  return out.sort((a, b) => a.tMs - b.tMs);
}

/**
 * Flatten samples to timestamped beats. Optional source arbitration so one
 * physical RR observation cannot enter HRV/respiration twice.
 */
export function beatsFromRrSamples(samples, { dedupe = true } = {}) {
  const rows = dedupe ? canonicalRrSamples(samples) : [...(samples || [])];
  const out = [];
  for (const s of rows) {
    const ts = Number.isFinite(s?.tMs)
      ? s.tMs
      : Date.parse(s?.t ?? s?.datetime ?? s?.at ?? '');
    if (!Number.isFinite(ts)) continue;
    const rr = s.rr_ms ?? s.rrIntervals;
    if (!Array.isArray(rr) || !rr.length) continue;
    const epoch = s.connection_epoch ?? s.rr_continuity ?? 0;
    out.push(...beatsFromRrArray(ts, rr, {
      epoch,
      src: s.src,
      src_class: s.src_class,
    }));
  }
  return out.sort((a, b) => a.ts - b.ts || (a.epoch ?? 0) - (b.epoch ?? 0));
}
