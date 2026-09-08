/**
 * Where the energy engine reads live samples from.
 *
 * BLE ingest is attributed to whichever identity the phone presented (JWT or
 * device token). Those are different UUIDs on this host, so a day file can sit
 * on one id while Overview asks as the other. Merge, then drop fixture-strap
 * rows when a real WHOOP device is in the mix.
 */

import fs from 'node:fs';
import path from 'node:path';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const E2E_DEVICE = 'e2e-strap';
/** e2e leftovers are ~26 KB; a real strap hour is hundreds of KB. */
export const REAL_DAY_FILE_BYTES = 80_000;

function deviceIdOf(sample) {
  return String(sample?.deviceId || sample?.device_id || sample?.externalId || '');
}

function sampleKey(sample) {
  const t = sample?.datetime || sample?.t || sample?.at || '';
  const bpm = sample?.bpm ?? sample?.hr ?? sample?.heartRate ?? '';
  const seq = sample?.seq ?? '';
  return `${t}|${bpm}|${seq}|${deviceIdOf(sample)}`;
}

export function mergeSamples(...lists) {
  const out = [];
  const seen = new Set();
  for (const list of lists) {
    for (const sample of list || []) {
      if (!sample || typeof sample !== 'object') continue;
      const key = sampleKey(sample);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(sample);
    }
  }
  return preferRealStrap(out);
}

/** Test-harness `e2e-strap` rows must not price a real WHOOP minute. */
export function preferRealStrap(samples) {
  const rows = samples || [];
  const hasReal = rows.some((s) => {
    const id = deviceIdOf(s);
    return id && id !== E2E_DEVICE;
  });
  if (!hasReal) return rows;
  return rows.filter((s) => deviceIdOf(s) !== E2E_DEVICE);
}

/**
 * Identities whose day files could feed one energy computation on a local
 * multi-folder host. Production identity routing does not use this: writes
 * and reads belong to the JWT `auth.users.id` only.
 */
export function overlayLiveUserIds({
  userId,
  localUserId,
  liveDir,
  days = [],
  minBytes = REAL_DAY_FILE_BYTES,
} = {}) {
  const ids = [];
  const seen = new Set();
  const add = (id) => {
    if (!id || seen.has(id)) return;
    seen.add(id);
    ids.push(id);
  };
  add(userId);
  add(localUserId);
  if (!liveDir) return ids;
  const dayList = (Array.isArray(days) ? days : [days]).filter(Boolean);
  try {
    for (const name of fs.readdirSync(liveDir)) {
      if (seen.has(name) || !UUID_RE.test(name)) continue;
      const big = dayList.some((day) => {
        try {
          return fs.statSync(path.join(liveDir, name, `${day}.ndjson`)).size >= minBytes;
        } catch {
          return false;
        }
      });
      if (big) add(name);
    }
  } catch {
    /* live dir missing in tests */
  }
  return ids;
}
