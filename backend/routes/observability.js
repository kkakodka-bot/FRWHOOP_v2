/**
 * Observability and debug surfaces: the day-index debug dump and the
 * operational observability endpoints (queue + metrics snapshot, manual
 * outbox redrive).
 *
 * Route blocks were extracted verbatim from backend/index.js and registered
 * in the same relative order they had inline.
 */
import { loadDayIndex } from '../coach/days.js';
import { snapshot } from '../observability/metrics.js';

export function registerObservabilityRoutes(app, {
  syncQueue,
  userRuntimes,
  ingestSecret,
} = {}) {
  app.get('/debug/data', (_req, res) => {
    try {
      const index = loadDayIndex();
      res.json({
        totalDays: index.days.length,
        mostRecentDate: index.lastDay,
        oldestDate: index.firstDay,
        sampleDates: index.days.slice(-10).reverse().map((d) => d.day),
      });
    } catch (error) {
      res.status(500).json({ error: 'day index unavailable' });
    }
  });

  app.get('/api/observability', (_req, res) => {
    const queue = syncQueue.status();
    res.json({
      ...snapshot(),
      ingest_secret: Boolean(ingestSecret),
      queue,
      pending_samples: userRuntimes.pendingCount(),
      outbox_blocked: Boolean(queue.lastError && (queue.lastError.status === 401 || queue.lastError.retryClass === 'block')),
    });
  });

  app.post('/api/observability/outbox/redrive', async (_req, res) => {
    const result = syncQueue.redrive({ reason: 'manual' });
    await syncQueue.flush();
    res.json({ ...result, queue: syncQueue.status() });
  });
}
