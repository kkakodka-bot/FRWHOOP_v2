
// memory/promote.js — memory promotion policy: choose which conversational content is
// durable. Deterministic extractor runs in the hot path (cheap); an optional model-based
// extractor can run post-response. Never promotes exact health measurements
// (canonical Supabase/local data is the source of truth, not memory).

const PREF_VERBS = /\b(prefer|like|love|hate|enjoy|dislike|can't stand|struggle with|favor|favour|rather)\b/i;
const TIME_WORDS = /\b(morning|evening|night|afternoon|early|late|midday|noon|before work|after work|weekend)\b/i;
const DAYS = /\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday|weekdays|weekends)\b/i;
const TIME_PATTERN = /(morning|evening|night|afternoon|midday|noon|early morning|early|late night|late)/i;
const GOAL = /\b(training for|training to|goal|target|aiming for|trying to|want to (?:hit|break|run|lift|build|get to))\b/i;
const GOAL_NOW = /\b(5k|10k|half|marathon|triathlon|ultra|bench|squat|deadlift|hit|break|sub[- ]?\d|body ?(?:fat|weight)|lose|gain|build muscle|strength)\b/i;
const INJURY = /\b(knee|back|shoulder|hip|ankle|wrist|elbow|neck|hamstring|achilles|plantar|shin|collarbone|rib|quad|calf|glute|groin)\b/i;
const PAIN = /\b(hurt\w*|sore\w*|pain\w*|ach\w*|injured|injury\w*|strain\w*|twinge|tender|swollen|rehab\w*|physical therapy|physio)\b/i;
const CONSTRAINT = /\b(can't|cannot|avoid|not able|unable|no longer|shouldn't|should not)\b/i;
const SCHEDULE = /\b(training plan|split|train(?:ing)? schedule|work out (?:on|at)|workout (?:on|at))\b/i;
const CORRECTION = /\b(changed|switched|used to|no longer|but now|instead|replaced|now i)\b/i;
const BODY_PARTS = ['knee','back','shoulder','hip','ankle','wrist','elbow','neck','hamstring','achilles','shin','quad','calf'];


/**
 * Resolve the time of day the user is expressing a CURRENT preference for,
 * honoring polarity and correction structure rather than first-match order.
 */
