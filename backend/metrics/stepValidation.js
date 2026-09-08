import { randomUUID } from 'node:crypto';
import { resolveRequestUser } from '../identity/resolveUser.js';
import { isUuid } from '../storage/keys.js';

export const STEP_LABEL_SOURCES = new Set([
  'video_manual',
  'apple_watch',
  'public_ground_truth',
  'synthetic',
]);

const WRISTS = new Set(['left', 'right', 'unknown']);

function text(value, maxLength) {
  const normalized = typeof value === 'string' ? value.trim() : '';
  return normalized && normalized.length <= maxLength ? normalized : null;
}

function timestamp(value) {
  const parsed = Date.parse(value || '');
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

export function normalizeStepValidationSession(body = {}, userId, idFactory = randomUUID) {
  if (!isUuid(userId)) throw new Error('authenticated_user_required');
  const start = timestamp(body.requested_start ?? body.start_at ?? body.start);
  const end = timestamp(body.requested_end ?? body.end_at ?? body.end);
  if (!start || !end || Date.parse(end) <= Date.parse(start)) {
    throw new Error('invalid_validation_window');
  }
  const scenario = text(body.scenario, 160);
  const participantKey = text(body.participant_key ?? body.participantKey, 160);
  if (!scenario || !participantKey) throw new Error('scenario_and_participant_required');
  const labelSource = text(body.label_source ?? body.labelSource, 40);
  if (!STEP_LABEL_SOURCES.has(labelSource)) throw new Error('invalid_label_source');
  const wrist = text(body.wrist, 16) || 'unknown';
  if (!WRISTS.has(wrist)) throw new Error('invalid_wrist');
  const trueCount = Number(body.true_count ?? body.trueCount);
  if (!Number.isInteger(trueCount) || trueCount < 0) throw new Error('invalid_true_count');

  const rawRefs = [...new Set((body.raw_imu_refs ?? body.rawImuRefs ?? [])
    .map((value) => text(value, 1024))
    .filter(Boolean))].sort();
  const events = body.event_timestamps ?? body.eventTimestamps ?? null;
  let eventTimestamps = null;
  if (events != null) {
    if (!Array.isArray(events)) throw new Error('invalid_event_timestamps');
    eventTimestamps = events.map(timestamp);
    if (eventTimestamps.some((value) => !value)) throw new Error('invalid_event_timestamps');
    eventTimestamps.sort();
    if (eventTimestamps.length !== trueCount) throw new Error('event_count_mismatch');
    if (eventTimestamps.some((value) => value < start || value > end)) {
      throw new Error('event_outside_validation_window');
    }
  }
  if (labelSource === 'apple_watch' && eventTimestamps?.length) {
    throw new Error('apple_watch_has_no_step_event_ground_truth');
  }

  const suppliedId = body.id == null ? null : text(body.id, 64);
  if (suppliedId && !isUuid(suppliedId)) throw new Error('invalid_validation_session_id');
  const metadata = body.metadata && typeof body.metadata === 'object' && !Array.isArray(body.metadata)
    ? body.metadata
    : {};
  return {
    id: suppliedId || idFactory(),
    user_id: userId,
    requested_start: start,
    requested_end: end,
    scenario,
    device: body.device && typeof body.device === 'object' && !Array.isArray(body.device)
      ? body.device
      : {},
    firmware: text(body.firmware, 160),
    wrist,
    participant_key: participantKey,
    raw_imu_refs: rawRefs,
    label_source: labelSource,
    true_count: trueCount,
    event_timestamps: eventTimestamps,
    metadata: {
      ...metadata,
      accuracy_eligible: labelSource === 'video_manual' || labelSource === 'public_ground_truth',
      agreement_only: labelSource === 'apple_watch',
      synthetic: labelSource === 'synthetic',
    },
  };
}

async function defaultResolveUser(req) {
  try {
    return (await resolveRequestUser({ headers: req.headers || {} })).id;
  } catch {
    return null;
  }
}

export function registerStepValidationRoutes(app, { rest, resolveUser = defaultResolveUser } = {}) {
  app.post('/api/steps/validation-sessions', async (req, res) => {
    const userId = await resolveUser(req);
    if (!userId) return res.status(401).json({ ok: false, error: 'auth_required' });
    if (!rest?.configured) {
      return res.status(503).json({ ok: false, error: 'validation_storage_unavailable' });
    }
    try {
      const row = normalizeStepValidationSession(req.body || {}, userId);
      const persisted = await rest.upsert('step_validation_sessions', row, { onConflict: 'id' });
      return res.status(201).json({ ok: true, session: Array.isArray(persisted) ? persisted[0] : persisted });
    } catch (error) {
      const message = error?.message || 'validation_session_write_failed';
      const invalid = /^(invalid_|scenario_|event_|apple_watch_)/.test(message);
      return res.status(invalid ? 400 : 503).json({ ok: false, error: message });
    }
  });

  app.get('/api/steps/validation-sessions', async (req, res) => {
    const userId = await resolveUser(req);
    if (!userId) return res.status(401).json({ ok: false, error: 'auth_required' });
    if (!rest?.configured) {
      return res.status(503).json({ ok: false, error: 'validation_storage_unavailable' });
    }
    const accuracyOnly = String(req.query?.accuracy_eligible || '') === 'true';
    const source = text(req.query?.label_source, 40);
    if (source && !STEP_LABEL_SOURCES.has(source)) {
      return res.status(400).json({ ok: false, error: 'invalid_label_source' });
    }
    const table = accuracyOnly ? 'step_validation_ground_truth' : 'step_validation_nonsynthetic';
    const filter = [
      `user_id=eq.${userId}`,
      ...(source ? [`label_source=eq.${encodeURIComponent(source)}`] : []),
      'order=requested_start.desc',
      'limit=500',
      'select=*',
    ].join('&');
    try {
      const rows = await rest.select(table, filter);
      return res.json({
        ok: true,
        evidence_role: accuracyOnly ? 'accuracy_ground_truth' : 'nonsynthetic_includes_watch_agreement',
        sessions: rows || [],
      });
    } catch (error) {
      return res.status(503).json({
        ok: false,
        error: error?.message || 'validation_session_read_failed',
      });
    }
  });
}
