import { calculateForStore, historyForStore, methodologyPublic } from './service.js';
import { ensureFunctionalAgeStore } from './repository.js';

export function registerFunctionalAgeRoutes(app, { loadStore, saveStore }) {
  const read = () => ensureFunctionalAgeStore(loadStore());

  app.get('/api/functional-age', (req, res) => {
    try {
      const asOfDay = req.query.asOf || req.query.date || undefined;
      const force = String(req.query.recalculate || '') === '1';
      const store = read();
      const { result, store: next } = calculateForStore(store, { asOfDay, persist: true, force });
      saveStore(next);
      if (result?.error) return res.status(422).json(result);
      res.json(result);
    } catch (error) {
      res.status(500).json({ error: 'functional_age_unavailable', message: String(error.message || error) });
    }
  });

  app.post('/api/functional-age/recalculate', (req, res) => {
    try {
      const asOfDay = req.body?.asOf || req.body?.date || undefined;
      const store = read();
      const { result, store: next } = calculateForStore(store, { asOfDay, persist: true, force: true });
      saveStore(next);
      if (result?.error) return res.status(422).json(result);
      res.json(result);
    } catch (error) {
      res.status(500).json({ error: 'functional_age_unavailable', message: String(error.message || error) });
    }
  });

  app.get('/api/functional-age/history', (req, res) => {
    try {
      const store = read();
      const limit = Number(req.query.limit) || 52;
      res.json({ snapshots: historyForStore(store, { limit }) });
    } catch (error) {
      res.status(500).json({ error: 'functional_age_history_unavailable' });
    }
  });

  app.get('/api/functional-age/methodology', (_req, res) => {
    res.json(methodologyPublic());
  });
}
