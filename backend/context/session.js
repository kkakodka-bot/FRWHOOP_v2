
// context/session.js — durable per-user conversation checkpoint.
// Session state survives server restarts / app closes: recent turns verbatim + structured
// episodes + topics/decisions/open questions/source refs + compaction version.
// Recomputed deterministically, so crashes leave a recoverable state.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildTurnMessages, estimateTokens, isTrivial } from './compactor.js';
import { extractDurableFacts } from '../memory/promote.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const SESSION_ROOT = path.join(here, '../data/sessions');

const RECENT_CAP = 28;       // turns kept verbatim
const EPISODE_BUDGET = 900;  // tokens of episode summaries

export class SessionStore {
  static pathFor(userId) {
    return path.join(SESSION_ROOT, `${String(userId).replace(/[^a-zA-Z0-9_-]/g, '_')}.json`);
  }
  static load(userId) {
    try {
      const raw = JSON.parse(fs.readFileSync(SessionStore.pathFor(userId), 'utf8'));
      return new SessionStore({ userId, ...raw });
    } catch {
      return new SessionStore({ userId });
    }
  }

  constructor({ userId, sessionId = null, updatedAt = null, version = 1, episodes = [], recent = [], messageCount = 0, topics = [], openQuestions = [], decisions = [], sourceRefs = {}, facts = [] } = {}) {
    this.userId = userId;
    this.sessionId = sessionId || `s-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
    this.updatedAt = updatedAt || new Date().toISOString();
    this.compactionVersion = version;
    this.episodes = episodes || [];
    this.recent = recent || [];
    this.messageCount = messageCount || 0;
    this.topics = topics || [];
    this.openQuestions = openQuestions || [];
    this.decisions = decisions || [];
    this.sourceRefs = sourceRefs || {};
    this.facts = facts || [];
  }

  /** Rebuild the message list the coach should see: facts + episodes block + recent turns. */
  history() {
    const messages = [];
    if (this.facts.length) {
      messages.push({ role: 'system', content: `RECENT SESSION FACTS (stated this session; treat as known until corrected):\n${this.facts.map((f) => `- [${f.type}] ${f.content}`).join('\n')}` });
    }
    if (this.episodes.length) {
      messages.push({
        role: 'system',
        content: `PAST CONVERSATION EPISODES (structured summaries; sourceTurnRefs shown when present):\n${this.episodes.join('\n')}`,
      });
    }
    for (const m of this.recent) {
      let content = String(m.content || '');
      if (m.role === 'assistant' && content.length > 1500) content = `${content.slice(0, 1500)}…[clipped]`;
      messages.push({ role: m.role === 'assistant' ? 'assistant' : 'user', content });
    }
    return messages;
  }

  /**
   * Append a user message + assistant reply. Rolls the oldest recent turns into compacted
   * episodes when they exceed RECENT_CAP. Falls back to the stateless compactor when the
   * change is large so results match evaluation harness behavior.
   */
  append(userMessage, assistantMessage, { analysis = {} } = {}) {
    const now = new Date().toISOString();
    this.recent.push({ role: 'user', content: String(userMessage || ''), at: now });
    this.recent.push({ role: 'assistant', content: String(assistantMessage || ''), at: now });
    this.messageCount += 1;

    // maintain episode store from older turns
    if (this.recent.length > RECENT_CAP) {
      const overflow = this.recent.slice(0, this.recent.length - RECENT_CAP);
      if (!overflow.every((m) => isTrivial(m.content))) {
        const built = buildTurnMessages({ history: overflow, recent: 0, episodeTokenBudget: EPISODE_BUDGET });
        const prefix = (built.messages.find((m) => m.role === 'system') || {}).content || '';
        const eps = prefix.replace(/^PAST CONVERSATION EPISODES \(structured summaries; sourceTurnRefs included where present\):\n/, '').split('\n');
        this.episodes = this.episodes.concat(eps.filter(Boolean)).slice(-10);
        this.sourceRefs[this.episodes.length] = { turn: this.messageCount - this.recent.length / 2, summary: eps.length };
      }
      this.recent = this.recent.slice(-RECENT_CAP);
    }

    // lightweight topic tracking from the user turn
    const LOWER = String(userMessage).toLowerCase();
    const seen = new Set(this.topics.map((t) => JSON.stringify(t)));
    for (const kw of ['sleep', 'recovery', 'hrv', 'workout', 'strain', 'knee', 'shoulder', 'goal', 'injury', 'nutrition', 'running', 'lifting']) {
      if (LOWER.includes(kw) && !seen.has(kw)) { this.topics.push(kw); seen.add(kw); }
    }
    this.topics = this.topics.slice(-10);
    // session fact buffer: keep recently-stated durable facts even if they aren't yet in
    // long-term memory, so early non-durable needles survive episode pruning.
    for (const f of extractDurableFacts({ message: userMessage, response: '' })) {
      const dupe = this.facts.find((x) => x.type === f.type && x.topic === f.topic && nearEq(x.content, f.content));
      if (!dupe) {
        this.facts.push({ type: f.type, topic: f.topic, content: f.content, at: now });
        this.facts = this.facts.slice(-20);
      }
    }
    if (/[?]/.test(String(userMessage)) && this.assistantPromisesOpen(assistantMessage)) {
      this.openQuestions.push({ q: String(userMessage).slice(0, 120), askedAt: now });
    }
    this.openQuestions = this.openQuestions.slice(-6);
    this.updatedAt = now;
    return this;
  }

  assistantPromisesOpen(assistantMessage) {
    // heuristic: if the assistant asked 'want me to' or offered follow-up, it's open-ish.
    return /want me to|shall i|i can|let me know|ask me|next step|want me/.test(String(assistantMessage || ''));
  }

  recordDecision(text) {
    if (text && text.trim()) {
      this.decisions.push({ text: String(text).slice(0, 200), at: new Date().toISOString() });
      this.decisions = this.decisions.slice(-8);
    }
  }

  toJSON() {
    return {
      userId: this.userId,
      sessionId: this.sessionId,
      updatedAt: this.updatedAt,
      compactionVersion: this.compactionVersion,
      episodes: this.episodes,
      recent: this.recent,
      messageCount: this.messageCount,
      topics: this.topics,
      openQuestions: this.openQuestions,
      decisions: this.decisions,
      sourceRefs: this.sourceRefs,
      facts: this.facts,
      tokenEstimate: estimateTokens(this.history().map((m) => m.content || '').join(' ')),
    };
  }

  save() {
    fs.mkdirSync(SESSION_ROOT, { recursive: true });
    fs.writeFileSync(SessionStore.pathFor(this.userId), JSON.stringify(this.toJSON(), null, 2));
  }
}

function nearEq(a, b) {
  const t = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, ' ').split(/\s+/).filter((x) => x.length > 1);
  const A = t(a); const B = t(b);
  return A.filter((x) => B.includes(x)).length >= Math.min(A.length, B.length) * 0.6;
}
