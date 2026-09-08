import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

const PREFIX = 'v1';

function keyBytes(secret) {
  const raw = String(secret || '');
  if (!raw) return null;
  if (/^[0-9a-f]{64}$/i.test(raw)) return Buffer.from(raw, 'hex');
  return createHash('sha256').update(raw).digest();
}

export function credentialsConfigured(secret) {
  return Boolean(keyBytes(secret));
}

export function currentKeyVersion(env = process.env) {
  const n = Number(env.FRWHOOP_CREDENTIALS_KEY_VERSION || 1);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 1;
}

function parseCipher(text) {
  const parts = String(text).split(':');
  if (parts[0] !== PREFIX || parts.length < 4) return null;
  if (parts[1]?.startsWith('k')) {
    return {
      version: Number(parts[1].slice(1)) || 1,
      ivB64: parts[2],
      tagB64: parts[3],
      ctB64: parts[4],
    };
  }
  return {
    version: 1,
    ivB64: parts[1],
    tagB64: parts[2],
    ctB64: parts[3],
  };
}

function decryptWith(blob, secret) {
  const key = keyBytes(secret);
  if (!key) throw new Error('FRWHOOP_CREDENTIALS_KEY is required to read integration secrets');
  const parsed = parseCipher(blob);
  if (!parsed?.ivB64 || !parsed?.tagB64 || !parsed?.ctB64) {
    throw new Error('unrecognized_credential_cipher');
  }
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(parsed.ivB64, 'base64url'));
  decipher.setAuthTag(Buffer.from(parsed.tagB64, 'base64url'));
  const pt = Buffer.concat([
    decipher.update(Buffer.from(parsed.ctB64, 'base64url')),
    decipher.final(),
  ]);
  return JSON.parse(pt.toString('utf8'));
}

export function encryptJson(obj, secret, { version = 1 } = {}) {
  const key = keyBytes(secret);
  if (!key) throw new Error('FRWHOOP_CREDENTIALS_KEY is required to store integration secrets');
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const pt = Buffer.from(JSON.stringify(obj ?? {}), 'utf8');
  const ct = Buffer.concat([cipher.update(pt), cipher.final()]);
  const tag = cipher.getAuthTag();
  const ver = Number.isFinite(Number(version)) && Number(version) >= 1 ? Math.floor(Number(version)) : 1;
  return `${PREFIX}:k${ver}:${iv.toString('base64url')}:${tag.toString('base64url')}:${ct.toString('base64url')}`;
}

export function decryptJson(blob, secret, { previousSecret } = {}) {
  if (blob == null || blob === '') return {};
  if (typeof blob === 'object' && !Buffer.isBuffer(blob)) return blob;
  const text = String(blob);
  if (!text.startsWith(`${PREFIX}:`)) {
    throw new Error('plaintext_credentials_rejected');
  }
  try {
    return decryptWith(text, secret);
  } catch (err) {
    if (previousSecret && previousSecret !== secret) {
      return decryptWith(text, previousSecret);
    }
    throw err;
  }
}

export function publicConnectionRow(row) {
  if (!row) return null;
  const { tokens, ciphertext, nonce, ...rest } = row;
  return {
    ...rest,
    tokens: undefined,
    ciphertext: undefined,
    nonce: undefined,
    credentials_present: Boolean(row.credentials_present || (tokens && Object.keys(tokens).length)),
  };
}
