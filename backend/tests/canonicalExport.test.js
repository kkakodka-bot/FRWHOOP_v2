import assert from 'node:assert/strict';
import test from 'node:test';
import { loadCanonicalAccount } from '../settings/canonicalExport.js';

const USER = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';

test('canonical export uses supabase rows and omits tokens', async () => {
  const rest = {
    configured: true,
    async select(table) {
      if (table === 'user_settings') return [{ user_id: USER, units: 'imperial', steps_goal: 4000 }];
      if (table === 'profiles') return [{ id: USER, onboarded: true }];
      if (table === 'devices') return [{ id: 'd1', nickname: 'WHOOP 4.0', last_synced_at: '2026-08-24T12:00:00Z' }];
      if (table === 'integration_connections') {
        return [{ provider: 'strava', status: 'connected', meta: { athlete: { name: 'A' } }, access_token: 'secret' }];
      }
      if (table === 'health_calibrations') return [{ kind: 'blood_pressure', systolic_mmhg: 118 }];
      return [];
    },
  };
  const bundle = await loadCanonicalAccount({
    rest,
    userId: USER,
    loadPersistedDays: async (uid) => ({ '2026-08-24': uid === USER ? { ok: true } : {} }),
    loadStore: () => ({
      activities: [
        { id: 'a1', userId: USER, name: 'Run' },
        { id: 'a2', userId: OTHER, name: 'Ride' },
      ],
    }),
  });
  assert.equal(bundle.source, 'supabase');
  assert.equal(bundle.userId, USER);
  assert.equal(bundle.settings.steps_goal, 4000);
  assert.equal(bundle.profile.onboarded, true);
  assert.equal(bundle.integrations[0].provider, 'strava');
  assert.equal(bundle.integrations[0].access_token, undefined);
  assert.equal(bundle.days['2026-08-24'].ok, true);
  assert.deepEqual(bundle.activities.map((a) => a.id), ['a1']);
});
