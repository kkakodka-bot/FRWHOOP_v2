const AGENTIC = /\b(why is my|help me figure|what.?s going on with my|plan my (?:week|training)|overreaching|am i overtraining)\b/i;
const PERSONAL = /\b(my|i|i'm|im|me|today|yesterday|this week|last night|last week)\b/i;
// Questions about what the chatbot remembers / knows about the user (memory, corrections,
// preferences, goals, injuries, schedule, personalization). Must reach the memory-aware path.
const MEMORY_ASPECT = /\b(told you|tell you|about my (?:knee|goal|schedule|pref|time|shoulder|back)|do i (?:prefer|like)|am i training for|what (?:time|day)|when do i|usually train|normally train|like to train|i prefer|prefer (?:to )?train|training for|my goal|goal is|switched|changed my|used to|hate (?:morn|even)|dislike (?:morn|even)|remember)\b/i;
const RECOVERY = /\b(recover\w*|hrv|rhr|resting heart\w*|readiness)\b/i;
const SLEEP = /\b(sleep\w*|bedtime|rem|deep sleep\w*|sleep debt\w*|insomnia|nap\w*)\b/i;
const STRAIN = /\b(strain\w*|workout\w*|training\w*|lifting\w*|lift\w+|run\w*(?:ning|s|ned)?|zone 2|zone2|effort\w*|cardio\w*|leg day\w*|sessions?|squat\w*|deadlift\w*|bench\w*)\b/i;
const TREND = /\b(trend\w*|over time|this month|last (?:week|month|few|two|three|four|30)|last \d+|compare\w* (?:with|to)?|pattern\w*|average\w*|chang\w*(?:d|ing|es)?|worse or better|vs (?:last|the)|over the (?:last|past))\b/i;
const DEFINE = /\b(what is|what's|what does|mean\w*|explain\w*|how does|define\w*|meaning of)\b/i;

// Architecture E/F: lane 3 receives COMPLETE deterministic evidence pre-fetched by the
// loop, so it only needs a small REFINEMENT surface (charts, deeper single-metric history,
// user context, graph, document full-text). Storage/metric tools are never the model's job.
export const BUNDLES = {
  none: [],
  refine: ['prepare_chart', 'get_metric_history', 'get_user_context', 'search_user_graph', 'get_document'],
  recovery: ['prepare_chart', 'get_metric_history', 'get_user_context', 'search_user_graph', 'get_document'],
  sleep: ['prepare_chart', 'get_metric_history', 'get_user_context', 'search_user_graph', 'get_document'],
  strain: ['prepare_chart', 'get_metric_history', 'get_user_context', 'search_user_graph', 'get_document'],
  general: ['prepare_chart', 'get_metric_history', 'get_user_context', 'search_user_graph', 'get_document'],
};

export const TOKEN_BUDGETS = {
  define: 250,
  evidence: 450,
  coaching: 600,
  analysis: 900,
  deep: 1200,
};

export function classify(message) {
  const text = String(message || '');
  const personal = PERSONAL.test(text);
  const recovery = RECOVERY.test(text);
  const sleep = SLEEP.test(text);
  const strain = STRAIN.test(text);
  const trend = TREND.test(text);
  const define = DEFINE.test(text);
  const agentic = AGENTIC.test(text);

  let intent = 'general';
  if (sleep && recovery && !strain) intent = 'general';
  else if (sleep && !strain) intent = 'sleep';
  else if (recovery && !sleep && !strain) intent = 'recovery';
  else if (strain && !sleep) intent = 'strain';
  else if (sleep) intent = 'sleep';
  else if (recovery) intent = 'recovery';
  else if (strain) intent = 'strain';

  const memoryAspect = MEMORY_ASPECT.test(text);

  // Memory/correction questions are personal and memory-aware; route to evidence path
  // with full general context (the user, not a single metric domain, is the subject).
  if (memoryAspect && !define) {
    return {
      lane: 2,
      name: 'evidence',
      intent: 'general',
      bundle: 'general',
      maxTokens: TOKEN_BUDGETS.evidence,
      tools: false,
    };
  }

  if (!personal && define && !agentic) {
    return {
      lane: 1,
      name: 'direct',
      intent: 'define',
      bundle: 'none',
      maxTokens: TOKEN_BUDGETS.define,
      tools: false,
    };
  }

  if (agentic || (personal && trend && (recovery || sleep || strain)) || (personal && trend && /chang\w*|worse|compared|this month|last week|last month/i.test(text))) {
    return {
      lane: 3,
      name: 'agentic',
      intent,
      bundle: intent === 'general' ? 'general' : intent,
      maxTokens: TOKEN_BUDGETS.analysis,
      tools: true,
    };
  }

  if (personal || recovery || sleep || strain || trend) {
    return {
      lane: 2,
      name: 'evidence',
      intent,
      bundle: intent === 'general' ? 'general' : intent,
      maxTokens: TOKEN_BUDGETS.evidence,
      tools: false,
    };
  }

  return {
    lane: 1,
    name: 'direct',
    intent: 'define',
    bundle: 'none',
    maxTokens: TOKEN_BUDGETS.define,
    tools: false,
  };
}

export function resolveRange(text, selectedDate, lastDay) {
  const anchor = selectedDate || lastDay;
  // Explicit calendar dates ("on 2025-03-05", "2025-03-05") anchor retrieval to that day.
  const explicit = /(20\d{2}-\d{2}-\d{2})/.exec(String(text || ''));
  if (explicit && explicit[1]) {
    return { fromDay: explicit[1], toDay: explicit[1], limit: 1 };
  }
  const lower = String(text || '').toLowerCase();
  if (/\byesterday\b/.test(lower) && anchor) {
    const d = new Date(`${anchor}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() - 1);
    const day = d.toISOString().slice(0, 10);
    return { fromDay: day, toDay: day, limit: 1 };
  }
  if (/\btoday\b/.test(lower) && anchor) return { fromDay: anchor, toDay: anchor, limit: 1 };
  if (/\blast night\b/.test(lower) && anchor) return { fromDay: anchor, toDay: anchor, limit: 1 };
  if (/\b(three months|3 months|quarter|90 days|last quarter)\b/.test(lower)) return { fromDay: shift(anchor, -89), toDay: anchor, limit: 90 };
  if (/\b(two months|2 months|60 days)\b/.test(lower)) return { fromDay: shift(anchor, -59), toDay: anchor, limit: 60 };
  if (/\b(this month|last month|30 days|30)\b/.test(lower)) return { fromDay: shift(anchor, -29), toDay: anchor, limit: 31 };
  if (/\b(last week|this week|7 days)\b/.test(lower)) return { fromDay: shift(anchor, -6), toDay: anchor, limit: 7 };
  if (/\b(two weeks|14)\b/.test(lower)) return { fromDay: shift(anchor, -13), toDay: anchor, limit: 14 };
  return { fromDay: shift(anchor, -13), toDay: anchor, limit: 14 };
}

function shift(isoDay, delta) {
  if (!isoDay) return null;
  const d = new Date(`${isoDay}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}
