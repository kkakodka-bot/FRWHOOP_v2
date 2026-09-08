import { gunzipSync, zstdDecompressSync } from 'node:zlib';

/**
 * Reader for the packed payloads the device uploads straight to the bucket.
 *
 * This is the twin of Swift `NoopPush.PushBinaryCodec` (`Packages/NoopPush/Sources/NoopPush/
 * PushBinaryCodec.swift`) and its Kotlin counterpart. The container is deliberately trivial — magic,
 * version, kind, then length-prefixed records — because the archive has to stay readable by whatever
 * reads it in five years, without a schema registry or a protobuf toolchain.
 *
 * The writer is the only side that exists today for kinds 1-3; `rawImuSession` (4) is defined here
 * first and the client encoder must match. Anything that changes a field order or width here is a
 * format break and needs a new `formatVersion`, not an in-place edit: objects already in the bucket
 * are not re-encodable.
 */
export const NPB1_MAGIC = 'NPB1';
export const NPB1_FORMAT_VERSION = 1;

export const NPB1_KIND = Object.freeze({
  ppgWaveformSample: 1,
  v18AuxSample: 2,
  rawBatch: 3,
  rawImuSession: 4,
});

const KIND_BY_CODE = Object.freeze(Object.fromEntries(
  Object.entries(NPB1_KIND).map(([stream, code]) => [code, stream]),
));

/** WHOOP 5/MG raw-IMU record geometry. Scales stay read-time constants; stored bytes are raw LSBs. */
export const IMU_SAMPLES_PER_RECORD = 100;
export const IMU_AXES = 6;
export const IMU_ACCEL_SCALE = 1 / 4096;          // g per LSB
export const IMU_GYRO_SCALE = 2000 / 32768;       // deg/s per LSB

export class RawObjectFormatError extends Error {}

export function decompressObject(body, compression) {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(body);
  if (compression === 'gzip') return gunzipSync(buf);
  if (compression === 'zstd') return zstdDecompressSync(buf);
  if (compression === 'none' || compression == null) return buf;
  throw new RawObjectFormatError(`unsupported compression: ${compression}`);
}

/** Packed i16 little-endian blob -> plain numbers. Rejects an odd length rather than dropping a byte. */
export function unpackI16LE(blob) {
  const buf = Buffer.isBuffer(blob) ? blob : Buffer.from(blob);
  if (buf.length % 2 !== 0) throw new RawObjectFormatError('i16 blob has an odd byte length');
  const out = new Array(buf.length / 2);
  for (let i = 0; i < out.length; i += 1) out[i] = buf.readInt16LE(i * 2);
  return out;
}

export function packI16LE(samples) {
  const buf = Buffer.alloc(samples.length * 2);
  for (let i = 0; i < samples.length; i += 1) buf.writeInt16LE(samples[i], i * 2);
  return buf;
}

/**
 * Columnar IMU LSBs -> scaled samples. Columns arrive as [ax*N, ay*N, az*N, gx*N, gy*N, gz*N], the
 * order `Whoop5RawImu.rawColumns` writes them in; interleaving them here would silently transpose
 * the signal, so the stride is asserted rather than assumed.
 */
export function imuSamplesFromColumns(columns, sampleCount = IMU_SAMPLES_PER_RECORD) {
  if (columns.length !== sampleCount * IMU_AXES) {
    throw new RawObjectFormatError(
      `imu record has ${columns.length} values, expected ${sampleCount * IMU_AXES}`,
    );
  }
  const out = new Array(sampleCount);
  for (let i = 0; i < sampleCount; i += 1) {
    out[i] = {
      ax: columns[i] * IMU_ACCEL_SCALE,
      ay: columns[sampleCount + i] * IMU_ACCEL_SCALE,
      az: columns[2 * sampleCount + i] * IMU_ACCEL_SCALE,
      gx: columns[3 * sampleCount + i] * IMU_GYRO_SCALE,
      gy: columns[4 * sampleCount + i] * IMU_GYRO_SCALE,
      gz: columns[5 * sampleCount + i] * IMU_GYRO_SCALE,
    };
  }
  return out;
}

class Cursor {
  constructor(buf) { this.buf = buf; this.at = 0; }

  need(n) {
    if (this.at + n > this.buf.length) {
      throw new RawObjectFormatError(`truncated payload: wanted ${n} bytes at ${this.at}`);
    }
  }

