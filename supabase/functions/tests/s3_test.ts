// Phase 2 S3 coverage — mirror of the retired Node receiver plus the newly
// ported deleteObject path used by the account-deletion worker.
import { assertEquals, assert } from 'jsr:@std/assert';
import { createS3 } from '../_shared/s3.ts';

function xmlPage({ keys, truncated, token }: { keys: string[]; truncated: boolean; token: string | null }) {
  const contents = keys.map((k) => `<Contents><Key>${k}</Key></Contents>`).join('');
  const next = token ? `<NextContinuationToken>${token}</NextContinuationToken>` : '';
  return `<ListBucketResult><IsTruncated>${truncated}</IsTruncated>${next}${contents}</ListBucketResult>`;
}

function makeS3(impl: (url: string, init: any) => Promise<any>) {
  return createS3({
    endpoint: 'https://s3.example.test',
    bucket: 'FRWHOOP',
    region: 'us-west-004',
    accessKeyId: 'kid',
    secretAccessKey: 'secret',
    fetchImpl: impl as typeof fetch,
  });
}

Deno.test('s3 listPrefix follows continuation tokens past one page', async () => {
  const urls: string[] = [];
  const s3 = makeS3(async (url: string) => {
    urls.push(url);
    const token = new URL(String(url)).searchParams.get('continuation-token');
    if (!token) {
      return { ok: true, status: 200, headers: { get: () => null }, text: async () => xmlPage({ keys: ['a'], truncated: true, token: 'page-2' }) };
    }
    assertEquals(token, 'page-2');
    return { ok: true, status: 200, headers: { get: () => null }, text: async () => xmlPage({ keys: ['b'], truncated: false, token: null }) };
  });
  const keys = await s3.listPrefix('v3/core/users/x/');
  assertEquals(keys, ['a', 'b']);
  assertEquals(urls.length, 2);
});

Deno.test('s3 listPrefix stops on an untruncated single page', async () => {
  const urls: string[] = [];
  const s3 = makeS3(async (url: string) => {
    urls.push(String(url));
    return { ok: true, status: 200, headers: { get: () => null }, text: async () => xmlPage({ keys: ['only'], truncated: false, token: null }) };
  });
  const keys = await s3.listPrefix('v1/metrics/');
  assertEquals(keys, ['only']);
  assertEquals(urls.length, 1);
});

Deno.test('s3 deleteObject treats a missing object as deleted and reports it', async () => {
  const s3 = makeS3(async () => ({ ok: true, status: 404, headers: { get: () => null }, text: async () => '' }));
  const out = await s3.deleteObject('v2/users/x/devices/d/raw/hr/k.ndjson.gz');
  assertEquals(out, { deleted: true, missing: true });
});

Deno.test('s3 deleteObject reports a server error instead of swallowing it', async () => {
  const s3 = makeS3(async () => ({ ok: false, status: 500, headers: { get: () => null }, text: async () => 'boom' }));
  let threw = false;
  try {
    await s3.deleteObject('k');
  } catch (e) {
    threw = true;
    assert(String(e).includes('object delete failed'));
  }
  assert(threw, 'deleteObject must throw on a non-404 failure');
});
