// Corpus audit for two disputed v18 readings. Does not change production decode.
// Question A: historical R-R u16 as milliseconds (H0) vs 1/1024 s ticks (H1).
// Question B: GenieMax "respiration" at frame byte 43 vs dynamic_acceleration f32@41.

import { u8, u16, f32Finite } from './gen5.js';
import { verifyFrame } from './framing.js';

export const AUDIT_VERSION = 'frwhoop-v18-claims/1';
export const TICKS_PER_SEC = 1024;
export const RR_MIN = 200;
export const RR_MAX = 2500;
export const HR_NEAR = 4;
export const TIME_NEAR_S = 2;
export const PHYSIO_BRPM_LO = 8;
export const PHYSIO_BRPM_HI = 30;
export const DYN_STILL_G = 0.02;
export const DYN_MOTION_G = 0.05;
export const DYN_IOS_GATE_G = 8;
export const DYN_FULL_SCALE_G = 16;

export const RR_UNIT_MIN_PAIRS = 200;
export const RR_UNIT_MIN_GROUPS = 2;
export const MAE_WIN_FACTOR = 3;
export const H0_RATIO = Object.freeze([0.99, 1.011]);
export const H1_RATIO = Object.freeze([1.018, 1.032]);

export function ticksToMs(raw) {
  return Math.round((Number(raw) * 1000) / TICKS_PER_SEC);
}

export function hexToBytes(hex) {
  const s = String(hex || '').toLowerCase().replace(/[^0-9a-f]/g, '');
  if (!s || s.length % 2) return [];
  const out = new Array(s.length / 2);
  for (let i = 0; i < s.length; i += 2) out[i / 2] = Number.parseInt(s.slice(i, i + 2), 16);
  return out;
}

export function median(xs) {
  if (!xs.length) return null;
  const a = xs.slice().sort((x, y) => x - y);
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

export function percentile(xs, p) {
  if (!xs.length) return null;
  const a = xs.slice().sort((x, y) => x - y);
  const i = Math.min(a.length - 1, Math.max(0, Math.ceil((p / 100) * a.length) - 1));
  return a[i];
}

export function shannonEntropy(counts, n) {
  if (!n) return null;
  let h = 0;
  for (const c of counts) {
    if (!c) continue;
    const p = c / n;
    h -= p * Math.log2(p);
  }
  return h;
}

export function pearson(a, b) {
  const n = Math.min(a.length, b.length);
  if (n < 8) return null;
  let sa = 0, sb = 0;
  for (let i = 0; i < n; i += 1) { sa += a[i]; sb += b[i]; }
  const ma = sa / n, sbm = sb / n;
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < n; i += 1) {
    const x = a[i] - ma, y = b[i] - sbm;
    num += x * y; da += x * x; db += y * y;
  }
  if (da <= 0 || db <= 0) return null;
  return num / Math.sqrt(da * db);
}

export function lag1(xs) {
  if (xs.length < 8) return null;
  return pearson(xs.slice(0, -1), xs.slice(1));
}

export function rmssd(rr) {
  if (!rr || rr.length < 2) return null;
  let s = 0, n = 0;
  for (let i = 1; i < rr.length; i += 1) {
    const d = rr[i] - rr[i - 1];
    s += d * d;
    n += 1;
  }
  return n ? Math.sqrt(s / n) : null;
}

export function zipFromEnd(a, b) {
  const n = Math.min(a.length, b.length);
  const out = [];
  for (let i = 1; i <= n; i += 1) out.push([a[a.length - i], b[b.length - i]]);
  return out.reverse();
}

function charKey(row) {
  return String(row?.char || row?.characteristic || '').replace(/-/g, '').toUpperCase();
}

export function isGattHrRow(row) {
  const ch = charKey(row);
  if (ch.endsWith('2A37') || ch === '2A37') return true;
  return String(row?.family || '').toLowerCase() === 'gatt' && ch.includes('2A37');
}

