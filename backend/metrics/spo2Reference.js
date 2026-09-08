import { createHash } from 'node:crypto';
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const CYCLE_FILES = new Set([
  'physiological_cycles.csv',
  'physiologische_zyklen.csv',
  'ciclos_fisiologicos.csv',
]);

const HEADER_ALIASES = {
  'cycle start time': 'cycle_start',
  'cycle end time': 'cycle_end',
  'cycle timezone': 'timezone_offset',
  'cycle timezone offset': 'timezone_offset',
  'sleep onset': 'sleep_onset',
  'blood oxygen %': 'official_spo2_pct',
  'blood oxygen pct': 'official_spo2_pct',
  'blood_oxygen_pct': 'blood_oxygen_pct',
  'startzeit des zyklus': 'cycle_start',
  'endzeit des zyklus': 'cycle_end',
  'blutsauerstoff %': 'official_spo2_pct',
  'hora de inicio del ciclo': 'cycle_start',
  'oxígeno en sangre %': 'official_spo2_pct',
  'oxigeno en sangre %': 'official_spo2_pct',
  'cycle_id': 'cycle_id',
  'id': 'cycle_id',
};

const PULSE_ALIASES = {
  timestamp: ['timestamp', 'time', 't', 'datetime', 'ts', 'iso'],
  spo2_pct: ['spo2_pct', 'spo2', 'spo2%', 'oxygen', 'spo2_percentage', 'blood_oxygen_pct'],
  pulse_rate: ['pulse_rate', 'hr', 'pulse', 'bpm'],
  quality: ['quality', 'perfusion', 'pi', 'signal_quality'],
  source_device: ['source_device', 'device', 'oximeter'],
};

function sha(text) {
  return createHash('sha256').update(String(text)).digest('hex');
}

function normHeader(h) {
  const key = String(h || '').trim().toLowerCase().replace(/^\ufeff/, '').replace(/\s+/g, ' ');
  return HEADER_ALIASES[key] || key.replace(/[^\w%]+/g, '_').replace(/^_|_$/g, '');
}

function parseFloatLoose(raw) {
  if (raw == null) return null;
  const s = String(raw).trim();
  if (!s || /^(nat|none|null|nan|-)$/i.test(s)) return null;
  const n = Number(s.replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}

export function parseTimezoneOffsetMinutes(tz) {
  if (tz == null || tz === '') return null;
  if (typeof tz === 'number' && Number.isFinite(tz)) return Math.round(tz);
  const s = String(tz).trim();
  const m = /([+-])(\d{1,2}):?(\d{2})/.exec(s);
  if (!m) return null;
  return (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3] || 0));
}

export function parseWhoopExportTimestamp(raw, timezoneOffset) {
  if (raw == null) return null;
  const s = String(raw).trim();
  if (!s || /^(nat|none|null)$/i.test(s)) return null;
  if (/^\d{10,13}$/.test(s)) {
    const n = Number(s);
    return n > 1e12 ? Math.floor(n / 1000) : Math.floor(n);
  }
  const cleaned = s.replace('T', ' ').replace(/Z$/i, '');
  const m = /^(\d{4})-(\d{2})-(\d{2})[ ](\d{2}):(\d{2})(?::(\d{2}))?/.exec(cleaned);
  if (!m) {
    const t = Date.parse(s);
    return Number.isFinite(t) ? Math.floor(t / 1000) : null;
  }
  const utc = Date.UTC(
    Number(m[1]), Number(m[2]) - 1, Number(m[3]),
    Number(m[4]), Number(m[5]), Number(m[6] || 0),
  );
  const off = parseTimezoneOffsetMinutes(timezoneOffset);
  if (off == null) return Math.floor(utc / 1000);
  return Math.floor(utc / 1000) - off * 60;
}

