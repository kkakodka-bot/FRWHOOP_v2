// Owner score readback. Same bearer as push (Supabase JWT or opaque noop_ ingest token).
import { createSupabaseRest, restConfigFromEnv } from '../_shared/rest.ts';
import { pushConfig } from '../_shared/config.ts';
import { handleScoresRequest } from '../_shared/serverScores.ts';

const cfg = pushConfig();
const rest = createSupabaseRest({ cfg: restConfigFromEnv() });

Deno.serve((req: Request) => handleScoresRequest(req, { rest, cfg }));
