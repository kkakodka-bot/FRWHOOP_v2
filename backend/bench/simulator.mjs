
// Plausible wrist physiology simulator. Turns a ground-truth stage sequence
// into 1 Hz gravity + HR + RR streams. The physics are intentionally simple but
// stage-consistent so detectors and stagers have authentic signal to work with:
//  - gravity is (almost) static during sleep, moving during wake
//  - HR has a per-stage mean + noise + slow circadian drift
//  - RR gets a respiratory sinusoid whose regularity differs by stage
// This validates software behavior and relative algorithm changes. It is NOT a
// PSG ground truth.

// Deterministic seeded PRNG (mulberry32) so benchmarks are reproducible.
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function simulateScenario(scenario, { opts = {} } = {}) {
  const RNG = opts.seed != null ? mulberry32(opts.seed) : mulberry32(20260810);
  const gauss = () => {
    let u = 0, v = 0;
    while (u === 0) u = RNG();
    while (v === 0) v = RNG();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  };
  const EPOCH = 30;
  const gravity = [];
  const hr = [];
  const rr = [];
  const start = scenario.startSec;
  const end = scenario.endSec;

  // per-stage templates
  const state = {
    wake: { hrMean: opts.wakeHr ?? 72, hrVar: 3.2, oriVar: 0.30, respAmp: 0.6, respFreq: 0.20 },
    light: { hrMean: opts.lightHr ?? 56, hrVar: 1.2, oriVar: 0.012, respAmp: 1.6, respFreq: 0.25 },
    deep: { hrMean: opts.deepHr ?? 52, hrVar: 0.7, oriVar: 0.006, respAmp: 1.9, respFreq: 0.24 },
    rem: { hrMean: opts.remHr ?? 60, hrVar: 2.4, oriVar: 0.05, respAmp: 0.8, respFreq: 0.21 },
  };

  let t = start;
  // slow orientation wander (axis of the "still" vector)
  let ang = 0.5;
  let grav = { x: 0, y: 0, z: 1 };
  // circadian HR drift: slightly lower in middle of a night (roughly 22:00-06:00)
  function drift(sec) {
    const local = ((sec % 86400) + 86400) % 86400;
    const hour = local / 3600;
    // lowest ~04:00, highest ~18:00
    const dip = 1 - 0.06 * Math.cos(((hour - 4) / 24) * 2 * Math.PI);
    return dip;
  }
  let epochIdx = 0;
  for (let s = start; s < end; s += 1) {
    const idx = Math.min(scenario.epochs.length - 1, Math.floor((s - start) / EPOCH));
    const stage = scenario.epochs[idx].stage;
    const tmpl = state[stage] || state.wake;
    const circadian = drift(s) * (opts.hrScale ?? 1);
    const baseHr = tmpl.hrMean * circadian;
    const bpm = baseHr + gauss() * tmpl.hrVar;
    hr.push({ ts: s, bpm: clamp(Math.round(bpm), 30, 180) });

    // respiratory sinusoid on RR (0.15-0.4 Hz band that the stager scores)
    const phase = 2 * Math.PI * tmpl.respFreq * (s % 86400);
    const rrMs = 60000 / bpm + Math.sin(phase) * tmpl.respAmp * (60000 / baseHr) * 0.25 + gauss() * 6;
    rr.push({ ts: s, rrMs: clamp(Math.round(rrMs), 250, 2200) });

    // orientation walk
    ang = Math.sin(s * 0.001) + Math.cos(s * 0.0007);
    // gravity stays near a fixed orientation when still; moves when awake
    const move = stage === 'wake' ? tmpl.oriVar : tmpl.oriVar;
    grav = {
      x: 0.12 * Math.sin(ang) + gauss() * move,
      y: 0.08 * Math.cos(ang * 0.7) + gauss() * move,
      z: 1 - 0.02 + gauss() * move,
    };
    gravity.push({ ts: s, x: grav.x, y: grav.y, z: grav.z });
    epochIdx += 0;
  }
  return { start, end, gravity, hr, rr };
}
function clamp(n, lo, hi) { return Math.min(hi, Math.max(lo, n)); }
