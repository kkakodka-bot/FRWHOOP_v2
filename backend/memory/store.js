
// memory/store.js — durable per-user memory with temporal semantics, supersession,
// a lightweight relationship graph, and hybrid (lexical + optional embedding) recall.
// This is an ADAPTER seam: the storage format is internal; swap-in of Graphiti/Neo4j
// later must preserve this public API.

export const MEMORY_TYPES = Object.freeze([
  'profile', 'preference', 'goal', 'injury', 'behavior', 'routine', 'entity',
  'relationship', 'conversation_event', 'coaching_decision', 'feedback',
  'correction', 'historical_state', 'temporary',
]);

export const TYPE_LABELS = Object.freeze({
  profile: 'profile',
  preference: 'preference',
  goal: 'goal',
  behavior: 'behavioral tendency',
  routine: 'routine',
  entity: 'personal entity',
  relationship: 'relationship',
  conversation_event: 'conversation event',
  coaching_decision: 'coaching decision',
  feedback: 'user feedback',
  correction: 'correction',
  historical_state: 'historical state',
  temporary: 'temporary',
});

let ID = 0;
export function nextId() {
  ID += 1;
  return `m-${Date.now().toString(36)}-${ID.toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

const STOP = new Set('a an the and or but to of for on in with at by from up about into over after under'.split(' '));
export function tokens(text) {
  return String(text || '').toLowerCase().replace(/[^a-z0-9#]/g, ' ').split(/\s+/).filter((t) => t.length > 1 && !STOP.has(t));
}


// Strong topic anchors in a query let oblique phrasing ("i hate morning workouts") still
// surface the current fact on that topic WITHOUT opening the door to unrelated memories.
export function topicSignals(query) {
  const ql = String(query || '').toLowerCase();
  const signals = new Set();
  if (/(morning|evening|night|afternoon|midday|noon)/.test(ql)) signals.add('training_time');
  if (/(monday|tuesday|wednesday|thursday|friday|saturday|sunday|weekdays|weekend)(?! )/.test(ql)) signals.add('schedule');
  const BODY = ['knee','back','shoulder','hip','ankle','wrist','elbow','neck','hamstring','achilles','shin','quad','calf','groin','glute'];
  for (const bp of BODY) if (ql.includes(bp)) signals.add(bp);
  if (/(goal|race|marathon|5k|10k|half|triathlon|training for|target|event)/.test(ql)) signals.add('goal');
  if (/(squat|leg|bench|deadlift|volume|rep|set|split)/.test(ql)) { signals.add('training_focus'); signals.add('training_time'); }
  return [...signals].filter(Boolean);
}

export class MemoryStore {
  /**
   * opts:
   *   userId, records (array seed), now (iso), embed (async fn(text)->number[]),
   *   relationSeed (array of {subject, predicate, object, confidence, observedAt})
   */
  constructor({ userId, records = [], relations = [], now = new Date().toISOString(), embed } = {}) {
    this.userId = userId;
    this.now = () => now;
    this.embed = embed || null;
    this.records = new Map();
    this.relations = [];
    this.relationIndex = new Map(); // subject -> [{predicate, object, recordId, confidence, observedAt, relationId}]
    for (const r of records) this.records.set(r.id, { ...r });
    for (const e of relations) this.addRelation(e);
  }

  addRelation({ subject, predicate, object, recordId = null, confidence = 1, observedAt = null }) {
    const rel = {
      relationId: nextId(),
      subject,
      predicate,
      object,
      recordId,
      confidence: confidence ?? 1,
      observedAt: observedAt || this.now(),
    };
    this.relations.push(rel);
    if (!this.relationIndex.has(subject)) this.relationIndex.set(subject, []);
    this.relationIndex.get(subject).push(rel);
    return rel;
  }

  relationsFor(subject) {
    return this.relationIndex.get(subject) || [];
  }

  add(record) {
    const now = this.now();
    const r = {
      id: record.id || nextId(),
      userId: record.userId || this.userId,
      type: MEMORY_TYPES.includes(record.type) ? record.type : (record.type === 'injury' ? 'injury' : 'preference'),
      topic: record.topic || null,
      content: String(record.content || '').trim(),
      entities: record.entities || [],
      createdAt: record.createdAt || now,
      validFrom: record.validFrom || now,
      validUntil: record.validUntil || null,
      supersededBy: record.supersededBy || null,
      status: record.status || (record.validUntil && record.validUntil <= now ? 'expired' : 'active'),
      confidence: record.confidence ?? 0.8,
      provenance: record.provenance || 'inferred',
      lastConfirmedAt: record.lastConfirmedAt || now,
      stable: record.stable !== false && !['conversation_event', 'temporary'].includes(record.type || ''),
      sourceTurnIds: record.sourceTurnIds || [],
      sourceDocId: record.sourceDocId || null,
      keywords: record.keywords || mergeTokens(record.content, record.topic),
      embedding: record.embedding || null,
    };
    if (!this.records.has(r.id)) this.records.set(r.id, r);
    else this.records.set(r.id, { ...this.records.get(r.id), ...r });
    // wire relations declared on the record
    for (const e of record.relations || []) {
      this.addRelation({ ...e, recordId: r.id });
    }
    return r;
  }

  get(id) { return this.records.get(id) || null; }

  active() {
    const now = this.now();
    return [...this.records.values()].filter((r) =>
      r.status === 'active' && (!r.validUntil || r.validUntil > now));
  }

  all() { return [...this.records.values()]; }

  byType(type) { return this.active().filter((r) => r.type === type); }

  byTopic(topic) {
    const t = String(topic || '').toLowerCase();
    return this.active().filter((r) =>
      (r.topic || '').toLowerCase() === t || tokens(String(r.topic || '')).includes(t));
  }

  /**
   * Explicit user correction: supersede old memories that match type+topic overlap,
   * add the new statement as user_supplied with high confidence.
   */
  correct({ type, topic, content, confidence = 0.97, on = null, entities = [] }) {
    const now = this.now();
    const target = this.active().filter((r) => {
      if (type && r.type !== type) return false;
      if (topic) {
        const tt = tokens(topic); const rt = tokens(r.topic);
        const overlap = tt.some((t) => rt.includes(t));
        if (!overlap) return false;
      }
      return true;
    });
    const newId = nextId();
    const newRec = {
      id: newId,
      type: type || 'correction',
      topic,
      content,
      entities,
      createdAt: on || now,
      validFrom: on || now,
      confidence,
      provenance: 'user_supplied',
      lastConfirmedAt: on || now,
      sourceTurnIds: [],
    };
    // supersede matching records (don't supersede the correction of itself)
    for (const old of target) {
      if (old.id === newId) continue;
      old.supersededBy = newId;
      old.status = 'superseded';
      old.validUntil = on || now;
    }
    return this.add(newRec);
  }

  /** Background re-confirmation: bump lastConfirmedAt for a matching memory. */
  confirm(id, at) {
    const r = this.records.get(id);
    if (r) r.lastConfirmedAt = at || this.now();
    return r;
  }

  /**
   * Hybrid recall. Lexical BM25-ish scoring + optional embedding similarity when embed is set.
   * Applies recency boost, type/topic filters, and hard "no superseded/contradicted" rule.
   */
  async search(query, { types = null, topics = null, limit = 8, boostRecency = true, minScore = 0 } = {}) {
    const q = tokens(query);
    const candidates = this.scorable().filter((r) => {
      if (types && !(Array.isArray(types) ? types : [types]).includes(r.type)) return false;
      if (topics) {
        const tt = Array.isArray(topics) ? topics : [topics];
        const rt = tokens(r.topic);
        if (!tt.some((t) => tokens(t).some((x) => rt.includes(x)))) return false;
      }
      return true;
    });
    // Base lexical score decides relevance; boosts only affect ordering among relevant rows.
    let scored = candidates.map((r) => ({
      rec: r,
      base: lexicalScore(q, r.keywords || mergeTokens(r.content, r.topic)),
    }));
    scored.sort((a, b) => b.base - a.base);
    const best = scored[0]?.base || 0;
    const floor = Math.max(minScore, 0.7, best * 0.45);
    let kept = scored.filter((s) => s.base >= floor).slice(0, limit);
    for (const s of kept) {
      s.rec = this.effective(s.rec);
      let score = s.base;
      if (s.rec.type === 'correction') score += 1.5; // corrections strongly express current state
      if (boostRecency && s.rec.lastConfirmedAt) {
        const ageMs = Date.now() - Date.parse(s.rec.lastConfirmedAt);
        const ageDays = Math.max(0, ageMs / 86400000);
        score += Math.max(0, 0.6 - ageDays * 0.003);
      }
      if (s.rec.confidence) score *= (0.6 + s.rec.confidence * 0.5);
      const ql = query.toLowerCase();
      if (s.rec.topic && ql.includes(String(s.rec.topic).toLowerCase())) score += 0.8;
      s.score = score;
    }
    // embedding rerank optional
    if (this.embed && query) {
      const vec = await this.embed(query);
      if (Array.isArray(vec)) {
        for (const s of kept) {
          if (s.rec.embedding) s.embedScore = cosSim(vec, s.rec.embedding);
        }
      }
    }
    const seen = new Set();
    const out = [];
    for (const s of kept.sort((a, b) => b.score - a.score)) {
      if (seen.has(s.rec.id)) continue;
      seen.add(s.rec.id);
      out.push({ ...s.rec, _score: Math.round(s.score * 100) / 100 });
      if (out.length >= limit) break;
    }
    if (out.length === 0) {
      const sigs = topicSignals(query);
      for (const sig of sigs) {
        for (const x of this.scorable().filter((r) => String(r.topic || '').toLowerCase() === sig)) {
          const eff = this.effective(x);
          if (seen.has(eff.id)) continue;
          seen.add(eff.id);
          out.push({ ...eff, _score: Math.round((0.5 + eff.confidence * 0.3) * 100) / 100 });
          if (out.length >= limit) break;
        }
      }
    }
    return out;
  }

  /** Graph search with hard budgets (anti-runaway). Returns BFS frontier nodes + paths. */
  searchGraph(query, { maxHops = 2, maxNodes = 24, maxExpanded = 48, types = null } = {}) {
    const seed = this.searchSync(query, { limit: 3, types });
    const subjects = new Set(seed.map((s) => s.topic).filter(Boolean));
    subjects.add('user');
    const visited = new Map();
    const paths = [];
    let expanded = 0;
    const queue = [...subjects].map((s, i) => ({ node: s, hop: 0, path: [s] }));
    while (queue.length && expanded < maxExpanded && visited.size < maxNodes) {
      const { node, hop, path } = queue.shift();
      if (visited.has(node)) continue;
      visited.set(node, hop);
      if (hop >= maxHops) continue;
      const rels = this.relationsFor(node);
      for (const rel of rels) {
        expanded += 1;
        if (expanded > maxExpanded) break;
        const nextNode = rel.object;
        // Record the edge even when the target is already discovered (e.g. seed nodes),
        // so relationships like user --prefers--> training_time survive seeding.
        paths.push({ from: node, predicate: rel.predicate, to: nextNode, confidence: rel.confidence, observedAt: rel.observedAt, recordId: rel.recordId });
        if (visited.has(nextNode)) continue;
        if (queue.length + 1 < maxNodes) queue.push({ node: nextNode, hop: hop + 1, path: [...path, nextNode] });
      }
    }
    return { nodes: [...visited.keys()], paths, seedCount: seed.length, expanded };
  }


  searchSync(query, { types = null, topics = null, limit = 8 } = {}) {
    const rows = this.scorable().filter((r) => {
      if (types && !(Array.isArray(types) ? types : [types]).includes(r.type)) return false;
      if (topics) {
        const tt = Array.isArray(topics) ? topics : [topics];
        const rt = tokens(r.topic);
        if (!tt.some((t) => tokens(t).some((x) => rt.includes(x)))) return false;
      }
      return true;
    });
    const q = tokens(query);
    const scored = rows
      .map((r) => ({ rec: r, score: lexicalScore(q, r.keywords || mergeTokens(r.content, r.topic)) }))
      .sort((a, b) => b.score - a.score);
    const best = scored[0]?.score || 0;
    const seen = new Set();
    const out = [];
    for (const s of scored) {
      const eff = this.effective(s.rec);
      if (seen.has(eff.id)) continue;
      seen.add(eff.id);
      out.push({ ...eff, inheritedFromId: eff.inheritedFromId, _score: Math.round(s.score * 100) / 100 });
      if (out.length >= limit) break;
    }
    // Topic-anchored fallback: oblique phrasing about a known topic must still recall it.
    if (out.length === 0) {
      const sigs = topicSignals(query);
      for (const sig of sigs) {
        for (const r of this.scorable().filter((x) => String(x.topic || '').toLowerCase() === sig)) {
          const eff = this.effective(r);
          if (seen.has(eff.id)) continue;
          seen.add(eff.id);
          out.push({ ...eff, inheritedFromId: eff.inheritedFromId, _score: Math.round((0.5 + eff.confidence * 0.3) * 100) / 100 });
          if (out.length >= limit) break;
        }
      }
    }
    return out;
  }

  /** Offers current-state view of a topic blob for the prompt: non-contradicting active facts. */
  summariseTopic(query, { limit = 3 } = {}) {
    return this.searchSync(query, { limit });
  }

  audits() {
    const now = this.now();
    const all = this.all();
    return {
      total: all.length,
      active: this.active().length,
      superseded: all.filter((r) => r.status === 'superseded').length,
      expired: all.filter((r) => r.status === 'expired' || (r.validUntil && r.validUntil <= now)).length,
      byType: all.reduce((m, r) => { m[r.type] = (m[r.type] || 0) + 1; return m; }, {}),
      relations: this.relations.length,
    };
  }

  /**
   * Candidate pool = active records + superseded records whose superseder is still
   * active. This lets old phrasing ("I hated mornings") still return the current,
   * corrected fact instead of the contradicted one.
   */
  scorable() {
    const now = this.now();
    const activeIds = new Set([...this.records.values()].filter((r) => r.status === 'active' && (!r.validUntil || r.validUntil > now)).map((r) => r.id));
    const out = [];
    for (const r of this.records.values()) {
      if (r.status === 'expired') continue;
      if (r.status === 'active') {
        // active but past its valid-until window => expired in effect
        if (r.validUntil && r.validUntil <= now) continue;
        out.push(r);
      } else if (r.status === 'superseded' && r.supersededBy && activeIds.has(r.supersededBy)) {
        // shadow: old phrasing must still surface the live superseding fact
        out.push(r);
      }
    }
    return out;
  }

  /** Resolve a scorable row to the ACTUAL current record (follow supersession chain). */
  effective(rec) {
    let cur = rec;
    let hops = 0;
    while ((cur.status === 'superseded' || cur.supersededBy) && cur.supersededBy && cur.supersededBy !== cur.id && hops < 8) {
      const next = this.records.get(cur.supersededBy);
      if (!next) break;
      cur = next;
      hops += 1;
    }
    return { ...cur, inheritedFromId: rec.id !== cur.id ? rec.id : null };
  }

  toJSON() {
    return {
      userId: this.userId,
      records: [...this.records.values()].map(({ embedding, ...r }) => r),
      relations: this.relations,
      _meta: { exportedAt: new Date().toISOString() },
    };
  }
}

function mergeTokens(content, topic) {
  return Array.from(new Set([...tokens(content), ...tokens(topic)]));
}

function lexicalScore(q, kw) {
  if (!q.length || !kw.length) return 0;
  const kwSet = new Set(kw);
  let score = 0;
  for (const t of q) {
    if (kwSet.has(t)) score += 1.2;
    else if (kw.some((k) => k.includes(t) || t.includes(k))) score += 0.6;
  }
  return score / Math.sqrt(q.length);
}

function cosSim(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i += 1) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return na && nb ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
}