export function parseGattRr(bytes) {
  const b = Array.isArray(bytes) ? bytes : [];
  if (b.length < 2) return null;
  const flags = b[0];
  const hr16 = (flags & 0x01) !== 0;
  let offset = 1;
  let bpm;
  if (hr16) {
    if (b.length < 3) return null;
    bpm = b[1] | (b[2] << 8);
    offset = 3;
  } else {
    bpm = b[1];
    offset = 2;
  }
  if (flags & 0x08) offset += 2;
  const ticks = [];
  if (flags & 0x10) {
    while (offset + 1 < b.length) {
      ticks.push(b[offset] | (b[offset + 1] << 8));
      offset += 2;
    }
  }
  if (!(bpm >= 20 && bpm <= 240)) return null;
  const ms = ticks.map(ticksToMs).filter((v) => v >= RR_MIN && v <= RR_MAX);
  return { bpm, ticks, ms };
}

function familyOf(row) {
  const fam = String(row?.family || '').toLowerCase();
  if (fam === 'puffin') return 'puffin';
  if (fam === 'harvard') return 'harvard';
  const ch = charKey(row);
  if (ch.startsWith('FD4B')) return 'puffin';
  if (ch.startsWith('6108')) return 'harvard';
  return 'puffin';
}

function nightOfUnix(unix, tz = 'America/Los_Angeles') {
  if (!Number.isFinite(unix)) return 'unknown';
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(unix * 1000));
  const pick = (t) => parts.find((p) => p.type === t)?.value;
  let day = `${pick('year')}-${pick('month')}-${pick('day')}`;
  const hour = Number(pick('hour'));
  if (Number.isFinite(hour) && hour < 12) {
    const prev = new Date(unix * 1000 - 12 * 3600 * 1000);
    const p2 = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    }).formatToParts(prev);
    const g = (t) => p2.find((p) => p.type === t)?.value;
    day = `${g('year')}-${g('month')}-${g('day')}`;
  }
  return day;
}

export function extractV18(buf, meta = {}) {
  if (!buf || buf.length < 118) return null;
  if (buf[8] !== 47 || buf[9] !== 18) return null;
  if (!verifyFrame(buf, 'puffin').ok) return null;
  const unix = (buf[15] | (buf[16] << 8) | (buf[17] << 16) | (buf[18] << 24)) >>> 0;
  const hrRaw = buf[22];
  const declared = buf[23] || 0;
  const rrRaw = [];
  const rejected = [];
  for (let i = 0; i < Math.min(declared, 4); i += 1) {
    const raw = u16(buf, 24 + i * 2);
    if (raw == null || raw === 0) continue;
    if (raw >= RR_MIN && raw <= RR_MAX) rrRaw.push(raw);
    else rejected.push(raw);
  }
  const dyn = f32Finite(buf, 41);
  const gx = f32Finite(buf, 45);
  const gy = f32Finite(buf, 49);
  const gz = f32Finite(buf, 53);
  const gmag = (gx != null && gy != null && gz != null)
    ? Math.sqrt(gx * gx + gy * gy + gz * gz) : null;
  const opticalA = u8(buf, 106);
  const opticalB = u8(buf, 107);
  const worn = hrRaw !== 0 && !(opticalA === 0 && opticalB === 0);
  return {
    kind: 'v18',
    unix,
    record_index: (buf[11] | (buf[12] << 8) | (buf[13] << 16) | (buf[14] << 24)) >>> 0,
    hr: hrRaw === 0 ? null : hrRaw,
    rr_raw: rrRaw,
    rr_rejected: rejected,
    b43: buf[43],
    dyn,
    gx, gy, gz, gmag,
    cadence: u8(buf, 59),
    sleep_state: (buf[81] >> 4) & 0x03,
    worn,
    optical_a: opticalA,
    optical_b: opticalB,
    device: meta.device || 'unknown',
    firmware: meta.fw || 'unknown',
    night: nightOfUnix(unix),
    recv_ms: meta.recv_ms ?? null,
  };
}

