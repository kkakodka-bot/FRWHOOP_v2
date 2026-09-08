import { gunzipSync } from 'node:zlib';
import {
  INGEST_ENABLED_STREAMS,
  PushProtocolError,
  advertisedStreams,
  capabilitiesBody,
  negotiateProtocol,
} from '../ingest/pushRegistry.js';
import { UPLOAD_URL_TTL_SEC } from '../ingest/pushObjects.js';
import { MAX_OBJECT_LANE_BYTES } from '../storage/retention.js';

const MAX_BODY_BYTES = 4 * 1024 * 1024 + 64 * 1024;

/** Cap on an intent body. A manifest is a few hundred bytes; anything larger is not one. */
const MAX_INTENT_BYTES = 8 * 1024;

export const OBJECT_LANE_PATH = '/api/push/objects';

function protocolError(res, err) {
  const status = err?.status || 500;
  const body = { type: 'error', protocolVersion: '1.2', code: err?.code || err?.message || 'push_failed' };
  if (Array.isArray(err?.fields)) body.fields = err.fields;
  return res.status(status).json(body);
}

function readRawBody(req, res, next) {
  const chunks = [];
  req.on('data', (chunk) => chunks.push(chunk));
  req.on('end', () => {
    req.body = Buffer.concat(chunks);
    next();
  });
  req.on('error', (err) => next(err));
}

export function registerPushRoutes(app, {
  resolvePushUser,
  pushIngest,
  pushObjects,
  ingestEnabledStreams = INGEST_ENABLED_STREAMS,
  receiverStateId = '00000000-0000-4000-8000-00000000push',
} = {}) {
  app.get('/api/push', async (req, res) => {
    try {
      const user = await resolvePushUser(req, res);
      if (!user) return;
      const version = negotiateProtocol(req.headers['noop-push-accept-version']);
      if (!version) return res.status(406).json({ type: 'error', protocolVersion: '1.2', code: 'unsupported_version' });
      const body = capabilitiesBody({
        protocolVersion: version,
        receiverStateId,
        streams: advertisedStreams(version, ingestEnabledStreams),
        userId: user.id,
        // Advertised whenever the lane can actually sign a URL. A sender that sees no `objectLane`
        // must keep its raw rows rather than assume they were taken.
        objectLane: pushObjects?.configured
          ? {
            endpoint: OBJECT_LANE_PATH,
            maxObjectBytes: MAX_OBJECT_LANE_BYTES,
            urlTtlSec: UPLOAD_URL_TTL_SEC,
          }
          : null,
      });
      return res.json(body);
    } catch (err) {
      const status = err.status || 500;
      return res.status(status).json({ type: 'error', protocolVersion: '1.2', code: err.code || 'push_failed' });
    }
  });

  /**
   * Object-lane intent. Takes the manifest the device already computes and returns a presigned PUT.
   * The payload is NOT posted here — it goes straight to the bucket, and this process never sees it.
   */
  app.post(OBJECT_LANE_PATH, readRawBody, async (req, res) => {
    try {
      const user = await resolvePushUser(req, res);
      if (!user) return;
      if (!pushObjects?.configured) {
        return res.status(503).json({ type: 'error', protocolVersion: '1.2', code: 'object_lane_unavailable' });
      }
      const body = Buffer.from(req.body || []);
      if (body.length > MAX_INTENT_BYTES) {
        return res.status(413).json({ type: 'error', protocolVersion: '1.2', code: 'payload_too_large' });
      }
      let manifest;
      try {
        manifest = JSON.parse(body.toString('utf8'));
      } catch {
        return res.status(400).json({ type: 'error', protocolVersion: '1.2', code: 'malformed_manifest' });
      }
      const intent = await pushObjects.createIntent({ userId: user.id, manifest });
      return res.status(200).json({ type: 'objectIntent', protocolVersion: '1.2', ...intent });
    } catch (err) {
      if (err instanceof PushProtocolError) return protocolError(res, err);
      console.error('[push] object intent failed:', err?.stack || err);
      return res.status(500).json({ type: 'error', protocolVersion: '1.2', code: 'push_failed' });
    }
  });

  /** Completion. Verifies the byte count committed at intent, then releases the device's rows. */
  app.post(`${OBJECT_LANE_PATH}/:objectId/complete`, async (req, res) => {
    try {
      const user = await resolvePushUser(req, res);
      if (!user) return;
      if (!pushObjects?.configured) {
        return res.status(503).json({ type: 'error', protocolVersion: '1.2', code: 'object_lane_unavailable' });
      }
      const ack = await pushObjects.completeObject({ userId: user.id, objectId: req.params.objectId });
      return res.status(200).json({ type: 'objectAck', protocolVersion: '1.2', ...ack });
    } catch (err) {
      if (err instanceof PushProtocolError) return protocolError(res, err);
      console.error('[push] object complete failed:', err?.stack || err);
      return res.status(500).json({ type: 'error', protocolVersion: '1.2', code: 'push_failed' });
    }
  });

  app.post('/api/push', readRawBody, async (req, res) => {
    try {
      const user = await resolvePushUser(req, res);
      if (!user) return;
      let body = Buffer.from(req.body || []);
      if (body.length > MAX_BODY_BYTES) {
        return res.status(413).json({ type: 'error', protocolVersion: '1.1', code: 'payload_too_large' });
      }
      const encoding = String(req.headers['content-encoding'] || '').toLowerCase();
      if (encoding === 'gzip') {
        try {
          body = gunzipSync(body);
        } catch {
          return res.status(400).json({ type: 'error', protocolVersion: '1.1', code: 'invalid_gzip' });
        }
      }
      if (body.length > 4 * 1024 * 1024) {
        return res.status(413).json({ type: 'error', protocolVersion: '1.1', code: 'decoded_body_too_large' });
      }
      const ack = await pushIngest.acceptBatch({ userId: user.id, decodedBody: body });
      return res.status(200).json(ack);
    } catch (err) {
      if (err instanceof PushProtocolError) {
        return res.status(err.status).json({ type: 'error', protocolVersion: '1.1', code: err.message });
      }
      if (err.message === 'batch_id_conflict') {
        return res.status(409).json({ type: 'error', protocolVersion: '1.1', code: 'batch_id_conflict' });
      }
      // The client can attribute every other branch from its receiver code; this one it sees as a bare
      // 500. Log the cause here or the only record of why a batch was refused is lost.
      console.error('[push] unexpected ingest failure:', err?.stack || err);
      return res.status(500).json({ type: 'error', protocolVersion: '1.1', code: 'push_failed' });
    }
  });
}

export function defaultReceiverStateId(cfg) {
  const seed = `${cfg?.localUserId || ''}|${cfg?.supabaseUrl || ''}|frwhoop-push`;
  let hash = 0;
  for (let i = 0; i < seed.length; i += 1) hash = ((hash << 5) - hash + seed.charCodeAt(i)) | 0;
  const hex = Math.abs(hash).toString(16).padStart(8, '0');
  return `${hex.slice(0, 8)}-0000-4000-8000-${hex.padStart(12, '0').slice(0, 12)}`;
}
