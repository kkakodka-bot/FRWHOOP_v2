/**
 * Person-level split for any future trained HR model.
 *
 * Contract (V2_DESIGN.md §2 "eval/split.js"): a model trained on `train` must
 * never see a subject whose data is in `test`. Splits are made at the person
 * level (by user_id by default) so no subject leakage is possible, and the
 * result is fully deterministic given (items, by, testFraction, seed) — the
 * same seed always yields the same assignment regardless of item input order.
 *
 * Algorithm: group items by person key → sort persons deterministically →
 * for each person derive a pseudo-random draw from seed+key (mulberry32 with a
 * person-key hash) → sort persons by (draw, key) → the first
 * round(testFraction·P) persons become `test`, the rest `train`. Exact counts:
 * testFraction is honored to the nearest integer person, not probabilistically.
 */

/** mulberry32 PRNG — deterministic, dependency-free (32-bit state). */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a += 0x6d2b79f5;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** FNV-1a 32-bit string hash → unsigned int. */
export function hashString(str) {
  const s = String(str == null ? '' : str);
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

const naturalCmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Split items into { train, test } with person-level disjointness.
 *
 * @param {Array} items — records that carry a person identifier.
 * @param {object} [options]
 * @param {string|Function} [options.by='user_id'] — field name or key function.
 * @param {number} [options.testFraction=0.2] — target fraction of PERSONS held
 *   out (0 < f < 1).
 * @param {number} [options.seed=1] — determinism seed.
 * @returns {{train: Array, test: Array, meta: object}} — meta carries
 *   { by, seed, testFraction, persons: { total, test, train },
 *     testKeys, trainKeys }.
 */
export function personSplit(items, options = {}) {
  const by = options.by ?? 'user_id';
  const testFraction = options.testFraction ?? 0.2;
  const seed = options.seed ?? 1;
  if (!Array.isArray(items)) throw new TypeError('personSplit: items must be an array');
  if (!(testFraction > 0 && testFraction < 1)) throw new RangeError('personSplit: testFraction must be in (0, 1)');
  const keyOf = typeof by === 'function' ? by : (item) => item?.[by];

  const byPerson = new Map(); // key -> items
  for (const item of items) {
    const k = keyOf(item);
    if (k == null || k === '') throw new TypeError(`personSplit: missing person key ("${String(by)}") on item`);
    const key = typeof k === 'string' ? k : String(k);
    if (!byPerson.has(key)) byPerson.set(key, []);
    byPerson.get(key).push(item);
  }
  const persons = [...byPerson.keys()].sort(naturalCmp);

  // deterministic per-person draw seeded by (seed, key): the chance each
  // person lands in the held-out set is fixed by the seed, never by input order.
  const drawn = persons
    .map((k) => ({ key: k, draw: mulberry32(hashString(`${seed}::${k}`))() }))
    .sort((a, b) => (a.draw - b.draw) || naturalCmp(a.key, b.key));

  const testCount = Math.min(persons.length, Math.max(1, Math.round(testFraction * persons.length)));
  const testKeysSet = new Set(drawn.slice(0, testCount).map((d) => d.key));
  const test = [];
  const train = [];
  for (const item of items) {
    const k = typeof keyOf(item) === 'string' ? keyOf(item) : String(keyOf(item));
    if (testKeysSet.has(k)) test.push(item); else train.push(item);
  }
  return {
    train,
    test,
    meta: {
      by: typeof by === 'function' ? '<function>' : String(by),
      seed,
      testFraction,
      persons: { total: persons.length, test: testCount, train: persons.length - testCount },
      testKeys: drawn.slice(0, testCount).map((d) => d.key).sort(naturalCmp),
      trainKeys: drawn.slice(testCount).map((d) => d.key).sort(naturalCmp),
    },
  };
}
