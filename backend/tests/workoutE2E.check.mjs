/**
 * End-to-end check of the workout-detect feature against a real backend and the
 * real Supabase project: auto-detect -> strap buzz -> Workout Mode -> end ->
 * local activity -> cloud session, plus the manual start/stop/name path.
 *
 * Runs as a throwaway auth user against a scratch store, so it never writes
 * fake workouts into the history the phone reads, and every assertion is scoped
 * to the ids this run produced — a leftover row from an earlier run must not be
 * able to make a run that persisted nothing look green.
 *
 * Usage: node tests/workoutE2E.check.mjs
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const BACKEND = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function readEnvFile(file) {
  try {
    return Object.fromEntries(fs.readFileSync(file, 'utf8').split('\n')
      .map((line) => line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/))
      .filter(Boolean)
      .map((m) => [m[1], m[2].trim()]));
  } catch {
    return {};
  }
}

const env = { ...readEnvFile(path.join(BACKEND, '.env')), ...process.env };
const SB_URL = env.SUPABASE_URL;
const SB_KEY = env.SUPABASE_SERVICE_ROLE_KEY;
if (!SB_URL || !SB_KEY) {
  console.log('skipped: needs SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY');
  process.exit(0);
}

const SB_HEADERS = { apikey: SB_KEY, authorization: `Bearer ${SB_KEY}`, 'content-type': 'application/json' };

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

async function api(pathname, opts = {}) {
  const res = await fetch(`${BASE}${pathname}`, {
    ...opts,
    headers: { 'content-type': 'application/json', ...(opts.headers || {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* non-json */ }
  return { status: res.status, json, text };
}

async function sbGet(query) {
  const res = await fetch(`${SB_URL}/rest/v1/${query}`, { headers: SB_HEADERS });
  if (!res.ok) throw new Error(`Supabase read failed ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

async function sbWrite(method, query, body) {
  const res = await fetch(`${SB_URL}/${query}`, {
    method,
    headers: SB_HEADERS,
    body: body ? JSON.stringify(body) : undefined,
  });
  // Long enough to reach PostgREST's "message", which sits after "details".
  return { ok: res.ok, status: res.status, text: res.ok ? '' : (await res.text()).slice(0, 600) };
}

function samples({ startMs, endMs, bpm, motion, strapMotion, stepMs = 5000, seq0 = 0 }) {
  const out = [];
  let seq = seq0;
  for (let t = startMs; t <= endMs; t += stepMs) {
    out.push({
      ts: t,
      bpm,
      motion,
      strapMotion: strapMotion ?? motion,
      connected: true,
      seq: ++seq,
      sourceOrigin: 'live',
      clockSource: 'sensor',
      sensorTs: t,
    });
  }
  return out;
}

const stamp = Date.now();
const PORT = Number(process.env.E2E_PORT || (18100 + (stamp % 400)));
const BASE = `http://127.0.0.1:${PORT}`;
const storeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'frwhoop-e2e-'));
const queueFile = path.join(storeDir, 'sync-queue.json');
const liveDir = path.join(storeDir, 'live');
fs.mkdirSync(liveDir, { recursive: true });
let userId = null;
let server = null;
const log = [];