  u8() { this.need(1); const v = this.buf.readUInt8(this.at); this.at += 1; return v; }
  i32() { this.need(4); const v = this.buf.readInt32LE(this.at); this.at += 4; return v; }
  u16() { this.need(2); const v = this.buf.readUInt16LE(this.at); this.at += 2; return v; }

  // Timestamps and SQLite rowids are i64 on the wire but always inside the safe-integer range in
  // practice. Converting at the edge keeps the rest of the reader in plain numbers; a value that
  // would actually lose precision is refused instead of silently rounded.
  i64() {
    this.need(8);
    const v = this.buf.readBigInt64LE(this.at);
    this.at += 8;
    if (v > BigInt(Number.MAX_SAFE_INTEGER) || v < BigInt(-Number.MAX_SAFE_INTEGER)) {
      throw new RawObjectFormatError('i64 field exceeds safe integer range');
    }
    return Number(v);
  }

  blob() {
    const len = this.i32();
    if (len < 0) throw new RawObjectFormatError('negative blob length');
    this.need(len);
    const out = this.buf.subarray(this.at, this.at + len);
    this.at += len;
    return out;
  }

  utf8() {
    const len = this.u16();
    this.need(len);
    const out = this.buf.subarray(this.at, this.at + len).toString('utf8');
    this.at += len;
    return out;
  }
}

/** Parses the NPB1 container. Trailing bytes are an error: a short read must not look like success. */
export function decodeNpb1(decoded) {
  const buf = Buffer.isBuffer(decoded) ? decoded : Buffer.from(decoded);
  if (buf.length < 6 || buf.subarray(0, 4).toString('utf8') !== NPB1_MAGIC) {
    throw new RawObjectFormatError('payload is not an NPB1 object');
  }
  const cur = new Cursor(buf);
  cur.at = 4;
  const formatVersion = cur.u8();
  if (formatVersion !== NPB1_FORMAT_VERSION) {
    throw new RawObjectFormatError(`unsupported NPB1 format version ${formatVersion}`);
  }
  const kindCode = cur.u8();
  const stream = KIND_BY_CODE[kindCode];
  if (!stream) throw new RawObjectFormatError(`unknown NPB1 kind ${kindCode}`);

  let records;
  if (stream === 'rawBatch') {
    records = [{
      batchId: cur.utf8(),
      capturedAt: cur.i64(),
      deviceClockRef: cur.i64(),
      wallClockRef: cur.i64(),
      startTs: cur.i64(),
      endTs: cur.i64(),
      frameCount: cur.i32(),
      byteSize: cur.i32(),
      framesBlob: cur.blob(),
    }];
  } else {
    const count = cur.i32();
    if (count < 0) throw new RawObjectFormatError('negative record count');
    records = new Array(count);
    for (let i = 0; i < count; i += 1) {
      const rowId = cur.i64();
      const ts = cur.i64();
      if (stream === 'ppgWaveformSample') {
        const hasBurst = cur.u8();
        const burstIndex = hasBurst ? cur.i32() : null;
        records[i] = { rowId, ts, burstIndex, samples: unpackI16LE(cur.blob()) };
      } else if (stream === 'rawImuSession') {
        const columns = unpackI16LE(cur.blob());
        records[i] = { rowId, ts, columns, samples: imuSamplesFromColumns(columns) };
      } else {
        records[i] = { rowId, ts, fields: cur.blob() };
      }
    }
  }

  if (cur.at !== buf.length) {
    throw new RawObjectFormatError(`${buf.length - cur.at} trailing bytes after ${records.length} records`);
  }
  return { formatVersion, kind: kindCode, stream, records };
}

/** Decompress + parse in one step, given a manifest row's `compression`. */
export function readRawObject({ body, compression }) {
  return decodeNpb1(decompressObject(body, compression));
}

/**
 * Fetches an archived object by manifest row and decodes it. Refuses anything not `ready`/`verified`
 * so a half-written or corrupt object cannot reach an analysis as if it were archive.
 */
export async function fetchRawObject({ objectStore, manifestRow }) {
  if (!manifestRow) throw new RawObjectFormatError('missing manifest row');
  if (manifestRow.status !== 'ready' && manifestRow.status !== 'verified') {
    throw new RawObjectFormatError(`object is ${manifestRow.status}, not readable`);
  }
  const obj = await objectStore.getObject(manifestRow.object_key);
  if (!obj?.body) throw new RawObjectFormatError('object body is absent');
  return readRawObject({ body: obj.body, compression: manifestRow.compression });
}
