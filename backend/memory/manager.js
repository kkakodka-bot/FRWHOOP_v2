
// memory/manager.js — per-user memory lifecycle: creation, prompt rendering, promotion.
// The production coach talks to memory through this seam only.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MemoryStore, TYPE_LABELS } from './store.js';
import { extractDurableFacts } from './promote.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const MEMORY_ROOT = path.join(here, '../data/memory');

function memoryPath(userId) {
  return path.join(MEMORY_ROOT, `${String(userId).replace(/[^a-zA-Z0-9_-]/g, '_')}.json`);
}

export function loadMemory(userId, { ensureDir = false } = {}) {
  try {
    const raw = JSON.parse(fs.readFileSync(memoryPath(userId), 'utf8'));
    return new MemoryStore({ userId, records: raw.records || [], relations: raw.relations || [] });
  } catch {
    if (ensureDir) fs.mkdirSync(MEMORY_ROOT, { recursive: true });
    return new MemoryStore({ userId });
  }
}

export function persistMemory(store) {
  fs.mkdirSync(MEMORY_ROOT, { recursive: true });
  fs.writeFileSync(memoryPath(store.userId), JSON.stringify(store.toJSON(), null, 2));
  return store.toJSON().records.length;
}

const MEMORY_BLOCK_CAP = 900;

/** Compact prompt block of the most relevant active memories for a message. */
export function renderMemory(store, query, { limit = 6, cap = MEMORY_BLOCK_CAP } = {}) {
  if (!store) return '';
  const rows = store.searchSync(query, { limit });
  if (!rows.length) return '';
  const parts = rows.map((r, i) => {
    const label = TYPE_LABELS[r.type] || r.type;
    const marker = r.provenance === 'user_supplied' ? 'user-stated' : 'inferred';
    let line = `${i + 1}. [${label} | ${marker}] ${r.content}`;
    if (r.confidence > 0.9) line += ' (strong)';
    return line;
  });
  const joined = parts.join('\n');
  return `USER CONTEXT (facts this user has told you or you've inferred; treat as known unless a tool contradicts it):\n${joined.slice(0, cap)}`;
}

/**
 * Promote durable facts from a finished turn. Deterministic, O(1), synchronous,
 * so it never materially increases response latency. Corrections supersede old facts.
 */
export function promoteTurn({ store, message, response, userMessageId }) {
  if (!store) return [];
  const facts = extractDurableFacts({ message, response });
  const written = [];
  for (const f of facts) {
    const isCorrection = f.type === 'correction' || /\b(changed|switched|used to|but now|no longer|instead)\b/i.test(String(message));
    if (isCorrection) {
      const rec = store.correct({
        type: f.type === 'correction' ? 'preference' : f.type,
        topic: f.topic,
        content: f.content,
        confidence: f.confidence,
      });
      wireRelations(store, rec);
      written.push(rec.id);
    } else {
      // dedup: if an active same-type+topic memory already encodes this, just confirm it.
      const dupes = store.byTopic(f.topic).filter((r) => r.type === f.type && r.provenance === f.provenance);
      const dupe = dupes.find((r) => nearEqual(r.content, f.content));
      if (dupe) {
        store.confirm(dupe.id);
        written.push(dupe.id);
      } else {
        const rec = store.add({ ...f, userId: store.userId });
        wireRelations(store, rec);
        written.push(rec.id);
      }
    }
  }
  return written.map((id) => store.get(id)).filter(Boolean);
}


function wireRelations(store, rec) {
  if (!rec.topic) return;
  const content = String(rec.content || '');
  let predicate = null;
  if (rec.type === 'preference') predicate = /dislikes|hates|can't stand|avoid/i.test(content) ? 'dislikes' : 'prefers';
  else if (rec.type === 'goal') predicate = 'training_for';
  else if (rec.type === 'injury') predicate = 'has_injury';
  else if (rec.type === 'routine') predicate = 'trains_on';
  else if (rec.type === 'feedback') predicate = 'feedback_on';
  if (predicate) store.addRelation({ subject: 'user', predicate, object: rec.topic, recordId: rec.id, confidence: rec.confidence });
}

function nearEqual(a, b) {
  const t = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, ' ').split(/\s+/).filter((x) => x.length > 1);
  const A = t(a); const B = t(b);
  const overlap = A.filter((x) => B.includes(x)).length;
  return overlap >= Math.min(A.length, B.length) * 0.7 && overlap > 2;
}
