import fs from 'node:fs';
import path from 'node:path';
import { mean, pearson } from './math.js';

export function mae(predicted, actual) {
  const pairs = zipFinite(predicted, actual);
  if (!pairs.length) return null;
  return mean(pairs.map(([p, a]) => Math.abs(p - a)));
}

export function rmse(predicted, actual) {
  const pairs = zipFinite(predicted, actual);
  if (!pairs.length) return null;
  return Math.sqrt(mean(pairs.map(([p, a]) => (p - a) ** 2)));
}

export function mape(predicted, actual) {
  const pairs = zipFinite(predicted, actual).filter(([, a]) => a !== 0);
  if (!pairs.length) return null;
  return 100 * mean(pairs.map(([p, a]) => Math.abs((p - a) / a)));
}

export function meanBias(predicted, actual) {
  const pairs = zipFinite(predicted, actual);
  if (!pairs.length) return null;
  return mean(pairs.map(([p, a]) => p - a));
}

export function rSquared(predicted, actual) {
  const pairs = zipFinite(predicted, actual);
  if (pairs.length < 3) return null;
  const ys = pairs.map(([, a]) => a);
  const yhat = pairs.map(([p]) => p);
  const ybar = mean(ys);
  const ssTot = ys.reduce((s, y) => s + (y - ybar) ** 2, 0);
  const ssRes = ys.reduce((s, y, i) => s + (y - yhat[i]) ** 2, 0);
  if (ssTot === 0) return null;
  return 1 - ssRes / ssTot;
}

export function blandAltman(predicted, actual) {
  const pairs = zipFinite(predicted, actual);
  if (pairs.length < 2) return null;
  const diffs = pairs.map(([p, a]) => p - a);
  const avgs = pairs.map(([p, a]) => (p + a) / 2);
  const bias = mean(diffs);
  const sd = Math.sqrt(diffs.reduce((s, d) => s + (d - bias) ** 2, 0) / (diffs.length - 1));
  return {
    bias,
    sd,
    loaLow: bias - 1.96 * sd,
    loaHigh: bias + 1.96 * sd,
    n: pairs.length,
    means: avgs,
    diffs,
  };
}

export function metricsFromPairs(predicted, actual) {
  return {
    n: zipFinite(predicted, actual).length,
    mae: mae(predicted, actual),
    rmse: rmse(predicted, actual),
    mape: mape(predicted, actual),
    bias: meanBias(predicted, actual),
    pearson: pearson(predicted, actual),
    r2: rSquared(predicted, actual),
    blandAltman: blandAltman(predicted, actual),
  };
}

export function stratify(rows, key) {
  const groups = new Map();
  for (const row of rows || []) {
    const k = String(row[key] ?? 'unknown');
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(row);
  }
  const out = {};
  for (const [k, list] of groups) {
    out[k] = metricsFromPairs(list.map((r) => r.predicted), list.map((r) => r.actual));
  }
  return out;
}

export function subjectLevelSplit(rows, { trainFraction = 0.7, seed = 1 } = {}) {
  const ids = [...new Set((rows || []).map((r) => r.subjectId))].sort();
  const shuffled = mulberryShuffle(ids, seed);
  const cut = Math.max(1, Math.round(shuffled.length * trainFraction));
  const trainIds = new Set(shuffled.slice(0, cut));
  return {
    train: rows.filter((r) => trainIds.has(r.subjectId)),
    test: rows.filter((r) => !trainIds.has(r.subjectId)),
    trainSubjects: shuffled.slice(0, cut),
    testSubjects: shuffled.slice(cut),
  };
}

export function evaluateVo2Estimates(rows = []) {
  const overall = metricsFromPairs(rows.map((r) => r.predicted), rows.map((r) => r.actual));
  return {
    overall,
    bySex: stratify(rows, 'sex'),
    byTier: stratify(rows, 'tier'),
    byGps: stratify(rows.map((r) => ({ ...r, gps: r.gps ? 'gps' : 'no_gps' })), 'gps'),
    whoopPublishedMae: { gps: 3.7, indoor: 3.3, note: 'aspirational benchmark, not a claim' },
  };
}

/**
 * Optional PhysioNet Málaga CPET parser. Skips when files are absent.
 * Expected (flexible) files: subject-info.csv + test_measure.csv.
 * Never trains a breath-level model as free-living VO2 Max.
 */
export function parsePhysioNetCpet(dir) {
  if (!dir || !fs.existsSync(dir)) return null;
  const subjectPath = findFile(dir, [/subject/i, /info/i]);
  const measurePath = findFile(dir, [/test/i, /measure|cpet|vo2/i]);
  if (!subjectPath) return null;
  const subjects = parseCsv(fs.readFileSync(subjectPath, 'utf8'));
  const measures = measurePath ? parseCsv(fs.readFileSync(measurePath, 'utf8')) : [];
  const byId = new Map();
  for (const row of subjects) {
    const id = row.ID || row.id || row.subject || row.Subject || row.participant;
    if (!id) continue;
    byId.set(String(id), {
      subjectId: String(id),
      sex: (row.Gender || row.sex || row.Sex || '').toLowerCase().startsWith('f') ? 'female' : 'male',
      age: num(row.Age || row.age),
      bmi: num(row.BMI || row.bmi),
      actual: num(row.VO2max || row.VO2Max || row.vo2max || row.VO2_max),
    });
  }
  for (const row of measures) {
    const id = String(row.ID || row.id || row.subject || '');
    if (!byId.has(id)) continue;
    const vo2 = num(row.VO2 || row.vo2 || row.VO2max);
    const existing = byId.get(id);
    if (existing.actual == null && vo2 != null) existing.actual = vo2;
  }
  const rows = [...byId.values()].filter((r) => r.actual != null);
  return rows.length ? rows : null;
}

function zipFinite(xs, ys) {
  const n = Math.min((xs || []).length, (ys || []).length);
  const pairs = [];
  for (let i = 0; i < n; i += 1) {
    if (Number.isFinite(xs[i]) && Number.isFinite(ys[i])) pairs.push([xs[i], ys[i]]);
  }
  return pairs;
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function parseCsv(text) {
  const lines = String(text || '').trim().split(/\r?\n/).filter(Boolean);
  if (lines.length < 2) return [];
  const headers = splitCsvLine(lines[0]);
  return lines.slice(1).map((line) => {
    const cols = splitCsvLine(line);
    const row = {};
    headers.forEach((h, i) => { row[h] = cols[i]; });
    return row;
  });
}

function splitCsvLine(line) {
  return line.split(',').map((s) => s.trim().replace(/^"|"$/g, ''));
}

function findFile(dir, patterns) {
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return null; }
  const hit = names.find((n) => patterns.every((p) => p.test(n)));
  return hit ? path.join(dir, hit) : null;
}

function mulberryShuffle(items, seed) {
  let s = seed >>> 0;
  const arr = items.slice();
  const rand = () => {
    s += 0x6D2B79F5;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  for (let i = arr.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rand() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}
