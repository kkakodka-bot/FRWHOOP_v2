import { storageConfig } from '../storage/config.js';
import { mergeHrSeries, mergeStrainSeries, mergeSkinTempSeries } from './buckets.js';
import { dayBounds, physiologicalDay } from '../time/dayBoundary.js';
import { uuidFromParts, isUuid } from '../storage/keys.js';
import { inc } from '../observability/metrics.js';
import { logOvernightEvent } from '../observability/overnightLog.js';

export const QUEUED_DB_METHODS = Object.freeze([
  'loadUserDays',
  'listPhysiologyManifests',
  'getDayCompleteness',
  'upsertDayCompleteness',
  'invalidateDayCompleteness',
  'listIngestGaps',
  'resolveIngestGaps',
  'patchDailyExtras',
  'latestOvernightRun',
]);

/** Device row for ingest. Payload user_id always wins — a stale device.user_id
 * must not hijack the FK. Skip blobs that are not a real devices row. */
export function deviceUpsertRow(payload) {
  const device = payload?.device;
  if (!device || typeof device !== 'object' || Array.isArray(device)) return null;
  if (!payload.user_id) return null;
  const sourceKind = device.source_kind || device.sourceKind;
  if (!sourceKind) return null;
  const { sourceKind: _camel, ...rest } = device;
  return { ...rest, source_kind: sourceKind, user_id: payload.user_id };
}

export const INGEST_GAP_KINDS = new Set([
  'missing_interval', 'connection', 'upload', 'bluetooth_off',
  'not_restored', 'app_killed', 'suspend', 'hr_stream_stalled',
  'off_wrist', 'wrist_off', 'charging',
]);

const EXTRAS_ONLY_DAILY_KEYS = new Set([
  'user_id', 'day', 'extras', 'computed_at', 'updated_at', 'record_class',
]);

export class RestWriteError extends Error {
  constructor(path, status, body) {
    super(`${path} write failed (${status}) ${String(body || '').slice(0, 500)}`);
    this.name = 'RestWriteError';
    this.status = status;
    this.body = body;
  }
}

export function requireDbMethod(db, name) {
  const fn = db?.[name];
  if (typeof fn !== 'function') throw new Error(`${name} required on metrics db`);
  return fn.bind(db);
}

export function bindLiveMetricsReads(db) {
  const out = {};
  for (const name of QUEUED_DB_METHODS) {
    out[name] = (...args) => requireDbMethod(db, name)(...args);
  }
  return out;
}

export function sanitizeIngestGap(row) {
  if (!row || !row.start_at || !row.end_at) return null;
  return { ...row, kind: INGEST_GAP_KINDS.has(row.kind) ? row.kind : 'missing_interval' };
}

export function sanitizeIngestGaps(rows) {
  return (rows || []).map(sanitizeIngestGap).filter(Boolean);
}

export function isExtrasOnlyDailyRow(row) {
  if (!row || typeof row !== 'object') return true;
  return Object.keys(row).every((key) => row[key] === undefined || EXTRAS_ONLY_DAILY_KEYS.has(key));
}

/**
 * Days this payload intends to send through engine_replace_sleep_day.
 * Omitted sleep_details → no days. Explicit sleep_details:[] → originating
 * daily days. Sleep work → days of those sessions/details only. A merged
 * sidecar `sleep_replace_days` wins so a sparse live daily row can never
 * inherit replacement intent from another day's overnight payload.
 */
export function inferSleepReplaceDays(payload) {
  if (!payload || typeof payload !== 'object') return [];
  if (Array.isArray(payload.sleep_replace_days)) {
    return [...new Set(payload.sleep_replace_days.filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(String(d))))];
  }
  if (!Object.prototype.hasOwnProperty.call(payload, 'sleep_details')) return [];
  const daily = payload.daily_metrics || [];
  if (daily.length && daily.every(isExtrasOnlyDailyRow)) return [];
  const tz = daily.find((r) => r?.timezone_name)?.timezone_name
    || payload.device?.timezone_name
    || 'UTC';
  const details = payload.sleep_details || [];
  const hasWork = details.length > 0
    || (payload.sessions || []).some((row) => ['sleep', 'nap'].includes(row?.kind));
  if (hasWork) {
    const days = new Set();
    const sessionDayById = new Map();
    for (const session of payload.sessions || []) {
      if (!['sleep', 'nap'].includes(session?.kind)) continue;
      const day = sleepSessionDay(session, tz);
      if (day) {
        days.add(day);
        if (session.id) sessionDayById.set(session.id, day);
      }
    }
    for (const detail of details) {
      const day = sessionDayById.get(detail?.session_id)
        || (detail?.original_end_at
          ? (physiologicalDay({ wakeIso: detail.original_end_at, timeZone: tz }) || null)
          : null);
      if (day) days.add(day);
    }
    return [...days];
  }
  const day = daily[0]?.day;
  const device = payload.device?.id || daily[0]?.source_device_id;
  if (!day || !device) return [];
  return [...new Set(daily.map((row) => row?.day).filter(Boolean))];
}

