import { classify, resolveRange, TOKEN_BUDGETS } from './lanes.js';
import { screenInput, screenOutput } from './guardrails.js';
import { buildTurnMessages, estimateTokens } from '../context/compactor.js';
import { patternBlock, PATTERN_HINTS } from './pattern.js';
import { loadDayIndex } from './days.js';
import { buildSystemPrompt, clipHistory } from './prompt.js';
import { executeTools, fetchEvidence, toolsForBundle, chartHint } from './tools.js';
import { createCloudReader } from './cloud.js';
import { heuristicCoachReply } from './heuristic.js';
import { renderMemory, promoteTurn } from '../memory/manager.js';

const MAX_TOOL_ROUNDS = 2;

export async function runCoachTurn({
  message,
  history = [],
  metrics,
  selectedDate,
  accessToken,
  complete,
  index,
  cloud,
  memory,
  documents,
  userId,
  now,
  session,
} = {}) {
  const started = Date.now();
  const perf = [];
  const mark = (k, t0) => perf.push({ k, ms: Date.now() - t0 });
  let tStage;
  const screened = screenInput(message);
  if (screened.blocked) {
    return {
      response: screened.refusal,
      analysis: { lane: 0, intent: 'guardrail', guardrail: screened.id, modelCalls: 0, tools: [] },
      toolsUsed: [],
      processingTime: Date.now() - started,
      messageId: `guard-${started}`,
    };
  }
  if (screened.emergency) {
    return {
      response: screened.refusal,
      analysis: { lane: 0, intent: 'emergency', guardrail: 'emergency', modelCalls: 0, tools: [] },
      toolsUsed: [],
      processingTime: Date.now() - started,
      messageId: `emergency-${started}`,
    };
  }

  const days = index || loadDayIndex();
  let focus = selectedDate && days.byDay.has(selectedDate) ? selectedDate : days.lastDay;
  tStage = Date.now(); const lane = classify(message); mark('routing', tStage);
  const explicit = /(20\d{2}-\d{2}-\d{2})/.exec(String(message || ''));
  if (explicit && explicit[1] && days.byDay.has(explicit[1])) focus = explicit[1];
  const range = resolveRange(message, focus, days.lastDay);
  const reader = cloud !== undefined ? cloud : createCloudReader({ accessToken });
  const ctx = { index: days, selectedDate: focus, liveMetrics: metrics, cloud: reader, memory, documents, userId };
  const memoryStart = Date.now();
  const memoryBlock = keepMemory(lane) ? renderMemory(memory, message, { limit: 6 }) : '';
  const pattern = PATTERN_HINTS.test(String(message)) ? patternBlock(days, 90) : '';
  mark('memory+pattern', memoryStart);
  const system = buildSystemPrompt({
    selectedDate: focus,
    lastDay: days.lastDay,
    firstDay: days.firstDay,
    liveMetrics: metrics,
    memoryBlock,
    patternBlock: pattern,
    userLabel: userId ? `${userId}${now ? ` (as of ${now})` : ''}` : undefined,
  });

  if (typeof complete !== 'function') {
    const evidence = lane.lane === 1 ? null : await fetchEvidence(ctx, lane.intent, range);
    const dayRow = evidence?.day && typeof evidence.day === 'object' ? evidence.day : evidence;
    return {
      response: heuristicCoachReply(message, metrics, { ...evidence, day: dayRow, averages: evidence?.averages }),
      analysis: {
        lane: lane.lane,
        intent: lane.intent,
        modelCalls: 0,
        source: 'local_heuristic',
        coverage: { from: days.firstDay, to: days.lastDay },
      },
      toolsUsed: [],
      processingTime: Date.now() - started,
      messageId: `local-${started}`,
    };
  }

  const prior = buildTurnMessages({ history, recent: 14, episodeTokenBudget: 900 }).messages;
  let toolsUsed = [];
  let modelCalls = 0;
  let evidenceDays = 0;

  const ask = async (messages, tools) => {
    modelCalls += 1;
    const body = {
      temperature: 0.6,
      max_tokens: TOKEN_BUDGETS.deep,
      messages,
    };
    if (tools?.length) {
      body.tools = tools;
      body.tool_choice = 'auto';
    }
    const t0 = Date.now();
    const res = await complete(body);
    perf.push({ k: `model_call_${modelCalls}`, ms: Date.now() - t0 });
    if (res && Number.isFinite(res._ttftMs)) perf.push({ k: `model_call_${modelCalls}_ttft`, ms: res._ttftMs });
    return res;
  };

  let content = '';
  let evidence = null;

  if (lane.lane === 1) {
    const res = await askUntilContent(ask, [
      { role: 'system', content: system },
      ...prior,
      { role: 'user', content: message },
    ]);
    content = res.content || completionFallback();
  } else if (lane.lane === 2) {
    const evT = Date.now(); evidence = await fetchEvidence(ctx, lane.intent, range, message); mark('evidence', evT);
    evidenceDays = evidence?.count || evidence?.days?.length || (evidence?.day ? 1 : 0);
    const hint = await chartHint(ctx, lane.intent, message, range);
    if (hint) evidence.chart = hint.chart;
    const res = await askUntilContent(ask, [
      { role: 'system', content: system },
      ...prior,
      {
        role: 'user',
        content: `${message}\n\nEVIDENCE (already retrieved, do not invent beyond this):\n${JSON.stringify(evidence)}\n${chartNote(hint)}`,
      },
    ]);
    content = res.content || completionFallback();
    toolsUsed = [{ name: `evidence_${lane.intent}`, label: labelForIntent(lane.intent) }];
    if (hint) toolsUsed.push({ name: `chart_${hint.metric}`, label: 'Chart (auto)' });
  } else {
    // Complete deterministic evidence is pre-fetched, exactly like lane 2, so the model
    // never has to decide which storage/metric tools to call. It only sees the small
    // refinement surface (deeper history / user context / graph / document / alt chart).
    const evT = Date.now(); evidence = await fetchEvidence(ctx, lane.intent, range, message); mark('evidence', evT);
    evidenceDays = evidence?.count || evidence?.days?.length || (evidence?.day ? 1 : 0);
    const hint = await chartHint(ctx, lane.intent, message, range);
    if (hint) evidence.chart = hint.chart;
    const exposed = refineToolsFor(lane.bundle, message, lane.intent, evidence, hint);
    const messages = [
      { role: 'system', content: system },
      ...prior,
      {
        role: 'user',
        content: `${message}\n\nEVIDENCE (already retrieved, grounded in this):\n${JSON.stringify(evidence)}\n${chartNote(hint)}\n\n${toolCallDirective(exposed)}`,
      },
    ];
    const dedup = new Map();
    for (let round = 0; round < MAX_TOOL_ROUNDS; round += 1) {
      const completion = await ask(messages, round === 0 && exposed.length ? exposed : undefined);
      const msg = completion?.choices?.[0]?.message || {};
      const calls = msg.tool_calls || [];
      if (!calls.length) {
        content = msg.content || '';
        break;
      }
      messages.push({
        role: 'assistant',
        content: msg.content || null,
        tool_calls: calls,
      });
      const executed = await executeTools(calls.map((c) => ({
        name: c.function?.name,
        arguments: c.function?.arguments,
        id: c.id,
      })), ctx, dedup);
      toolsUsed = toolsUsed.concat(executed.map(({ name, label, deduped }) => ({ name, label, deduped })));
      executed.forEach((result, i) => {
        messages.push({
          role: 'tool',
          tool_call_id: calls[i]?.id || `tool-${round}-${i}`,
          content: result.content,
        });
      });
      // No second round if every tool result was a cached duplicate (nothing new to learn).
      const anyFresh = executed.some((e) => !e.deduped);
      if (!anyFresh) {
        const res = await askUntilContent(ask, messages, undefined);
        content = res.content || completionFallback();
        break;
      }
    }
    if (!content) {
      const res = await askUntilContent(ask, messages, undefined);
      content = res.content || completionFallback();
    }
  }

  const out = screenOutput(content);
  const promoted = promoteTurn({ store: memory, message, response: out.text });
  return {
    response: out.text,
    analysis: {
      lane: lane.lane,
      intent: lane.intent,
      bundle: lane.bundle,
      modelCalls,
      tools: toolsUsed.map((t) => t.name),
      daysAnalyzed: evidenceDays,
      coverage: { from: days.firstDay, to: days.lastDay },
      focus,
      contextTokens: { system: estimateTokens(system), history: prior.reduce((a, m) => a + estimateTokens(m.content || ''), 0) },
      memoryWritten: promoted.length,
      memoryTimeline: memory ? { active: memory.active().length, superseded: memory.all().filter((r) => r.status === 'superseded').length } : null,
      perf,
    },
    toolsUsed: uniqueTools(toolsUsed),
    evidenceDocuments: lane.lane === 2 && evidence?.relevantDocuments ? evidence.relevantDocuments : undefined,
    processingTime: Date.now() - started,
    messageId: `coach-${started}`,
  };
}

