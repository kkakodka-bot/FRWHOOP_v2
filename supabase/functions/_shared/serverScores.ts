import { IdentityError, resolvePushUser } from './tokens.ts';
import type { PushFunctionConfig } from './config.ts';
import type { SupabaseRest } from './rest.ts';

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

export function utcDay(at = new Date()): string {
  return at.toISOString().slice(0, 10);
}

export async function readOwnerDayScores({
  rest,
  userId,
  day,
}: {
  rest: Pick<SupabaseRest, 'rpc'>;
  userId: string;
  day: string;
}) {
  if (!DAY_RE.test(day)) {
    const err: any = new Error('invalid day');
    err.status = 400;
    err.code = 'invalid_day';
    throw err;
  }
  const overlay = await rest.rpc('server_scoring_for_day', {
    p_user: userId,
    p_day: day,
  });
  return { server_scoring: overlay };
}

export async function handleScoresRequest(
  req: Request,
  {
    rest,
    cfg,
    fetchImpl = fetch,
  }: {
    rest: SupabaseRest;
    cfg: Pick<PushFunctionConfig, 'supabaseUrl' | 'supabaseAnonKey'>;
    fetchImpl?: typeof fetch;
  },
): Promise<Response> {
  if (req.method !== 'GET') {
    return Response.json({ error: 'method_not_allowed' }, { status: 405 });
  }
  if (!rest.configured) {
    return Response.json({ error: 'service_role_unconfigured' }, { status: 503 });
  }
  try {
    const user = await resolvePushUser({
      headers: req.headers,
      rest,
      supabaseUrl: cfg.supabaseUrl,
      anonKey: cfg.supabaseAnonKey,
      fetchImpl,
    });
    const url = new URL(req.url);
    const day = url.searchParams.get('day') || utcDay();
    const body = await readOwnerDayScores({ rest, userId: user.id, day });
    return Response.json(body);
  } catch (err: any) {
    if (err instanceof IdentityError) {
      return Response.json({ error: 'unauthorized' }, { status: err.status || 401 });
    }
    if (err?.code === 'invalid_day') {
      return Response.json({ error: 'invalid day' }, { status: 400 });
    }
    console.error('[scores] failed:', err?.stack || err);
    return Response.json({ error: 'scores_unavailable' }, { status: 500 });
  }
}
