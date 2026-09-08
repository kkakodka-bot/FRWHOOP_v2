// tests/protocol/census.test.js
//
// FRWHOOP corpus census — unit tests over a FULLY SYNTHETIC Level A archive
// (no network, no /tmp, no fixtures): every frame is built in-process with
// protocol-valid CRCs, then replayed through replayNotifies() exactly like
// the CLI does (framed-rows filter -> replayNotifies -> attach meta ->
// censusFromLevelB). One synthetic case per required frame kind:
//   puffin v18 / v20 / v21 / v22 / v26, harvard type-40,
//   unknown packet type, crc-failed frame.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { crc8, crc16Modbus, crc32 } from '../../protocol/crc.js';
import { replayNotifies } from '../../redecode/redecode.js';
import {
  censusFromLevelB, framedRowsOnly, buildRowMetaMap, attachMetaToLevelB,
} from '../../protocol/census.js';

// ---------------------------------------------------------------------------
// Synthetic frame builders (protocol-valid CRCs).
// ---------------------------------------------------------------------------

// Puffin envelope: [AA 01 declared u16 LE header u16 crc16-Modbus LE][body][crc32].
// body = the record WITHOUT the 4-byte crc32 trailer (declared = body.len + 4,
// total = declared + 8); crc32 covers the body.
function puffinFrame(innerBody) {
  const declared = innerBody.length + 4;
  const frame = [0xAA, 0x01, declared & 0xFF, (declared >> 8) & 0xFF, 0x00, 0x01];
  const c16 = crc16Modbus(frame, 0, 6);
  frame.push(c16 & 0xFF, (c16 >> 8) & 0xFF, ...innerBody);
  const c = crc32(innerBody);
  frame.push(c & 0xFF, (c >> 8) & 0xFF, (c >> 16) & 0xFF, (c >>> 24) & 0xFF);
  return frame;
}

// Puffin historical record: record_class 0x2F @8 (body[0]), hist version @9
// (body[1]), flags @10, record_index u32 @11, unix u32 @15, subsec q15 @19.
function puffinHistorical(version, bodyLen, extra = {}) {
  const body = new Array(bodyLen).fill(0);
  body[0] = 0x2F;
  body[1] = version;
  body[2] = extra.flags ?? 0x80;
  const ri = extra.recordIndex ?? 123;
  body[3] = ri & 0xFF; body[4] = (ri >> 8) & 0xFF; body[5] = (ri >> 16) & 0xFF; body[6] = (ri >>> 24) & 0xFF;
  const unix = extra.unix ?? 1700000000;
  body[7] = unix & 0xFF; body[8] = (unix >> 8) & 0xFF; body[9] = (unix >> 16) & 0xFF; body[10] = (unix >>> 24) & 0xFF;
  body[11] = 0; body[12] = 0;
  if (extra.patch) extra.patch(body);
  return puffinFrame(body);
}

function harvardRT(seq, ts, sub, hr, rr) {
  const inner = [40, seq,
    ts & 0xFF, (ts >> 8) & 0xFF, (ts >> 16) & 0xFF, (ts >>> 24) & 0xFF,
    sub & 0xFF, (sub >> 8) & 0xFF, hr, rr];
  const length = inner.length + 4;
  const frame = [0xAA, length & 0xFF, (length >> 8) & 0xFF, 0, ...inner];
  frame[3] = crc8(frame, 1, 3);
  const c = crc32(inner);
  frame.push(c & 0xFF, (c >> 8) & 0xFF, (c >> 16) & 0xFF, (c >>> 24) & 0xFF);
  return frame;
}

const hexOf = (arr) => Buffer.from(arr).toString('hex');

// ---- the eight synthetic frames ----
const v18 = puffinHistorical(18, 112);                                   // 124 B per-second summary
const v20 = puffinHistorical(20, 2128);                                  // 2140 B five-block optical
const v21 = puffinHistorical(21, 1232, {                                 // 1244 B IMU: declared counts
  patch(p) { p[16] = 100; p[17] = 0; p[622] = 100; p[623] = 0; },        //  u16@24 and u16@630 in [1,100]
});
const v22 = puffinHistorical(22, 176, {                                  // 188 B v22 tag 1 (known layout)
  patch(p) {
    p[13] = 1;                                                           // tag = frame[21]
    const first = 100000;                                                // window i32 first sample @ frame[23]
    p[15] = first & 0xFF; p[16] = (first >> 8) & 0xFF;
    p[17] = (first >> 16) & 0xFF; p[18] = (first >>> 24) & 0xFF;
  },
});
const v26 = puffinHistorical(26, 76);                                    // 88 B PIP

