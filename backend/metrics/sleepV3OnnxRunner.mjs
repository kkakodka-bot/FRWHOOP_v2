#!/usr/bin/env node
/**
 * stdin JSON { compact: number[][], present?: number[][], input_name, output_name }
 * stdout JSON { ok, logits, probabilities, argmax }
 */
import { readFileSync } from 'node:fs';

function softmax(row) {
  const max = Math.max(...row);
  const exps = row.map((v) => Math.exp(v - max));
  const sum = exps.reduce((a, b) => a + b, 0);
  return exps.map((v) => v / sum);
}

try {
  const modelPath = process.argv[2];
  const raw = readFileSync(0, 'utf8');
  const payload = JSON.parse(raw);
  const ort = await import('onnxruntime-node');
  const session = await ort.InferenceSession.create(modelPath);
  const compact = payload.compact;
  if (!Array.isArray(compact) || !compact.length) {
    process.stdout.write(JSON.stringify({ ok: false, reason: 'onnx_empty_input' }));
    process.exit(0);
  }
  const T = compact.length;
  const F = compact[0].length;
  const flat = Float32Array.from(compact.flat());
  const inputName = payload.input_name || session.inputNames[0];
  const feeds = {};
  const inputMeta = session.inputNames;
  feeds[inputName] = new ort.Tensor('float32', flat, [T, F]);
  if (inputMeta.includes('present') && Array.isArray(payload.present)) {
    feeds.present = new ort.Tensor(
      'float32',
      Float32Array.from(payload.present.flat()),
      [T, payload.present[0].length],
    );
  }
  const out = await session.run(feeds);
  const outName = payload.output_name || session.outputNames[0];
  const tensor = out[outName];
  const data = Array.from(tensor.data);
  const classes = 4;
  const logits = [];
  for (let t = 0; t < T; t += 1) logits.push(data.slice(t * classes, (t + 1) * classes));
  const probabilities = logits.map(softmax);
  const argmax = logits.map((row) => row.indexOf(Math.max(...row)));
  process.stdout.write(JSON.stringify({ ok: true, logits, probabilities, argmax }));
} catch (error) {
  process.stderr.write(String(error?.stack || error?.message || error));
  process.exit(1);
}
