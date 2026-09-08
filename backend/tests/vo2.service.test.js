import assert from 'node:assert/strict';
import test from 'node:test';
import express from 'express';
import { registerVo2Routes } from '../vo2/routes.js';
import { normalizeHostStore } from '../host/routes.js';
import { emptyVo2State } from '../vo2/repository.js';

function fixtureDays(n = 21) {
  const days = {};
  for (let i = 0; i < n; i += 1) {
    const d = new Date(Date.UTC(2026, 7, 24 - i)).toISOString().slice(0, 10);
    days[d] = {
      physiological_summary: {
        'Recovery score %': 70,
        'Resting heart rate (bpm)': 58,
        'Heart rate variability (ms)': 62,
        'Asleep duration (min)': 430,
        'Sleep efficiency %': 90,
        'Sleep consistency %': 80,
        Steps: 8000,
      },
      workouts: [],
    };
  }
  return days;
}


test('VO2 routes expose current estimate, history, methodology, lab, and HRmax', async () => {
  let store = normalizeHostStore({
    prefs: {},
    profile: { sex: 'male', birthYear: 1990, heightCm: 178, weightKg: 75 },
    vo2: emptyVo2State(),
    days: fixtureDays(),
  });
  const app = express();
  app.use(express.json());
  registerVo2Routes(app, {
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
    const method = await json('/api/vo2-max/methodology');
    assert.equal(method.status, 200);
    assert.equal(method.body.version, 'vo2_v1');
    assert.match(method.body.disclaimer, /not a metabolic-cart/i);

    const current = await json('/api/vo2-max');
    assert.equal(current.status, 200);
    assert.ok('vo2Max' in current.body);
    assert.ok('tier' in current.body);
    assert.ok('eligibility' in current.body);
    assert.ok(store.vo2.latest);

    const history = await json('/api/vo2-max/history');
    assert.equal(history.status, 200);
    assert.ok(Array.isArray(history.body.snapshots));
    assert.ok(history.body.snapshots.length >= 1);

    const labBad = await json('/api/vo2-max/lab', {
      method: 'POST',
      body: { value: 50, modality: 'user_entered' },
    });
    assert.equal(labBad.status, 400);

    const lab = await json('/api/vo2-max/lab', {
      method: 'POST',
      body: { value: 51.2, modality: 'gas_exchange_gxt', measuredOn: '2026-01-15' },
    });
    assert.equal(lab.status, 201);
    assert.equal(lab.body.anchor.value, 51.2);
    const listed = await json('/api/vo2-max/lab');
    assert.equal(listed.body.anchors.length, 1);
    assert.equal(listed.body.anchors[0].value, 51.2);

    const hr = await json('/api/vo2-max/hr-max', { method: 'POST', body: { value: 191 } });
    assert.equal(hr.status, 200);
    assert.equal(hr.body.hrMaxOverride.value, 191);

    const again = await json('/api/vo2-max/recalculate', { method: 'POST', body: {} });
    assert.equal(again.status, 200);
    assert.ok('vo2Max' in again.body);
  } finally {
    await new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  }
});