/** extras-only daily_metrics must never invoke engine_replace_sleep_day. */
export function shouldReplaceSleepDay(payload) {
  return inferSleepReplaceDays(payload).length > 0;
}

/**
 * PostgREST requires every row in one POST array to carry an identical key set
 * (PGRST102 "All object keys must match"). Outbox-merged payloads legitimately
 * mix shapes: days whose projection has steps next to days without, live gaps
 * with `meta` next to gaps without, sessions from different writers. Group
 * rows by exact key shape and post each homogeneous group. Upsert semantics
 * are per row, so grouping changes nothing about what lands — and a sparse row
 * still updates only its own keys, so absent keys can never null existing
 * values.
 */
export function rowsByShape(rows) {
  const groups = new Map();
  for (const row of rows || []) {
    if (!row || typeof row !== 'object') continue;
    const shape = Object.keys(row).sort().join('\u0001');
    if (!groups.has(shape)) groups.set(shape, []);
    groups.get(shape).push(row);
  }
  return [...groups.values()];
}

/**
 * One uniform-shape ingest_gaps row. Heterogeneous optional keys (id, meta,
 * sample_seq_end) made merged batches fail PostgREST's identical-key
 * requirement; a fixed shape keeps a 300-row batch a single POST. The
 * deterministic id (stable per user/kind/window) makes queue re-sends
 * idempotent instead of inserting duplicates on every retry. resolved_at /
 * resolution are kept ONLY when the incoming row carries them: writing null
 * would reopen a gap the resolve path already closed.
 */
export function normalizeIngestGapRow(row, fallbackUserId = null) {
  if (!row || !row.start_at || !row.end_at) return null;
  const kind = INGEST_GAP_KINDS.has(row.kind) ? row.kind : 'missing_interval';
  const user_id = row.user_id || fallbackUserId || null;
  if (!user_id) {
    inc('ingest_gaps_dropped');
    return null;
  }
  const normalized = {
    id: isUuid(row.id)
      ? row.id
      : uuidFromParts([user_id, 'gap', kind, String(row.start_at), String(row.end_at)]),
    user_id,
    device_id: row.device_id ?? null,
    kind,
    start_at: row.start_at,
    end_at: row.end_at,
    expected_samples: row.expected_samples ?? null,
    received_samples: row.received_samples ?? 0,
    sample_seq_start: row.sample_seq_start ?? null,
    sample_seq_end: row.sample_seq_end ?? null,
    meta: row.meta && typeof row.meta === 'object' && !Array.isArray(row.meta) ? row.meta : {},
  };
  if (row.resolved_at) {
    normalized.resolved_at = row.resolved_at;
    if (row.resolution) normalized.resolution = row.resolution;
  }
  return normalized;
}

const SLEEP_EXTERNAL_ID_DAY = /^sleep:[0-9a-fA-F-]+:(\d{4}-\d{2}-\d{2}):/;

/**
 * object kinds the legacy sensor_objects registry accepts
 * (sensor_objects_kind_check). The canonical archive streams — 'physiology'
 * above all — are NOT among them: those objects live in object_manifests, and
 * a live window that references one keeps its row with the link dropped
 * rather than violating the legacy FK or fabricating a registry row.
 */
export const SENSOR_OBJECT_KINDS = new Set([
  'canonical', 'ppg', 'imu', 'diagnostic', 'export',
  'live_hr', 'hr', 'rr', 'hr_rr', 'ble', 'ecg',
]);

/** Engine day of a persisted sleep/nap session (its external_id carries it). */
export function sleepSessionDay(session, timeZone = 'UTC') {
  const match = SLEEP_EXTERNAL_ID_DAY.exec(String(session?.external_id || ''));
  if (match) return match[1];
  const end = session?.end_at;
  return end ? (physiologicalDay({ wakeIso: end, timeZone }) || null) : null;
}

/**
 * Split a (possibly outbox-merged, multi-day) payload into one
 * engine_replace_sleep_day slice per day that actually requested replacement.
 * Daily_metrics rows do not create slices: a sparse live day merged into an
 * overnight op must not inherit the overnight's sleep_details key.
 */
