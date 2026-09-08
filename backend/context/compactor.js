
// context/compactor.js — durable long-conversation context management.
// Recent turns stay verbatim; older turns become structured, checkpointed episodes with
// source references. Durable facts from older turns are captured so they survive the window.
import { extractDurableFacts } from '../memory/promote.js';

export function estimateTokens(text) {
  const s = String(text || '');
  return Math.ceil(s.length / 4);
}

const TRIVIAL = /\b(thanks|thank you|thx|ok|okay|got it|sounds good|lol|ha ha|nice|great|bye|goodnight)\b/i;

export function isTrivial(text) {
  const t = String(text || '').trim();
  if (!t || t.length < 3) return true;
  if (t.length > 60) return false;
  return TRIVIAL.test(t);
}

/** Deterministic, cheap episode summarization of a block of turns. */
export function summariseEpisode(turns, { cap = 700 } = {}) {
  const asks = [];
  const key = new Set();
  const decisions = [];
  for (const t of turns) {
    if (t.role !== 'user') continue;
    if (isTrivial(t.content || '')) continue;
    const txt = String(t.content || '').slice(0, 200);
    asks.push(txt);
    const facts = extractDurableFacts({ message: txt, response: '' });
    for (const f of facts) {
      if (f.type === 'goal') decisions.push(`${f.topic}: ${f.content}`);
      else key.add(f.topic || f.type);
    }
  }
  // Keep the head AND the tail of each episode so facts near the end of an old
  // block (worst case for compaction) still survive the window.
  const head = asks.slice(0, 5);
  const tail = asks.slice(-3);
  const keptAsks = [...new Set([...head, ...tail])].slice(0, cap > 600 ? 8 : 6);
  const topics = [...key].filter(Boolean).slice(0, 8).join(', ');
  const eps = {
    sourceTurns: [turns[0]?.id || turns[0]?.idx || 0, turns[turns.length - 1]?.id || turns[turns.length - 1]?.idx || 0],
    count: turns.length,
    asks: keptAsks,
    topics: topics || 'general chat',
    decisions: decisions.slice(0, 4),
  };
  return JSON.stringify(eps).slice(0, cap);
}

/**
 * Build the turn list for the model from history:
 *  - recent turns verbatim
 *  - older turns grouped into episodes (summarised, capped)
 *  - durable facts re-subjected through memory (caller passes memoryBlock separately)
 * Returns { messages, meta: { kept, episodes, dropped, estimateTokens } }
 */
export function buildTurnMessages({ history, recent = 14, episodeTokenBudget = 900, roleMap, nowTokenBudget = 2000 } = {}) {
  const rows = Array.isArray(history) ? history : [];
  const clean = rows.map((m, i) => {
    let role = String(m.role || '');
    if (role === 'ai' || role === 'assistant') role = 'assistant';
    else if (role === 'tool') role = 'tool';
    else role = 'user';
    return { ...m, role, idx: i, id: m.id != null ? m.id : i };
  });

  const recentTurnList = recent > 0 ? clean.slice(-recent) : [];
  const older = recent > 0 ? clean.slice(0, -recent) : clean;

  // group older turns into episodes of ~10 turns (aligned to role boundaries around user turns)
  const episodes = [];
  const STEP = 10;
  for (let i = 0; i < older.length; i += STEP) {
    const block = older.slice(i, i + STEP);
    if (block.every((m) => isTrivial(m.content || ''))) continue; // drop trivia
    episodes.push(summariseEpisode(block));
  }

  let episodeTokens = episodes.reduce((a, e) => a + estimateTokens(e), 0);
  // drop oldest episodes first if over budget
  while (episodes.length > 1 && episodeTokens > episodeTokenBudget) {
    episodeTokens -= estimateTokens(episodes.shift());
  }

  const messages = [];
  if (episodes.length) {
    messages.push({
      role: 'system',
      content: `PAST CONVERSATION EPISODES (structured summaries; sourceTurnRefs included where present):\n${episodes.join('\n')}`,
    });
  }
  for (const m of recentTurnList) {
    let content = String(m.content || '');
    if (m.role === 'assistant' && content.length > 1500) content = `${content.slice(0, 1500)}…[clipped]`;
    messages.push({ role: m.role === 'tool' ? 'tool' : (m.role === 'assistant' ? 'assistant' : 'user'), content });
  }
  return {
    messages,
    meta: {
      totalTurns: clean.length,
      kept: recentTurnList.length,
      episodes: episodes.length,
      dropped: older.filter((m) => isTrivial(m.content || '')).length,
      estimateTokens: messages.reduce((a, m) => a + estimateTokens(m.content), 0),
    },
  };
}

/** Repeatedly compact an arbitrarily long stream to a bounded message list. */
export function chunkedMessages(history, { recentWindow = 14, budgetTokens = 1600 } = {}) {
  return buildTurnMessages(history, { recent: recentWindow, episodeTokenBudget: budgetTokens });
}
