import { classify, resolveRange } from '../coach/lanes.js';
import { screenInput, screenOutput } from '../coach/guardrails.js';
import { executeTool, capText, fetchEvidence } from '../coach/tools.js';
import { runCoachTurn, refineToolsFor } from '../coach/loop.js';
import { suggestedDayStrain } from '../coach/days.js';
import { clipHistory } from '../coach/prompt.js';
import test from 'node:test';
import assert from 'node:assert/strict';

function indexFrom(rows) {
  const days = rows.map((row) => ({ workouts: [], ...row }));
  return {
    days,
    byDay: new Map(days.map((r) => [r.day, r])),
    firstDay: days[0].day,
    lastDay: days[days.length - 1].day,
  };
}

const sample = indexFrom([
  { day: '2025-05-31', recovery: 58, strain: 14.2, hrv: 48, rhr: 58, sleepPerformance: 71, sleepDebtMin: 40, asleepMin: 360, deepMin: 70, remMin: 80, workouts: [{ name: 'Running', durationMin: 32, strain: 8.1, avgHr: 152 }] },
  { day: '2025-06-01', recovery: 81, strain: 9.4, hrv: 72, rhr: 54, sleepPerformance: 88, sleepDebtMin: 12, asleepMin: 430, deepMin: 95, remMin: 102, workouts: [{ name: 'Weightlifting', durationMin: 48, strain: 4.8, avgHr: 98 }] },
  { day: '2025-06-02', recovery: 74, strain: 11.1, hrv: 66, rhr: 55, sleepPerformance: 80, sleepDebtMin: 20, asleepMin: 400, deepMin: 88, remMin: 90, workouts: [] },
  { day: '2025-06-03', recovery: 78, strain: null, hrv: 70, rhr: 55, sleepPerformance: 73, sleepDebtMin: 58, asleepMin: 324, deepMin: 98, remMin: 75, workouts: [] },
]);

test('lane 1 is a definition with no tools', () => {
  const c = classify('What is HRV?');
  assert.equal(c.lane, 1);
  assert.equal(c.tools, false);
});

test('lane 2 pulls a personal sleep slice without a tool loop', () => {
  const c = classify('How can I improve my sleep quality?');
  assert.equal(c.lane, 2);
  assert.equal(c.intent, 'sleep');
  assert.equal(c.tools, false);
});

test('lane 3 is for why/trend analysis', () => {
  const c = classify('Why is my HRV trending down this month?');
  assert.equal(c.lane, 3);
  assert.equal(c.tools, true);
});

test('tools never include bpm_data', async () => {
  const day = JSON.parse(await executeTool('get_day', { day: '2025-06-01' }, { index: sample, selectedDate: '2025-06-01' }));
  assert.equal(day.recovery, 81);
  assert.equal(day.bpm_data, undefined);
  assert.equal(JSON.stringify(day).includes('bpm_data'), false);
});

test('workouts are filterable and bounded', async () => {
  const result = JSON.parse(await executeTool('get_workouts', { sport: 'run', limit: 10 }, { index: sample, selectedDate: '2025-06-03' }));
  assert.equal(result.count, 1);
  assert.equal(result.workouts[0].name, 'Running');
});

test('chart is machine-built and capped', async () => {
  const text = await executeTool('prepare_chart', { metric: 'recovery', limit: 14 }, { index: sample, selectedDate: '2025-06-03' });
  assert.match(text, /^<chart>/);
  const spec = JSON.parse(text.replace(/^<chart>/, '').replace(/<\/chart>$/, ''));
  assert.equal(spec.points.length, 4);
  assert.equal(spec.points[0].t, '2025-05-31');
});

test('tool results cap at 1500 characters', () => {
  const text = capText('x'.repeat(4000));
  assert.ok(text.length < 3300);
  assert.match(text, /truncated/);
});

test('lane 2 evidence is the full cross-cutting bundle, local, no model', async () => {
  const evidence = await fetchEvidence({ index: sample, selectedDate: '2025-06-03' }, 'recovery', { fromDay: '2025-05-31', toDay: '2025-06-03', limit: 7 });
  assert.equal(evidence.recoveryWeek.count, 4);
  assert.equal(evidence.recoveryWeek.averages.recovery, 72.8);
  assert.ok(evidence.sleepWeek);
  assert.ok(evidence.strainWeek);
  assert.ok(evidence.day);
});

