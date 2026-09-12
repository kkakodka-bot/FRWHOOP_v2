
// Scheduled retention sweep (Phase 2 port of the retired Node receiver sweepExpiredManifests).
// Invoked by pg_cron via pg_net; auth = WORKER_SECRET env (set with `supabase secrets set`)
// matching the Authorization bearer the cron sends, or the service-role key locally.
import { createSupabaseRest, restConfigFromEnv } from '../_shared/rest.ts';
import { pushConfig } from '../_shared/config.ts';
import { createS3 } from '../_shared/s3.ts';
import { sweepExpiredManifests } from '../_shared/workers.ts';
import { authorizeWorkerRequest, unauthorizedWorkerResponse } from '../_shared/workerAuth.ts';

const cfg = pushConfig();
const rest = createSupabaseRest({ cfg: restConfigFromEnv() });
const raw = cfg.b2KeyId && cfg.b2ApplicationKey && cfg.b2Bucket && cfg.b2S3Endpoint
  ? createS3({ endpoint: cfg.b2S3Endpoint, bucket: cfg.b2Bucket, region: cfg.b2Region,
               accessKeyId: cfg.b2KeyId, secretAccessKey: cfg.b2ApplicationKey, style: 'path' })
  : null;

Deno.serve(async (req: Request) => {
  if (!authorizeWorkerRequest(req, cfg)) return unauthorizedWorkerResponse();
  if (!raw) return Response.json({ error: 'archive_not_configured' }, { status: 503 });
  try {
    const report = await sweepExpiredManifests({ rest, objectStore: raw });
    return Response.json({ ok: true, report });
  } catch (err: any) {
    console.error('[retention-sweep] failed:', err?.stack || err);
    return Response.json({ ok: false, error: String(err?.message || err).slice(0, 300) }, { status: 500 });
  }
});