export function extractType40(buf, family, meta = {}) {
  if (!buf || buf.length < 18) return null;
  if (!verifyFrame(buf, family).ok) return null;
  const typeOff = family === 'puffin' ? 8 : 4;
  if (buf[typeOff] !== 40) return null;
  const tsOff = family === 'puffin' ? 10 : 6;
  const hrOff = family === 'puffin' ? 16 : 12;
  const countOff = family === 'puffin' ? 17 : 13;
  const unix = (buf[tsOff] | (buf[tsOff + 1] << 8) | (buf[tsOff + 2] << 16) | (buf[tsOff + 3] << 24)) >>> 0;
  const hr = buf[hrOff];
  const declared = buf[countOff] || 0;
  const payloadEnd = buf.length - 4;
  const fit = Math.max(0, Math.floor((payloadEnd - (countOff + 1)) / 2));
  const rrRaw = [];
  for (let i = 0; i < Math.min(declared, fit); i += 1) {
    const raw = u16(buf, countOff + 1 + i * 2);
    if (raw == null || raw === 0) continue;
    if (raw >= RR_MIN && raw <= RR_MAX) rrRaw.push(raw);
  }
  return {
    kind: 'type40',
    unix,
    hr: hr >= 20 && hr <= 240 ? hr : null,
    rr_raw: rrRaw,
    device: meta.device || 'unknown',
    firmware: meta.fw || 'unknown',
    recv_ms: meta.recv_ms ?? null,
  };
}

export function ingestNotifyRow(row, meta = {}) {
  const recv_ms = Date.parse(row?.t || row?.datetime || row?.received_at || '');
  const fw = row?.fw || meta.fw || 'unknown';
  const device = meta.device || row?.device_id || 'unknown';
  const m = { ...meta, fw, device, recv_ms: Number.isFinite(recv_ms) ? recv_ms : null };
  if (isGattHrRow(row)) {
    const parsed = parseGattRr(hexToBytes(row.hex));
    if (!parsed) return { kind: 'gatt', skipped: true };
    return {
      kind: 'gatt',
      bpm: parsed.bpm,
      ticks: parsed.ticks,
      rr_ms: parsed.ms,
      recv_ms: m.recv_ms,
      unix: Number.isFinite(m.recv_ms) ? Math.floor(m.recv_ms / 1000) : null,
      device,
      firmware: fw,
    };
  }
  const hex = typeof row?.hex === 'string' ? row.hex : '';
  if (!hex.startsWith('aa') && !hex.startsWith('AA')) return null;
  const buf = hexToBytes(hex);
  const family = familyOf(row);
  if (family === 'puffin' && buf.length >= 124 && buf[8] === 47 && buf[9] === 18) {
    return extractV18(buf, m);
  }
  if (buf.length >= 18 && buf[family === 'puffin' ? 8 : 4] === 40) {
    return extractType40(buf, family, m);
  }
  return null;
}

export function scorePair(histRaw, liveMs) {
  const h0 = Math.abs(histRaw - liveMs);
  const h1 = Math.abs(ticksToMs(histRaw) - liveMs);
  const ratio = liveMs > 0 ? histRaw / liveMs : null;
  return {
    hist_raw: histRaw,
    live_ms: liveMs,
    h0_err: h0,
    h1_err: h1,
    ratio,
    favor: h0 === h1 ? 'tie' : (h0 < h1 ? 'H0' : 'H1'),
  };
}

function indexByUnix(rows) {
  const map = new Map();
  for (const r of rows) {
    if (!Number.isFinite(r.unix)) continue;
    const key = `${r.device}|${r.unix}`;
    const prev = map.get(key);
    if (!prev || (r.rr_raw?.length || 0) >= (prev.rr_raw?.length || 0)) map.set(key, r);
  }
  return map;
}

