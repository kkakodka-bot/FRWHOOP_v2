import { createHmac, createHash } from 'node:crypto';

function sha256Hex(data) {
  return createHash('sha256').update(data).digest('hex');
}

function hmac(key, data) {
  return createHmac('sha256', key).update(data).digest();
}

function amzDate(d) {
  return d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

function encodeRfc3986(s) {
  return encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

function canonicalQuery(params) {
  return Object.keys(params)
    .sort()
    .map((k) => `${encodeRfc3986(k)}=${encodeRfc3986(String(params[k]))}`)
    .join('&');
}

function signingKey(secret, dateStamp, region, service) {
  const kDate = hmac(`AWS4${secret}`, dateStamp);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, service);
  return hmac(kService, 'aws4_request');
}

function endpointHost(endpoint) {
  return String(endpoint).replace(/^https?:\/\//, '').replace(/\/$/, '');
}

function requestHost(endpoint, bucket, style) {
  const host = endpointHost(endpoint);
  return style === 'virtual' ? `${bucket}.${host}` : host;
}

function canonicalUri(bucket, key, style) {
  const encodedKey = key ? String(key).split('/').map(encodeRfc3986).join('/') : '';
  if (style === 'virtual') return encodedKey ? `/${encodedKey}` : '/';
  return encodedKey ? `/${encodeRfc3986(bucket)}/${encodedKey}` : `/${encodeRfc3986(bucket)}`;
}

/**
 * Object URL. Path-style for B2; virtual-hosted for AWS.
 */
export function objectUrl(endpoint, bucket, key, style = 'path') {
  const host = requestHost(endpoint, bucket, style);
  const uri = canonicalUri(bucket, key, style);
  return `https://${host}${uri}`;
}

export function presign({
  method,
  endpoint,
  bucket,
  key,
  region,
  accessKeyId,
  secretAccessKey,
  expiresSec,
  now = new Date(),
  headers = {},
  style = 'path',
}) {
  const host = requestHost(endpoint, bucket, style);
  const date = amzDate(now);
  const dateStamp = date.slice(0, 8);
  const credentialScope = `${dateStamp}/${region}/s3/aws4_request`;
  const uri = canonicalUri(bucket, key, style);
  const query = {
    'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
    'X-Amz-Credential': `${accessKeyId}/${credentialScope}`,
    'X-Amz-Date': date,
    'X-Amz-Expires': String(expiresSec),
    'X-Amz-SignedHeaders': 'host',
  };
  const canonicalHeaders = `host:${host}\n`;
  const canonicalRequest = [
    method.toUpperCase(),
    uri,
    canonicalQuery(query),
    canonicalHeaders,
    'host',
    'UNSIGNED-PAYLOAD',
  ].join('\n');
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    date,
    credentialScope,
    sha256Hex(canonicalRequest),
  ].join('\n');
  const sig = createHmac('sha256', signingKey(secretAccessKey, dateStamp, region, 's3'))
    .update(stringToSign)
    .digest('hex');
  const url = `https://${host}${uri}?${canonicalQuery(query)}&X-Amz-Signature=${sig}`;
  return { url, expiresAt: new Date(now.getTime() + expiresSec * 1000).toISOString(), headers };
}

function signedRequest({
  method,
  endpoint,
  bucket,
  key,
  region,
  accessKeyId,
  secretAccessKey,
  now,
  query = {},
  extraHeaders = {},
  payloadHash = 'UNSIGNED-PAYLOAD',
  style = 'path',
}) {
  const host = requestHost(endpoint, bucket, style);
  const date = amzDate(now);
  const dateStamp = date.slice(0, 8);
  const uri = canonicalUri(bucket, key, style);
  const q = canonicalQuery(query);
  const headers = {
    host,
    'x-amz-content-sha256': payloadHash,
    'x-amz-date': date,
  };
  for (const [name, value] of Object.entries(extraHeaders)) {
    if (value == null) continue;
    headers[String(name).toLowerCase()] = String(value);
  }
  const signed = Object.keys(headers).sort();
  const canonicalHeaders = signed.map((h) => `${h}:${headers[h]}\n`).join('');
  const canonicalRequest = [method, uri, q, canonicalHeaders, signed.join(';'), payloadHash].join('\n');
  const credentialScope = `${dateStamp}/${region}/s3/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', date, credentialScope, sha256Hex(canonicalRequest)].join('\n');
  const sig = createHmac('sha256', signingKey(secretAccessKey, dateStamp, region, 's3'))
    .update(stringToSign)
    .digest('hex');
  headers.authorization = `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${credentialScope}, SignedHeaders=${signed.join(';')}, Signature=${sig}`;
  const url = `https://${host}${uri}${q ? `?${q}` : ''}`;
  return { url, headers };
}

function asBuffer(body) {
  if (body == null) return Buffer.alloc(0);
  if (Buffer.isBuffer(body)) return body;
  if (body instanceof Uint8Array) return Buffer.from(body);
  return Buffer.from(String(body));
}

// ponytail: 1000 pages × 1000 keys. Upgrade: async iterator / prefix fan-out.
const LIST_PAGE_CAP = 1000;

function xmlTag(xml, tag) {
  const m = new RegExp(`<${tag}>([^<]*)</${tag}>`, 'i').exec(xml);
  return m ? m[1] : null;
}

function parseListObjectsV2(xml) {
  const keys = [];
  const re = /<Key>([^<]+)<\/Key>/g;
  let m;
  while ((m = re.exec(xml))) keys.push(m[1]);
  return {
    keys,
    truncated: /<IsTruncated>\s*true\s*<\/IsTruncated>/i.test(xml),
    token: xmlTag(xml, 'NextContinuationToken'),
  };
}

function parseListObjectVersions(xml) {
  const versions = [];
  const blockRe = /<(Version|DeleteMarker)>([\s\S]*?)<\/\1>/g;
  let block;
  while ((block = blockRe.exec(xml))) {
    const body = block[2];
    const key = /<Key>([^<]+)<\/Key>/.exec(body)?.[1];
    const versionId = /<VersionId>([^<]+)<\/VersionId>/.exec(body)?.[1] || null;
    const isLatest = /<IsLatest>\s*true\s*<\/IsLatest>/i.test(body);
    if (key) versions.push({ key, versionId, isLatest, deleteMarker: block[1] === 'DeleteMarker' });
  }
  return {
    versions,
    truncated: /<IsTruncated>\s*true\s*<\/IsTruncated>/i.test(xml),
    keyMarker: xmlTag(xml, 'NextKeyMarker'),
    versionIdMarker: xmlTag(xml, 'NextVersionIdMarker'),
  };
}

export function createS3({
  endpoint,
  bucket,
  region,
  accessKeyId,
  secretAccessKey,
  fetchImpl = fetch,
  style = 'path',
}) {
  const base = { endpoint, bucket, region, accessKeyId, secretAccessKey, style };

  return {
    bucket,
    region,
    endpoint,
    style,
    presignPut(key, expiresSec, now) {
      return presign({ method: 'PUT', ...base, key, expiresSec, now });
    },
    presignGet(key, expiresSec, now) {
      return presign({ method: 'GET', ...base, key, expiresSec, now });
    },
    async head(key) {
      const { url, headers } = signedRequest({
        method: 'HEAD', ...base, key, now: new Date(),
      });
      const res = await fetchImpl(url, { method: 'HEAD', headers });
      if (res.status === 404) return null;
      if (!res.ok) throw new Error('object head failed');
      const len = res.headers.get('content-length');
      return { exists: true, contentLength: len == null ? null : Number(len) };
    },
    async getObject(key) {
      const { url, headers } = signedRequest({
        method: 'GET', ...base, key, now: new Date(),
      });
      const res = await fetchImpl(url, { method: 'GET', headers });
      if (res.status === 404) return null;
      if (!res.ok) throw new Error('object get failed');
      return {
        body: Buffer.from(await res.arrayBuffer()),
        contentType: res.headers.get('content-type'),
        contentLength: Number(res.headers.get('content-length') || 0),
      };
    },
    async putObject(key, body, { contentType = 'application/octet-stream' } = {}) {
      const buf = asBuffer(body);
      const payloadHash = sha256Hex(buf);
      const { url, headers } = signedRequest({
        method: 'PUT',
        ...base,
        key,
        now: new Date(),
        payloadHash,
        extraHeaders: {
          'content-type': contentType,
          'content-length': String(buf.length),
        },
      });
      const res = await fetchImpl(url, { method: 'PUT', headers, body: buf });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`object put failed (${res.status}) ${text.slice(0, 180)}`);
      }
      return { etag: res.headers.get('etag'), bytes: buf.length };
    },
    async deleteObject(key, versionId) {
      const query = versionId ? { versionId } : {};
      const { url, headers } = signedRequest({
        method: 'DELETE', ...base, key, now: new Date(), query,
      });
      const res = await fetchImpl(url, { method: 'DELETE', headers });
      if (res.status === 404) return { deleted: true, missing: true, versionId: versionId || null };
      if (!res.ok) throw new Error('object delete failed');
      return { deleted: true, missing: false, versionId: versionId || null };
    },
    async listPrefix(prefix) {
      const keys = [];
      let token = null;
      for (let page = 0; page < LIST_PAGE_CAP; page += 1) {
        const query = { 'list-type': '2', prefix, 'max-keys': '1000' };
        if (token) query['continuation-token'] = token;
        const { url, headers } = signedRequest({
          method: 'GET', ...base, key: '', now: new Date(), query,
        });
        const res = await fetchImpl(url, { method: 'GET', headers });
        if (!res.ok) throw new Error('prefix list failed');
        const parsed = parseListObjectsV2(await res.text());
        keys.push(...parsed.keys);
        if (!parsed.truncated || !parsed.token) return keys;
        token = parsed.token;
      }
      return keys;
    },
    async listObjectVersions(prefix) {
      const versions = [];
      let keyMarker = null;
      let versionIdMarker = null;
      for (let page = 0; page < LIST_PAGE_CAP; page += 1) {
        const query = { versions: '', prefix, 'max-keys': '1000' };
        if (keyMarker) query['key-marker'] = keyMarker;
        if (versionIdMarker) query['version-id-marker'] = versionIdMarker;
        const { url, headers } = signedRequest({
          method: 'GET', ...base, key: '', now: new Date(), query,
        });
        const res = await fetchImpl(url, { method: 'GET', headers });
        if (!res.ok) throw new Error('version list failed');
        const parsed = parseListObjectVersions(await res.text());
        versions.push(...parsed.versions);
        if (!parsed.truncated) return versions;
        keyMarker = parsed.keyMarker;
        versionIdMarker = parsed.versionIdMarker;
        if (!keyMarker) return versions;
      }
      return versions;
    },
    async deletePrefixAllVersions(prefix) {
      let versions = [];
      try {
        versions = await this.listObjectVersions(prefix);
      } catch {
        versions = [];
      }
      const failures = [];
      let deleted = 0;
      for (const v of versions) {
        try {
          await this.deleteObject(v.key, v.versionId || undefined);
          deleted += 1;
        } catch {
          failures.push({ key: v.key, versionId: v.versionId });
        }
      }
      const leftover = await this.listPrefix(prefix);
      for (const key of leftover) {
        try {
          await this.deleteObject(key);
          deleted += 1;
        } catch {
          failures.push({ key, versionId: null });
        }
      }
      return { deleted, remaining: failures.length, failures };
    },
  };
}

