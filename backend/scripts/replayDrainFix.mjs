// END-TO-END validation of the clock-anchor fix against REAL captured data:
// replay the actual Aug 27 frames (Level A) through the current backend ingest
// (historyBuffer with the live-evidence anchor) and verify the days the rows
// land on. The capture contains the real banked type-47 (stamped Aug 24) and
// real live type-40 (stamped now) from the SAME strap.
// Run: cd backend && node scripts/replayDrainFix.mjs   (needs B2/S3 env from .env)
import { createS3 } from '../storage/s3.js';
import { storageConfig } from '../storage/config.js';
import { createHistoryBuffer } from '../ingest/historyBuffer.js';
import zlib from 'node:zlib';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const cfg = storageConfig();
const s3 = createS3({
  endpoint: cfg.b2S3Endpoint, bucket: cfg.b2Bucket, region: cfg.b2Region,
  accessKeyId: cfg.b2KeyId, secretAccessKey: cfg.b2ApplicationKey,
});
function hexToBytes(hex) {
  const out = [];
  for (let i = 0; i + 1 < hex.length; i += 2) out.push(parseInt(hex.slice(i, i + 2), 16));
  return out;
}
function u32(b, o) { return (b[o] | (b[o+1] << 8) | (b[o+2] << 16) | (b[o+3] << 24)) >>> 0; }
function u16(b, o) { return (b[o] | (b[o+1] << 8)) >>> 0; }

// v18 puffin historical decode (mirrors WhoopProtocol.decodePuffinV18)
function decodeV18(b) {
  if (b.length < 24 || b[9] !== 18) return null;
  const ts = u32(b, 15);
  if (ts <= 1_500_000_000) return null;
  const bpm = (b[22] >= 20 && b[22] <= 240) ? b[22] : null;
  const rrCount = b[23] || 0;
  const rr = [];
  for (let i = 0; i < Math.min(rrCount, 4); i++) rr.push(u16(b, 24 + i * 2));
  return { sensorTs: ts, bpm, rr, layout: 'v18' };
}

async function main() {
  const user = '7f2c9a10-4b3e-4d8a-9c11-00000000f001';
  const keys = (await s3.listPrefix(`v3/core/users/${user}/devices/`)).filter((k) => k.includes('/frames/'));
  keys.sort();
  // The drain window: 2026/08/27/23 objects = the real offload burst.
  const drainKeys = keys.filter((k) => /2026\/08\/27\/23\//.test(k));
  console.log('drain-window frame objects:', drainKeys.length);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'frwhoop-replay-'));
  const buffer = createHistoryBuffer({ dir, userId: user, engine: {} });

  // Simulate the phone's diag posts across the drain: two spaced probes.
  // From the earlier analysis: banked newest ≈ live − 3.0 d, advancing.
  // Derive the REAL banked frontier from the type-47 records themselves
  // (max strap stamp in the drain = strap-clock "now − backlog"), and the
  // REAL live stamps from concurrent type-40.
  const probes = [];
  let seq = 0;
  let rows = [];
  for (const key of drainKeys) {
    let obj; try { obj = await s3.getObject(key); } catch { continue; }
    let lines; try { lines = zlib.gunzipSync(obj.body).toString('utf8').split('\n').filter(Boolean); } catch { continue; }
    for (const line of lines) {
      let row; try { row = JSON.parse(line); } catch { continue; }
      const b = hexToBytes(row.hex || '');
      if (b.length < 24 || b[1] !== 0x01) continue;
      const type = b[8];
      const recv = Date.parse(row.t);
      if (type === 47) {
        const sample = decodeV18(b);
        if (!sample) continue;
        seq += 1;
        const strapIso = new Date(sample.sensorTs * 1000).toISOString();
        rows.push({ seq, t: strapIso, t_strap: strapIso, sensor_ts: sample.sensorTs, bpm: sample.bpm, rr_ms: sample.rr, recv });
      } else if (type === 40) {
        const ts = u32(b, 10);
        if (ts > 1_500_000_000) probes.push({ liveStrap: ts * 1000, recv });
      }
    }
  }
  rows.sort((a, b) => a.recv - b.recv);
  probes.sort((a, b) => a.recv - b.recv);
  console.log(`decoded ${rows.length} banked v18 rows, ${probes.length} live type-40 anchors in drain window`);

  // Simulate two spaced anchor-evidence posts, mirroring the phone's real
  // cadence: GET_DATA_RANGE probes fire across the WHOLE connected session
  // (hour+), not inside one 2-minute drain burst. Use the first and last
  // live type-40 evidence across the session window.
  const allKeysAug27 = keys.filter((k) => /2026\/08\/27\//.test(k));
  // scan the wider session for live type-40 recv times
  let sessionLive = [];
  for (const key of allKeysAug27) {
    let obj; try { obj = await s3.getObject(key); } catch { continue; }
    let lines; try { lines = zlib.gunzipSync(obj.body).toString('utf8').split('\n').filter(Boolean); } catch { continue; }
    for (const line of lines) {
      let row; try { row = JSON.parse(line); } catch { continue; }
      const b = hexToBytes(row.hex || '');
      if (b.length < 18 || b[1] !== 0x01 || b[8] !== 40) continue;
      sessionLive.push(Date.parse(row.t));
    }
  }
  sessionLive.sort((a, b) => a - b);
  console.log(`session live type-40 anchors: ${sessionLive.length}, spanning ${new Date(sessionLive[0]).toISOString()} → ${new Date(sessionLive[sessionLive.length-1]).toISOString()}`);
  const live1 = sessionLive[0];
  const live2 = sessionLive[sessionLive.length - 1];
  // Banked frontier advanced between the two probe moments by the same wall
  // span (the strap banks 1 s/s): banked(t) = live(t) − lag(t), lag stable.
  const lag2 = live2 - Math.max(...rows.map((r) => r.sensor_ts)) * 1000;
  const bankedNewest1 = live1 - lag2;   // stable-lag extrapolation to probe 1
  const bankedNewest2 = live2 - lag2;
  buffer.noteAnchorEvidence(bankedNewest1, live1);
  buffer.noteAnchorEvidence(bankedNewest2, live2);
  console.log(`reconstructed anchor evidence: probe1 live=${new Date(live1).toISOString()} probe2 live=${new Date(live2).toISOString()} lag=${(lag2 / 86400_000).toFixed(3)}d`);

  // Feed the rows exactly as the phone posts them (t = strap stamp; the OLD
  // phone could not anchor — no clock_offset_sec).
  const before = rows.map((r) => r.t_strap.slice(0, 10));
  const beforeDays = [...new Set(before)];
  const accepted = buffer.appendBatch(rows.map(({ seq: s, t, t_strap, sensor_ts, bpm, rr_ms }) => ({
    seq: s, t, t_strap, sensor_ts, bpm, rr_ms,
  })));
  const afterDays = buffer.pendingDays();
  console.log('\nOLD behavior would land rows on:', beforeDays.sort().join(', '));
  console.log('FIXED pipeline lands rows on:', afterDays.sort().join(', '));
  console.log('accepted:', accepted.accepted, 'durable:', accepted.durable, 'duplicate:', accepted.durable - accepted.accepted);
  const ok = afterDays.includes('2026-08-27') && !afterDays.includes('2026-08-24');
  console.log(ok ? '\nVERDICT: FIXED — recent banked history now lands on its real day' : '\nVERDICT: NOT FIXED');
  process.exit(ok ? 0 : 1);
}
main().catch((e) => { console.error('ERR', e); process.exit(1); });