export function splitSleepReplacement(payload, timeZone = 'UTC') {
  const empty = { slices: [], direct: { sessions: [], sleep_details: [] } };
  const replaceDays = new Set(inferSleepReplaceDays(payload));
  if (!replaceDays.size) return empty;
  const tz = (payload.daily_metrics || []).find((r) => r?.timezone_name)?.timezone_name
    || (payload.device?.timezone_name) || timeZone;
  const byDay = new Map();
  const daySlice = (day) => {
    let slice = byDay.get(day);
    if (!slice) {
      slice = { day, daily_metrics: [], sessions: [], sleep_details: [], explicit_clear: true };
      byDay.set(day, slice);
    }
    return slice;
  };
  for (const day of replaceDays) daySlice(day);
  for (const row of payload.daily_metrics || []) {
    if (row?.day && replaceDays.has(row.day)) daySlice(row.day).daily_metrics.push(row);
  }
  const sessionDayById = new Map();
  for (const session of payload.sessions || []) {
    if (!['sleep', 'nap'].includes(session?.kind)) continue;
    const day = sleepSessionDay(session, tz);
    if (!day) { empty.direct.sessions.push(session); continue; }
    if (session.id) sessionDayById.set(session.id, day);
    if (replaceDays.has(day)) daySlice(day).sessions.push(session);
    else empty.direct.sessions.push(session);
  }
  for (const detail of payload.sleep_details || []) {
    const day = sessionDayById.get(detail?.session_id)
      || (detail?.original_end_at
        ? (physiologicalDay({ wakeIso: detail.original_end_at, timeZone: tz }) || null)
        : null);
    if (!day) { empty.direct.sleep_details.push(detail); continue; }
    if (replaceDays.has(day)) {
      const slice = daySlice(day);
      slice.sleep_details.push(detail);
      slice.explicit_clear = false;
    } else empty.direct.sleep_details.push(detail);
  }
  for (const slice of byDay.values()) {
    slice.explicit_clear = slice.sleep_details.length === 0;
  }
  return { slices: [...byDay.values()], direct: empty.direct };
}

/** Per-slice payload for engine_replace_sleep_day (one physiological day). */
export function sleepDaySlicePayload(payload, slice) {
  return {
    user_id: payload.user_id,
    ...(payload.device ? { device: payload.device } : {}),
    ...(payload.sleep_source ? { sleep_source: payload.sleep_source } : {}),
    daily_metrics: slice.daily_metrics.length
      ? slice.daily_metrics
      : [{ user_id: payload.user_id, day: slice.day }],
    sessions: slice.sessions,
    sleep_details: slice.sleep_details,
  };
}

// engine_replace_sleep_day owns these daily_metrics columns for a replace day.
// A later merge-duplicates POST that still carries overnight headlines would
// undo an explicit empty replacement.
const RPC_OWNED_SLEEP_DAILY_KEYS = [
  'rest', 'sleep_performance_pct',
  'sleep_total_min', 'sleep_in_bed_min', 'sleep_awake_min',
  'sleep_light_min', 'sleep_deep_min', 'sleep_rem_min',
  'sleep_efficiency', 'sleep_need_min', 'sleep_debt_balance_min', 'sleep_consistency',
  'sleep_onset_at', 'wake_onset_at', 'overnight_hr_bpm', 'disturbances',
];

function omitRpcOwnedSleepHeadlines(row) {
  if (!row || typeof row !== 'object') return row;
  const out = { ...row };
  for (const key of RPC_OWNED_SLEEP_DAILY_KEYS) delete out[key];
  return out;
}

/**
 * One uniform-shape live window row with a deterministic id, so queue retries
 * upsert the same window instead of inserting duplicates.
 */
export function normalizeLiveWindowRow(row, fallbackUserId = null) {
  if (!row || !row.start_at || !row.end_at) return null;
  const user_id = row.user_id || fallbackUserId || null;
  if (!user_id) {
    inc('live_windows_dropped');
    return null;
  }
  return {
    id: isUuid(row.id)
      ? row.id
      : uuidFromParts([user_id, 'live-window',
        String(row.raw_object_id || row.start_at), String(row.end_at)]),
    user_id,
    device_id: row.device_id ?? null,
    period_day: row.period_day ?? null,
    start_at: row.start_at,
    end_at: row.end_at,
    sample_count: row.sample_count ?? null,
    raw_object_id: row.raw_object_id ?? null,
    status: row.status || 'ready',
  };
}

/** Map an object_manifests row onto the legacy sensor_objects registry shape. */
export function manifestToSensorObject(manifest) {
  if (!manifest?.id) return null;
  return {
    id: manifest.id,
    user_id: manifest.user_id,
    device_id: manifest.device_id ?? null,
    object_kind: manifest.object_kind || 'physiology',
    object_key: manifest.object_key,
    store: manifest.provider || manifest.store || 'b2',
    start_at: manifest.start_at,
    end_at: manifest.end_at,
    period_day: manifest.period_day ?? null,
    sample_count: manifest.sample_count ?? null,
    compressed_bytes: manifest.compressed_bytes ?? null,
    content_type: manifest.content_type || 'application/octet-stream',
    format: manifest.format || 'ndjson_gzip_v1',
    compression: manifest.compression || 'gzip',
    schema_version: manifest.schema_version ?? 1,
    retention_class: manifest.retention_class || 'core',
    status: manifest.status || 'ready',
  };
}

function restHeaders(cfg, { service = false } = {}) {
  const key = service ? cfg.supabaseServiceRoleKey : cfg.supabaseAnonKey;
  return {
    apikey: key,
    authorization: `Bearer ${service && cfg.supabaseServiceRoleKey ? cfg.supabaseServiceRoleKey : cfg.supabaseAnonKey}`,
    'content-type': 'application/json',
  };
}

