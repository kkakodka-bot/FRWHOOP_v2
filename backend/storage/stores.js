import { createS3, discoverS3Endpoint, createB2Bucket } from './s3.js';
import { storageConfig } from './config.js';

let cached;

export function resetStores() {
  cached = null;
}

async function b2Client(cfg) {
  let endpoint = cfg.b2S3Endpoint;
  let region = cfg.b2Region;
  if (!endpoint) {
    const discovered = await discoverS3Endpoint(cfg.b2KeyId, cfg.b2ApplicationKey);
    endpoint = discovered.s3ApiUrl;
    region = discovered.region || region;
  }
  return createS3({
    endpoint,
    bucket: cfg.b2Bucket,
    region,
    accessKeyId: cfg.b2KeyId,
    secretAccessKey: cfg.b2ApplicationKey,
    style: 'path',
  });
}

export async function getStores(cfg = storageConfig()) {
  if (cached) return cached;
  const b2Ready = Boolean(cfg.b2KeyId && cfg.b2ApplicationKey && cfg.b2Bucket);
  let raw = null;
  let derived = null;
  let rawKind = 'none';
  let derivedKind = 'none';

  if (b2Ready) {
    const client = await b2Client(cfg);
    raw = client;
    derived = client;
    rawKind = 'b2';
    derivedKind = 'b2';
  }

  cached = { raw, derived, rawKind, derivedKind, cfg };
  return cached;
}

export async function bootstrapStores(cfg = storageConfig()) {
  const out = { raw: null, derived: null, b2: null };
  if (cfg.b2KeyId && cfg.b2ApplicationKey && cfg.b2Bucket) {
    try {
      out.b2 = await createB2Bucket({
        keyId: cfg.b2KeyId,
        applicationKey: cfg.b2ApplicationKey,
        bucketName: cfg.b2Bucket,
      });
    } catch (error) {
      out.b2 = { error: String(error.message || error) };
    }
  }
  const stores = await getStores(cfg);
  out.raw = stores.rawKind;
  out.derived = stores.derivedKind;
  out.bucket = cfg.b2Bucket;
  return out;
}
