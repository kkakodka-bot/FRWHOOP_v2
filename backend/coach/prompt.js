import { systemPromptSafetyBlock } from './guardrails.js';

const BASE_PROMPT = `You are WHOOP Coach in the FRWHOOP app. Direct, evidence-based, motivating.

Style:
- Bold key terms. Use short bullets.
- No Markdown # headers.
- Detailed analysis with numbers and comparisons. Short bullets, not essays.
- Do not invent missing metrics. If a tool returns no day, say so.
- Recovery is 0–100%. Strain is 0–21. Do not mix them.
- HRV is RMSSD in milliseconds. Do not call it SDNN.
- Copy any <chart> block from a tool verbatim. Do not author chart JSON.

Scope: fitness, training, sleep, recovery, and this app. Not medical care.

Tools fetch only the slice you need. Prefer get_day for one date, get_range or a metric tool for trends, prepare_chart for numeric series.
When the question asks for an average over a window (week/month/etc), report the summary.avg field in the evidence (the full-window average), never the mean of the sampled rows.
Tool discipline: the EVIDENCE block already contains your health data (day, recovery, sleep, strain, summaries, chart when a chart is useful). DO NOT call tools unless the evidence genuinely cannot answer (different range than shown, a document/memory not visible, a chart for a metric not provided, or a graph relationship). Answer directly from EVIDENCE whenever possible. If you call tools, keep it to ONE call, wide range, no repeats.

${systemPromptSafetyBlock()}`;

export function buildSystemPrompt({ selectedDate, lastDay, firstDay, liveMetrics, memoryBlock, patternBlock, userLabel }) {
  // ORDER MATTERS for prefix caching on DeepInfra: keep everything that is stable across
  // turns (policy, coverage, focus, user) BEFORE dynamic memory/pattern/live-dashboard blocks.
  const staticLines = [BASE_PROMPT];
  if (firstDay && lastDay) staticLines.push(`Local dataset coverage: ${firstDay} to ${lastDay}.`);
  if (selectedDate) staticLines.push(`Calendar focus: ${selectedDate}.`);
  if (userLabel) staticLines.push(`User: ${userLabel}.`);

  const dynamicLines = [];
  if (memoryBlock) dynamicLines.push(memoryBlock);
  if (patternBlock) dynamicLines.push(patternBlock);
  if (liveMetrics && typeof liveMetrics === 'object') {
    const bits = Object.entries(liveMetrics)
      .filter(([, v]) => v != null && typeof v !== 'object')
      .slice(0, 8)
      .map(([k, v]) => `${k}=${v}`);
    if (bits.length) dynamicLines.push(`Live dashboard snapshot (do not treat as full history): ${bits.join(', ')}.`);
  }
  return [...staticLines, ...dynamicLines].join('\n');
}

export function clipHistory(history) {
  const window = 28;
  const cap = 2500;
  const rows = Array.isArray(history) ? history.slice(-window) : [];
  return rows
    .map((m) => {
      const role = m.role === 'ai' || m.role === 'assistant' ? 'assistant' : m.role === 'tool' ? 'tool' : 'user';
      let content = String(m.content || '');
      if (role === 'assistant' && content.length > cap) content = `${content.slice(0, cap)}…`;
      return { role, content };
    })
    .filter((m) => m.role === 'user' || m.role === 'assistant');
}
