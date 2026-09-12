// Fail-closed bearer auth for scheduled workers and ops-only diagnostics.
// Accepts WORKER_SECRET (cron/pg_net) or the service-role JWT — never anonymous.

import type { PushFunctionConfig } from './config.ts';

export function authorizeWorkerRequest(
  req: Request,
  cfg: Pick<PushFunctionConfig, 'supabaseServiceRoleKey'>,
): boolean {
  const workerSecret = Deno.env.get('WORKER_SECRET') || '';
  const bearer = (req.headers.get('authorization') || '').replace(/^Bearer /i, '');
  const okSecret = workerSecret !== '' && bearer === workerSecret;
  const okService = cfg.supabaseServiceRoleKey !== '' && bearer === cfg.supabaseServiceRoleKey;
  return okSecret || okService;
}

export function unauthorizedWorkerResponse(): Response {
  return Response.json({ error: 'unauthorized' }, { status: 401 });
}
