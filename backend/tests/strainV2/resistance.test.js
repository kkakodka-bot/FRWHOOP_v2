import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resistanceFeatures, exerciseFeatures } from '../../metrics/strainV2/resistance.js';
import { BODY_MASS_FRACTIONS, exerciseFamily } from '../../metrics/strainV2/resistanceTable.js';

test('resistance: volume load + relative intensity arithmetic', () => {
  const out = resistanceFeatures({
    bodyMassKg: 80,
    exercises: [{
      name: 'Back Squat',
      oneRmKg: 140,
      sets: [
        { reps: 8, loadKg: 100 },
        { reps: 8, loadKg: 100 },
        { reps: 6, loadKg: 112.5 },
      ],
    }],
  });
  const ex = out.features.exercises[0];
  assert.equal(ex.family, 'squat');
  assert.equal(ex.totalReps, 22);
  assert.equal(ex.sets, 3);
  // external: 8*100 + 8*100 + 6*112.5 = 2275
  assert.equal(ex.externalVolumeLoadKg, 2275);
  // effective: (8+8)*(100+0.70*80) + 6*(112.5+56) = 2496 + 1011 = 3507
  assert.equal(ex.effectiveVolumeLoadKg, 3507);
  // relative intensity: 100/140 = 0.714, 112.5/140 = 0.804
  assert.deepEqual(ex.relativeIntensity, [0.714, 0.714, 0.804]);
  assert.equal(out.state, 'experimental');
  assert.equal(out.mergedMuscularStrain, null); // no universal AU by design
});

test('resistance: unknown family suppresses effective mass instead of guessing', () => {
  const out = resistanceFeatures({
    bodyMassKg: 80,
    exercises: [{ name: 'Mystery Machine', sets: [{ reps: 10, loadKg: 40 }] }],
  });
  const ex = out.features.exercises[0];
  assert.equal(ex.family, 'unknown');
  assert.equal(ex.effectiveVolumeLoadKg, null);
  assert.ok(ex.notes.includes('unknown_family_effective_mass_suppressed'));
  // session-level effective total is null if any exercise cannot be converted
  assert.equal(out.features.effectiveVolumeLoadKg, null);
  // external volume still computed
  assert.equal(out.features.externalVolumeLoadKg, 400);
});

test('resistance: session RPE (Foster) only when both RPE and duration exist', () => {
  const a = resistanceFeatures({ durationMin: 45, sessionRpe0to10: 6, exercises: [] });
  assert.equal(a.sessionRpe.au, 270);
  const b = resistanceFeatures({ durationMin: 45, exercises: [] });
  assert.equal(b.sessionRpe, null);
  const c = resistanceFeatures({ sessionRpe0to10: 11, exercises: [] });
  assert.equal(c.sessionRpe, null);
});

test('resistance: velocity fields are passthrough provenance, never load', () => {
  const ex = exerciseFeatures({
    name: 'Bench Press', family: 'bench', bodyMassKg: 80,
    sets: [{ reps: 5, loadKg: 100, meanConcentricMs: 0.42, romDeg: 38 }],
  });
  assert.equal(ex.effectiveVolumeLoadKg, 5 * (100 + 0.15 * 80));
  // meanConcentricMs present but NOT converted to any load/strain quantity
  assert.ok(!('velocityLoad' in ex));
  assert.ok(!('muscularStrain' in ex));
});

test('resistance: body-mass fraction overrides allowed per set', () => {
  const ex = exerciseFeatures({
    name: 'Squat', bodyMassKg: 100,
    sets: [{ reps: 2, loadKg: 0, bodyMassFraction: 0.5 }],
  });
  assert.equal(ex.effectiveVolumeLoadKg, 2 * (0 + 0.5 * 100));
});

test('resistance: determinism', () => {
  const activity = { bodyMassKg: 75, exercises: [{ name: 'Deadlift', sets: [{ reps: 5, loadKg: 120 }] }] };
  assert.deepEqual(resistanceFeatures(activity), resistanceFeatures(activity));
});

test('resistance: exercise family regexes', () => {
  assert.equal(exerciseFamily('Back Squat'), 'squat');
  assert.equal(exerciseFamily('Romanian Deadlift'), 'deadlift');
  assert.equal(exerciseFamily('DB Bench Press'), 'bench');
  assert.equal(exerciseFamily('Overhead Press'), 'overhead_press');
  assert.equal(exerciseFamily('Pull-ups'), 'pullup');
  assert.equal(exerciseFamily('Bicep Curl'), 'unknown');
});

test('resistance: body-mass fraction table carries evidence flags', () => {
  for (const [fam, meta] of Object.entries(BODY_MASS_FRACTIONS)) {
    if (fam === 'unknown') assert.equal(BODY_MASS_FRACTIONS[fam].value, null);
    assert.equal(typeof BODY_MASS_FRACTIONS[fam].evidence, 'string');
  }
});
