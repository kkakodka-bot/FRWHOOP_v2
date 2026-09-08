import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeLabradorEcgPayload } from '../../protocol/gen5.js';
import { decodeFrame } from '../../protocol/decoder.js';
import { harvardRT } from '../fixtures/whoopFrames.mjs';

test('Labrador ECG helper stays experimental raw and is not a product metric', () => {
  const n = 4;
  const payload = new Uint8Array(17 + n * 2);
  payload[15] = n;
  payload[16] = 0;
  payload[17] = 0x10;
  payload[18] = 0x00;
  const decoded = decodeLabradorEcgPayload(payload);
  assert.equal(decoded.experimental, true);
  assert.equal(decoded.product_metric, false);
  assert.equal(decoded.voltage_scale, null);
  assert.equal(decoded.carrier_unproven, true);
  assert.ok(Array.isArray(decoded.filtered_ecg_data_raw));
  const live = decodeFrame(harvardRT(1, 1700000000, 0, 72, 0), 'harvard');
  assert.equal(live.decoded?.filtered_ecg_data_raw, undefined);
  assert.equal(live.packet_type, 40);
});