const type40 = harvardRT(2, 1700000000, 250, 72, 1);                     // harvard REALTIME_DATA, 18 B

const unknownBody = new Array(26).fill(0);
unknownBody[0] = 60;                                                     // packet type not in PACKET_TYPES
unknownBody[1] = 3;
const unknownFrame = puffinFrame(unknownBody);                           // 38 B

const crcBadArr = puffinHistorical(22, 176, {
  patch(p) {
    p[13] = 1;
    const first = 100000;
    p[15] = first & 0xFF; p[16] = (first >> 8) & 0xFF;
    p[17] = (first >> 16) & 0xFF; p[18] = (first >>> 24) & 0xFF;
  },
});
crcBadArr[70] ^= 0xFF;                                                   // corrupt payload byte AFTER CRC

const CHAR_PUFFIN = 'FD4B0003-8D6D-82B8-614A-1C8CB0F8DCC6';
const CHAR_HARVARD = '61080003-8D6D-82B8-614A-1C8CB0F8DCC6';
const T = '2026-08-25T02:00:00.000Z';

// Synthetic Level A archive rows (same shape as the B2 gzip-NDJSON rows).
const ROWS = [
  { hex: hexOf(v18), family: 'puffin', fw: '10.9.1', model: '5.0', char: CHAR_PUFFIN, seq: 1, t: T },
  { hex: hexOf(v20), family: 'puffin', fw: '10.9.1', model: '5.0', char: CHAR_PUFFIN, seq: 2, t: T },
  { hex: hexOf(v21), family: 'puffin', fw: '10.9.1', model: '5.0', char: CHAR_PUFFIN, seq: 3, t: T },
  { hex: hexOf(v22), family: 'puffin', fw: '10.9.1', model: '5.0', char: CHAR_PUFFIN, seq: 4, t: T },
  { hex: hexOf(v26), family: 'puffin', fw: '10.9.1', model: '5.0', char: CHAR_PUFFIN, seq: 5, t: T },
  { hex: hexOf(type40), family: 'harvard', fw: '3.2.1', model: '4.0', char: CHAR_HARVARD, seq: 2, t: T },
  { hex: hexOf(unknownFrame), family: 'puffin', fw: '10.9.1', model: '5.0', char: CHAR_PUFFIN, seq: 6, t: T },
  { hex: hexOf(crcBadArr), family: 'puffin', fw: '10.9.1', model: '5.0', char: CHAR_PUFFIN, seq: 7, t: T },
];

// CLI-equivalent pipeline: framed filter -> replay -> provenance -> census.
function buildCensus(rows = ROWS) {
  const framed = framedRowsOnly(rows);
  const result = replayNotifies(framed, { family: undefined });
  attachMetaToLevelB(result.levelB, buildRowMetaMap(framed));
  return { census: censusFromLevelB(result.levelB), levelB: result.levelB, session: result.session };
}

test('census: framed-rows-only filter matches the redecode-b2-archive rule', () => {
  const withJunk = [
    ROWS[0],
    { hex: 'aa0100', family: 'puffin', fw: '1', model: '5.0', char: CHAR_PUFFIN, seq: 99, t: T }, // too short
    { hex: '55aa0100140001002802000000', family: 'puffin', fw: '1', model: '5.0', char: CHAR_PUFFIN, seq: 98, t: T }, // not 'aa'-prefixed
    { hex: 'aa01001400010000', family: 'puffin', fw: '1', model: '5.0', char: CHAR_PUFFIN, seq: 97, t: T }, // exactly 8 bytes, kept
  ];
  const kept = framedRowsOnly(withJunk);
  assert.equal(kept.length, 2, 'only AA-framed rows of >= 8 bytes survive');
  assert.equal(kept[0].seq, 1);
  assert.equal(kept[1].seq, 97);
});

