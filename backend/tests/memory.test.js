
import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryStore, nextId } from '../memory/store.js';
import { extractDurableFacts } from '../memory/promote.js';
import { promoteTurn } from '../memory/manager.js';

const NOW = '2026-08-20T00:00:00Z';

function store(records = []) {
  return new MemoryStore({ userId: 'u1', records, now: NOW });
}

test('add + search returns active facts', async () => {
  const m = store();
  m.add({ id: 'a', type: 'preference', topic: 'training_time', content: 'User prefers evening workouts.', provenance: 'user_supplied', confidence: 0.9 });
  m.add({ id: 'b', type: 'goal', topic: 'goal', content: 'User is training for a 5K, target sub 22 min.', confidence: 0.8 });
  const r = await m.search('what time do I like to train');
  assert.ok(r.some((x) => x.id === 'a'));
  assert.ok(!r.some((x) => x.id === 'b'));
});

test('explicit correction supersedes old preference', async () => {
  const m = store();
  m.add({ id: 'old', type: 'preference', topic: 'training_time', content: 'User prefers morning workouts.', provenance: 'user_supplied', confidence: 0.9 });
  const rec = m.correct({ type: 'preference', topic: 'training_time', content: 'User switched to evening workouts and now prefers evenings.', confidence: 0.97 });
  const active = m.active();
  assert.equal(active.length, 1);
  assert.equal(active[0].id, rec.id);
  assert.equal(m.get('old').status, 'superseded');
  assert.equal(m.get('old').supersededBy, rec.id);
  // search must NOT return the contradicted memory
  const r = await m.search('morning workout preference');
  assert.deepEqual(r.map((x) => x.id), [rec.id]);
});

test('correction survives later search against old phrasing', async () => {
  const m = store();
  m.add({ id: 'old', type: 'preference', topic: 'training_time', content: 'User hated morning workouts.', confidence: 0.9 });
  m.correct({ type: 'preference', topic: 'training_time', content: 'User now trains in the morning and prefers it.', confidence: 0.97 });
  const r = await m.search('does the user hate morning workouts');
  assert.equal(r.length, 1);
  assert.match(r[0].content, /prefers it/);
});

test('graph traversal respects hop budgets', () => {
  const m = store();
  m.addRelation({ subject: 'user', predicate: 'prefers', object: 'evening workouts' });
  m.addRelation({ subject: 'evening workouts', predicate: 'associated_with', object: 'better recovery' });
  m.addRelation({ subject: 'user', predicate: 'training_for', object: '5K' });
  const g1 = m.searchGraph('evening workouts', { maxHops: 2, maxNodes: 10, maxExpanded: 12 });
  assert.ok(g1.nodes.includes('evening workouts'));
  assert.ok(g1.nodes.includes('better recovery'));
  const g2 = m.searchGraph('evening workouts', { maxHops: 0 });
  assert.equal(g2.expanded, 0);
});

test('promotion extracts preferences, goals, injuries', () => {
  const prefs = extractDurableFacts({ message: 'I prefer evening workouts, I hate training in the morning.', response: '' });
  assert.ok(prefs.some((f) => f.type === 'preference' && /evening/.test(f.content)));
  const goals = extractDurableFacts({ message: 'I am training for a marathon, aiming for a sub 4 hour finish.', response: '' });
  assert.ok(goals.some((f) => f.type === 'goal'));
  const inj = extractDurableFacts({ message: 'My knee has been hurting since my last leg session.', response: '' });
  assert.ok(inj.some((f) => f.type === 'injury'));
});

test('promoteTurn writes and dedups', () => {
  const m = store();
  let written = promoteTurn({ store: m, message: 'I prefer evening workouts.', response: 'Noted.' });
  assert.equal(m.active().length, 1);
  written = promoteTurn({ store: m, message: 'I prefer evening workouts pretty strongly now.', response: 'Got it.' });
  assert.equal(m.active().length, 1, 'duplicate should confirm, not duplicate');
});

test('promoteTurn applies corrections via supersession', () => {
  const m = store();
  promoteTurn({ store: m, message: 'I used to train in the morning but I switched to evenings and prefer it now.', response: '' });
  const active = m.active();
  assert.ok(active.length > 0);
  assert.match(active[0].content, /evening/i);
  const audits = m.audits();
  assert.equal(audits.total, active.length);
});

test('memory types are bounded to the 13 classes', () => {
  const m = store();
  m.add({ id: 'x', type: 'goals_typo', content: 'bad type' });
  const audits = m.audits();
  assert.equal(audits.byType.goals_typo, undefined);
});
