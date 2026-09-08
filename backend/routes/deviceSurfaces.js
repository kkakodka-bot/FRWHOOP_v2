/**
 * Device-measured surfaces: ECG captures, blood-pressure readings, and
 * health reports. All three are plain user-store documents; the shared
 * `newestFirst` ordering is the only logic beyond the store accessors.
 *
 * Route blocks were extracted verbatim from backend/index.js and registered
 * in the same relative order they had inline.
 */

export function registerDeviceSurfacesRoutes(app, {
  loadStore,
  saveStore,
} = {}) {
  app.get('/api/health-reports', (_req, res) => {
    res.json(loadStore().healthReports);
  });

  app.post('/api/health-reports', (req, res) => {
    const { date, text, vitals } = req.body || {};
    if (!date || !text) return res.status(400).json({ error: 'date and text are required' });
    const row = {
      id: crypto.randomUUID(),
      date,
      text,
      vitals: vitals || null,
      createdAt: new Date().toISOString(),
    };
    const store = loadStore();
    store.healthReports.push(row);
    saveStore(store);
    res.status(201).json(row);
  });

  function newestFirst(rows) {
    return [...rows].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  }

  app.get('/api/ecg', (req, res) => {
    const { date } = req.query;
    const rows = loadStore().ecgReports;
    res.json(newestFirst(date ? rows.filter((r) => r.date === date) : rows));
  });

  app.get('/api/ecg/:id', (req, res) => {
    const row = loadStore().ecgReports.find((r) => r.id === req.params.id);
    if (!row) return res.status(404).json({ error: 'not found' });
    res.json(row);
  });

  app.post('/api/ecg', (req, res) => {
    const { date, bpm, samples, classification, findings, status, durationSec, rrCv, source, createdAt } = req.body || {};
    if (!date || !Number.isFinite(Number(bpm)) || !Array.isArray(samples) || samples.length < 8) {
      return res.status(400).json({ error: 'date, bpm, and samples are required' });
    }
    if (samples.length > 2000) return res.status(400).json({ error: 'samples too long' });
    const store = loadStore();
    const src = source || 'capture';
    if (src === 'seed') {
      const existing = store.ecgReports.find((r) => r.date === date && r.source === 'seed');
      if (existing) return res.json(existing);
    }
    const row = {
      id: crypto.randomUUID(),
      date,
      bpm: Math.round(Number(bpm)),
      samples: samples.map(Number).filter(Number.isFinite),
      classification: classification || 'Inconclusive',
      findings: Array.isArray(findings) ? findings : [],
      status: status || 'CHECK',
      durationSec: Number(durationSec) || 12,
      rrCv: Number.isFinite(Number(rrCv)) ? Number(rrCv) : null,
      source: src,
      createdAt: createdAt || new Date().toISOString(),
    };
    store.ecgReports.push(row);
    saveStore(store);
    res.status(201).json(row);
  });

  app.get('/api/bp', (req, res) => {
    const { date } = req.query;
    const rows = loadStore().bpReadings;
    res.json(newestFirst(date ? rows.filter((r) => r.date === date) : rows));
  });

  app.post('/api/bp', (req, res) => {
    const { date, systolic, diastolic, hour, source, createdAt } = req.body || {};
    const sys = Math.round(Number(systolic));
    const dia = Math.round(Number(diastolic));
    if (!date || !Number.isFinite(sys) || !Number.isFinite(dia)) {
      return res.status(400).json({ error: 'date, systolic, and diastolic are required' });
    }
    if (sys < 70 || sys > 220 || dia < 40 || dia > 130 || dia >= sys) {
      return res.status(400).json({ error: 'reading out of range' });
    }
    const src = source || 'cuff';
    const hr = hour == null || hour === '' ? null : Number(hour);
    const store = loadStore();
    const match = (r) => r.date === date && r.source === src && r.hour === hr;
    const row = {
      id: crypto.randomUUID(),
      date,
      systolic: sys,
      diastolic: dia,
      pulsePressure: sys - dia,
      hour: Number.isFinite(hr) ? hr : null,
      source: src,
      createdAt: createdAt || new Date().toISOString(),
    };
    const i = store.bpReadings.findIndex(match);
    if (i >= 0) {
      store.bpReadings[i] = { ...row, id: store.bpReadings[i].id };
      saveStore(store);
      return res.json(store.bpReadings[i]);
    }
    store.bpReadings.push(row);
    saveStore(store);
    res.status(201).json(row);
  });
}