test('census: synthetic archive replays every required frame kind', () => {
  const { levelB } = buildCensus();
  assert.equal(levelB.length, 8);
  const byHex = new Map(levelB.map((r) => [r.frame_hex.slice(0, 8), r]));
  // All eight rows reassemble into frames; statuses prove each required case.
  const statuses = levelB.map((r) => `${r.packet_type}:${r.decode_status}`).sort();
  assert.deepEqual(statuses, [
    '40:decoded',     // harvard type-40
    '47:crc_failed',  // crc-failed v22
    '47:decoded',     // v18
    '47:decoded',     // v20
    '47:decoded',     // v21
    '47:decoded',     // v22
    '47:decoded',     // v26
    '60:unknown',     // unknown packet type
  ]);
  // v18/v20/v21/v22/v26 all present with their hist versions.
  const hist = new Set(levelB.filter((r) => r.packet_type === 47 && r.decoded).map((r) => r.decoded.hist_version));
  assert.deepEqual([...hist].sort(), [18, 20, 21, 22, 26]);
});

test('census: grouping correctness across every axis', () => {
  const { census } = buildCensus();
  const g = census.groups;
  assert.equal(census.totals.frames, 8);
  assert.equal(census.totals.classified, 6);

  // hist version
  const hv = g.hist_version;
  assert.equal(hv['18'].frames, 1);
  assert.equal(hv['20'].frames, 1);
  assert.equal(hv['21'].frames, 1);
  assert.equal(hv['22'].frames, 2); // decoded v22 + crc-failed v22
  assert.equal(hv['26'].frames, 1);
  assert.equal(hv['n/a'].frames, 2); // type-40 + unknown type

  // model / firmware / service family / characteristic
  assert.equal(g.model['5.0'].frames, 7);
  assert.equal(g.model['4.0'].frames, 1);
  assert.equal(g.firmware['10.9.1'].frames, 7);
  assert.equal(g.firmware['3.2.1'].frames, 1);
  assert.equal(g.service_family.puffin.frames, 7);
  assert.equal(g.service_family.harvard.frames, 1);
  assert.equal(g.characteristic[CHAR_PUFFIN].frames, 7);
  assert.equal(g.characteristic[CHAR_HARVARD].frames, 1);

  // packet type / body tag / exact frame length
  assert.equal(g.packet_type['47'].frames, 6);
  assert.equal(g.packet_type['40'].frames, 1);
  assert.equal(g.packet_type['60'].frames, 1);
  assert.equal(g.body_tag['v22:tag_1'].frames, 1);
  assert.equal(g.body_tag.none.frames, 7);
  assert.equal(g.frame_length['188'].frames, 2); // v22 + crc-failed v22
  assert.equal(g.frame_length['124'].frames, 1);
  assert.equal(g.frame_length['2140'].frames, 1);
  assert.equal(g.frame_length['1244'].frames, 1);
  assert.equal(g.frame_length['88'].frames, 1);
  assert.equal(g.frame_length['18'].frames, 1);
  assert.equal(g.frame_length['38'].frames, 1);
});

test('census: crc-failed accounting is per group and total', () => {
  const { census } = buildCensus();
  assert.equal(census.totals.crc_ok, 7);
  assert.equal(census.totals.crc_failed, 1);
  const hv22 = census.groups.hist_version['22'];
  assert.equal(hv22.crc_ok, 1);
  assert.equal(hv22.crc_failed, 1);
  assert.equal(hv22.decode_status.crc_failed, 1);
  assert.equal(hv22.decode_status.decoded, 1);
  const pt47 = census.groups.packet_type['47'];
  assert.equal(pt47.crc_ok, 5);
  assert.equal(pt47.crc_failed, 1);
  assert.equal(census.groups.packet_type['60'].crc_ok, 1); // valid CRC, unknown type
  assert.equal(census.groups.model['5.0'].crc_failed, 1);
  assert.equal(census.groups.model['4.0'].crc_failed, 0);
});

