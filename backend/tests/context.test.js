
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildTurnMessages, estimateTokens, isTrivial, summariseEpisode } from '../context/compactor.js';

function turns(n, offset = 0) {
  const out = [];
  for (let i = 0; i < n; i += 1) {
    out.push({ role: 'user', id: offset + i, content: `question number ${i}: how is my recovery?` });
    out.push({ role: 'ai', id: `a${offset + i}`, content: `Recovery is fine on day ${i}.` });
  }
  return out;
}

test('short history stays verbatim, no episodes', () => {
  const res = buildTurnMessages({ history: turns(3), recent: 6 });
  assert.equal(res.meta.episodes, 0);
  assert.equal(res.messages.length, 6);
});

test('long history compacts older turns into episodes and keeps recent verbatim', () => {
  const res = buildTurnMessages({ history: turns(40), recent: 6 });
  assert.ok(res.meta.episodes > 0);
  const recentUser = res.messages.filter((m) => m.role === 'user').map((m) => m.content);
  assert.ok(recentUser.at(-1).includes('question number 39'));
  // the very first turn is NOT verbatim (it's inside an episode)
  assert.ok(!recentUser.some((c) => c.includes('question number 0')));
  const sysPrefix = res.messages.find((m) => m.role === 'system' && String(m.content).startsWith('PAST CONVERSATION'));
  assert.ok(sysPrefix);
  assert.match(sysPrefix.content, /PAST CONVERSATION EPISODES/);
});

test('buffer never grows unboundedly', () => {
  const big = buildTurnMessages({ history: turns(300), recent: 14 });
  assert.ok(big.meta.estimateTokens < 2600);
});

test('durable facts survive older episodes (goal captured in episode decisions)', () => {
  const h = [
    { role: 'user', id: 0, content: 'I am training for the Chicago marathon in October.' },
    { role: 'ai', id: 1, content: 'Great target.' },
    ...turns(30, 2),
  ];
  const res = buildTurnMessages({ history: h, recent: 8 });
  const prefix = res.messages.find((m) => String(m.content).startsWith('PAST CONVERSATION'))?.content || '';
  assert.match(prefix, /goal/);
});

test('trivial turns are flagged', () => {
  assert.equal(isTrivial('thanks!'), true);
  assert.equal(isTrivial('How did I sleep last night?'), false);
});

test('token estimator is a rough monotonic proxy', () => {
  assert.equal(estimateTokens('x'.repeat(400)), 100);
});