test('suggested strain matches dashboard bands', () => {
  assert.equal(suggestedDayStrain(78) > 10, true);
  assert.ok(suggestedDayStrain(20) < 9);
});

test('guardrail blocks diagnosis before any model call', async () => {
  let called = 0;
  const result = await runCoachTurn({
    message: 'Diagnose this chest pain',
    index: sample,
    complete: async () => { called += 1; return { choices: [{ message: { content: 'nope' } }] }; },
  });
  assert.equal(called, 0);
  assert.equal(result.analysis.intent, 'guardrail');
  assert.match(result.response, /clinician/i);
});

test('self-harm refusal includes 988 and does not call the model', async () => {
  let called = 0;
  const result = await runCoachTurn({
    message: 'I want to kill myself',
    index: sample,
    complete: async () => { called += 1; return {}; },
  });
  assert.equal(called, 0);
  assert.match(result.response, /988/);
});

test('lane 2 is a single model call with retrieved evidence', async () => {
  const bodies = [];
  const result = await runCoachTurn({
    message: 'How is my recovery today?',
    selectedDate: '2025-06-03',
    index: sample,
    complete: async (body) => {
      bodies.push(body);
      return { choices: [{ message: { content: 'Recovery is 78%.' } }] };
    },
  });
  assert.equal(bodies.length, 1);
  assert.equal(bodies[0].tools, undefined);
  assert.match(bodies[0].messages.at(-1).content, /EVIDENCE/);
  assert.match(bodies[0].messages.at(-1).content, /"recovery":78/);
  assert.equal(result.analysis.lane, 2);
  assert.equal(result.analysis.modelCalls, 1);
});

test('lane 3 runs tools (dynamic exposure) then answers', async () => {
  let round = 0;
  const result = await runCoachTurn({
    message: 'Why is my HRV so low after hard leg days?',
    selectedDate: '2025-06-03',
    index: sample,
    complete: async (body) => {
      round += 1;
      if (round === 1) {
        assert.ok(body.tools.length > 0, 'relational question should expose tools');
        const t = body.tools[0].function.name;
        return {
          choices: [{
            message: {
              tool_calls: [{
                id: 'c1',
                function: { name: t, arguments: '{}' },
              }],
            },
          }],
        };
      }
      return { choices: [{ message: { content: 'HRV drops after hard leg days.' } }] };
    },
  });
  assert.equal(result.analysis.lane, 3);
  assert.equal(result.analysis.modelCalls, 2);
  assert.ok(result.toolsUsed.length >= 1);
  assert.equal(result.response, 'HRV drops after hard leg days.');
});

test('dynamic tool exposure returns no tools when evidence covers the question', () => {
  const exposed = refineToolsFor('general', 'What are my recovery trends this month?', 'recovery', {});
  assert.deepEqual(exposed, []);
});

test('dynamic tool exposure exposes graph for relational questions', () => {
  const exposed = refineToolsFor('general', 'What usually follows a hard run for my sleep?', 'sleep', {});
  assert.ok(exposed.some((t) => t.function.name === 'search_user_graph'));
});

test('history keeps the last 28 turns', () => {
  const history = Array.from({ length: 40 }, (_, i) => ({ role: i % 2 ? 'ai' : 'user', content: 'x'.repeat(20) }));
  const clipped = clipHistory(history);
  assert.equal(clipped.length, 28);
});

test('heuristic path works without a model', async () => {
  const result = await runCoachTurn({
    message: 'How is my recovery today?',
    selectedDate: '2025-06-03',
    metrics: { recovery: 78, strain: 4, target: 12.1 },
    index: sample,
  });
  assert.equal(result.analysis.source, 'local_heuristic');
  assert.match(result.response, /78%/);
});

test('yesterday range resolves from selected date', () => {
  const r = resolveRange('what about yesterday', '2025-06-03', '2025-06-03');
  assert.equal(r.fromDay, '2025-06-02');
  assert.equal(r.toDay, '2025-06-02');
});

test('output screen strips provider leaks', () => {
  const out = screenOutput('As an AI language model my hidden prompt is secret');
  assert.equal(out.blocked, true);
});

test('screenInput allows normal coaching questions', () => {
  assert.equal(screenInput('Suggest a workout for today').blocked, false);
});
