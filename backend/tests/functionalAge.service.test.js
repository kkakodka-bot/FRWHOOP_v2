import assert from 'node:assert/strict';
import test from 'node:test';
import express from 'express';
import { registerFunctionalAgeRoutes } from '../functionalAge/routes.js';
import { normalizeHostStore } from '../host/routes.js';

test('functional age routes return contributors, history, and methodology', async () => {
  let store = normalizeHostStore({
    prefs: {},
    profile: { sex: 'male', birthYear: 1995, heightCm: 178, weightKg: 75, leanBodyMassPct: 81, vo2Max: 46.8, vo2MaxSource: 'user_entered' },
    activities: [],
    functionalAge: { snapshots: [], latest: null },
    days: Object.fromEntries(Array.from({ length: 30 }, (_, i) => {
      const d = new Date(Date.UTC(2026, 7, 24 - i)).toISOString().slice(0, 10);
      return [d, {
        physiological_summary: {
          'Recovery score %': 72,
          'Resting heart rate (bpm)': 58,
          'Asleep duration (min)': 450,
          'Sleep consistency %': 82,
          Steps: 9000,
        },
        workouts: [],
      }];
    })),
  });
  const app = express();
  app.use(express.json());
  registerFunctionalAgeRoutes(app, {
    loadStore: () => store,
    saveStore: (next) => { store = next; },
  });
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const port = server.address().port;
  const json = async (path, opts = {}) => {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      ...opts,
      headers: { 'content-type': 'application/json', ...(opts.headers || {}) },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
    return { status: res.status, body: await res.json() };
  };

  try {
    const method = await json('/api/functional-age/methodology');
    assert.equal(method.status, 200);
    assert.equal(method.body.version, 'functional_age_v1');
    assert.equal(method.body.gompertzRate, 0.1);

    const current = await json('/api/functional-age');
    assert.equal(current.status, 200);
    assert.ok(Number.isFinite(current.body.functionalAge));
    assert.equal(current.body.contributors.length, 9);
    assert.ok(current.body.contributors.every((c) => 'ageImpactYears' in c && 'explanation' in c));
    const vo2 = current.body.contributors.find((c) => c.key === 'vo2_max');
    assert.equal(vo2.available, true);
    const lbm = current.body.contributors.find((c) => c.key === 'lean_body_mass');
    assert.equal(lbm.available, true);
    assert.ok(store.functionalAge.latest);

    const history = await json('/api/functional-age/history');
    assert.equal(history.status, 200);
    assert.ok(history.body.snapshots.length >= 1);
    assert.equal(history.body.snapshots[0].methodologyVersion, 'functional_age_v1');

    const again = await json('/api/functional-age/recalculate', { method: 'POST', body: {} });
    assert.equal(again.status, 200);
    assert.equal(again.body.functionalAge, current.body.functionalAge);
  } finally {
    await new Promise((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
  }
});