export function createMetricsDb({ cfg = storageConfig(), fetchImpl = fetch } = {}) {
  const url = cfg.supabaseUrl;
  const secret = cfg.ingestSecret;
  const canService = Boolean(url && cfg.supabaseServiceRoleKey);
  const canRpc = Boolean(url && secret && (cfg.supabaseServiceRoleKey || cfg.supabaseAnonKey));

  async function rpc(name, body, { service = true } = {}) {
    const res = await fetchImpl(`${url}/rest/v1/rpc/${name}`, {
      method: 'POST',
      headers: restHeaders(cfg, { service }),
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new RestWriteError(name, res.status, text);
    }
    const text = await res.text();
    return text ? JSON.parse(text) : null;
  }

  async function rest(path, { method = 'GET', body, query, prefer } = {}) {
    const headers = restHeaders(cfg, { service: true });
    if (prefer) headers.prefer = prefer;
    const q = query ? `?${query}` : '';
    const res = await fetchImpl(`${url}/rest/v1/${path}${q}`, {
      method,
      headers,
      body: body == null ? undefined : JSON.stringify(body),
    });
    if (method && method !== 'GET' && !res.ok) {
      const text = await res.text().catch(() => '');
      throw new RestWriteError(path, res.status, text);
    }
    return res;
  }

  /**
   * Energy always goes through the RPC, on both the service-role and anon paths.
   * The RPC upserts the minutes and recomputes the daily and workout rollups in
   * one transaction, so a partial write cannot leave a day disagreeing with its
   * own minutes.
   */
  async function ingestEnergy(payload, service) {
    if (!payload?.energy_minutes?.length && !payload?.energy_user_calibration?.length) return null;
    return rpc('engine_ingest_energy', {
      p_secret: secret,
      p_payload: {
        energy_minutes: payload.energy_minutes || [],
        energy_user_calibration: payload.energy_user_calibration || [],
      },
    }, { service });
  }

  return {
    configured: canService || canRpc,

    async upsertPayload(payload) {
      const replacesSleep = shouldReplaceSleepDay(payload);
      // Merged outbox payloads can carry MANY physiological days at once (the
      // queue merges every pending ingest op per user+device). The sleep
      // replacement RPC is one-day by contract, so split before writing.
      const sleepPlan = splitSleepReplacement(payload);
      const replaceDays = new Set(sleepPlan.slices.map((s) => s.day));
      const dailyAfterSleepRpc = (rows) => {
        if (!replaceDays.size) return rows;
        return (rows || []).map((row) => (
          row?.day && replaceDays.has(row.day) ? omitRpcOwnedSleepHeadlines(row) : row
        ));
      };
      logOvernightEvent('sleep.replace.plan', {
        user_id: payload.user_id,
        affected_days: inferSleepReplaceDays(payload).join(',') || 'none',
        detail: sleepPlan.slices.map((s) => `${s.day}:${s.explicit_clear ? 'clear' : s.sleep_details.length}`).join(',') || 'none',
      });
      const recordCount = Object.entries(payload || {})
        .reduce((n, [key, value]) => (Array.isArray(value) ? n + value.length : n), 0);
      if (recordCount > 0) inc('supabase_records_written', recordCount);
      async function replaceSleepSlices(service) {
        for (const slice of sleepPlan.slices) {
          logOvernightEvent('sleep.replace.rpc', {
            user_id: payload.user_id,
            day: slice.day,
            sleep_detected: slice.sleep_details.length > 0,
            detail: slice.explicit_clear ? 'explicit_clear' : `rows:${slice.sleep_details.length}`,
          });
          await rpc('engine_replace_sleep_day', {
            p_secret: secret,
            p_payload: sleepDaySlicePayload(payload, slice),
          }, service ? { service: true } : undefined);
        }
      }
      if (!canService) {
        const err = new Error('service_role_required_for_engine_ingest');
        err.code = 'service_role_required';
        throw err;
      }
      const prefer = 'resolution=merge-duplicates,return=minimal';
      // PostgREST rejects a POST whose rows carry different key sets
      // (PGRST102), and rejects a batch whose rows repeat one conflict key
      // (21000 ON CONFLICT DO UPDATE cannot affect row a second time). The
      // merged outbox payload can legitimately carry the same row twice (an
      // op merged across recomputes), so dedupe by conflict key (newest wins)
      // before grouping by shape.
      const postRows = async (path, rows, keyOf = (row) => row?.id) => {
        const byKey = new Map();
        for (const row of rows || []) {
          if (!row || typeof row !== 'object') continue;
          const key = keyOf(row) ?? JSON.stringify(row);
          byKey.set(key, row);
        }
        for (const group of rowsByShape([...byKey.values()])) {
          await rest(path, { method: 'POST', body: group, prefer });
        }
      };
      const deviceRow = deviceUpsertRow(payload);
      if (deviceRow) {
        let profileKnown = false;
        try {
          const res = await rest('profiles', { query: `id=eq.${deviceRow.user_id}&select=id` });
          if (res.ok) {
            const rows = await res.json();
            profileKnown = Array.isArray(rows) && rows.length > 0;
          }
        } catch { /* quarantine below */ }
        if (!profileKnown) {
          inc('ingest_orphan_user_quarantined');
          logOvernightEvent('ingest.orphan_user', {
            user_id: deviceRow.user_id,
            detail: 'device_row_skipped',
          });
        } else {
          await rest('devices', { method: 'POST', body: deviceRow, prefer });
        }
      }
      await replaceSleepSlices(true);
      const rpcOwnedSessionIds = new Set(sleepPlan.slices.flatMap((slice) => slice.sessions.map((s) => s.id)));
      if (payload.daily_metrics?.length) {
        const dailyRows = [];
        for (const incoming of payload.daily_metrics) {
          if (!incoming?.extras || !incoming.user_id || !incoming.day) {
            dailyRows.push(incoming);
            continue;
          }
          const existingRes = await rest('daily_metrics', {
            query: `user_id=eq.${incoming.user_id}&day=eq.${incoming.day}&record_class=eq.${incoming.record_class || 'user'}&select=extras`,
          });
          const existing = existingRes.ok ? (await existingRes.json())[0] : null;
          dailyRows.push(existing?.extras
            ? { ...incoming, extras: { ...existing.extras, ...incoming.extras } }
            : incoming);
        }
        await postRows('daily_metrics', dailyAfterSleepRpc(dailyRows), (row) => `${row?.user_id}|${row?.day}`);
      }
      if (payload.sessions?.length) {
        // Sleep/nap sessions consumed by a per-day replacement RPC are owned by
        // that RPC; everything else (workouts, direct sleeps, unattributed
        // rows) still goes through the plain table upsert.
        const sessions = payload.sessions.filter((row) => !rpcOwnedSessionIds.has(row?.id));
        const ids = sessions.map((row) => row.id).filter(Boolean);
        let existing = [];
        if (ids.length) {
          const current = await rest('sessions', {
            query: `id=in.(${ids.join(',')})&select=id,user_modified,start_at,end_at`,
          });
          if (current.ok) existing = await current.json();
        }
        const byId = new Map(existing.map((row) => [row.id, row]));
        const rows = sessions.map((row) => {
          const current = byId.get(row.id);
          return current?.user_modified
            ? { ...row, start_at: current.start_at, end_at: current.end_at, user_modified: true }
            : row;
        });
        if (rows.length) await postRows('sessions', rows, (row) => row?.id ?? JSON.stringify(row));
      }
      const directSleepDetails = replacesSleep
        ? sleepPlan.direct.sleep_details
        : (payload.sleep_details || []);
      if (directSleepDetails.length) {
        const ids = directSleepDetails.map((row) => row.session_id).filter(Boolean);
        let existing = [];
        if (ids.length) {
          const current = await rest('sleep_details', {
            query: `session_id=in.(${ids.join(',')})&select=session_id,user_start_at,user_end_at`,
          });
          if (current.ok) existing = await current.json();
        }
        const byId = new Map(existing.map((row) => [row.session_id, row]));
        const rows = directSleepDetails.map((row) => {
          const current = byId.get(row.session_id);
          return current
            ? {
              ...row,
              user_start_at: current.user_start_at,
              user_end_at: current.user_end_at,
            }
            : row;
        });
        await postRows('sleep_details', rows, (row) => row?.session_id ?? JSON.stringify(row));
      }
      if (payload.object_manifests?.length) {
        // Individual upserts used to be the only way around PostgREST's
        // identical-object-key requirement; shape grouping keeps the guarantee
        // while letting uniform batches (the common archive case) post once.
        const rows = payload.object_manifests.map((manifest) => {
          const { store: _legacyStore, ...row } = manifest;
          return row;
        });
        await postRows('object_manifests', rows, (row) => row?.id ?? row?.object_key ?? JSON.stringify(row));
      }
      if (payload.daily_physiology_series?.length) {
        for (const incoming of payload.daily_physiology_series) {
          const existingRes = await rest('daily_physiology_series', {
            query: `user_id=eq.${incoming.user_id}&day=eq.${incoming.day}&select=*`,
          });
          const existing = existingRes.ok ? (await existingRes.json())[0] : null;
          let row = incoming;
          if (existing) {
            const hrSeries = mergeHrSeries(existing.hr_series, incoming.hr_series);
            const strainSeries = mergeStrainSeries(existing.strain_series, incoming.strain_series);
            const skinTempSeries = mergeSkinTempSeries(existing.skin_temp_series, incoming.skin_temp_series);
            // Count from the merged curve. A max reported only the largest single
            // batch, so a day assembled from many partial batches (live ticks plus
            // per-object history archives) under-reported by multiples; a sum would
            // double count on re-upsert. Deriving is exact and still idempotent.
            const counted = hrSeries.reduce((n, p) => n + (Number(p?.n ?? p?.sample_count) || 0), 0);
            row = {
              ...incoming,
              hr_series: hrSeries,
              strain_series: strainSeries,
              skin_temp_series: skinTempSeries,
              sample_count: counted || Math.max(existing.sample_count || 0, incoming.sample_count || 0),
              version: (existing.version || 1) + 1,
            };
          }
          await rest('daily_physiology_series', { method: 'POST', body: row, prefer });
        }
      }
      if (payload.ingest_gaps?.length) {
        const gaps = (payload.ingest_gaps || [])
          .map((row) => normalizeIngestGapRow(row, payload.user_id))
          .filter(Boolean);
        if (gaps.length) await postRows('ingest_gaps', gaps, (row) => row?.id);
      }
      if (payload.measurements?.length) {
        await postRows('measurements', payload.measurements, (row) => row?.id ?? JSON.stringify(row));
      }
      if (payload.events?.length) {
        await postRows('events', payload.events, (row) => row?.id ?? JSON.stringify(row));
      }
      if (payload.live_windows?.length) {
        const windows = (payload.live_windows || [])
          .map((row) => normalizeLiveWindowRow(row, payload.user_id))
          .filter(Boolean);
        // live_windows.raw_object_id has an FK into the legacy sensor_objects
        // registry, but the archive path records manifests in object_manifests.
        // Mirror the referenced manifests so the telemetry link cannot 409
        // the whole op; a reference with no manifest anywhere keeps its window
        // row with the broken link dropped.
        const referenced = [...new Set(windows.map((w) => w.raw_object_id).filter(Boolean))];
        if (referenced.length) {
          const presentRes = await rest('sensor_objects', {
            query: `id=in.(${referenced.join(',')})&select=id`,
          });
          const present = new Set(presentRes.ok ? (await presentRes.json()).map((r) => r.id) : []);
          const missing = referenced.filter((id) => !present.has(id));
          if (missing.length) {
            const manifestsRes = await rest('object_manifests', {
              query: `id=in.(${missing.join(',')})&select=*`,
            });
            const manifests = manifestsRes.ok ? await manifestsRes.json() : [];
            // Mirror only kinds the legacy registry accepts (its kind check
            // rejects the canonical 'physiology' stream); a window referencing
            // anything else keeps its row with the link dropped.
            const mirrored = manifests
              .map(manifestToSensorObject)
              .filter((row) => row && SENSOR_OBJECT_KINDS.has(row.object_kind));
            const mirroredIds = new Set(mirrored.map((row) => row.id));
            if (mirrored.length) await postRows('sensor_objects', mirrored, (row) => row?.id ?? row?.object_key);
            for (const window of windows) {
              if (window.raw_object_id && missing.includes(window.raw_object_id)
                && !mirroredIds.has(window.raw_object_id)) {
                window.raw_object_id = null;
                inc('live_windows_link_dropped');
              }
            }
          }
        }
        if (windows.length) await postRows('live_windows', windows, (row) => row?.id);
      }
      if (payload.metric_runs?.length) {
        await postRows('metric_runs', payload.metric_runs, (row) => row?.id ?? JSON.stringify(row));
      }
      await ingestEnergy(payload, true);
      return { ok: true };
    },

    async loadUserDays(userId, fromDay, toDay) {
      if (canService) {
        const q = [`user_id=eq.${userId}`, 'record_class=eq.user', 'select=*'];
        if (fromDay) q.push(`day=gte.${fromDay}`);
        if (toDay) q.push(`day=lte.${toDay}`);
        const sessionQ = [`user_id=eq.${userId}`, 'select=*'];
        const seriesQ = [`user_id=eq.${userId}`, 'order=day.desc', 'select=day,hr_series,strain_series,skin_temp_series,timezone_name'];
        const sleepQ = [`user_id=eq.${userId}`, 'select=*'];
        if (fromDay) {
          const start = dayBounds(fromDay, 'UTC').day_start_at;
          const fromIso = new Date(Date.parse(start) - 12 * 3600000).toISOString();
          sessionQ.push(`start_at=gte.${encodeURIComponent(fromIso)}`);
          seriesQ.push(`day=gte.${fromDay}`);
          sleepQ.push(`original_end_at=gte.${encodeURIComponent(fromIso)}`);
        }
        if (toDay) {
          // Bound the sleep read by WAKE instant with slack, not by session
          // start against the UTC day end: a night attributed to `toDay` can
          // START after UTC midnight of the next day (e.g. a 05:25 UTC onset
          // for an America/Los_Angeles wake day), which the old
          // `original_start_at <= UTC day_end` predicate excluded — the
          // finalizer's readback then reported a persisted projection as
          // missing (production 2026-08-30, day 2026-08-23). Callers
          // re-attribute by wake day in JS, so the slack is safe.
          const end = dayBounds(toDay, 'UTC').day_end_at;
          sleepQ.push(`original_end_at=lt.${encodeURIComponent(new Date(Date.parse(end) + 24 * 3600000).toISOString())}`);
        }
        const [daily, sessions, details, series] = await Promise.all([
          rest('daily_metrics', { query: q.join('&') }),
          rest('sessions', { query: sessionQ.join('&') }),
          rest('sleep_details', { query: sleepQ.join('&') }),
          rest('daily_physiology_series', { query: seriesQ.join('&') }),
        ]);
        return {
          daily_metrics: daily.ok ? await daily.json() : [],
          sessions: sessions.ok ? await sessions.json() : [],
          sleep_details: details.ok ? await details.json() : [],
          daily_physiology_series: series.ok ? await series.json() : [],
        };
      }
      if (canRpc) {
        return rpc('engine_load_user_days', {
          p_secret: secret,
          p_user_id: userId,
          p_from: fromDay || null,
          p_to: toDay || null,
        }) || { daily_metrics: [], sleep_details: [], sessions: [], daily_physiology_series: [] };
      }
      return { daily_metrics: [], sleep_details: [], sessions: [], daily_physiology_series: [] };
    },

    async listPhysiologyManifests({
      userId,
      days = [],
      fromDay,
      toDay,
      timeZone = 'UTC',
    } = {}) {
      return this.listObjectManifests({
        userId, days, fromDay, toDay, timeZone, objectKind: 'physiology',
      });
    },

    async listObjectManifests({
      userId,
      days = [],
      fromDay,
      toDay,
      timeZone = 'UTC',
      objectKind = 'physiology',
    } = {}) {
      if (!canService) {
        const err = new Error('service_role_required_for_manifest_list');
        err.code = 'service_role_required';
        throw err;
      }
      const selected = [...new Set(days || [])].sort();
      const first = fromDay || selected[0];
      const last = toDay || selected.at(-1) || first;
      const kind = String(objectKind || 'physiology').replace(/[^a-z0-9_]/gi, '') || 'physiology';
      const clauses = [
        `user_id=eq.${userId}`,
        `object_kind=eq.${kind}`,
        'status=in.(ready,verified)',
        'select=*',
        'order=start_at.asc',
      ];
      if (first) {
        const start = dayBounds(first, timeZone).day_start_at;
        clauses.push(`end_at=gte.${encodeURIComponent(new Date(Date.parse(start) - 12 * 60 * 60_000).toISOString())}`);
      }
      if (last) {
        const end = dayBounds(last, timeZone).day_end_at;
        clauses.push(`start_at=lt.${encodeURIComponent(end)}`);
      }
      const response = await rest('object_manifests', { query: clauses.join('&') });
      if (!response.ok) {
        const err = new Error(`manifest_access_unavailable (${response.status})`);
        err.code = 'manifest_access_unavailable';
        throw err;
      }
      return response.json();
    },

    async markManifestCorrupt(objectKey) {
      if (!canService || !objectKey) return null;
      const res = await rest('object_manifests', {
        method: 'PATCH',
        body: { status: 'failed' },
        query: `object_key=eq.${encodeURIComponent(objectKey)}`,
      });
      return res.ok;
    },

    /**
     * Canonical DayCompleteness gate persistence (table day_completeness).
     * The gate is the ONLY writer of finalized status; these are thin CRUD.
     */
    async getDayCompleteness(userId, day) {
      if (!userId || !day) return null;
      if (!canService) {
        const err = new Error('service_role_required_for_day_completeness');
        err.code = 'service_role_required';
        throw err;
      }
      const res = await rest('day_completeness', {
        query: `user_id=eq.${userId}&day=eq.${day}&select=*`,
      });
      return res.ok ? (await res.json())?.[0] || null : null;
    },

    async upsertDayCompleteness(userId, row = {}) {
      if (!userId || !row.day) return null;
      if (!canService) {
        const err = new Error('service_role_required_for_day_completeness');
        err.code = 'service_role_required';
        throw err;
      }
      const body = {
        user_id: userId,
        day: row.day,
        timezone_name: row.timezone_name || 'UTC',
      };
      if (row.status != null) body.status = row.status;
      if (row.result != null) body.result = row.result;
      if ('finalized_at' in row) body.finalized_at = row.finalized_at;
      if (row.overnight_state != null) body.overnight_state = row.overnight_state;
      if ('overnight_reason' in row) body.overnight_reason = row.overnight_reason;
      if ('input_fingerprint' in row) body.input_fingerprint = row.input_fingerprint;
      if ('last_trigger' in row) body.last_trigger = row.last_trigger;
      if ('last_attempt_at' in row) body.last_attempt_at = row.last_attempt_at;
      if ('overnight_finalized_at' in row) body.overnight_finalized_at = row.overnight_finalized_at;
      const res = await rest('day_completeness', {
        method: 'POST',
        body,
        prefer: 'resolution=merge-duplicates,return=representation',
      });
      return res.ok ? (await res.json())?.[0] || null : null;
    },

    /** Late backfill invalidation: a day being recomputed is open until proven. */
    async invalidateDayCompleteness(userId, days = []) {
      if (!userId || !days.length) return 0;
      if (!canService) {
        const err = new Error('service_role_required_for_invalidate_day');
        err.code = 'service_role_required';
        throw err;
      }
      const res = await rest('day_completeness', {
        method: 'PATCH',
        body: { status: 'open', finalized_at: null },
        query: `user_id=eq.${userId}&day=in.(${days.join(',')})`,
      });
      return res.ok ? days.length : 0;
    },

    async listIngestGaps(userId, loIso, hiIso) {
      if (!userId) return [];
      if (!canService) {
        const err = new Error('service_role_required_for_ingest_gaps');
        err.code = 'service_role_required';
        throw err;
      }
      const res = await rest('ingest_gaps', {
        query: [
          `user_id=eq.${userId}`,
          `start_at=lt.${encodeURIComponent(hiIso)}`,
          `end_at=gt.${encodeURIComponent(loIso)}`,
          'select=*',
        ].join('&'),
      });
      if (!res.ok) {
        const err = new Error(`ingest_gaps_unavailable (${res.status})`);
        err.code = 'ingest_gaps_unavailable';
        throw err;
      }
      return res.json();
    },

    /** Close gap rows. Payload may include resolved_at; skip only missing id.
     *  DB filter resolved_at=is.null / RPC keeps the transition monotonic. */
    async resolveIngestGaps(userId, rows = []) {
      if (!userId) return 0;
      const payload = [];
      for (const row of rows) {
        if (!row?.id) continue;
        payload.push({
          id: row.id,
          resolved_at: row.resolved_at || new Date().toISOString(),
          resolution: row.resolution || 'backfilled',
          meta: row.meta && typeof row.meta === 'object' ? row.meta : undefined,
        });
      }
      if (!payload.length) return 0;
      if (canRpc) {
        const n = await rpc('engine_resolve_ingest_gaps', {
          p_secret: secret,
          p_user_id: userId,
          p_rows: payload,
        }, { service: canService });
        return Number(n) || 0;
      }
      if (!canService) {
        const err = new Error('service_role_required_for_resolve_ingest_gaps');
        err.code = 'service_role_required';
        throw err;
      }
      let resolved = 0;
      for (const row of payload) {
        const body = {
          resolved_at: row.resolved_at,
          resolution: row.resolution,
        };
        if (row.meta) body.meta = row.meta;
        const res = await rest('ingest_gaps', {
          method: 'PATCH',
          body,
          query: `id=eq.${row.id}&user_id=eq.${userId}&resolved_at=is.null`,
        });
        if (res.ok) resolved += 1;
      }
      return resolved;
    },

    async probeContinuitySchema() {
      const { probeContinuitySchema } = await import('./schemaReadiness.js');
      return probeContinuitySchema({ rest });
    },

    async patchDailyExtras(userId, day, patch) {
      if (!userId || !day || !patch || typeof patch !== 'object') return null;
      if (!canRpc && !canService) throw new Error('engine_patch_daily_extras required');
      return rpc('engine_patch_daily_extras', {
        p_secret: secret || '',
        p_user_id: userId,
        p_day: day,
        p_patch: patch,
      }, { service: canService });
    },

    async readDaySnapshot(userId, day) {
      if (!userId || !day) return null;
      if (!canService || !secret) throw new Error('engine_read_day_snapshot requires service_role');
      return rpc('engine_read_day_snapshot', {
        p_secret: secret,
        p_user_id: userId,
        p_day: day,
      }, { service: true });
    },

    async latestOvernightRun(userId, day) {
      if (!canService || !userId || !day) return null;
      const res = await rest('metric_runs', {
        query: [
          `user_id=eq.${userId}`,
          `period_day=eq.${day}`,
          'algorithm=eq.overnight_finalize',
          'status=in.(complete,partial)',
          'order=finished_at.desc.nullslast',
          'limit=1',
          'select=id,status,quality,input_refs,output_refs,finished_at,started_at',
        ].join('&'),
      });
      return res.ok ? (await res.json())?.[0] || null : null;
    },

    async deleteAutoSleepSessions({
      userId,
      day,
      timeZone = 'UTC',
      keepIds = [],
    } = {}) {
      if (!canService || !day) return { deleted: 0, supported: false };
      const bounds = dayBounds(day, timeZone);
      const response = await rest('sessions', {
        query: [
          `user_id=eq.${userId}`,
          'source=eq.frwhoop',
          'kind=in.(sleep,nap)',
          'user_modified=eq.false',
          `start_at=lt.${encodeURIComponent(bounds.day_end_at)}`,
          `end_at=gt.${encodeURIComponent(new Date(Date.parse(bounds.day_start_at) - 12 * 60 * 60_000).toISOString())}`,
          'select=id,external_id',
        ].join('&'),
      });
      if (!response.ok) return { deleted: 0, supported: true };
      const rows = await response.json();
      const keep = new Set(keepIds);
      let deleted = 0;
      for (const row of rows) {
        if (keep.has(row.id)) continue;
        // Ownership: a sleep/nap projection belongs to the ENGINE day encoded
        // in its external_id, which is not always the local date of its end
        // instant (a night can end at/after local midnight, an afternoon
        // episode before it). The 12h window overlaps neighboring days, so
        // deleting every overlap raced the neighbor's own recompute and
        // destroyed its projection (production 2026-08-30: a day's session
        // landed, the next day's finalize deleted it, forever). Only rows this
        // day's projection owns are stale candidates; rows without a parseable
        // external_id keep the legacy window semantics.
        const owned = SLEEP_EXTERNAL_ID_DAY.exec(String(row.external_id || ''));
        if (owned && owned[1] !== day) continue;
        const result = await rest('sessions', { method: 'DELETE', query: `id=eq.${row.id}` });
        if (result.ok) deleted += 1;
      }
      return { deleted, supported: true };
    },
  };
}
