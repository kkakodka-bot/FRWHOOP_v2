
// documents/store.js — per-user document store adapter (training plans, physio notes, reports).
// Production reads metadata/content abstraced across local cache + Backblaze manifests.
// Sandbox/eval injects fixtures. Never raw storage path knowledge in the tool layer.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const DOC_ROOT = path.join(here, '../data/documents');

const STOP = new Set('a an the and or but to of for on in with at by from up about into over after under during before between'.split(' '));
export function docTokens(text) {
  return String(text || '').toLowerCase().replace(/[^a-z0-9]/g, ' ').split(/\s+/).filter((t) => t.length > 1 && !STOP.has(t));
}

export class DocumentStore {
  constructor({ userId, docs = [], base = DOC_ROOT } = {}) {
    this.userId = userId;
    this.docs = [];
    for (const d of docs) this.add(d);
  }

  add(d) {
    const doc = {
      id: d.id || `doc-${this.docs.length + 1}-${Math.random().toString(36).slice(2, 7)}`,
      userId: d.userId || this.userId,
      name: d.name || 'Untitled',
      kind: d.kind || 'note',
      date: d.date || null,
      source: d.source || 'local', // local | b2 | supabase
      text: String(d.text || d.content || ''),
      keywords: d.keywords || docTokens(String(d.text || d.content || '').slice(0, 4000)),
      meta: d.meta || {},
    };
    // upsert by id
    const i = this.docs.findIndex((x) => x.id === doc.id);
    if (i >= 0) this.docs[i] = doc; else this.docs.push(doc);
    return doc;
  }

  get(id) {
    return this.docs.find((d) => d.id === id) || null;
  }

  search(query, limit = 6) {
    const q = docTokens(query);
    if (!q.length) return this.docs.slice(-limit).map(({ text, ...d }) => ({ ...d, snippet: text ? text.slice(0, 160) : '' }));
    const scored = this.docs.map((d) => {
      const kw = d.keywords || docTokens(d.text);
      let score = 0;
      for (const t of q) {
        if (kw.includes(t)) score += 1.2;
        else if (kw.some((k) => k.includes(t) || t.includes(k))) score += 0.6;
        else if ((d.name + ' ' + d.text).toLowerCase().includes(t)) score += 0.3;
      }
      return { d, score };
    })
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
    // if nothing scores, fall back to recent docs (coach may still be useful)
    if (!scored.length) {
      return this.docs.slice(-limit).map((d) => ({ id: d.id, name: d.name, kind: d.kind, date: d.date, snippet: d.text ? d.text.slice(0, 160) : '' }));
    }
    return scored.map(({ d }) => ({
      id: d.id, name: d.name, kind: d.kind, date: d.date,
      snippet: d.text ? d.text.slice(0, 200) : '',
      _score: Math.round(d.score * 100) / 100,
    }));
  }

  toJSON() {
    return { userId: this.userId, docs: this.docs };
  }
}

export function loadDocuments(userId) {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(DOC_ROOT, `${userId}.json`), 'utf8'));
    return new DocumentStore({ userId, docs: raw.docs || [] });
  } catch {
    return new DocumentStore({ userId });
  }
}
