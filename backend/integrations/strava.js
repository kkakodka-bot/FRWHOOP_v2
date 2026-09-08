/**
 * Strava OAuth + token lifecycle. Pure functions with injectable fetch so the
 * whole flow is testable without network. Secrets come from env only:
 *   STRAVA_CLIENT_ID, STRAVA_CLIENT_SECRET, STRAVA_REDIRECT_URI
 * Create an app at https://www.strava.com/settings/api to get credentials.
 */

const AUTH_BASE = 'https://www.strava.com/oauth/authorize';
const TOKEN_URL = 'https://www.strava.com/oauth/token';
const DEAUTH_URL = 'https://www.strava.com/oauth/deauthorize';

export const STRAVA_SCOPE = 'read,activity:read_all';

export function stravaConfig(env = process.env) {
  const pick = (name) => {
    const v = env[name];
    return v != null && String(v).trim() !== '' ? String(v).trim() : '';
  };
  const clientId = pick('STRAVA_CLIENT_ID');
  const clientSecret = pick('STRAVA_CLIENT_SECRET');
  const redirectUri = pick('STRAVA_REDIRECT_URI')
    || `http://localhost:${pick('PORT') || '8080'}/api/integrations/strava/callback`;
  return {
    clientId,
    clientSecret,
    redirectUri,
    configured: Boolean(clientId && clientSecret),
  };
}

export function authorizeUrl({ clientId, redirectUri, state, scope = STRAVA_SCOPE }) {
  const q = new URLSearchParams({
    client_id: String(clientId),
    redirect_uri: redirectUri,
    response_type: 'code',
    approval_prompt: 'auto',
    scope,
  });
  if (state) q.set('state', String(state));
  return `${AUTH_BASE}?${q.toString()}`;
}

async function postForm(url, params, fetchImpl) {
  const res = await fetchImpl(url, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params).toString(),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const msg = data?.message || data?.errors?.[0]?.code || `strava_http_${res.status}`;
    throw new Error(msg);
  }
  return data;
}

/** code → tokens + athlete. Throws with Strava's error message on failure. */
export async function exchangeCode(code, cfg, fetchImpl = fetch) {
  const data = await postForm(TOKEN_URL, {
    client_id: cfg.clientId,
    client_secret: cfg.clientSecret,
    code,
    grant_type: 'authorization_code',
  }, fetchImpl);
  return normalizeTokenResponse(data);
}

export async function refreshTokens(refreshToken, cfg, fetchImpl = fetch) {
  const data = await postForm(TOKEN_URL, {
    client_id: cfg.clientId,
    client_secret: cfg.clientSecret,
    refresh_token: refreshToken,
    grant_type: 'refresh_token',
  }, fetchImpl);
  return normalizeTokenResponse(data);
}

export async function deauthorize(accessToken, fetchImpl = fetch) {
  const res = await fetchImpl(DEAUTH_URL, {
    method: 'POST',
    headers: { authorization: `Bearer ${accessToken}` },
  });
  return res.ok;
}

function normalizeTokenResponse(data) {
  if (!data?.access_token) throw new Error('strava_token_missing');
  return {
    access_token: data.access_token,
    refresh_token: data.refresh_token || null,
    expires_at: data.expires_at || null, // unix seconds
    athlete: data.athlete || null,
  };
}

/** Public, non-secret athlete shape safe to send to the frontend. */
export function athleteMeta(athlete) {
  if (!athlete || typeof athlete !== 'object') return {};
  const name = [athlete.firstname, athlete.lastname].filter(Boolean).join(' ').trim();
  return {
    id: athlete.id ?? null,
    name: name || athlete.username || null,
    username: athlete.username || null,
    profile: athlete.profile_medium || athlete.profile || null,
  };
}

export function tokensExpired(tokens, skewSec = 300) {
  const exp = Number(tokens?.expires_at);
  if (!Number.isFinite(exp) || exp <= 0) return false;
  return exp * 1000 <= Date.now() + skewSec * 1000;
}
