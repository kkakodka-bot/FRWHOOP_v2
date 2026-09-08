import assert from 'node:assert/strict';
import test from 'node:test';
import { eventsFromStore, sessionsFromStore } from '../persistence/domainMap.js';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';

test('check-ins persist only for the JWT user', () => {
  const events = eventsFromStore({
    checkIns: [
      { id: 'a', userId: A, date: '2026-08-31', feeling: 'good' },
      { id: 'b', userId: B, date: '2026-08-31', feeling: 'ok' },
      { id: 'orphan', date: '2026-08-30', feeling: 'legacy' },
    ],
  }, A);
  assert.deepEqual(events.map((e) => e.id), ['a']);
  assert.equal(events[0].user_id, A);
  assert.equal(events[0].event_type, 'check_in');
});

test('journal and activities do not stamp another user', () => {
  const events = eventsFromStore({
    journal: [
      { id: 'ja', userId: A, date: '2026-08-31' },
      { id: 'jb', userId: B, date: '2026-08-31' },
    ],
  }, A);
  assert.deepEqual(events.map((e) => e.id), ['ja']);
});

test('activities persist only for the JWT user', () => {
  const sessions = sessionsFromStore({
    activities: [
      { id: 'a', userId: A, start: '2026-08-31T10:00:00Z', end: '2026-08-31T11:00:00Z' },
      { id: 'b', userId: B, start: '2026-08-31T10:00:00Z', end: '2026-08-31T11:00:00Z' },
      { id: 'orphan', start: '2026-08-31T12:00:00Z', end: '2026-08-31T13:00:00Z' },
    ],
  }, A);
  assert.deepEqual(sessions.map((s) => s.id), ['a', 'orphan']);
  assert.equal(sessions.every((s) => s.user_id === A), true);
});