function scoredSpo2(row, { requireScored = false } = {}) {
  const state = String(row?.score_state || row?.recovery?.score_state || row?.recovery_score_state || '')
    .toUpperCase();
  const nested = row?.score?.spo2_percentage ?? row?.recovery?.score?.spo2_percentage;
  const pct = parseFloatLoose(row?.official_spo2_pct ?? row?.spo2_percentage ?? nested ?? row?.blood_oxygen_pct);
  if (state === 'PENDING_SCORE' || state === 'UNSCORABLE') return null;
  if (requireScored && state !== 'SCORED') return null;
  if (state && state !== 'SCORED') return null;
  if (pct == null || !Number.isFinite(pct) || pct <= 0) return null;
  return pct;
}

export function toWhoopSpo2Reference(row, extra = {}) {
  if (!row || typeof row !== 'object') return null;
  const tz = row.timezone_offset ?? row.cycle_timezone ?? row.timezone ?? extra.timezone_offset ?? null;
  const start = parseWhoopExportTimestamp(
    row.cycle_start ?? row.cycle_start_time ?? row.start ?? row.whoop_cycle_start,
    tz,
  );
  const end = parseWhoopExportTimestamp(
    row.cycle_end ?? row.cycle_end_time ?? row.end ?? row.whoop_cycle_end,
    tz,
  );
  if (start == null || end == null || end <= start) return null;
  const source = extra.source || row.source || 'imported';
  const rawState = row.score_state || row.recovery?.score_state || extra.score_state || '';
  const state = String(rawState).toUpperCase() || (source === 'api' ? '' : 'SCORED');
  const official = scoredSpo2({ ...row, score_state: state }, { requireScored: source === 'api' });
  return {
    cycle_id: row.cycle_id || row.whoop_cycle_id || row.id || `cycle-${start}`,
    cycle_start: start,
    cycle_end: end,
    timezone_offset: tz || null,
    sleep_id: row.sleep_id || row.sleep?.id || null,
    official_spo2_pct: official,
    score_state: state,
    source: extra.source || row.source || 'imported',
    source_file: extra.source_file || row.source_file || null,
    source_hash: extra.source_hash || null,
    created_at: row.created_at || null,
    updated_at: row.updated_at || null,
    cycle_start_iso: new Date(start * 1000).toISOString(),
    cycle_end_iso: new Date(end * 1000).toISOString(),
  };
}

function parseCsv(text) {
  const lines = String(text).replace(/^\ufeff/, '').split(/\r?\n/).filter((l) => l.length);
  if (!lines.length) return [];
  const headers = splitCsvLine(lines[0]).map(normHeader);
  const rows = [];
  for (const line of lines.slice(1)) {
    const cells = splitCsvLine(line);
    const row = {};
    headers.forEach((h, i) => { row[h] = cells[i]; });
    rows.push(row);
  }
  return rows;
}

function splitCsvLine(line) {
  const out = [];
  let cur = '';
  let q = false;
  for (let i = 0; i < line.length; i += 1) {
    const c = line[i];
    if (c === '"') {
      if (q && line[i + 1] === '"') { cur += '"'; i += 1; }
      else q = !q;
    } else if (c === ',' && !q) {
      out.push(cur);
      cur = '';
    } else cur += c;
  }
  out.push(cur);
  return out;
}

function filesFromExport(input) {
  if (!input) return [];
  if (typeof input === 'string' && !existsSync(input) && input.includes(',')) {
    return [{ name: 'inline.csv', text: input }];
  }
  if (typeof input === 'string' && input.includes('Cycle start')) {
    return [{ name: 'inline.csv', text: input }];
  }
  const out = [];
  const walk = (p) => {
    const st = statSync(p);
    if (st.isFile()) {
      const base = path.basename(p).toLowerCase();
      if (base.endsWith('.csv') || CYCLE_FILES.has(base)) {
        out.push({ name: base, text: readFileSync(p, 'utf8') });
      } else if (base.endsWith('.zip')) {
        // ponytail: unzip via existing zlib only for gzip; zip needs a walker. Use python-less: skip zip unless unzip available.
        out.push({ name: base, path: p, zip: true });
      } else if (base.endsWith('.json') || base.endsWith('.json.gz')) {
        out.push({ name: base, path: p, json: true });
      }
      return;
    }
    for (const ent of readdirSync(p)) walk(path.join(p, ent));
  };
  if (existsSync(input)) walk(input);
  return out;
}

