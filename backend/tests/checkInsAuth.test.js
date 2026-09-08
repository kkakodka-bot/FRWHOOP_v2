import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const src = fs.readFileSync(new URL('../index.js', import.meta.url), 'utf8');

test('check-ins and captures require a JWT user', () => {
  for (const path of ["/api/check-ins", "/api/captures"]) {
    const getAt = src.indexOf(`app.get('${path}'`);
    const postAt = src.indexOf(`app.post('${path}'`);
    assert.ok(getAt > 0, `missing GET ${path}`);
    assert.ok(postAt > getAt, `missing POST ${path}`);
    const getBlock = src.slice(getAt, postAt);
    const postEnd = src.indexOf('app.get', postAt + 1);
    const postBlock = src.slice(postAt, postEnd > postAt ? postEnd : postAt + 800);
    assert.match(getBlock, /requestUser/, `${path} GET must authenticate`);
    assert.match(postBlock, /requestUser/, `${path} POST must authenticate`);
    assert.match(postBlock, /userId: user\.id/, `${path} POST must stamp the JWT user`);
  }
});

test('POST /api/activities persists only the owned row', () => {
  const postAt = src.indexOf("app.post('/api/activities'");
  const delAt = src.indexOf("app.delete('/api/activities");
  assert.ok(postAt > 0, 'missing POST /api/activities');
  const postBlock = src.slice(postAt, delAt > postAt ? delAt : postAt + 1200);
  assert.match(postBlock, /requestUser/, 'POST /api/activities must authenticate');
  assert.match(postBlock, /saveMemory/, 'must not persist the process-wide store');
  assert.match(postBlock, /enqueueOwnedSession/, 'must enqueue only the new session row');
  assert.doesNotMatch(postBlock, /saveStore\(/);
});
