#!/usr/bin/env node
// RECODECODE PIPELINE CLI
//
// Replay a Level A WHOOP BLE notify archive (as written by the iOS app to
// ble-frames.ndjson and archived by the backend to the B2 `frames` stream,
// format `ndjson_gzip_frames_v1`) through the reassembler + versioned decoder
// to produce Level B frame records and structured decode output.
//
// Usage:
//   node bin/redecode.mjs <levelA.ndjson[.gz]> [options]
//
// Options:
//   --family     harvard|puffin|auto     generation (default auto-by-char)
//   --decoder    <version>                decoder version to apply
//   --startAt    <ISO>                    inclusive lower time bound
//   --endAt      <ISO>                    inclusive upper time bound
//   --packet-type <n[,n]>                 only these packet types
//   --version    <n[,n]>                  only these packet/record versions
//   --unknown-only                        only currently-undecodable packets
//   --out <path>                          write Level B frame records (NDJSON)
//   --derive [dir]                        also write derived records (imu_raw/ppg_raw/events/
//                                         console/cmd-battery NDJSON + census) — the
//                                         same code path as the live frame flush
//   --compare <oldDecoder>                diff current vs a null/older decoder
//   --summary                             print full integrity accounting (JSON)
//   --observed                            print unknown-protocol observation tally
//
// A returned record is never lost: unknown/CRC-failed/malformed frames are
// reported and retained (Level B), never discarded.
//
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { replayNotifies, compareDecodes } from '../redecode/redecode.js';
import { deriveRecords } from '../redecode/derive.js';
import { encodeImuArchive, IMU_ARCHIVE_STREAM } from '../protocol/imuArchive.js';
import { encodePpgArchive, PPG_ARCHIVE_STREAM } from '../protocol/ppgArchive.js';
import {
  encodeImuV21Archive, encodePpgV26Archive, encodeOpticalV20Archive,
  WHOOP5_IMU_V21_STREAM, WHOOP5_PPG_V26_STREAM, WHOOP5_OPTICAL_V20_STREAM,
} from '../protocol/deepSensorArchive.js';
import { encodeEventArchive, encodeConsoleArchive } from '../protocol/eventRecords.js';
import { DECODER_VERSION } from '../protocol/decoder.js';

function parseArgs(argv) {
  const args = { _: [], packetTypes: [], versions: [], family: 'auto', decoder: DECODER_VERSION };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--family') args.family = next();
    else if (a === '--decoder') args.decoder = next();
    else if (a === '--startAt') args.startAt = next();
    else if (a === '--endAt') args.endAt = next();
    else if (a === '--packet-type') args.packetTypes = next().split(',').map(Number);
    else if (a === '--version') args.versions = next().split(',').map(Number);
    else if (a === '--unknown-only') args.unknownOnly = true;
    else if (a === '--out') args.out = next();
    else if (a === '--derive') args.derive = next() || './frwhoop-derived';
    else if (a === '--compare') args.compare = next();
    else if (a === '--summary') args.summary = true;
    else if (a === '--observed') args.observed = true;
    else if (a.startsWith('--')) { console.error('unknown option: ' + a); process.exit(2); }
    else args._.push(a);
  }
  return args;
}

function readLevelAMaybeGzip(path) {
  const raw = readFileSync(path);
  let buf = raw;
  if (path.endsWith('.gz')) {
    try { buf = gunzipSync(raw); } catch { /* treat as plain */ }
  }
  const text = buf.toString('utf8').trim();
  if (!text) return [];
  if (text.startsWith('[')) {
    return JSON.parse(text);
  }
  return text.split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

function writeDerived(path, body) {
  if (body.length) writeFileSync(path, body);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args._.length) {
    console.error('usage: node bin/redecode.mjs <levelA.ndjson[.gz]> [options]');
    process.exit(1);
  }
  let notifies;
  try {
    notifies = readLevelAMaybeGzip(args._[0]);
  } catch (err) {
    console.error('could not read Level A archive: ' + err.message);
    process.exit(1);
  }
  const filters = {
    startAt: args.startAt,
    endAt: args.endAt,
    packetTypes: args.packetTypes.length ? args.packetTypes : undefined,
    versions: args.versions.length ? args.versions : undefined,
    unknownOnly: args.unknownOnly,
  };
  const result = replayNotifies(notifies, {
    family: args.family === 'auto' || args.family === 'harvard' ? (args.family === 'harvard' ? 'harvard' : undefined) : 'puffin',
    decoder: args.decoder,
    filters,
  });

  if (args.out) {
    const lines = result.levelB.map((r) => JSON.stringify(r)).join('\n');
    writeFileSync(args.out, lines + (lines ? '\n' : ''));
    console.error(`wrote ${result.levelB.length} Level B frame records -> ${args.out}`);
  }
  if (args.derive) {
    // Mission target 3: replay NEW interpretations against OLD Level A
    // captures. Derived records use the exact same code path as the live
    // frame flush (redecode/derive.js), so a regeneration can never disagree
    // with what the live pipeline produces.
    mkdirSync(args.derive, { recursive: true });
    const d = deriveRecords(notifies, {});
    writeDerived(`${args.derive}/${IMU_ARCHIVE_STREAM}.ndjson`, encodeImuArchive(d.imu).body);
    writeDerived(`${args.derive}/${PPG_ARCHIVE_STREAM}.ndjson`, encodePpgArchive(d.ppg).body);
    writeDerived(`${args.derive}/${WHOOP5_IMU_V21_STREAM}.ndjson`, encodeImuV21Archive(d.whoop5Imu).body);
    writeDerived(`${args.derive}/${WHOOP5_PPG_V26_STREAM}.ndjson`, encodePpgV26Archive(d.whoop5Ppg).body);
    writeDerived(`${args.derive}/${WHOOP5_OPTICAL_V20_STREAM}.ndjson`, encodeOpticalV20Archive(d.whoop5Optical).body);
    writeDerived(`${args.derive}/events.ndjson`, encodeEventArchive(d.events).body);
    writeDerived(`${args.derive}/console.ndjson`, encodeConsoleArchive(d.console).body);
    writeDerived(`${args.derive}/cmd-battery.ndjson`, encodeEventArchive(d.battery).body);
    const census = { ...d.session };
    writeFileSync(`${args.derive}/derived-census.json`, JSON.stringify(census, null, 2));
    console.error(
      `derived: imu=${d.imu.length} ppg=${d.ppg.length} whoop5_imu=${d.whoop5Imu.length} `
      + `whoop5_ppg=${d.whoop5Ppg.length} whoop5_optical=${d.whoop5Optical.length} `
      + `events=${d.events.length} puffin54=${d.session.puffin54_records} `
      + `console=${d.console.length} cmd_battery=${d.battery.length} -> ${args.derive}/`,
    );
  }
  if (args.compare) {
    const cmp = compareDecodes(notifies, { decoderA: args.compare, decoderB: args.decoder });
    console.error(`compare ${args.compare} -> ${args.decoder}: ${cmp.changedCount} frame interpretations changed`);
    if (args.summary) console.log(JSON.stringify(cmp, null, 2));
  }
  if (args.observed) {
    console.log('== unknown-protocol observations ==');
    for (const o of result.observed) console.log(JSON.stringify(o));
  }
  if (args.summary) {
    console.log(JSON.stringify({ ...result.session, levelB_records: result.levelB.length, unknown_observations: result.observed.length }, null, 2));
  }
  if (!args.summary && !args.observed && !args.out && !args.compare) {
    console.log(JSON.stringify({ ...result.session, levelB_records: result.levelB.length }, null, 2));
  }
}

main();
