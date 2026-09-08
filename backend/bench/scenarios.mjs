
// Ground-truth 30-second epoch stage sequences for the FRWHOOP sleep benchmark.
// 'wake' = awake epoch (internal vocabulary matches the stager).
// Scenarios are SYNTHETIC but labeled; they measure software correctness and
// relative algorithm changes, NOT PSG-grade accuracy.

export const EPOCH = 30;

function night({ startSec, pattern, wakeAt }) {
  const epochs = pattern.map((stage, i) => ({ start: startSec + i * EPOCH, stage }));
  return { kind: 'night', startSec, endSec: startSec + pattern.length * EPOCH, epochs, wakeAt };
}
function nap({ startSec, pattern }) {
  const epochs = pattern.map((stage, i) => ({ start: startSec + i * EPOCH, stage }));
  return { kind: 'nap', startSec, endSec: startSec + pattern.length * EPOCH, epochs };
}
function seq(stage, n) { return Array(n).fill(stage); }

// One ~90 min sleep cycle (~180 epochs): light -> deep -> light -> rem.
function cycle(light1 = 32, deep = 48, light2 = 34, rem = 60) {
  return [...seq('light', light1), ...seq('deep', deep), ...seq('light', light2), ...seq('rem', rem)];
}
const HOUR = 120; // epochs per hour

const BASE = Date.parse('2026-06-10T23:00:00Z') / 1000;

function nCycles(n) { const o=[]; for(let i=0;i<n;i++) o.push(...cycle()); return o; }

export const SCENARIOS = {
  normal8: night({ startSec: BASE, wakeAt: BASE + 8 * 3600,
    pattern: [...seq('wake', 10), ...nCycles(5), ...seq('wake', 8)] }),

  short4: night({ startSec: BASE, wakeAt: BASE + 4 * 3600,
    pattern: [...seq('wake', 8), ...nCycles(2), ...seq('light', 40), ...seq('wake', 6)] }),

  long10: night({ startSec: BASE, wakeAt: BASE + 10 * 3600,
    pattern: [...seq('wake', 10), ...nCycles(6), ...seq('light', 60), ...seq('wake', 8)] }),

  late: night({ startSec: BASE + 3 * 3600, wakeAt: BASE + 10 * 3600,
    pattern: [...seq('wake', 10), ...nCycles(4), ...seq('rem', 20), ...seq('wake', 8)] }),

  early: night({ startSec: BASE - 3 * 3600, wakeAt: BASE - 3 * 3600 + 7 * 3600,
    pattern: [...seq('wake', 10), ...nCycles(4), ...seq('light', 30), ...seq('wake', 8)] }),

  fragmented: night({ startSec: BASE, wakeAt: BASE + 8 * 3600,
    pattern: (() => { const p=[]; for(let i=0;i<8*HOUR;i++){ if(i%50===0) p.push(...seq('wake',6)); else p.push('light'); } return p; })() }),

  overnight_wake: night({ startSec: BASE, wakeAt: BASE + 8 * 3600,
    pattern: [...seq('wake',10), ...nCycles(2), ...seq('wake',120), ...nCycles(3), ...seq('wake',8)] }),

  athlete: night({ startSec: BASE, wakeAt: BASE + 8 * 3600,
    pattern: [...seq('wake',10), ...nCycles(5), ...seq('wake',8)] }),

  high_resting: night({ startSec: BASE, wakeAt: BASE + 8 * 3600,
    pattern: [...seq('wake',10), ...nCycles(5), ...seq('wake',8)] }),

  motionless_awake: night({ startSec: BASE, wakeAt: BASE + 8 * 3600,
    pattern: seq('wake', 8 * HOUR) }),

  // naps at ~15:00
  nap20: nap({ startSec: BASE + 16 * 3600, pattern: [...seq('wake',4), ...seq('deep',10), ...seq('wake',3)] }),
  nap45: nap({ startSec: BASE + 16 * 3600, pattern: [...seq('wake',6), ...seq('deep',24), ...seq('rem',6), ...seq('wake',5)] }),
  nap90: nap({ startSec: BASE + 16 * 3600, pattern: [...seq('wake',8), ...seq('light',20), ...seq('deep',30), ...seq('rem',22), ...seq('wake',8)] }),
};
