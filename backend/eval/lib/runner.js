
// eval/lib/runner.js — execute a frozen suite against a live (or stubbed) coach.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

export function loadCohortIndex() {
  const raw = JSON.parse(
    fs.readFileSync(path.join(here, '../../data/coach-days.json'), 'utf8')
  );
  const days = Array.isArray(raw) ? raw : raw.days;
  const sorted = [...days].sort((a, b) => a.day.localeCompare(b.day));
  return {
    days: sorted,
    byDay: new Map(sorted.map((r) => [r.day, r])),
    firstDay: sorted[0]?.day,
    lastDay: sorted[sorted.length - 1]?.day,
  };
}

// Wraps the model call to capture per-call telemetry without touching prod loop.
export function telemetryComplete(complete, sink) {
  return async (body) => {
    const t0 = Date.now();
    const before = sink.tokens.prompt + sink.tokens.completion;
    const res = await complete(body);
    const ms = Date.now() - t0;
    sink.calls += 1;
    sink.latency.push(ms);
    sink.callsLatencyMs.push(ms);
    if (res?.usage) {
      sink.tokens.prompt += res.usage.prompt_tokens || 0;
      sink.tokens.completion += res.usage.completion_tokens || 0;
      if (res.usage.cached_tokens) sink.tokens.cached += res.usage.cached_tokens || 0;
      if (res.usage.estimated_cost) sink.cost += Number(res.usage.estimated_cost) || 0;
    }
    return res;
  };
}

export function makeSink() {
  return { calls: 0, tokens: { prompt: 0, completion: 0, cached: 0 }, cost: 0, latency: [], callsLatencyMs: [], toolCalls: 0 };
}

export const SESSION_META = {
  suite: 'coaching',
  model: 'deepseek-ai/DeepSeek-V4-Flash-0731',
  runner: 'eval/runner.mjs',
  frozen: true,
};
