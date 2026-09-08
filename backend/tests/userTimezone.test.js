import assert from 'node:assert/strict';
import test from 'node:test';
import { createTimeZoneResolver, readProfileTimeZone } from '../identity/userTimezone.js';

const USER = '9f33375b-e029-480f-9ebb-a99e5ff22ac9';

test('resolver uses the profile IANA zone not a process default', async () => {
  const resolver = createTimeZoneResolver({
    loadProfileTimeZone: async (id) => (id === USER ? 'America/Los_Angeles' : 'UTC'),
    fallback: 'UTC',
  });
  assert.equal(resolver.peek(USER), 'UTC');
  assert.equal(await resolver.ensure(USER), 'America/Los_Angeles');
  assert.equal(resolver.peek(USER), 'America/Los_Angeles');
});

test('invalid IANA names fall back to UTC', async () => {
  const resolver = createTimeZoneResolver({
    loadProfileTimeZone: async () => 'Not/AZone',
    fallback: 'UTC',
  });
  assert.equal(await resolver.ensure(USER), 'UTC');
});

test('failed profile fetch does not pin UTC', async () => {
  let fail = true;
  const resolver = createTimeZoneResolver({
    loadProfileTimeZone: async () => {
      if (fail) throw new Error('down');
      return 'America/Los_Angeles';
    },
    fallback: 'UTC',
  });
  assert.equal(await resolver.ensure(USER), 'UTC');
  fail = false;
  assert.equal(await resolver.ensure(USER), 'America/Los_Angeles');
});

test('readProfileTimeZone hits profiles for that user only', async () => {
  const calls = [];
  const tz = await readProfileTimeZone({
    userId: USER,
    rest: async (table, query) => {
      calls.push({ table, query });
      return [{ timezone: 'America/Los_Angeles' }];
    },
  });
  assert.equal(tz, 'America/Los_Angeles');
  assert.equal(calls[0].table, 'profiles');
  assert.equal(calls[0].query.includes(USER), true);
  assert.equal(calls[0].query.includes('select=timezone'), true);
});
