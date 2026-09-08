/**
 * FRWHOOP day-boundary contract.
 *
 * Raw sensor timestamps are always UTC instants.
 * Session start_at / end_at are always absolute UTC.
 *
 * A physiological "day" is the calendar date in the user's IANA timezone on
 * which the main overnight sleep episode ended (local wake date). When no
 * sleep episode exists, the day is the local calendar date of the request.
 *
 * day_start_at / day_end_at are the UTC instants of local midnight → next
 * local midnight. DST is handled by the timezone offset at each midnight.
 * Travel: the day's timezone_name is the profile timezone at compute time;
 * historical rows keep the timezone they were stored with.
 *
 * This is not a 16:00–16:00 WHOOP cycle. Local midnight is the range bound
 * for snapshots and physiology buckets; sleep association uses wake date.
 */

const UTC = 'UTC';

export function isIanaTimeZone(name) {
  if (!name || typeof name !== 'string') return false;
  try {
    cachedFormatter({ timeZone: name }).format(new Date());
    return true;
  } catch {
    return false;
  }
}

export function resolveTimeZone(name, fallback = UTC) {
  return isIanaTimeZone(name) ? name : fallback;
}

// Intl.DateTimeFormat construction is expensive (~0.1-0.5ms) and these
// helpers run per sensor sample on hot paths (live-series downsampling,
// day-key mapping during overlay/merge). Formatters are immutable and
// stateless for this use, so cache them per (timezone, option shape).
// Bounded: a process serves a handful of timezones; clear past 64.
const FORMATTER_CACHE = new Map();
const FORMATTER_CACHE_MAX = 64;

function cachedFormatter(options) {
  const key = `${options.timeZone}|${options.hourCycle || ''}`;
  let fmt = FORMATTER_CACHE.get(key);
  if (!fmt) {
    if (FORMATTER_CACHE.size >= FORMATTER_CACHE_MAX) FORMATTER_CACHE.clear();
    fmt = new Intl.DateTimeFormat('en-US', options);
    FORMATTER_CACHE.set(key, fmt);
  }
  return fmt;
}

function partsInZone(date, timeZone) {
  const fmt = cachedFormatter({
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  });
  const map = {};
  for (const p of fmt.formatToParts(date)) {
    if (p.type !== 'literal') map[p.type] = p.value;
  }
  return map;
}

function utcFromZoned(y, m, d, hh, mm, ss, timeZone) {
  let guess = Date.UTC(y, m - 1, d, hh, mm, ss);
  for (let i = 0; i < 3; i += 1) {
    const p = partsInZone(new Date(guess), timeZone);
    const asUtc = Date.UTC(
      Number(p.year), Number(p.month) - 1, Number(p.day),
      Number(p.hour), Number(p.minute), Number(p.second),
    );
    const wanted = Date.UTC(y, m - 1, d, hh, mm, ss);
    const delta = wanted - asUtc;
    if (delta === 0) return guess;
    guess += delta;
  }
  return guess;
}

export function localDateKey(isoOrDate, timeZone = UTC) {
  const d = isoOrDate instanceof Date ? isoOrDate : new Date(isoOrDate);
  if (Number.isNaN(d.getTime())) return null;
  const p = partsInZone(d, resolveTimeZone(timeZone));
  return `${p.year}-${p.month}-${p.day}`;
}

export function localHour(isoOrDate, timeZone = UTC) {
  const d = isoOrDate instanceof Date ? isoOrDate : new Date(isoOrDate);
  if (Number.isNaN(d.getTime())) return null;
  return Number(partsInZone(d, resolveTimeZone(timeZone)).hour);
}

export function dayBounds(day, timeZone = UTC) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(day));
  if (!m) throw new Error('day must be YYYY-MM-DD');
  const tz = resolveTimeZone(timeZone);
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const startMs = utcFromZoned(y, mo, d, 0, 0, 0, tz);
  const next = new Date(Date.UTC(y, mo - 1, d) + 86400000);
  const ny = next.getUTCFullYear();
  const nm = next.getUTCMonth() + 1;
  const nd = next.getUTCDate();
  const endMs = utcFromZoned(ny, nm, nd, 0, 0, 0, tz);
  const offsetMinutes = -new Date(startMs).getTimezoneOffset();
  const zoned = partsInZone(new Date(startMs), tz);
  const asIfUtc = Date.UTC(
    Number(zoned.year), Number(zoned.month) - 1, Number(zoned.day),
    Number(zoned.hour), Number(zoned.minute), Number(zoned.second),
  );
  const offsetSeconds = Math.round((asIfUtc - startMs) / 1000);
  return {
    day: `${m[1]}-${m[2]}-${m[3]}`,
    timezone_name: tz,
    day_start_at: new Date(startMs).toISOString(),
    day_end_at: new Date(endMs).toISOString(),
    timezone_offset_seconds: offsetSeconds,
    timezone_offset_minutes: Math.round(offsetSeconds / 60) || offsetMinutes,
  };
}

export function physiologicalDay({ wakeIso, nowIso, timeZone = UTC } = {}) {
  if (wakeIso) {
    const key = localDateKey(wakeIso, timeZone);
    if (key) return key;
  }
  return localDateKey(nowIso || new Date(), timeZone);
}

export function hourBucketUtc(isoOrDate) {
  const d = isoOrDate instanceof Date ? isoOrDate : new Date(isoOrDate);
  const t = Date.UTC(
    d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), d.getUTCHours(), 0, 0, 0,
  );
  return new Date(t);
}

export function utcYmdh(isoOrDate) {
  const d = hourBucketUtc(isoOrDate);
  const p = (n) => String(n).padStart(2, '0');
  return {
    yyyy: String(d.getUTCFullYear()),
    mm: p(d.getUTCMonth() + 1),
    dd: p(d.getUTCDate()),
    hh: p(d.getUTCHours()),
  };
}
