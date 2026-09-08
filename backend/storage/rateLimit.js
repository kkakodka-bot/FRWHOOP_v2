export function createRateLimiter({ windowMs = 15 * 60 * 1000, max = 30 } = {}) {
  const hits = new Map();
  return {
    allow(key, now = Date.now()) {
      const cutoff = now - windowMs;
      const prev = (hits.get(key) || []).filter((t) => t > cutoff);
      if (prev.length >= max) {
        hits.set(key, prev);
        return false;
      }
      prev.push(now);
      hits.set(key, prev);
      return true;
    },
    reset() { hits.clear(); },
  };
}