function nearUnix(map, device, unix, span, hr, hrTol) {
  const hits = [];
  for (let d = -span; d <= span; d += 1) {
    const row = map.get(`${device}|${unix + d}`);
    if (!row) continue;
    if (hr != null && row.hr != null && Math.abs(row.hr - hr) > hrTol) continue;
    hits.push(row);
  }
  return hits;
}

function pairRecords(liveList, histList, { timeSpan = TIME_NEAR_S, hrTol = HR_NEAR } = {}) {
  const hist = indexByUnix(histList.filter((r) => r.rr_raw?.length));
  const pairs = [];
  for (const live of liveList) {
    const liveMs = live.rr_ms || (live.rr_raw || []).slice();
    if (!liveMs.length) continue;
    const unix = live.unix;
    if (!Number.isFinite(unix)) continue;
    const cands = nearUnix(hist, live.device || 'unknown', unix, timeSpan, live.bpm ?? live.hr, hrTol);
    if (!cands.length) continue;
    const histRow = cands.reduce((best, r) => {
      const dt = Math.abs(r.unix - unix);
      const bdt = Math.abs(best.unix - unix);
      if (dt < bdt) return r;
      if (dt > bdt) return best;
      return (r.rr_raw?.length || 0) >= (best.rr_raw?.length || 0) ? r : best;
    });
    const zipped = zipFromEnd(histRow.rr_raw, liveMs);
    for (const [histRaw, ms] of zipped) {
      const scored = scorePair(histRaw, ms);
      pairs.push({
        ...scored,
        unix: histRow.unix,
        live_unix: unix,
        hist_hr: histRow.hr,
        live_hr: live.bpm ?? live.hr,
        device: histRow.device,
        firmware: histRow.firmware || live.firmware,
        night: histRow.night || nightOfUnix(histRow.unix),
      });
    }
  }
  return pairs;
}

export function attachGattStrapUnix(gatt, type40) {
  const bySec = new Map();
  for (const t of type40) {
    if (!Number.isFinite(t.recv_ms) || !Number.isFinite(t.unix)) continue;
    const key = `${t.device}|${Math.floor(t.recv_ms / 1000)}`;
    if (!bySec.has(key)) bySec.set(key, t);
  }
  return gatt.map((g) => {
    let unix = Number.isFinite(g.recv_ms) ? Math.floor(g.recv_ms / 1000) : g.unix;
    if (Number.isFinite(g.recv_ms)) {
      const sec = Math.floor(g.recv_ms / 1000);
      for (const d of [0, -1, 1, -2, 2]) {
        const t = bySec.get(`${g.device}|${sec + d}`);
        if (t) { unix = t.unix; break; }
      }
    }
    return { ...g, unix, bpm: g.bpm, rr_ms: g.rr_ms };
  });
}

function summarizePairs(pairs) {
  const n = pairs.length;
  const empty = {
    n: 0,
    median_hist_live_ratio: null,
    mae_h0: null,
    mae_h1: null,
    p95_h0: null,
    p95_h1: null,
    frac_h0: null,
    frac_h1: null,
    frac_tie: null,
    by_group: {},
  };
  if (!n) return empty;
  const ratios = pairs.map((p) => p.ratio).filter((v) => Number.isFinite(v));
  const e0 = pairs.map((p) => p.h0_err);
  const e1 = pairs.map((p) => p.h1_err);
  const favor = { H0: 0, H1: 0, tie: 0 };
  const by = {};
  for (const p of pairs) {
    favor[p.favor] += 1;
    const key = `${p.firmware}|${p.night}|${p.device}`;
    if (!by[key]) by[key] = { n: 0, e0: [], e1: [], ratios: [], favor: { H0: 0, H1: 0, tie: 0 } };
    by[key].n += 1;
    by[key].e0.push(p.h0_err);
    by[key].e1.push(p.h1_err);
    if (p.ratio != null) by[key].ratios.push(p.ratio);
    by[key].favor[p.favor] += 1;
  }
  const by_group = {};
  for (const [k, g] of Object.entries(by)) {
    by_group[k] = {
      n: g.n,
      median_ratio: median(g.ratios),
      mae_h0: median(g.e0),
      mae_h1: median(g.e1),
      frac_h0: g.favor.H0 / g.n,
      frac_h1: g.favor.H1 / g.n,
    };
  }
  return {
    n,
    median_hist_live_ratio: median(ratios),
    mae_h0: median(e0),
    mae_h1: median(e1),
    p95_h0: percentile(e0, 95),
    p95_h1: percentile(e1, 95),
    frac_h0: favor.H0 / n,
    frac_h1: favor.H1 / n,
    frac_tie: favor.tie / n,
    by_group,
  };
}

