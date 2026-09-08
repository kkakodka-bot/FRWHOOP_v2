import assert from 'node:assert/strict';
import test from 'node:test';
import { createS3 } from '../storage/s3.js';

function xmlPage({ keys, truncated, token }) {
  const contents = keys.map((k) => `<Contents><Key>${k}</Key></Contents>`).join('');
  const next = token ? `<NextContinuationToken>${token}</NextContinuationToken>` : '';
  return `<ListBucketResult><IsTruncated>${truncated}</IsTruncated>${next}${contents}</ListBucketResult>`;
}

test('listPrefix follows continuation tokens past one page', async () => {
  const urls = [];
  const s3 = createS3({
    endpoint: 'https://s3.example.test',
    bucket: 'FRWHOOP',
    region: 'us-west-004',
    accessKeyId: 'kid',
    secretAccessKey: 'secret',
    fetchImpl: async (url) => {
      urls.push(url);
      const token = new URL(url).searchParams.get('continuation-token');
      if (!token) {
        return { ok: true, async text() { return xmlPage({ keys: ['a'], truncated: true, token: 'page-2' }); } };
      }
      assert.equal(token, 'page-2');
      return { ok: true, async text() { return xmlPage({ keys: ['b'], truncated: false, token: null }); } };
    },
  });
  const keys = await s3.listPrefix('v3/core/users/x/');
  assert.deepEqual(keys, ['a', 'b']);
  assert.equal(urls.length, 2);
});
