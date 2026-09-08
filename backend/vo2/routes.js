import { addLabForStore, calculateForStore, historyForStore, methodologyPublic, setHrMaxForStore } from './service.js';
import { ensureVo2Store, listLabAnchors } from './repository.js';

export function registerVo2Routes(app, { loadStore, saveStore }) {
  const read = () => ensureVo2Store(loadStore());

  app.get('/api/vo2-max', (req, res) => {
    try {
      const asOfDay = req.query.asOf || req.query.date || undefined;
      const force = String(req.query.recalculate || '') === '1';
      const store = read();
      const { result, store: next } = calculateForStore(store, { asOfDay, persist: true, force });
      saveStore(next);
      if (result?.error) return res.status(422).json(result);
      res.json(result);
    } catch (error) {
      res.status(500).json({ error: 'vo2_unavailable', message: String(error.message || error) });
    }
  });

  app.post('/api/vo2-max/recalculate', (req, res) => {
    try {
      const asOfDay = req.body?.asOf || req.body?.date || undefined;
      const store = read();
      const { result, store: next } = calculateForStore(store, { asOfDay, persist: true, force: true });
      saveStore(next);
      if (result?.error) return res.status(422).json(result);
      res.json(result);
    } catch (error) {
      res.status(500).json({ error: 'vo2_unavailable', message: String(error.message || error) });
    }
  });

  app.get('/api/vo2-max/history', (req, res) => {
    try {
      const store = read();
      const limit = Number(req.query.limit) || 52;
      res.json({ snapshots: historyForStore(store, { limit }) });
    } catch (error) {
      res.status(500).json({ error: 'vo2_history_unavailable' });
    }
  });

  app.get('/api/vo2-max/methodology', (_req, res) => {
    res.json(methodologyPublic());
  });

  app.get('/api/vo2-max/lab', (_req, res) => {
    try {
      res.json({ anchors: listLabAnchors(read()) });
    } catch (error) {
      res.status(500).json({ error: 'vo2_lab_unavailable' });
    }
  });

  app.post('/api/vo2-max/lab', (req, res) => {
    try {
      const store = read();
      const saved = addLabForStore(store, req.body || {});
      if (saved.error) return res.status(400).json(saved);
      saveStore(saved.store);
      res.status(201).json({ anchor: saved.anchor, result: saved.result });
    } catch (error) {
      res.status(500).json({ error: 'vo2_lab_unavailable', message: String(error.message || error) });
    }
  });

  app.post('/api/vo2-max/hr-max', (req, res) => {
    try {
      const store = read();
      const saved = setHrMaxForStore(store, req.body?.value ?? req.body?.hrMax);
      if (saved.error) return res.status(400).json(saved);
      saveStore(saved.store);
      res.json({ hrMaxOverride: saved.hrMaxOverride, result: saved.result });
    } catch (error) {
      res.status(500).json({ error: 'vo2_hr_max_unavailable', message: String(error.message || error) });
    }
  });
}
