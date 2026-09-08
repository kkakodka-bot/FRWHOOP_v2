import { createHash } from 'node:crypto';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Deterministic UUID from opaque parts (device MAC hashes, local-demo, etc.). */
export function uuidFromParts(parts) {
  const hex = createHash('sha256').update((parts || []).join('|')).digest('hex').slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/** Existing WHOOP device mint: uuidFromParts([userId, 'whoop', externalId || 'strap']). */
export function whoopDeviceId(userId, externalId = 'strap') {
  return uuidFromParts([userId, 'whoop', String(externalId || 'strap')]);
}

/**
 * Cloud device uuid for a NOOP push `deviceId`, which is a strap-local opaque id rather than a uuid.
 * Both push lanes must mint identically or the same strap lands under two device ids and its object
 * keys stop lining up with its row projections.
 */
export function noopDeviceId(userId, deviceId) {
  if (isUuid(deviceId)) return deviceId;
  return uuidFromParts([userId, 'noop', String(deviceId || 'strap')]);
}

const GENERIC_EXTERNAL_IDS = new Set(['strap', 'whoop', 'unknown']);

export function isGenericWhoopExternalId(value) {
  if (value == null) return false;
  return GENERIC_EXTERNAL_IDS.has(String(value).trim().toLowerCase());
}

export function inferWhoopExternalId(userId, deviceId) {
  if (!userId || !deviceId) return null;
  if (deviceId === whoopDeviceId(userId, 'strap')) return 'strap';
  return null;
}

export function isVerifiedHardwareSerial(serial) {
  if (typeof serial !== 'string') return false;
  const s = serial.trim();
  if (s.length < 6) return false;
  if (isGenericWhoopExternalId(s)) return false;
  if (s.includes('*') || /redacted/i.test(s)) return false;
  return true;
}

function hardwareToken(value) {
  const s = String(value).trim();
  return isUuid(s) ? s.toLowerCase() : s;
}

/**
 * Strict physical-device identity. Generic fallbacks ('strap', 'whoop',
 * 'unknown') are provenance, not hardware proof.
 */
export function resolvePhysicalWhoopIdentity({
  externalId,
  serial,
  hardwareId,
} = {}) {
  if (isVerifiedHardwareSerial(serial) && !isUuid(serial.trim())) {
    return {
      physical_device_id: uuidFromParts(['whoop-physical', hardwareToken(serial)]),
      physical_identity_confidence: 'confirmed',
      physical_identity_evidence: 'dis_serial',
    };
  }
  if (hardwareId != null && isVerifiedHardwareSerial(String(hardwareId)) && !isUuid(String(hardwareId).trim())) {
    return {
      physical_device_id: uuidFromParts(['whoop-physical', hardwareToken(hardwareId)]),
      physical_identity_confidence: 'confirmed',
      physical_identity_evidence: 'registry_hardware_id',
    };
  }
  const ext = externalId && !isGenericWhoopExternalId(externalId) ? String(externalId).trim() : null;
  const platform = [serial, hardwareId, ext].find((v) => v && isUuid(String(v).trim()));
  if (platform) {
    return {
      physical_device_id: uuidFromParts(['whoop-physical', hardwareToken(platform)]),
      physical_identity_confidence: 'confirmed',
      physical_identity_evidence: 'platform_device_id',
    };
  }
  return {
    physical_device_id: null,
    physical_identity_confidence: 'unknown',
    physical_identity_evidence: null,
  };
}

export function physicalWhoopDeviceId(args) {
  return resolvePhysicalWhoopIdentity(args).physical_device_id;
}

export function isUuid(value) {
  return typeof value === 'string' && UUID_RE.test(value);
}

const RAW_EXT = {
  canonical: 'pb.zst',
  ppg: 'pb.zst',
  imu: 'pb.zst',
  diagnostic: 'bin.zst',
  live_hr: 'ndjson.gz',
  export: 'json.gz',
};

const STREAM_EXT = {
  frames: 'ndjson.gz',
  frames_reassembled: 'ndjson.gz',
  physiology: 'ndjson.gz',
  hr: 'ndjson.gz',
  rr: 'ndjson.gz',
  hr_rr: 'ndjson.gz',
  hrSample: 'ndjson.gz',
  rrInterval: 'ndjson.gz',
  event: 'ndjson.gz',
  battery: 'ndjson.gz',
  spo2Sample: 'ndjson.gz',
  skinTempSample: 'ndjson.gz',
  respSample: 'ndjson.gz',
  gravitySample: 'ndjson.gz',
  stepSample: 'ndjson.gz',
  sleepStateSample: 'ndjson.gz',
  ppgHrSample: 'ndjson.gz',
  appleStepHour: 'ndjson.gz',
  ouraRaw: 'ndjson.gz',
  coachMessage: 'ndjson.gz',
  dailyMetric: 'ndjson.gz',
  sleepSession: 'ndjson.gz',
  workout: 'ndjson.gz',
  journal: 'ndjson.gz',
  metricSeries: 'ndjson.gz',
  appleDaily: 'ndjson.gz',
  scoreInputProvenance: 'ndjson.gz',
  labMarker: 'ndjson.gz',
  liveSession: 'ndjson.gz',
  ppgWaveformSample: 'bin.gz',
  v18AuxSample: 'bin.gz',
  rawBatch: 'pb.zst',
  rawImuSession: 'bin.zst',
  ppg: 'bin.gz',
  imu: 'bin.gz',
  ble: 'bin.gz',
  diagnostic: 'bin.gz',
  ecg: 'bin.gz',
  derived: 'json.gz',
  export: 'json.gz',
  imu_raw: 'ndjson.gz',
  ppg_raw: 'ndjson.gz',
  whoop5_imu_v21: 'ndjson.gz',
  whoop5_ppg_v26: 'ndjson.gz',
  whoop5_optical_v20: 'ndjson.gz',
  events: 'ndjson.gz',
  console_logs: 'ndjson.gz',
  cmd_battery: 'ndjson.gz',
};

export const RETENTION_CLASS = {
  frames: 'core',
  frames_reassembled: 'core',
  physiology: 'core',
  hr: 'core',
  rr: 'core',
  hr_rr: 'core',
  live_hr: 'core',
  derived: 'core',
  ppg: 'ppg',
  imu: 'imu',
  imu_raw: 'core',
  ppg_raw: 'core',
  whoop5_imu_v21: 'core',
  whoop5_ppg_v26: 'core',
  whoop5_optical_v20: 'core',
  hrSample: 'core',
  rrInterval: 'core',
  event: 'core',
  battery: 'core',
  spo2Sample: 'core',
  skinTempSample: 'core',
  respSample: 'core',
  gravitySample: 'core',
  stepSample: 'core',
  sleepStateSample: 'core',
  ppgHrSample: 'core',
  appleStepHour: 'core',
  ouraRaw: 'core',
  coachMessage: 'core',
  dailyMetric: 'core',
  sleepSession: 'core',
  workout: 'core',
  journal: 'core',
  metricSeries: 'core',
  appleDaily: 'core',
  scoreInputProvenance: 'core',
  labMarker: 'core',
  liveSession: 'core',
  // Object-lane raw signal. `research` never expires and carries no B2 lifecycle rule, so the
  // longitudinal corpus is not deleted underneath the manifests. `v18AuxSample` stays `diag`: it is
  // an unpinned diagnostic field dump, not signal anyone will train on.
  ppgWaveformSample: 'research',
  rawImuSession: 'research',
  rawBatch: 'research',
  v18AuxSample: 'diag',
  ble: 'diag',
  diagnostic: 'diag',
  export: 'export',
};

/**
 * Streams the device uploads straight to the bucket with a presigned PUT instead of posting inline
 * through `/api/push`. Bytes never transit this server; it brokers the URL and owns the manifest.
 */
export const OBJECT_LANE_STREAMS = Object.freeze(new Set([
  'ppgWaveformSample',
  'rawImuSession',
  'rawBatch',
  'v18AuxSample',
]));

/** Nominal records per second for an object-lane stream, or null when the stream has no fixed rate. */
export const OBJECT_LANE_RECORD_HZ = Object.freeze({
  ppgWaveformSample: 1,
  rawImuSession: 1,
  v18AuxSample: 1,
  rawBatch: null,
});

function sanitizeStream(stream) {
  return String(stream || 'physiology').replace(/[^a-z0-9_]/gi, '') || 'physiology';
}

/** Retention class for a stream — must match rawObjectKeyV3's v3/{class}/ prefix. */
export function retentionClassForStream(stream) {
  return RETENTION_CLASS[sanitizeStream(stream)] || 'core';
}

/** Parse the retention-class segment from a v3 object key. */
export function retentionClassFromObjectKey(objectKey) {
  const m = /^v3\/([^/]+)\//.exec(String(objectKey || ''));
  return m ? m[1] : null;
}

const PUSH_ARCHIVE_BY_EXT = {
  'ndjson.gz': {
    format: 'ndjson_gzip_noop_push_v1',
    contentType: 'application/x-ndjson',
    compression: 'gzip',
  },
  'bin.gz': {
    format: 'bin_gzip_noop_push_v1',
    contentType: 'application/octet-stream',
    compression: 'gzip',
  },
  'bin.zst': {
    format: 'bin_zstd_noop_push_v1',
    contentType: 'application/octet-stream',
    compression: 'zstd',
  },
  'pb.zst': {
    format: 'protobuf_zstd_noop_push_v1',
    contentType: 'application/octet-stream',
    compression: 'zstd',
  },
};

/** Canonical NOOP push archive metadata for object_manifests (format/type/compression/class). */
export function pushArchiveSpecForStream(stream) {
  const safe = sanitizeStream(stream);
  const ext = STREAM_EXT[safe] || 'ndjson.gz';
  const wire = PUSH_ARCHIVE_BY_EXT[ext] || PUSH_ARCHIVE_BY_EXT['ndjson.gz'];
  return {
    retentionClass: retentionClassForStream(safe),
    format: wire.format,
    contentType: wire.contentType,
    compression: wire.compression,
  };
}

function assertIds({ userId, deviceId, objectId, allowMissingDevice = false }) {
  if (!isUuid(userId)) throw new Error('user id must be a uuid');
  if (looksLikePii(userId) || looksLikePii(deviceId) || looksLikePii(objectId)) {
    throw new Error('pii in object identity');
  }
  if (!allowMissingDevice && !isUuid(deviceId)) throw new Error('device id must be a uuid');
  if (!isUuid(objectId)) throw new Error('object id must be a uuid');
}

/** Legacy v1 key. Prefer rawObjectKey for new archives. */
export function objectKey({ userId, deviceId, kind, day, objectId, exportId }) {
  if (!isUuid(userId)) throw new Error('user id must be a uuid');
  if (looksLikePii(userId) || looksLikePii(deviceId)) throw new Error('pii in object identity');
  const [yyyy, mm, dd] = String(day).split('-');
  if (!yyyy || !mm || !dd) throw new Error('period_day must be YYYY-MM-DD');
  if (kind === 'export') {
    if (!isUuid(exportId || objectId)) throw new Error('export id must be a uuid');
    return `v1/users/${userId}/exports/${yyyy}/${mm}/${dd}/${exportId || objectId}.json.gz`;
  }
  if (!isUuid(deviceId)) throw new Error('device id must be a uuid');
  if (!isUuid(objectId)) throw new Error('object id must be a uuid');
  const ext = RAW_EXT[kind] || 'bin';
  return `v1/users/${userId}/devices/${deviceId}/${kind}/${yyyy}/${mm}/${dd}/${objectId}.${ext}`;
}

/**
 * v2 temporal key. Hour is UTC.
 * v2/users/{user_id}/devices/{device_id}/raw/{stream}/YYYY/MM/DD/HH/{object_id}.ndjson.gz
 */
export function rawObjectKey({ userId, deviceId, stream = 'hr', startAt, objectId }) {
  assertIds({ userId, deviceId, objectId });
  const d = startAt instanceof Date ? startAt : new Date(startAt);
  if (Number.isNaN(d.getTime())) throw new Error('startAt must be a UTC instant');
  const p = (n) => String(n).padStart(2, '0');
  const yyyy = d.getUTCFullYear();
  const mm = p(d.getUTCMonth() + 1);
  const dd = p(d.getUTCDate());
  const hh = p(d.getUTCHours());
  const safe = String(stream || 'hr').replace(/[^a-z0-9_]/gi, '') || 'hr';
  const ext = STREAM_EXT[safe] || 'ndjson.gz';
  return `v2/users/${userId}/devices/${deviceId}/raw/${safe}/${yyyy}/${mm}/${dd}/${hh}/${objectId}.${ext}`;
}

/**
 * v3 key: retention class is the first path segment so B2 lifecycle prefixes work.
 * v3/{core|ppg|imu|diag|export}/users/{user}/devices/{device}/{stream}/YYYY/MM/DD/HH/{id}.ext
 */
export function rawObjectKeyV3({ userId, deviceId, stream = 'physiology', startAt, objectId }) {
  assertIds({ userId, deviceId, objectId });
  const d = startAt instanceof Date ? startAt : new Date(startAt);
  if (Number.isNaN(d.getTime())) throw new Error('startAt must be a UTC instant');
  const p = (n) => String(n).padStart(2, '0');
  const yyyy = d.getUTCFullYear();
  const mm = p(d.getUTCMonth() + 1);
  const dd = p(d.getUTCDate());
  const hh = p(d.getUTCHours());
  const safe = sanitizeStream(stream);
  const cls = retentionClassForStream(safe);
  const ext = STREAM_EXT[safe] || 'ndjson.gz';
  return `v3/${cls}/users/${userId}/devices/${deviceId}/${safe}/${yyyy}/${mm}/${dd}/${hh}/${objectId}.${ext}`;
}

/**
 * Inverse of `rawObjectKeyV3`. Returns null for anything that is not a well-formed v3 key rather
 * than guessing, so a reconciliation sweep cannot silently attribute an object to the wrong subject.
 * `rawObjectKeyV3(parseRawObjectKeyV3(k))` reproduces `k` for every key the builder can emit.
 */
export function parseRawObjectKeyV3(objectKey) {
  const parts = String(objectKey || '').split('/');
  if (parts.length !== 12) return null;
  const [v3, cls, users, userId, devices, deviceId, stream, yyyy, mm, dd, hh, leaf] = parts;
  if (v3 !== 'v3' || users !== 'users' || devices !== 'devices') return null;
  if (!isUuid(userId) || !isUuid(deviceId)) return null;
  if (sanitizeStream(stream) !== stream) return null;
  if (retentionClassForStream(stream) !== cls) return null;
  const dot = leaf.indexOf('.');
  if (dot <= 0) return null;
  const objectId = leaf.slice(0, dot);
  const ext = leaf.slice(dot + 1);
  if (!isUuid(objectId) || (STREAM_EXT[stream] || 'ndjson.gz') !== ext) return null;
  if (!/^\d{4}$/.test(yyyy) || !/^\d{2}$/.test(mm) || !/^\d{2}$/.test(dd) || !/^\d{2}$/.test(hh)) return null;
  const startAt = new Date(`${yyyy}-${mm}-${dd}T${hh}:00:00.000Z`);
  if (Number.isNaN(startAt.getTime())) return null;
  return { userId, deviceId, stream, startAt, objectId, retentionClass: cls, ext };
}

export function derivedObjectKeyV2({ userId, kind, day, objectId }) {
  assertIds({ userId, objectId, allowMissingDevice: true, deviceId: null });
  if (looksLikePii(userId)) throw new Error('pii in object identity');
  const [yyyy, mm, dd] = String(day).split('-');
  if (!yyyy || !mm || !dd) throw new Error('period_day must be YYYY-MM-DD');
  const safeKind = String(kind || 'metrics').replace(/[^a-z0-9_]/gi, '');
  return `v2/users/${userId}/derived/${safeKind}/${yyyy}/${mm}/${dd}/${objectId}.json.gz`;
}

export function exportObjectKey({ userId, objectId, compression = 'gzip' }) {
  assertIds({ userId, objectId, allowMissingDevice: true, deviceId: null });
  const ext = compression === 'gzip' ? 'json.gz' : 'json';
  return `v2/users/${userId}/exports/${objectId}.${ext}`;
}

/** Compact JSON the app and algorithms need. */
export function derivedObjectKey({ userId, kind, day, objectId }) {
  if (!isUuid(userId) || !isUuid(objectId)) throw new Error('derived key ids must be uuids');
  if (looksLikePii(userId)) throw new Error('pii in object identity');
  const [yyyy, mm, dd] = String(day).split('-');
  if (!yyyy || !mm || !dd) throw new Error('period_day must be YYYY-MM-DD');
  const safeKind = String(kind || 'metrics').replace(/[^a-z0-9_]/gi, '');
  return `v1/users/${userId}/derived/${safeKind}/${yyyy}/${mm}/${dd}/${objectId}.json.gz`;
}

export function userPrefix(userId) {
  if (!isUuid(userId)) throw new Error('user id must be a uuid');
  return `v1/users/${userId}/`;
}

export function userPrefixV2(userId) {
  if (!isUuid(userId)) throw new Error('user id must be a uuid');
  return `v2/users/${userId}/`;
}

/**
 * Every prefix a subject's bytes can live under. Per-subject deletion walks this list, so a new
 * retention class that is not listed here leaves objects behind that no delete request can reach.
 * `RETENTION_CLASS` is the source of truth; the v3 entries are derived from it rather than restated.
 */
export function allUserPrefixes(userId) {
  if (!isUuid(userId)) throw new Error('user id must be a uuid');
  const classes = [...new Set(Object.values(RETENTION_CLASS))].sort();
  return [
    userPrefix(userId),
    userPrefixV2(userId),
    ...classes.map((cls) => `v3/${cls}/users/${userId}/`),
  ];
}

export function looksLikePii(value) {
  if (value == null) return false;
  const s = String(value);
  if (isUuid(s)) return false;
  if (s.includes('@')) return true;
  if (/^\+?\d{7,}$/.test(s.replace(/[\s-]/g, ''))) return true;
  return false;
}

export function periodParts(isoDay) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(isoDay));
  return m ? { yyyy: m[1], mm: m[2], dd: m[3] } : null;
}