export function rrUnitVerdict(summary) {
  if (!summary || summary.n < RR_UNIT_MIN_PAIRS) return 'OPEN';
  const groups = Object.keys(summary.by_group || {}).length;
  if (groups < RR_UNIT_MIN_GROUPS) return 'OPEN';
  const r = summary.median_hist_live_ratio;
  const h0 = summary.mae_h0, h1 = summary.mae_h1;
  if (h0 == null || h1 == null || r == null) return 'OPEN';
  const h0Wins = h0 * MAE_WIN_FACTOR <= h1 && summary.frac_h0 >= 0.8
    && r >= H0_RATIO[0] && r <= H0_RATIO[1];
  const h1Wins = h1 * MAE_WIN_FACTOR <= h0 && summary.frac_h1 >= 0.8
    && r >= H1_RATIO[0] && r <= H1_RATIO[1];
  if (h0Wins && !h1Wins) return 'CONFIRMED';
  if (h1Wins && !h0Wins) return 'REFUTED';
  return 'OPEN';
}

export function hrFromRrErrors(v18) {
  const h0 = [], h1 = [], r0 = [], r1 = [];
  const by = {};
  let n = 0;
  for (const r of v18) {
    if (!r.rr_raw || r.rr_raw.length < 2 || r.hr == null) continue;
    const mean0 = r.rr_raw.reduce((a, b) => a + b, 0) / r.rr_raw.length;
    const mean1 = r.rr_raw.map(ticksToMs).reduce((a, b) => a + b, 0) / r.rr_raw.length;
    if (!(mean0 > 0 && mean1 > 0)) continue;
    const bpm0 = 60000 / mean0;
    const bpm1 = 60000 / mean1;
    const e0 = Math.abs(bpm0 - r.hr);
    const e1 = Math.abs(bpm1 - r.hr);
    h0.push(e0);
    h1.push(e1);
    r0.push(mean0 / (60000 / r.hr));
    r1.push(mean1 / (60000 / r.hr));
    n += 1;
    const key = `${r.firmware}|${r.night}|${r.device}`;
    if (!by[key]) by[key] = { n: 0, e0: [], e1: [], r0: [] };
    by[key].n += 1;
    by[key].e0.push(e0);
    by[key].e1.push(e1);
    by[key].r0.push(mean0 / (60000 / r.hr));
  }
  const by_group = {};
  for (const [k, g] of Object.entries(by)) {
    by_group[k] = { n: g.n, mae_h0: median(g.e0), mae_h1: median(g.e1), median_raw_over_expected: median(g.r0) };
  }
  return {
    n_multi_rr: n,
    mae_h0: median(h0),
    mae_h1: median(h1),
    p95_h0: percentile(h0, 95),
    p95_h1: percentile(h1, 95),
    median_raw_over_expected: median(r0),
    median_ticks_ms_over_expected: median(r1),
    frac_h0: n ? h0.filter((e, i) => e < h1[i]).length / n : null,
    frac_h1: n ? h1.filter((e, i) => e < h0[i]).length / n : null,
    by_group,
  };
}

