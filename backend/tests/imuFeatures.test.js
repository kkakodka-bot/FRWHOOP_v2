import test from 'node:test';
import assert from 'node:assert/strict';

import {
  extractImuFeatures, enmoPerSample, dominantFrequency, cadenceSpM,
  bandPowerFraction, movementIntermittency, sampleEntropy,
} from '../energy/imuFeatures.js';

/** Synthesize a 100 Hz acceleration signal: gravity + a periodic arm swing. */
function synth({ seconds = 5, rate = 100, swingHz = 0.8, swingAmp = 0.3, rest = false } = {}) {
  const n = seconds * rate;
  const ax = [], ay = [], az = [];
  for (let i = 0; i < n; i++) {
    const t = i / rate;
    const phase = 2 * Math.PI * swingHz * t;
    if (rest) { ax.push(0.02); ay.push(0.01); az.push(0.98 + 0.01 * Math.sin(phase)); }
    else {
      ax.push(swingAmp * Math.sin(phase));
      ay.push(0.1 * swingAmp * Math.sin(2 * phase + 0.3));
      az.push(0.98 + 0.3 * swingAmp * Math.sin(phase));
    }
  }
  return { ax, ay, az, sampleRate: rate };
}

test('rest vs active: ENMO and VM are distinctly separated', () => {
  const rest = extractImuFeatures(synth({ rest: true }));
  const walk = extractImuFeatures(synth({ swingHz: 0.8, swingAmp: 0.6 }));
  assert.ok(rest.enmo_mean < 0.05, `rest enmo ${rest.enmo_mean} should be ~0 (no net acceleration)`);
  assert.ok(walk.enmo_mean > 0.05, `walk enmo ${walk.enmo_mean} should be non-trivial`);
  assert.ok(walk.enmo_sma > rest.enmo_sma, `walk SMA ${walk.enmo_sma} > rest ${rest.enmo_sma}`);
  assert.ok(walk.accel_peak > rest.accel_peak);
});

test('dominant frequency recovers the swing frequency', () => {
  const { ax, az, sampleRate } = synth({ swingHz: 1.4, swingAmp: 0.4 });
  const dom = dominantFrequency(az, sampleRate);
  assert.ok(dom.freq != null);
  assert.ok(Math.abs(dom.freq - 1.4) < 0.3, `dom freq ${dom.freq} ~= 1.4`);
});

test('cadence band power is higher when a gait-frequency signal is present', () => {
  const still = bandPowerFraction(new Array(500).fill(0.5), 100, 1.0, 3.2);
  const { az, sampleRate } = synth({ swingHz: 1.6, swingAmp: 0.4 });
  const moving = bandPowerFraction(az, sampleRate, 1.0, 3.2);
  assert.ok(moving > still, `moving cadence band ${moving} > still ${still}`);
});

test('movement intermittency separates continuous motion from stillness', () => {
  // All samples have vector magnitude-1 > 0.12 (continuous movement).
  const a = [1.2, 1.25, 1.22, 1.3, 1.28], b = [0, 0, 0, 0, 0], c = [0, 0, 0, 0, 0];
  assert.equal(movementIntermittency(a, b, c), 1);
  // All at rest (magnitude ~0.98-1 -> |v|-1 ~ -0.02, below threshold).
  const a2 = [0.02, 0.01, -0.01, 0.0, 0.02], b2 = [0.01, 0.0, 0.0, 0.0, 0.01], c2 = [1.0, 0.99, 1.0, 1.0, 0.98];
  assert.equal(movementIntermittency(a2, b2, c2), 0);
});

test('entropy is bounded and finite on clean periodic input', () => {
  const { az, sampleRate } = synth({ swingHz: 0.8, swingAmp: 0.3 });
  const se = sampleEntropy(az);
  assert.ok(se == null || (Number.isFinite(se) && se >= 0), `entropy ${se}`);
});

test('full feature vector carries every documented field', () => {
  const f = extractImuFeatures(synth({ swingHz: 1.0, swingAmp: 0.3 }));
  const expected = ['enmo_mean','vm_mean','accel_std','dom_freq_hz','cadence_cycles_per_min',
    'period_s','jerk_mean','entropy','movement_intermittency','accel_peak','accel_rms',
    'ax_ay_corr','gravity_z_mean','tilt_estimate','enmo_p10','enmo_p90','dyn_enmo_mean',
    'bandpass_motion_auc_20hz','orientation_stability','coverage','sub_enmo_mean','gyro_energy'];
  for (const k of expected) {
    assert.ok(k in f, `missing feature ${k}`);
    assert.ok(f[k] == null || Number.isFinite(f[k]), `${k} not finite: ${f[k]}`);
  }
});

test('rest posture: tilt estimate places the strap near vertical or horizontal appropriately', () => {
  // z near +g -> tilt ~0 (upright). z near 0 -> tilt ~90 (flat).
  const upright = extractImuFeatures({ ax:[0,0,0], ay:[0,0,0], az:[1,1,1], sampleRate:100 });
  const flat = extractImuFeatures({ ax:[1,1,1], ay:[0,0,0], az:[0,0,0], sampleRate:100 });
  assert.ok(upright.tilt_estimate < 30, `upright tilt ${upright.tilt_estimate}`);
  assert.ok(flat.tilt_estimate > 60, `flat tilt ${flat.tilt_estimate}`);
});

test('wrist and bicep still-thresholds are not shared', () => {
  const n = 80;
  const ax = Array(n).fill(0.57);
  const ay = Array(n).fill(0);
  const az = Array(n).fill(1);
  const wrist = extractImuFeatures({ ax, ay, az, sampleRate: 100, placement: 'wrist' });
  const bicep = extractImuFeatures({ ax, ay, az, sampleRate: 100, placement: 'bicep' });
  assert.ok(wrist.movement_intermittency > bicep.movement_intermittency,
    `wrist ${wrist.movement_intermittency} should exceed bicep ${bicep.movement_intermittency}`);
  assert.ok(wrist.placement === 'wrist' && bicep.placement === 'bicep');
});