function keepMemory(lane) {
  if (!lane) return true;
  // Definitions don't need durable memory; everything personal/evidence/agentic does.
  return lane.lane !== 1;
}

// DeepInfra occasionally returns a tool-only or empty-content turn. Retry so a transient
// empty response never surfaces to the user, then fall back to a graceful message.
async function askUntilContent(ask, messages, tools) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const completion = await ask(messages, attempt === 0 ? tools : undefined);
    const msg = completion?.choices?.[0]?.message || {};
    const content = String(msg.content || '').replace(/ thinking[\s\S]*?<\/think>/gi, '').trim();
    if (content) return { completion, content };
    if ((msg.tool_calls || []).length && attempt === 0) return { completion, content: '' };
  }
  return { completion: null, content: '' };
}

function completionFallback() {
  return 'I couldn\u2019t finish a clean answer just now \u2014 please ask again or narrow the question and I\u2019ll pull the exact data.';
}

function completionContent(completion) {
  const raw = completion?.choices?.[0]?.message?.content || '';
  return String(raw).replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
}

function labelForIntent(intent) {
  if (intent === 'sleep') return 'Sleep';
  if (intent === 'recovery') return 'Recovery';
  if (intent === 'strain') return 'Strain';
  return 'Trends';
}

function uniqueTools(list) {
  const seen = new Set();
  const out = [];
  for (const t of list) {
    const key = t.name;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(t);
  }
  return out;
}