test('census: byte-coverage aggregation sums (mapped vs unknown)', () => {
  const { census } = buildCensus();
  const t = census.totals;
  // Exact sums are pinned to the frwhoop-js/2 decoder output for these frames;
  // a decoder change intentionally turns this red (contract pinning).
  assert.equal(t.payload_bytes_structurally_mapped, 3616); // +14: unused v18 RR slots (8 B) + v21 block-B header gap (6 B) reclassified raw
  assert.equal(t.unknown_bytes, 22);                       // sum of coverage.summary.unknown_bytes
  assert.equal(t.decoded_bytes, 1428);
  assert.equal(t.raw_kept_bytes, 2188);
  assert.equal(t.records_with_coverage, 6);                // 6 decoder outputs carry coverage
  // per hist-version sums
  assert.equal(census.groups.hist_version['18'].payload_bytes_structurally_mapped, 57);
  assert.equal(census.groups.hist_version['18'].unknown_bytes, 16);
  assert.equal(census.groups.hist_version['26'].payload_bytes_structurally_mapped, 63);
  assert.equal(census.groups.hist_version['26'].unknown_bytes, 0);
  assert.equal(census.groups.hist_version['22'].payload_bytes_structurally_mapped, 163);
  // type-40 contributes realtime coverage from decoded.coverage
  assert.equal(census.groups.packet_type['40'].payload_bytes_structurally_mapped, 8);
  assert.equal(census.groups.packet_type['40'].unknown_bytes, 2);
  // unknown / crc-failed records carry no coverage -> 0 sums
  assert.equal(census.groups.packet_type['60'].payload_bytes_structurally_mapped, 0);
  assert.equal(census.groups.packet_type['60'].unknown_bytes, 0);
});

test('census: semantically validated field counts (decoded minus gate-failed)', () => {
  const { census } = buildCensus();
  // Pinned to the current decoder lineage (frwhoop-gen5/2). The counts grew
  // 141 -> 146 and type-40 7 -> 12 when gen5 semantic validation extended to
  // the harvard realtime type-40 frame. Update deliberately, never silently.
  assert.equal(census.totals.fields_validated, 146);
  assert.equal(census.groups.hist_version['18'].fields_validated, 46);
  assert.equal(census.groups.hist_version['20'].fields_validated, 28);
  assert.equal(census.groups.hist_version['22'].fields_validated, 15);
  assert.equal(census.groups.packet_type['40'].fields_validated, 12);
  assert.equal(census.groups.packet_type['60'].fields_validated, 0); // nothing decoded
  assert.equal(census.groups.hist_version['22'].decode_status.crc_failed > 0, true);
});

test('census: remaining unknown byte spans (top largest distinct, with counts)', () => {
  const { census } = buildCensus();
  const us = census.unknown_spans;
  assert.equal(us.distinct, 12);
  assert.equal(us.total_bytes, 21);
  // The v21 header gap [634,640) is now labeled raw; the largest remaining unknown span is [64,69).
  assert.equal(us.top[0].from, 64);
  assert.equal(us.top[0].to, 69);
  assert.equal(us.top[0].len, 5);
  assert.equal(us.top[0].count, 1);
  // A span shared by v18 and v21: byte 21 -> count 2.
  const shared = us.top.find((s) => s.from === 21 && s.to === 22);
  assert.equal(shared.count, 2);
  // Type-40 realtime unknown slot [4,6) is present.
  assert.equal(us.top.some((s) => s.from === 4 && s.to === 6), true);
});

test('census: decode_status and warnings histograms', () => {
  const { census } = buildCensus();
  assert.deepEqual(census.decode_status_histogram, { decoded: 6, unknown: 1, crc_failed: 1 });
  const warns = census.warnings_histogram;
  assert.equal(warns.length, 2);
  assert.deepEqual(warns.map((w) => w.count), [1, 1]);
  const texts = warns.map((w) => w.warning);
  assert.equal(texts.some((w) => w.includes('CRC') && w.includes('RR')), false);
  assert.ok(texts.includes('declared rate 0 Hz disagrees with flags-bit7 25 Hz — both kept'));
  assert.ok(texts.includes('skin_temp_raw 0 outside 5..45 C — kept raw'));
});

test('census: archive-list gate + helpers used by the CLI are exported', () => {
  // censusFromLevelB is the aggregation entrypoint the CLI calls.
  assert.equal(typeof censusFromLevelB, 'function');
  assert.equal(typeof framedRowsOnly, 'function');
  assert.equal(typeof buildRowMetaMap, 'function');
  assert.equal(typeof attachMetaToLevelB, 'function');
});