export function hrvDelta(v18) {
  const recs = [];
  const nights = new Map();
  for (const r of v18) {
    if (!r.rr_raw || r.rr_raw.length < 3) continue;
    const a = rmssd(r.rr_raw);
    const b = rmssd(r.rr_raw.map(ticksToMs));
    if (a == null || b == null || a === 0) continue;
    recs.push({ a, b, pct: ((b - a) / a) * 100 });
    const k = `${r.firmware}|${r.night}|${r.device}`;
    if (!nights.has(k)) nights.set(k, []);
    nights.get(k).push(((b - a) / a) * 100);
  }
  const by_group = {};
  for (const [k, pcts] of nights) by_group[k] = { n: pcts.length, median_pct: median(pcts) };
  return {
    n_records_3plus_rr: recs.length,
    nights: Object.keys(by_group).length,
    median_rmssd_h0: median(recs.map((r) => r.a)),
    median_rmssd_h1: median(recs.map((r) => r.b)),
    median_pct_h1_vs_h0: median(recs.map((r) => r.pct)),
    expected_scale: 1000 / 1024,
    by_group,
  };
}

function hist(byteVals) {
  const counts = new Array(256).fill(0);
  for (const v of byteVals) counts[v & 255] += 1;
  return counts;
}

export function byte43Stats(v18) {
  const worn = v18.filter((r) => r.worn);
  const off = v18.filter((r) => !r.worn);
  const sleep = v18.filter((r) => r.sleep_state === 2);
  const wake = v18.filter((r) => r.sleep_state === 0);
  const vals = v18.map((r) => r.b43).filter((v) => v != null);
  const counts = hist(vals);
  const distinct = counts.filter((c) => c > 0).length;
  const phys = vals.filter((v) => v >= PHYSIO_BRPM_LO && v <= PHYSIO_BRPM_HI).length;
  const byDev = new Map();
  for (const r of v18) {
    const k = r.device;
    if (!byDev.has(k)) byDev.set(k, []);
    byDev.get(k).push(r);
  }
  const deltas = [];
  const b43Series = [], b43ForDyn = [], dynSeries = [], b43ForG = [], dynForG = [], gDeltaSeries = [], dynGDelta = [];
  const stillB = [], motionB = [];
  const stillDyn = [], motionDyn = [];
  const nearStillByteJump = [];
  let finite = 0, in8 = 0, in16 = 0, nonfinite = 0, neg = 0;
  for (const rows of byDev.values()) {
    rows.sort((a, b) => a.unix - b.unix || a.record_index - b.record_index);
    for (let i = 0; i < rows.length; i += 1) {
      const r = rows[i];
      if (r.dyn == null || !Number.isFinite(r.dyn)) nonfinite += 1;
      else {
        finite += 1;
        if (r.dyn < 0) neg += 1;
        if (r.dyn >= 0 && r.dyn <= DYN_IOS_GATE_G) in8 += 1;
        if (Math.abs(r.dyn) <= DYN_FULL_SCALE_G) in16 += 1;
        if (r.dyn < DYN_STILL_G) { stillB.push(r.b43); stillDyn.push(r.dyn); }
        if (r.dyn > DYN_MOTION_G) { motionB.push(r.b43); motionDyn.push(r.dyn); }
      }
      if (i === 0) continue;
      const prev = rows[i - 1];
      if (r.unix !== prev.unix + 1) continue;
      deltas.push(Math.abs(r.b43 - prev.b43));
      b43Series.push(r.b43);
      if (r.dyn != null && prev.dyn != null && Number.isFinite(r.dyn) && Number.isFinite(prev.dyn)) {
        b43ForDyn.push(r.b43);
        dynSeries.push(r.dyn);
        if (Math.abs(r.dyn - prev.dyn) < 0.01) nearStillByteJump.push(Math.abs(r.b43 - prev.b43));
      }
      if (r.gmag != null && prev.gmag != null) {
        const dg = Math.abs(r.gmag - prev.gmag);
        b43ForG.push(r.b43);
        gDeltaSeries.push(dg);
        if (r.dyn != null && Number.isFinite(r.dyn)) {
          dynForG.push(r.dyn);
          dynGDelta.push(dg);
        }
      }
    }
  }
  const n = vals.length;
  let vmin = null, vmax = null;
  for (const v of vals) {
    if (vmin == null || v < vmin) vmin = v;
    if (vmax == null || v > vmax) vmax = v;
  }
  const dyns = [];
  for (const r of v18) {
    if (r.dyn != null && Number.isFinite(r.dyn)) dyns.push(r.dyn);
  }
  return {
    n: n,
    distinct,
    entropy_bits: shannonEntropy(counts, n),
    min: vmin,
    max: vmax,
    median: median(vals),
    p05: percentile(vals, 5),
    p95: percentile(vals, 95),
    frac_physio_8_30: n ? phys / n : null,
    median_abs_delta_1s: median(deltas),
    p95_abs_delta_1s: percentile(deltas, 95),
    lag1: lag1(b43Series),
    worn: { n: worn.length, median: median(worn.map((r) => r.b43)), mean: worn.length ? worn.reduce((s, r) => s + r.b43, 0) / worn.length : null },
    off_wrist: { n: off.length, median: median(off.map((r) => r.b43)), mean: off.length ? off.reduce((s, r) => s + r.b43, 0) / off.length : null },
    sleep: { n: sleep.length, median: median(sleep.map((r) => r.b43)) },
    wake: { n: wake.length, median: median(wake.map((r) => r.b43)) },
    median_abs_delta_when_dyn_stable: median(nearStillByteJump),
    corr_b43_dyn: pearson(b43ForDyn, dynSeries),
    corr_b43_gdelta: pearson(b43ForG, gDeltaSeries),
    corr_b43_cadence: pearson(
      v18.filter((r) => r.cadence != null).map((r) => r.b43),
      v18.filter((r) => r.cadence != null).map((r) => r.cadence),
    ),
    still_vs_motion_b43: { still_median: median(stillB), motion_median: median(motionB) },
    dynamic_acceleration: {
      n_finite: finite,
      n_nonfinite: nonfinite,
      n_negative: neg,
      frac_finite: v18.length ? finite / v18.length : null,
      frac_0_8g: finite ? in8 / finite : null,
      frac_abs_le_16g: finite ? in16 / finite : null,
      median: median(dyns),
      p95: percentile(dyns, 95),
      still_median: median(stillDyn),
      motion_median: median(motionDyn),
      corr_dyn_gdelta: pearson(dynForG, dynGDelta),
      still_n: stillDyn.length,
      motion_n: motionDyn.length,
    },
  };
}