function chartNote(hint) {
  if (!hint) return '';
  return `A chart of ${hint.metric} is already included in EVIDENCE.chart. Copy the <chart> block verbatim if it helps; do NOT call prepare_chart for ${hint.metric}.`;
}
// ---- Dynamic tool exposure (Architecture D) --------------------------------
// The full evidence pre-fetch already covers the intent's primary metrics over the
// requested window (with wide-window summaries and a chart). Expose a refinement tool
// only when the question actually needs more than the evidence provides.
const METRIC_SIGNALS = {
  hrv: ['hrv', 'heart rate variab'],
  rem: ['rem', ' dream'],
  deep: ['deep', ' slow wave'],
  sleepDebt: ['debt', 'sleep debt'],
  rhr: ['resting heart', 'rhr'],
  strain: ['strain'],
  recovery: ['recover', 'readiness'],
  sleepPerformance: ['sleep performance', 'sleep quality'],
  sleep: ['sleep', 'asleep', 'bedtime'],
  workouts: ['workout', 'training', 'lift', 'run', 'squat', 'bench', 'deadlift'],
};
const INTENT_METRICS = {
  recovery: ['hrv', 'rhr', 'recovery', 'readiness'],
  sleep: ['sleepPerformance', 'sleep', 'rem', 'deep', 'sleepDebt', 'bedtime'],
  strain: ['strain', 'workouts'],
  general: ['recovery', 'hrv', 'rhr', 'sleepPerformance', 'strain'],
};
const RELATIONAL_SIGNALS = /\b(relat\w*|connect|preced\w*|follow\w*|compar\w*|after i|after (?:my|a hard|hard|heavy|a leg|leg)|when i|how is .{0,20} (?:related|linked|affect)|cause\w*|trigger\w*|tend\w*|usually|typically|normally)\b/i;
const USER_SIGNALS = /\b(document\w*|note\w*|plan\w*|physio|file\w*|pdf|said|told you|ago|previously|before|prefer\w*|goal\w*|injur\w*|knee|shoulder|back|schedule|habit\w*)\b/i;

function mentionedMetrics(text) {
  const lower = String(text || '').toLowerCase();
  const out = new Set();
  for (const [metric, sigs] of Object.entries(METRIC_SIGNALS)) {
    if (sigs.some((s) => lower.includes(s))) out.add(metric);
  }
  return [...out];
}

const CHART_METRIC_MAP = {
  hrv: 'hrv', rhr: 'rhr', sleepDebt: 'sleepDebtMin', rem: 'remMin', deep: 'deepMin',
  sleep: 'sleepPerformance', strain: 'strain', recovery: 'recovery',
};

export function refineToolsFor(bundle, message, intent, evidence, hint) {
  const lower = String(message || '').toLowerCase();
  const add = [];
  const asked = mentionedMetrics(message);
  // metric not covered by the intent's evidence slice -> need history tool
  const covered = INTENT_METRICS[intent] || INTENT_METRICS.general;
  const uncovered = asked.filter((m) => !covered.includes(m));
  if (uncovered.length) add.push('get_metric_history');
  // documents/memory
  if (USER_SIGNALS.test(lower)) add.push('get_user_context');
  // graph/relationships
  if (RELATIONAL_SIGNALS.test(lower)) add.push('search_user_graph');
  // alternate chart ONLY when a pre-built chart exists but does NOT cover an explicitly
  // asked metric (the router pre-builds the chart the question actually asks about).
  const askedMapped = [...new Set(asked.map((m) => CHART_METRIC_MAP[m]).filter(Boolean))];
  if (hint && askedMapped.length && !askedMapped.includes(hint.metric)) add.push('prepare_chart');
  const names = [...new Set(add)];
  const all = toolsForBundle(bundle);
  return all.filter((t) => names.includes(t.function.name));
}

function toolCallDirective(exposed) {
  if (!exposed.length) return 'All the information you need is in EVIDENCE. Answer directly — do not invent data.';
  const names = exposed.map((t) => t.function.name).join(', ');
  return `EVIDENCE is complete for this question, but you may call these tools if genuinely needed (${names}). Answer directly otherwise.`;
}