function loadZipCsv(zipPath) {
  try {
    const text = execFileSync('unzip', ['-p', zipPath, '*physiological_cycles.csv'], {
      encoding: 'utf8',
      maxBuffer: 20e6,
    });
    return text;
  } catch {
    return null;
  }
}

export function importWhoopSpo2References(input, { source = null } = {}) {
  if (Array.isArray(input)) {
    return input.map((row) => toWhoopSpo2Reference(row, { source: source || 'imported' })).filter(Boolean);
  }
  if (input && typeof input === 'object' && !Buffer.isBuffer(input)) {
    if (input.cycle_start || input.cycle_id || input.id) {
      const one = toWhoopSpo2Reference(input, { source: source || 'api' });
      return one ? [one] : [];
    }
    if (input.physiological_summary || Object.values(input)[0]?.physiological_summary) {
      return importFromDayWiseJson(input, { source: source || 'imported' });
    }
    if (input.records || input.cycles || input.data) {
      return importWhoopSpo2References(input.records || input.cycles || input.data, { source: source || 'api' });
    }
  }
  if (typeof input === 'string') {
    if (existsSync(input)) {
      const st = statSync(input);
      if (st.isFile() && /\.json(\.gz)?$/i.test(input) && !input.endsWith('.gz')) {
        const slim = importDayWiseViaJq(input, { source: source || 'imported' });
        if (slim) return slim;
      }
      if (st.isFile() && /\.json(\.gz)?$/i.test(input)) {
        let buf = readFileSync(input);
        if (input.endsWith('.gz')) buf = gunzipSync(buf);
        return importWhoopSpo2References(JSON.parse(buf.toString('utf8')), { source: source || 'imported' });
      }
      if (st.isFile() && input.toLowerCase().endsWith('.zip')) {
        const text = loadZipCsv(input);
        if (!text) return [];
        return parseCsv(text).map((row) => toWhoopSpo2Reference(row, {
          source: 'csv',
          source_file: path.basename(input),
          source_hash: sha(text),
        })).filter(Boolean);
      }
      if (st.isFile() && input.toLowerCase().endsWith('.csv')) {
        const text = readFileSync(input, 'utf8');
        return parseCsv(text).map((row) => toWhoopSpo2Reference(row, {
          source: 'csv',
          source_file: path.basename(input),
          source_hash: sha(text),
        })).filter(Boolean);
      }
      const collected = [];
      for (const f of filesFromExport(input)) {
        if (f.text) {
          collected.push(...parseCsv(f.text).map((row) => toWhoopSpo2Reference(row, {
            source: 'csv',
            source_file: f.name,
            source_hash: sha(f.text),
          })));
        }
      }
      return collected.filter(Boolean);
    }
    return parseCsv(input).map((row) => toWhoopSpo2Reference(row, { source: source || 'csv' })).filter(Boolean);
  }
  return [];
}

function importDayWiseViaJq(file, extra = {}) {
  try {
    const text = execFileSync('jq', ['-c', 'to_entries[] | {day: .key} + (.value.physiological_summary // {})', file], {
      encoding: 'utf8',
      maxBuffer: 20e6,
    });
    const out = [];
    for (const line of text.split('\n').filter(Boolean)) {
      const ps = JSON.parse(line);
      const row = {
        cycle_id: ps.cycle_id || ps['Cycle id'] || ps.day,
        cycle_start: ps['Cycle start time'] ?? ps.cycle_start,
        cycle_end: ps['Cycle end time'] ?? ps.cycle_end,
        timezone_offset: ps['Cycle timezone'] ?? ps.cycle_timezone,
        official_spo2_pct: ps['Blood oxygen %'] ?? ps.blood_oxygen_pct,
        score_state: 'SCORED',
        sleep_id: ps.sleep_id,
      };
      const ref = toWhoopSpo2Reference(row, extra);
      if (ref) out.push(ref);
    }
    return out;
  } catch {
    return null;
  }
}