export function respirationVerdict(stats) {
  if (!stats || stats.n < 50) return 'OPEN';
  const phys = stats.frac_physio_8_30;
  const ent = stats.entropy_bits;
  const jump = stats.median_abs_delta_when_dyn_stable;
  const offMed = stats.off_wrist?.median;
  const wornMed = stats.worn?.median;
  const mantissa = (ent != null && ent >= 6)
    && (phys != null && phys < 0.45)
    && (jump == null || jump >= 8);
  const offWorse = offMed != null && wornMed != null && offMed > wornMed + 10;
  const notRate = mantissa || offWorse || (phys != null && phys < 0.3 && (stats.p95 == null || stats.p95 > 80));
  if (notRate && (stats.dynamic_acceleration?.frac_finite > 0.95)) return 'REFUTED';
  if (phys >= 0.8 && ent != null && ent < 4 && stats.median_abs_delta_1s != null && stats.median_abs_delta_1s <= 2) {
    return 'CONFIRMED';
  }
  return 'OPEN';
}

export function dynAccelVerdict(stats) {
  const d = stats?.dynamic_acceleration;
  if (!d || !d.n_finite) return 'OPEN';
  const ok = d.frac_finite >= 0.99 && d.frac_0_8g >= 0.95
    && d.still_n >= 20 && d.motion_n >= 20
    && d.still_median != null && d.motion_median != null
    && d.motion_median > d.still_median * 2;
  if (ok) return 'CONFIRMED';
  if (d.frac_finite >= 0.99 && d.frac_0_8g >= 0.95) return 'CONFIRMED';
  return 'OPEN';
}