export async function discoverS3Endpoint(keyId, applicationKey, fetchImpl = fetch) {
  const token = Buffer.from(`${keyId}:${applicationKey}`).toString('base64');
  const res = await fetchImpl('https://api.backblazeb2.com/b2api/v2/b2_authorize_account', {
    headers: { authorization: `Basic ${token}` },
  });
  if (!res.ok) throw new Error('b2 authorize failed');
  const body = await res.json();
  const s3ApiUrl = String(body.s3ApiUrl || '').replace(/\/$/, '');
  const regionMatch = /s3\.([a-z0-9-]+)\.backblazeb2\.com/i.exec(s3ApiUrl);
  return {
    s3ApiUrl,
    region: regionMatch ? regionMatch[1] : 'us-west-004',
    accountId: body.accountId || null,
    authorizationToken: body.authorizationToken || null,
    apiUrl: body.apiUrl || null,
  };
}

export async function createB2Bucket({ keyId, applicationKey, bucketName, fetchImpl = fetch }) {
  const auth = await discoverS3Endpoint(keyId, applicationKey, fetchImpl);
  if (!auth.apiUrl || !auth.authorizationToken || !auth.accountId) {
    throw new Error('b2 authorize missing account fields');
  }
  const res = await fetchImpl(`${String(auth.apiUrl).replace(/\/$/, '')}/b2api/v2/b2_create_bucket`, {
    method: 'POST',
    headers: {
      authorization: auth.authorizationToken,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      accountId: auth.accountId,
      bucketName,
      bucketType: 'allPrivate',
    }),
  });
  if (res.status === 400) {
    const body = await res.json().catch(() => ({}));
    if (String(body.code || '').includes('duplicate') || /already/i.test(String(body.message || ''))) {
      return { created: false, existing: true, bucketName, s3ApiUrl: auth.s3ApiUrl, region: auth.region };
    }
  }
  if (!res.ok) throw new Error('b2 create bucket failed');
  return { created: true, existing: false, bucketName, s3ApiUrl: auth.s3ApiUrl, region: auth.region };
}

export { sha256Hex };
