export function registerPushTokenRoutes(app, { requestUser, ingestTokenStore } = {}) {
  app.post('/api/push/tokens', async (req, res) => {
    const user = await requestUser(req, res);
    if (!user) return;
    if (!ingestTokenStore?.configured) {
      return res.status(503).json({ error: 'ingest token store unavailable' });
    }
    try {
      const label = req.body?.label;
      const minted = await ingestTokenStore.mint({ userId: user.id, label });
      return res.status(201).json({
        token: minted.token,
        ...minted.row,
      });
    } catch (err) {
      console.error('[push] mint ingest token failed:', err?.stack || err);
      return res.status(500).json({ error: 'ingest_token_mint_failed' });
    }
  });

  app.get('/api/push/tokens', async (req, res) => {
    const user = await requestUser(req, res);
    if (!user) return;
    if (!ingestTokenStore?.configured) {
      return res.status(503).json({ error: 'ingest token store unavailable' });
    }
    try {
      const tokens = await ingestTokenStore.list({ userId: user.id });
      return res.json({ tokens });
    } catch (err) {
      console.error('[push] list ingest tokens failed:', err?.stack || err);
      return res.status(500).json({ error: 'ingest_token_list_failed' });
    }
  });

  app.delete('/api/push/tokens/:id', async (req, res) => {
    const user = await requestUser(req, res);
    if (!user) return;
    if (!ingestTokenStore?.configured) {
      return res.status(503).json({ error: 'ingest token store unavailable' });
    }
    try {
      const revoked = await ingestTokenStore.revoke({ userId: user.id, id: req.params.id });
      if (!revoked) return res.status(404).json({ error: 'ingest_token_not_found' });
      return res.json(revoked);
    } catch (err) {
      console.error('[push] revoke ingest token failed:', err?.stack || err);
      return res.status(500).json({ error: 'ingest_token_revoke_failed' });
    }
  });
}