function analyzeTimeSentiment(text) {
  // clause-based: each comma/period/'but' clause may bind a time to a sentiment verb
  const prefVerbs = /(prefer|prefers|like|likes|love|loves|enjoy|enjoys|favor|favours?|rather)/i;
  const negVerbs = /(hate|hates|dislike|dislikes|can't stand|cannot stand|struggle with|don't like|do not like|avoid)/i;
  const clauseSplit = String(text).split(/[,.;!?]|\bbut\b/i);
  let prefer = null, dislike = null;
  for (const clause of clauseSplit) {
    const tm = clause.match(TIME_PATTERN);
    if (!tm) continue;
    const time = tm[1].toLowerCase();
    if (prefVerbs.test(clause) && !/(just|used to|before|previously)/.test(clause)) prefer = prefer || time;
    if (negVerbs.test(clause)) dislike = dislike || time;
    // "switched/prefer to X now"
    const sw = /(?:switch(?:ed)?|changed) to (morning|evening|night|afternoon|midday|noon)/.exec(clause);
    if (sw) prefer = sw[1];
    const now = /(?:prefer|like|love) (?:the )?(morning|evening|night|afternoon) (?:now|these days|better|best)/.exec(clause);
    if (now) prefer = now[1];
  }
  // correction frame: "used to X but now Y"
  if (!prefer) {
    const butNow = /but (?:now )?(?:i|i'm|i am) (?:train|work out|prefer|like) (?:in the |at )?(morning|evening|night|afternoon)/.exec(text);
    if (butNow) prefer = butNow[1];
  }
  return { prefer, dislike };
}
export function extractDurableFacts({ message, response }) {
  const msg = String(message || '');
  const facts = [];
  const lower = msg.toLowerCase();
  // Pure look-up questions ("What was my 5K goal?", "When do I train?") are requests for
  // existing memories — they must not be written back as new durable facts.
  const isPureLookup = /^(what|when|how|why|which|who|where|do i|does my|is my|am i)[^?.]*\?$/.test(msg.trim())
    && !/\b(i prefer|i like|i hate|i switched|my goal is|training for|i want to|can't|cannot|avoid)\b/i.test(msg);
  if (isPureLookup) return facts;


  const add = (type, content, topic, extra = {}) => {
    // collapse dupes
    const seen = facts.some((f) => f.type === type && f.topic === topic && nearEqual(f.content, content));
    if (!seen) facts.push({ type, content, topic, entities: extra.entities || [], confidence: extra.confidence ?? 0.72, provenance: 'user_supplied', stable: extra.stable !== false, sourceTurnIds: [] });
  };

  // corrections (highest priority: supersede old facts of same type+topic)
  const sent = analyzeTimeSentiment(lower);
  const isCorrectionContext = CORRECTION.test(msg) && (PREF_VERBS.test(msg) || TIME_WORDS.test(msg) || SCHEDULE.test(msg));
  if (isCorrectionContext && (sent.prefer || sent.dislike)) {
    const t = sent.prefer || sent.dislike;
    const verb = sent.prefer ? 'prefers' : 'dislikes';
    add('preference', `User now ${verb} ${t} training sessions.`, 'training_time', { confidence: 0.92, stable: true, entities: ['training_time'] });
  }
  // preference + day + activity ("prefer to train legs on Wednesday, not Tuesday")
  else if (PREF_VERBS.test(msg) && DAYS.test(msg) && /train|lift|leg|run|workout|exercise/.test(msg)) {
    const day = ((msg.match(DAYS) || [])[0] || '').toUpperCase();
    const act = (/legs?|run|run\w*|lift\w*|cardio|upper|lower/i.exec(msg) || [])[0] || 'training';
    if (day) add('preference', `User prefers ${act} on ${day}.`, 'training_time', { confidence: 0.86, stable: true, entities: [act.toLowerCase()] });
  }
  // preferences + times
  else if (PREF_VERBS.test(msg) && TIME_WORDS.test(msg) && (sent.prefer || sent.dislike)) {
    const time = sent.prefer || sent.dislike;
    const isNeg = !sent.prefer && Boolean(sent.dislike);
    const topic = /train|workout|exercise|gym/.test(msg) ? 'training_time' : 'preference';
    add('preference', `User ${isNeg ? 'dislikes' : 'prefers'} ${time.toLowerCase()} ${topic === 'training_time' ? 'training' : ''}`.trim() + '.', topic, { confidence: 0.85, stable: true });
  }

  // schedule / routine days (skip when a training_time preference was already written,
  // and never include days the user explicitly negates: "not Tuesday")
  if (!facts.some((f) => f.topic === 'training_time' && f.type === 'preference')) {
    if (SCHEDULE.test(msg) || (PREF_VERBS.test(msg) && DAYS.test(msg))) {
      const matches = msg.match(DAYS) || [];
      const negated = [...String(msg).matchAll(/\bnot (monday|tuesday|wednesday|thursday|friday|saturday|sunday|weekdays|weekends)\b/gi)].map((m) => m[1].toLowerCase());
      const daysText = [...new Set(matches.map((d) => d.toUpperCase()).filter((d) => !negated.includes(d.toLowerCase())))].join(', ');
      if (daysText) add('routine', `User trains on ${daysText}.`, 'schedule', { confidence: 0.8, stable: true });
    }
  }

  // goals
  if (GOAL.test(msg) || (lower.includes('goal') && GOAL_NOW.test(msg))) {
    add('goal', msg.trim(), 'goal', { confidence: 0.8, stable: true });
  } else if (GOAL_NOW.test(msg) && /training|goal|target|running|race|early this year|lately/.test(msg)) {
    add('goal', msg.trim(), 'goal', { confidence: 0.65, stable: true });
  }

  // injuries
  if (INJURY.test(msg) && PAIN.test(msg)) {
    const bp = (msg.match(INJURY) || [])[0].toLowerCase();
    add('injury', msg.trim(), bp, { confidence: 0.85, stable: true, entities: [bp] });
  }

  // plans (deload/taper/start next week) — durable until changed
  if (/\b(deload|taper)\b/.test(lower)) {
    add('routine', msg.trim(), 'plan', { confidence: 0.8, stable: true });
  } else if (/\b(start(?:ing|ed)?|begin(?:ning)?)\b/.test(msg) && /\b(next (?:monday|tuesday|wednesday|thursday|friday|saturday|sunday|week)|tomorrow|this weekend)\b/i.test(msg)) {
    add('routine', msg.trim(), 'plan', { confidence: 0.82, stable: true });
  }
  // supplements / daily habits ("started taking creatine daily")
  if (/\b(started|start|take|taking|added)\b/i.test(msg) && /\b(daily|every day|each morning|after breakfast|morning|night)\b/i.test(msg) && /\b(creatine|protein|vitamin|magnesium|omega|zinc|multivitamin|supplement)\b/i.test(lower)) {
    add('routine', msg.trim(), 'supplement', { confidence: 0.85, stable: true });
  }
  // medical/coach clearance ("physio cleared me to run 3x a week max 5k")
  if (/\b(physio|physiotherapist|doctor|coach|therapist|ortho)\b/i.test(msg) && /\b(cleared|said|told|ok\w*d|recommended)\b/i.test(msg) && /\b(to |i can|i should|limit|max)\b/i.test(msg)) {
    add('temporary', msg.trim(), 'medical_clearance', { confidence: 0.85, stable: false, entities: ['medical'] });
  }
  // personal entities (family / coach names) — relevant relationships for coaching
  const person = /\bmy (?:wife|husband|girlfriend|boyfriend|partner|fiance\w*|spouse|sister|brother|mom|mother|dad|father|daughter|son|coach|trainer|physio)['’]?s name is ([A-Z][a-z]+)\b/.exec(msg);
  if (person) add('entity', `User's ${person[0].split(' ').slice(1, 3).join(' ')} is ${person[1]}.`, 'person', { confidence: 0.88, stable: true, entities: [person[1]] });
  else {
    const named = /\b(name is|named|called) ([A-Z][a-z]{2,})\b/.exec(msg);
    if (named && /(wife|husband|partner|gf|fianc|coach|trainer|physio)/i.test(msg)) {
      add('entity', msg.trim(), 'person', { confidence: 0.7, stable: true, entities: [named[2]] });
    }
  }
  // gear / equipment changes ("barefoot shoes now, no more cushioned runners")
  if (/\b(only train with|switched to|started using|no more|instead of|now i train with)\b/i.test(msg) && /\b(shoes?|barefoot|runners?|squat shoes|lifting belt|belt|grips?|bike|treadmill|barbell|kettlebell)\b/i.test(msg)) {
    add('preference', msg.trim(), 'gear', { confidence: 0.82, stable: true });
  }
  // constraints
  if (CONSTRAINT.test(msg) && (INJURY.test(msg) || /train|run|lift|exercise/.test(msg))) {
    const bp = (msg.match(INJURY) || [])[0]?.toLowerCase() || 'exercise';
    add('temporary', msg.trim(), bp, { confidence: 0.7, stable: false });
  }

  return facts;
}

export function nearEqual(a, b) {
  return tokens(a).join(' ') === tokens(b).join(' ');
}

function tokens(text) {
  return String(text || '').toLowerCase().replace(/[^a-z0-9]/g, ' ').split(/\s+/).filter((t) => t.length > 1);
}

// Optional model-based extraction (used offline / post-response). Returns facts JSON.
export async function extractWithModel({ message, response, complete, model }) {
  const body = {
    model: model || 'deepseek-ai/DeepSeek-V4-Flash-0731',
    temperature: 0,
    max_tokens: 500,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: 'You extract durable coaching-relevant facts from a user message for a health coach memory store. Return JSON {"facts":[{type,content,topic,confidence}]}. Only include durable preferences, goals, injuries, schedule/routines, constraints, or corrections. Skip one-off questions, greetings, and exact health numbers (those live in canonical storage). Types: preference|goal|injury|routine|constraint|correction|feedback.' },
      { role: 'user', content: `User said: "${message}"\nAssistant replied: "${String(response || '').slice(0, 600)}"` },
    ],
  };
  try {
    const out = await complete(body);
    const text = String(out?.choices?.[0]?.message?.content || '').trim();
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start >= 0 && end > start) {
      return (JSON.parse(text.slice(start, end + 1)).facts || []).filter((f) => f && f.content);
    }
    return [];
  } catch (e) {
    return [];
  }
}