export function importFromDayWiseJson(data, extra = {}) {
  const days = data.physiological_summary ? { day: data } : data;
  const out = [];
  for (const [day, body] of Object.entries(days)) {
    const ps = body?.physiological_summary || body;
    if (!ps) continue;
    const row = {
      cycle_id: ps.cycle_id || ps['Cycle id'] || day,
      cycle_start: ps['Cycle start time'] ?? ps.cycle_start,
      cycle_end: ps['Cycle end time'] ?? ps.cycle_end,
      timezone_offset: ps['Cycle timezone'] ?? ps.cycle_timezone,
      official_spo2_pct: ps['Blood oxygen %'] ?? ps.blood_oxygen_pct,
      score_state: 'SCORED',
      sleep_id: ps.sleep_id,
    };
    const ref = toWhoopSpo2Reference(row, { ...extra, source: extra.source || 'imported', source_file: extra.source_file || 'day_wise_whoop_data.json' });
    if (ref) out.push(ref);
  }
  return out;
}

export function importWhoopApiCycle(doc) {
  const recovery = doc?.recovery || doc;
  const score = recovery?.score || doc?.score || {};
  const state = String(recovery?.score_state || doc?.score_state || '').toUpperCase();
  return toWhoopSpo2Reference({
    cycle_id: doc?.id || doc?.cycle_id,
    cycle_start: doc?.start || doc?.cycle_start || doc?.start_at,
    cycle_end: doc?.end || doc?.cycle_end || doc?.end_at,
    timezone_offset: doc?.timezone_offset,
    sleep_id: doc?.sleep_id || doc?.sleep?.id,
    score_state: state,
    spo2_percentage: score.spo2_percentage,
    created_at: doc?.created_at,
    updated_at: doc?.updated_at,
  }, { source: 'api' });
}

function pulseCol(row, names) {
  for (const n of names) {
    if (row[n] != null && row[n] !== '') return row[n];
    const found = Object.keys(row).find((k) => n === k.toLowerCase() || HEADER_ALIASES[k.toLowerCase()] === n);
    if (found && row[found] != null) return row[found];
  }
  return null;
}

export function importPulseOx(input, mapping = {}) {
  const text = typeof input === 'string' && existsSync(input) ? readFileSync(input, 'utf8') : String(input || '');
  const rows = parseCsv(text);
  const aliases = {
    timestamp: mapping.timestamp ? [mapping.timestamp] : PULSE_ALIASES.timestamp,
    spo2_pct: mapping.spo2_pct ? [mapping.spo2_pct] : PULSE_ALIASES.spo2_pct,
    pulse_rate: mapping.pulse_rate ? [mapping.pulse_rate] : PULSE_ALIASES.pulse_rate,
    quality: mapping.quality ? [mapping.quality] : PULSE_ALIASES.quality,
    source_device: mapping.source_device ? [mapping.source_device] : PULSE_ALIASES.source_device,
  };
  return rows.map((row) => {
    const lower = {};
    for (const [k, v] of Object.entries(row)) lower[k.toLowerCase()] = v;
    const tsRaw = pulseCol(lower, aliases.timestamp);
    const t = parseWhoopExportTimestamp(tsRaw, null);
    const spo2 = parseFloatLoose(pulseCol(lower, aliases.spo2_pct));
    if (t == null || spo2 == null) return null;
    return {
      timestamp: t,
      timestamp_raw: tsRaw,
      spo2_pct: spo2,
      pulse_rate: parseFloatLoose(pulseCol(lower, aliases.pulse_rate)),
      quality: parseFloatLoose(pulseCol(lower, aliases.quality)),
      source_device: pulseCol(lower, aliases.source_device) || null,
    };
  }).filter(Boolean);
}