export function auditV18Claims({ v18 = [], gatt = [], type40 = [] } = {}) {
  v18 = (v18 || []).filter(Boolean);
  gatt = (gatt || []).filter(Boolean);
  type40 = (type40 || []).filter(Boolean);
  const gattUnix = attachGattStrapUnix(gatt, type40);
  const gattHist = pairRecords(gattUnix, v18);
  const gattType40 = pairRecords(
    gattUnix.map((g) => ({ ...g, rr_ms: g.rr_ms })),
    type40.map((t) => ({ ...t, rr_raw: t.rr_raw, night: nightOfUnix(t.unix), hr: t.hr })),
  );
  const type40Hist = pairRecords(
    type40.filter((t) => t.rr_raw?.length).map((t) => ({
      unix: t.unix, device: t.device, firmware: t.firmware, hr: t.hr, bpm: t.hr, rr_ms: t.rr_raw,
    })),
    v18,
  );
  const matched = summarizePairs(gattHist);
  const hopLive = summarizePairs(gattType40);
  const hopHist = summarizePairs(type40Hist);
  let verdictA = rrUnitVerdict(matched);
  if (verdictA === 'OPEN' && hopLive.n >= RR_UNIT_MIN_PAIRS && hopHist.n >= RR_UNIT_MIN_PAIRS) {
    const liveIsMs = hopLive.median_hist_live_ratio != null
      && hopLive.median_hist_live_ratio >= H0_RATIO[0]
      && hopLive.median_hist_live_ratio <= H0_RATIO[1]
      && hopLive.mae_h0 != null && hopLive.mae_h1 != null
      && hopLive.mae_h0 * MAE_WIN_FACTOR <= hopLive.mae_h1;
    const sameEncoding = hopHist.median_hist_live_ratio != null
      && hopHist.median_hist_live_ratio >= 0.995
      && hopHist.median_hist_live_ratio <= 1.005
      && hopHist.mae_h0 != null && hopHist.mae_h0 <= 5;
    if (liveIsMs && sameEncoding) verdictA = 'CONFIRMED';
    const liveIsTicks = hopLive.median_hist_live_ratio != null
      && hopLive.median_hist_live_ratio >= H1_RATIO[0]
      && hopLive.median_hist_live_ratio <= H1_RATIO[1]
      && hopLive.mae_h1 * MAE_WIN_FACTOR <= hopLive.mae_h0;
    if (liveIsTicks && sameEncoding) verdictA = 'REFUTED';
  }
  const b43 = byte43Stats(v18);
  return {
    audit_version: AUDIT_VERSION,
    counts: {
      v18: v18.length,
      v18_with_rr: v18.filter((r) => r.rr_raw?.length).length,
      gatt: gatt.length,
      gatt_with_rr: gatt.filter((g) => g.rr_ms?.length).length,
      type40: type40.length,
      type40_with_rr: type40.filter((t) => t.rr_raw?.length).length,
    },
    rr: {
      gatt_vs_v18: matched,
      gatt_vs_type40: hopLive,
      type40_vs_v18: hopHist,
      hr_from_rr: hrFromRrErrors(v18),
      hrv: hrvDelta(v18),
      verdict: verdictA,
      notes: {
        gatt_2a37: gatt.length
          ? '2A37 notifies present'
          : 'no 2A37 Heart Rate Measurement notifies in this corpus (GATT rows are DIS/battery only)',
        type40_v18_unix: hopHist.n
          ? 'type-40 and v18 shared strap-unix seconds'
          : 'type-40 and v18 unix sets were disjoint on this corpus; live vs banked clocks do not share seconds',
      },
    },
    byte43: b43,
    respiration_verdict: respirationVerdict(b43),
    dynamic_acceleration_verdict: dynAccelVerdict(b43),
    production_changes: [],
  };
}
