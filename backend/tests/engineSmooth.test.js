
import test from 'node:test';
import assert from 'node:assert/strict';
import { computeEnergyMinutesWithSmoothing } from '../energy/engineSmooth.js';
import { resolvePhysiology } from '../energy/physiology.js';

const PROFILE = { birthYear: 1994, sex: 'male', heightCm: 180, weightKg: 78 };
const PREFS = { restingHr: 52 };
const T0 = Date.parse('2026-08-24T15:00:00Z');
function steady({ minutes = 20, bpm = 60, mot = 0.01 }) {
  const out = [];
  for (let s = 0; s < minutes * 60; s += 4) out.push({ datetime: new Date(T0 + s * 1000).toISOString(), bpm, motion: mot });
  return out;
}
function phys() { return resolvePhysiology({ profile: PROFILE, prefs: PREFS }); }

test('smoothing variant runs and is deterministic', () => {
  const samples = steady({ minutes: 15 });
  const p = phys();
  const a = computeEnergyMinutesWithSmoothing({ samples, physiology: p, timeZone: 'UTC', smooth: 'filter' });
  const b = computeEnergyMinutesWithSmoothing({ samples, physiology: p, timeZone: 'UTC', smooth: 'filter' });
  assert.equal(a.minutes.length, b.minutes.length);
  assert.deepEqual(a.minutes, b.minutes, 'recompute identical');
  assert.ok(a.minutes.length > 0, 'has minutes');
});

test('smoothing removes a lone single-minute flicker', () => {
  // 20 walking minutes with a single anomalous "running" minute in the middle.
  const base = steady({ minutes: 20, bpm: 110, mot: 0.4 });
  // The anomaly: minute 10 gets a huge motion spike + low HR -> classifier may flicker to running/daily_activity.
  const samples = base.map((sm, idx) => {
    const sec = idx * 4;
    const minI = Math.floor(sec / 60);
    return { ...sm, motion: minI === 10 ? 0.9 : sm.motion };
  });
  const p = phys();
  const r = computeEnergyMinutesWithSmoothing({ samples, physiology: p, timeZone: 'UTC', smooth: 'filter' });
  const acts = r.minutes.map((m) => m.activity_type);
  // The minute around index ~10 should not be an isolated extreme jump; count transitions.
  let jumps = 0;
  for (let i = 1; i < acts.length; i++) if (acts[i] !== acts[i - 1]) jumps++;
  assert.ok(jumps <= 3, `flicker reduced, got ${jumps} transitions`);
  // continuity: at least 14 of 20 minutes share the same dominant activity
  const dom = acts.reduce((m2, a2) => { m2[a2] = (m2[a2] || 0) + 1; return m2; }, {});
  const top = Math.max(...Object.values(dom));
  assert.ok(top >= 15, `dominant activity covers ${top}/20`);
});

test('smooth=none matches single-pass coverage', () => {
  const samples = steady({ minutes: 12 });
  const p = phys();
  const r = computeEnergyMinutesWithSmoothing({ samples, physiology: p, timeZone: 'UTC', smooth: 'none' });
  assert.ok(r.minutes.length === 12, `coverage ${r.minutes.length}`);
});

test('full (smoothing) mode also runs and bounds confidence', () => {
  const samples = steady({ minutes: 10 });
  const p = phys();
  const r = computeEnergyMinutesWithSmoothing({ samples, physiology: p, timeZone: 'UTC', smooth: 'full' });
  for (const m of r.minutes) {
    assert.ok(m.activity_confidence >= 0 && m.activity_confidence <= 1);
    assert.ok(m.model_confidence >= 0 && m.model_confidence <= 1);
  }
});
