import { assert, assertEquals } from 'jsr:@std/assert';
import { IdentityError } from '../_shared/tokens.ts';
import { handleScoresRequest, readOwnerDayScores } from '../_shared/serverScores.ts';
import { enqueueScoringAfterIngest, localDaysTouched, ymdInTimeZone } from '../_shared/scoringEnqueue.ts';
import { makeMemRest } from './helpers.ts';

const USER = '7f2c9a10-4b3e-4d8a-9c11-00000000f001';
const DAY = '2026-09-18';

function overlayFor(userId: string, day: string) {
  return {
    schema_version: 2,
    user_id: userId,
    day,
    algorithm_version: 'frwhoop-physiology-2',
    features: {
      hrv: { status: 'available', device_id: 'device', algorithm_version: 'frwhoop-physiology-2' },
    },
    daily: { hrv_rmssd_ms: 42, recovery: 88, strain: 12 },
    nights: [],
    stale: false,
  };
}

Deno.test('scores: wraps server_scoring_for_day for the authenticated owner', async () => {
  const rest = makeMemRest();
  rest.rpc = async (name: string, args: any) => {
    assertEquals(name, 'server_scoring_for_day');
    assertEquals(args.p_user, USER);
    assertEquals(args.p_day, DAY);
    return overlayFor(USER, DAY);
  };
  const body = await readOwnerDayScores({ rest: rest as any, userId: USER, day: DAY });
  assertEquals(body.server_scoring.user_id, USER);
  assertEquals(body.server_scoring.daily.recovery, 88);
});

Deno.test('scores: rejects a malformed day', async () => {
  const rest = makeMemRest();
  let threw = false;
  try {
    await readOwnerDayScores({ rest: rest as any, userId: USER, day: '18-09-2026' });
  } catch (err: any) {
    threw = true;
    assertEquals(err.code, 'invalid_day');
  }
  assert(threw);
});

Deno.test('scores HTTP: ingest token owner can read without a password JWT', async () => {
  const rest = makeMemRest() as any;
  rest.select = async (table: string) => {
    if (table === 'noop_ingest_tokens') return [{ id: 'tok', user_id: USER }];
    return [];
  };
  rest.rpc = async () => overlayFor(USER, DAY);
  const res = await handleScoresRequest(
    new Request(`https://example.test/functions/v1/scores?day=${DAY}`, {
      headers: { authorization: 'Bearer noop_test-token' },
    }),
    {
      rest,
      cfg: { supabaseUrl: 'https://example.test', supabaseAnonKey: 'anon' },
    },
  );
  assertEquals(res.status, 200);
  const json = await res.json();
  assertEquals(json.server_scoring.daily.hrv_rmssd_ms, 42);
});

Deno.test('scores HTTP: missing bearer is 401', async () => {
  const rest = makeMemRest() as any;
  const res = await handleScoresRequest(new Request('https://example.test/functions/v1/scores'), {
    rest,
    cfg: { supabaseUrl: 'https://example.test', supabaseAnonKey: 'anon' },
  });
  assertEquals(res.status, 401);
});

Deno.test('scores HTTP: identity errors stay unauthorized', async () => {
  const rest = makeMemRest() as any;
  rest.select = async () => {
    throw new IdentityError('authentication required');
  };
  const res = await handleScoresRequest(
    new Request('https://example.test/functions/v1/scores', {
      headers: { authorization: 'Bearer noop_missing' },
    }),
    { rest, cfg: { supabaseUrl: 'https://example.test', supabaseAnonKey: 'anon' } },
  );
  assertEquals(res.status, 401);
});

Deno.test('scoring enqueue: dirty yesterday and today in the owner timezone', async () => {
  const rest = makeMemRest() as any;
  const calls: any[] = [];
  rest.rpc = async (name: string, args: any) => {
    if (name === 'profile_timezone') return 'America/Los_Angeles';
    calls.push({ name, args });
    return 1;
  };
  const at = new Date('2026-09-18T08:30:00Z'); // 01:30 PT, so yesterday is still in play
  const result = await enqueueScoringAfterIngest({
    rest,
    userId: USER,
    deviceId: 'strap-1',
    at,
  });
  assertEquals(result.timezone, 'America/Los_Angeles');
  assertEquals(result.days, localDaysTouched(at, 'America/Los_Angeles'));
  assert(calls.every((c) => c.name === 'scoring_enqueue_day'));
  assertEquals(calls.map((c) => c.args.p_day), result.days);
  assertEquals(new Set(calls.map((c) => c.args.p_user)), new Set([USER]));
  assert(calls.every((c) => c.args.p_debounce_seconds === 30));
});

Deno.test('ymdInTimeZone uses the owner calendar, not UTC', () => {
  assertEquals(ymdInTimeZone(new Date('2026-09-18T08:30:00Z'), 'America/Los_Angeles'), '2026-09-18');
  assertEquals(ymdInTimeZone(new Date('2026-09-18T06:30:00Z'), 'America/Los_Angeles'), '2026-09-17');
});