async function waitUp() {
  for (let i = 0; i < 60; i += 1) {
    try {
      if ((await api('/api/prefs')).status === 200) return true;
    } catch { /* not listening yet */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

try {
  // 1. A throwaway user, so nothing here can touch the real account's history.
  const created = await fetch(`${SB_URL}/auth/v1/admin/users`, {
    method: 'POST',
    headers: SB_HEADERS,
    body: JSON.stringify({
      email: `frwhoop-e2e+${stamp}@example.invalid`,
      password: `e2e-${stamp}-pw`,
      email_confirm: true,
    }),
  });
  const createdBody = await created.json();
  userId = createdBody?.id;
  if (!userId) throw new Error(`could not create the test user: ${JSON.stringify(createdBody).slice(0, 200)}`);
  console.log(`test user ${userId}\nscratch store ${storeDir}\n`);

  // The detector personalizes its HR floor from resting HR, which it reads back
  // out of daily_metrics, so a brand-new user needs one seeded day.
  const d = new Date();
  const today = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const seeded = await sbWrite('POST', 'rest/v1/daily_metrics', [{
    user_id: userId,
    day: today,
    resting_hr_bpm: 54,
    algorithm_version: 'e2e-seed',
    computed_at: new Date().toISOString(),
  }]);
  if (!seeded.ok) throw new Error(`could not seed resting HR: ${seeded.status} ${seeded.text}`);

  server = spawn('node', ['index.js'], {
    cwd: BACKEND,
    env: {
      ...process.env,
      PORT: String(PORT),
      FRWHOOP_LOCAL_USER_ID: userId,
      FRWHOOP_STORE_PATH: path.join(storeDir, 'user-store.json'),
      FRWHOOP_SYNC_QUEUE_PATH: queueFile,
      FRWHOOP_LIVE_DIR: liveDir,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.on('data', (b) => log.push(String(b)));
  server.stderr.on('data', (b) => log.push(String(b)));
  if (!await waitUp()) throw new Error(`server never came up:\n${log.join('')}`);

  // 2. Detection + strap buzz on. Haptics ship off (shadow mode), so the check
  //    has to opt in the same way the Settings toggle does.
  const runtime = await api('/api/host/runtime', {
    method: 'POST',
    body: {
      autoWorkoutDetect: true,
      hapticAlerts: true,
      autoWorkoutHaptics: true,
      autoWorkoutRolloutPercentage: 100,
      autoWorkoutDetectorVersion: '2.2.1-beta',
    },
  });
  check('detect + strap haptics are enabled', runtime.json?.autoWorkoutDetect === true && runtime.json?.autoWorkoutHaptics === true, JSON.stringify(runtime.json));

  // The app re-hints these every couple of seconds. Each write enqueues cloud
  // work, so an unchanged hint has to be a no-op.
  const storeFile = path.join(storeDir, 'user-store.json');
  const beforeHint = fs.readFileSync(storeFile, 'utf8');
  const repeat = await api('/api/host/runtime', {
    method: 'POST',
    body: {
      autoWorkoutDetect: true,
      hapticAlerts: true,
      autoWorkoutHaptics: true,
      autoWorkoutRolloutPercentage: 100,
      autoWorkoutDetectorVersion: '2.2.1-beta',
    },
  });
  check('re-hinting the same flags does not rewrite the store',
    repeat.json?.autoWorkoutHaptics === true && fs.readFileSync(storeFile, 'utf8') === beforeHint,
    `haptics=${repeat.json?.autoWorkoutHaptics} rewritten=${fs.readFileSync(storeFile, 'utf8') !== beforeHint}`);

  const changed = await api('/api/host/runtime', { method: 'POST', body: { autoWorkoutMinConfidence: 'high' } });
  check('a changed flag still persists', changed.json?.autoWorkoutMinConfidence === 'high', JSON.stringify(changed.json?.autoWorkoutMinConfidence));
  await api('/api/host/runtime', { method: 'POST', body: { autoWorkoutMinConfidence: 'standard' } });

  // Resting HR arrives asynchronously; the floor is null until it lands.
  let pre = await api('/api/workout-detection/state');
  for (let i = 0; i < 60 && !Number.isFinite(pre.json?.floor); i += 1) {
    await new Promise((r) => setTimeout(r, 500));
    pre = await api('/api/workout-detection/state');
  }
  check('detector has a personalized HR floor', Number.isFinite(pre.json?.floor), `floor=${pre.json?.floor} rhr=${pre.json?.restingHr}`);

  // 3. Rest then >=10 min of strap cardio so V2 lane confirmation can fire.
  const now = Date.now();
  const onset = now - 10 * 60_000;
  const rest = samples({ startMs: now - 13 * 60_000, endMs: onset - 5000, bpm: 62, motion: 0.01, strapMotion: 0.02 });
  const work = samples({ startMs: onset, endMs: now, bpm: 150, motion: 0.5, strapMotion: 0.22, seq0: rest.length });
  const posted = await api('/api/ble/live', {
    method: 'POST',
    body: { connected: true, heartRate: 150, deviceId: 'e2e-strap', name: 'WHOOP 4.0', samples: [...rest, ...work] },
  });
  const buzzed = posted.json?.detection?.buzz === true;

  const active = await api('/api/workout-detection/state');
  const w = active.json?.workout;
  const workoutId = w?.id;
  console.log(`\nconfirmed workout: ${JSON.stringify({ id: workoutId, lifecycle: w?.lifecycle, path: w?.confirmationPath, reason: w?.reasonCode, durationS: w?.durationS, hr: w?.hr, strain: w?.strain, haptic: w?.haptic })}`);

  check('auto-detect confirms a workout', w?.lifecycle === 'ACTIVE' && active.json?.detectorState === 'CONFIRMED', `path=${w?.confirmationPath} reason=${w?.reasonCode}`);
  check('confirmed workoutId is a durable uuid', UUID_RE.test(String(workoutId || '')), `id=${workoutId}`);
  check('confirm is backdated to the onset, not to now', w?.durationS >= 480 && w?.durationS <= 780, `durationS=${w?.durationS}`);
  check('the strap is told to buzz on confirmation', buzzed, `buzz=${posted.json?.detection?.buzz}`);
  check('the buzz is recorded on the session', w?.haptic?.attempted === true, JSON.stringify(w?.haptic));
  check('Workout Mode is signalled to open', active.json?.openWorkoutMode === true || w?.modeOpened === true, `openWorkoutMode=${active.json?.openWorkoutMode}`);
  check('the Live Activity is signalled to start', active.json?.startLiveActivity === true, `startLiveActivity=${active.json?.startLiveActivity}`);
  check('live HR and strain are available to Workout Mode', w?.hr === 150 && Number(w?.strain) > 0, `hr=${w?.hr} zone=${w?.zone} strain=${w?.strain}`);

  // 4. The app calls mode-started when the screen opens; polling must not re-buzz.
  await api('/api/workout-detection/mode-started', { method: 'POST' });
  const again = await api('/api/ble/live', {
    method: 'POST',
    body: { connected: true, heartRate: 150, deviceId: 'e2e-strap', samples: [{ ts: now + 5000, bpm: 150, motion: 0.5, strapMotion: 0.22, connected: true, sourceOrigin: 'live' }] },
  });
  check('the same session never buzzes twice', again.json?.detection?.buzz !== true, `buzz=${again.json?.detection?.buzz}`);

  // 5. "End Workout" from Workout Mode.
  const ended = await api('/api/workout-detection/end', { method: 'POST', body: { reason: 'manual' } });
  check('ending closes the open session', !ended.json?.workout || ended.json?.workout?.lifecycle === 'COMPLETED', `lifecycle=${ended.json?.workout?.lifecycle}`);

  const acts = await api(`/api/activities?date=${today}`);
  const auto = (acts.json || []).find((a) => a.id === workoutId);
  console.log(`\nsaved auto activity: ${JSON.stringify(auto)}`);
  check('the detected workout is saved as an activity', Boolean(auto && auto.source === 'auto'), auto ? `${auto.durationMin} min, strain ${auto.strain}` : 'this run\'s workout id is not in today\'s activities');
  check('the activity carries the workout data', Boolean(auto && auto.durationMin > 0 && auto.avgHr && auto.strain > 0 && Array.isArray(auto.zones)), JSON.stringify({ durationMin: auto?.durationMin, avgHr: auto?.avgHr, maxHr: auto?.maxHr, strain: auto?.strain, calories: auto?.calories }));

  // 6. Manual start/stop/name — what StartActivityScreen posts on "Finish & save".
  const manual = await api('/api/activities', {
    method: 'POST',
    body: {
      date: today,
      name: 'Weightlifting',
      start: new Date(Date.now() - 30 * 60_000).toISOString(),
      end: new Date(Date.now() - 5 * 60_000).toISOString(),
      durationMin: 25,
      avgHr: 132,
    },
  });
  const manualId = manual.json?.id;
  console.log(`\nsaved manual activity: ${JSON.stringify(manual.json)}`);
  check('a manual workout saves under the name it was given', manual.status === 201 && manual.json?.name === 'Weightlifting', `status=${manual.status} name=${manual.json?.name}`);
  check('the manual workout keeps its duration, strain and calories', Number(manual.json?.durationMin) === 25 && Number(manual.json?.strain) > 0 && Number(manual.json?.calories) > 0, JSON.stringify({ durationMin: manual.json?.durationMin, strain: manual.json?.strain, calories: manual.json?.calories }));

  // 7. Drain this-run outbox ops. Lifetime failed totals and other-user
  //    dead letters must not hide a V2 session that never flushed.
  function opUser(op) {
    return op?.payload?.user_id || op?.userId || op?.rows?.[0]?.user_id || op?.row?.user_id || null;
  }
  function loadIsolated() {
    return fs.existsSync(queueFile)
      ? JSON.parse(fs.readFileSync(queueFile, 'utf8'))
      : { pending: [] };
  }
  let queue = null;
  let isolatedQueue = loadIsolated();
  let autoRow = null;
  for (let i = 0; i < 30; i += 1) {
    queue = (await api('/api/observability')).json?.queue;
    isolatedQueue = loadIsolated();
    const mineOpen = (isolatedQueue.pending || []).filter((op) => opUser(op) === userId && !op.deadLetter);
    try {
      const sessionsNow = await sbGet(`sessions?select=id,kind,source,start_at,end_at,summary&user_id=eq.${userId}&id=eq.${workoutId}`);
      autoRow = sessionsNow[0] || null;
    } catch { /* read retry */ }
    if (mineOpen.length === 0 && autoRow) break;
    await new Promise((r) => setTimeout(r, 2000));
  }
  isolatedQueue = loadIsolated();
  const mine = (isolatedQueue.pending || []).filter((op) => opUser(op) === userId);
  const mineOpen = mine.filter((op) => !op.deadLetter);
  const mineDead = mine.filter((op) => op.deadLetter);
  console.log(`\nsync queue: ${JSON.stringify({
    pending: queue?.pending,
    deadLetters: queue?.deadLetters,
    flushed: queue?.totals?.flushed,
    failed: queue?.totals?.failed,
    lastError: queue?.lastError,
    thisRunOpen: mineOpen.length,
    thisRunDead: mineDead.map((op) => ({ type: op.type, error: op.lastError, key: op.__key })),
  })}`);
  check(
    'this-run V2 queue ops drained or classified',
    mineOpen.length === 0,
    `open=${mineOpen.length} dead=${mineDead.length} lastError=${JSON.stringify(queue?.lastError)}`,
  );
  check('canonical V2 session write used the isolated queue path', fs.existsSync(queueFile), queueFile);
  check(
    'this-run V2 session write was not dead-lettered',
    mineDead.length === 0,
    JSON.stringify(mineDead.map((op) => ({ type: op.type, error: op.lastError }))),
  );

  const sessions = await sbGet(`sessions?select=id,kind,source,start_at,end_at,summary&user_id=eq.${userId}&order=start_at.desc&limit=20`);
  autoRow = sessions.find((s) => s.id === workoutId) || autoRow;
  check('the detected workout reached Supabase', Boolean(autoRow && autoRow.kind === 'workout' && autoRow.source === 'auto-detect'), autoRow ? `kind=${autoRow.kind} source=${autoRow.source} strain=${autoRow.summary?.strain}` : `no session row for ${workoutId}`);

  const manualRow = sessions.find((s) => s.id === manualId);
  check('the manual workout reached Supabase with its name', Boolean(manualRow && manualRow.kind === 'manual_workout' && manualRow.summary?.name === 'Weightlifting'), manualRow ? `kind=${manualRow.kind} name=${manualRow.summary?.name} durationMin=${manualRow.summary?.durationMin}` : `no session row for ${manualId}`);

  const events = await sbGet(`events?select=event_type,occurred_at,payload&user_id=eq.${userId}&payload->>workout_id=eq.${workoutId}&order=occurred_at.asc&limit=50`);
  const types = events.map((e) => e.event_type);
  console.log(`\nSupabase ledger for this workout: ${JSON.stringify(types)}`);
  check('the workout lifecycle is in the Supabase ledger', types.includes('workout_confirmed') && types.includes('workout_persisted'), types.join(',') || 'none');
  check('the buzz attempt is in the Supabase ledger', types.includes('haptic_attempted'), types.join(',') || 'none');

  const store = JSON.parse(fs.readFileSync(path.join(storeDir, 'user-store.json'), 'utf8'));
  const localTypes = (store.workoutEvents || []).filter((e) => e.payload?.workout_id === workoutId).map((e) => e.event_type);
  check('every local ledger event for this workout also reached Supabase', localTypes.length > 0 && localTypes.every((t) => types.includes(t)), `local=${JSON.stringify(localTypes)} supabase=${JSON.stringify(types)}`);
} catch (err) {
  check('the check ran to completion', false, String(err?.message || err));
  console.error(log.join('').slice(-2000));
} finally {
  server?.kill('SIGKILL');
  // Children before parents: sessions and the auth user are referenced.
  if (userId) {
    const tables = ['measurements', 'sleep_details', 'algorithm_runs', 'derived_objects', 'object_manifests',
      'events', 'physiology_buckets', 'daily_physiology_series', 'ingest_gaps', 'daily_metrics', 'sessions',
      'devices', 'user_settings'];
    const stuck = [];
    for (const table of tables) {
      const res = await sbWrite('DELETE', `rest/v1/${table}?user_id=eq.${userId}`, null);
      if (!res.ok && !res.text.includes('PGRST205')) stuck.push(`${table}(${res.status})`);
    }
    const dropped = await sbWrite('DELETE', `auth/v1/admin/users/${userId}`, null);
    if (!dropped.ok) stuck.push(`auth user(${dropped.status})`);
    console.log(`\ncleanup: ${stuck.length ? `LEFT BEHIND ${stuck.join(', ')} for ${userId}` : 'test user and all its rows removed'}`);
  }
  fs.rmSync(storeDir, { recursive: true, force: true });

  const failed = results.filter((r) => !r.ok);
  console.log(`\n==== ${results.length - failed.length}/${results.length} checks passed ====`);
  if (failed.length) console.log(failed.map((f) => `FAIL ${f.name} — ${f.detail}`).join('\n'));
  process.exit(failed.length ? 1 : 0);
}
