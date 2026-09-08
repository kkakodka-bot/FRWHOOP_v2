#!/usr/bin/env node
/**
 * Diagnostic tap: the frames/history WALs are flushed to B2 within seconds, so
 * a census has to read them as they grow. Tracks byte offsets per file and
 * reports which type-47 historical layouts the strap actually sends, plus what
 * corrected timestamps the history rows claim.
 *
 * Usage: node tools/history-census.mjs [seconds]
 */
import fs from 'node:fs';
import path from 'node:path';

const LIVE = path.join(import.meta.dirname, '..', 'data', 'live');
const runFor = (Number(process.argv[2]) || 300) * 1000;
const started = Date.now();

const offsets = new Map();
const packetTypes = new Map();
const histLayouts = new Map();
const historyDays = new Map();
const historyBpm = { withBpm: 0, nullBpm: 0 };
const historyLayoutField = new Map();
let frameCount = 0;
let historyRows = 0;
let strapRange = { min: null, max: null };

function bump(map, key) {
  map.set(key, (map.get(key) || 0) + 1);
}

function readNew(file) {
  let size;
  try { size = fs.statSync(file).size; } catch { return []; }
  // A flush truncates the WAL; restart from 0 rather than reading garbage.
  const prev = offsets.get(file) ?? 0;
  const from = size < prev ? 0 : prev;
  offsets.set(file, from);
  if (size <= from) return [];
  const fd = fs.openSync(file, 'r');
  const buf = Buffer.alloc(size - from);
  fs.readSync(fd, buf, 0, buf.length, from);
  fs.closeSync(fd);
  offsets.set(file, size);
  return buf.toString('utf8').split('\n').filter(Boolean);
}

function scanFrames(file) {
  for (const line of readNew(file)) {
    let row;
    try { row = JSON.parse(line); } catch { continue; }
    if (!row?.hex) continue;
    frameCount += 1;
    const bytes = Buffer.from(row.hex, 'hex');
    // Packet type offset differs by family (iOS WhoopProtocol: puffin 8, harvard 4).
    const typeOff = row.family === 'puffin' ? 8 : 4;
    if (bytes.length <= typeOff) continue;
    const type = bytes[typeOff];
    bump(packetTypes, type);
    if (type !== 47) continue;
    // Historical layout version rides in the byte after the type.
    const versionOff = row.family === 'puffin' ? 9 : 5;
    if (bytes.length > versionOff) {
      bump(histLayouts, `v${bytes[versionOff]}(len=${bytes.length})`);
    }
  }
}

function scanHistory(file) {
  for (const line of readNew(file)) {
    let row;
    try { row = JSON.parse(line); } catch { continue; }
    if (!row?.t) continue;
    historyRows += 1;
    bump(historyDays, String(row.t).slice(0, 13));
    bump(historyLayoutField, row.layout || '(none)');
    if (row.bpm == null) historyBpm.nullBpm += 1; else historyBpm.withBpm += 1;
    const strap = Date.parse(row.t_strap || row.t);
    if (Number.isFinite(strap)) {
      if (!strapRange.min || strap < strapRange.min) strapRange.min = strap;
      if (!strapRange.max || strap > strapRange.max) strapRange.max = strap;
    }
  }
}

function report() {
  const iso = (ms) => (ms ? new Date(ms).toISOString() : null);
  console.log('\n=== history census after', Math.round((Date.now() - started) / 1000), 's');
  console.log('frames seen:', frameCount);
  console.log('packet types:', JSON.stringify(Object.fromEntries(packetTypes)));
  console.log('type-47 layouts:', JSON.stringify(Object.fromEntries(histLayouts)));
  console.log('history rows:', historyRows, 'bpm present:', historyBpm.withBpm, 'bpm null:', historyBpm.nullBpm);
  console.log('history layout field:', JSON.stringify(Object.fromEntries(historyLayoutField)));
  console.log('history strap range:', iso(strapRange.min), '->', iso(strapRange.max));
  const hours = [...historyDays.entries()].sort();
  console.log('history rows by corrected UTC hour:', JSON.stringify(Object.fromEntries(hours)));
}

const users = fs.readdirSync(LIVE).filter((d) => fs.statSync(path.join(LIVE, d)).isDirectory());
console.log('watching', users.length, 'user dirs for', runFor / 1000, 's');

const tick = setInterval(() => {
  for (const user of users) {
    scanFrames(path.join(LIVE, user, 'frames-wal.ndjson'));
    scanHistory(path.join(LIVE, user, 'history-pending-wal.ndjson'));
  }
  if (Date.now() - started >= runFor) {
    clearInterval(tick);
    report();
    process.exit(0);
  }
}, 300);

setInterval(report, 60_000).unref();
