import assert from 'node:assert/strict';
import test from 'node:test';
import { detectSampleGaps, summarizeCoverage } from '../ingest/gaps.js';
import { applyB2Lifecycle, desiredLifecycleRules } from '../storage/b2Lifecycle.js';

test('detectSampleGaps counts a 10s hole as missing samples', () => {
  const gaps = detectSampleGaps([
    { datetime: '2026-08-24T18:00:00.000Z', seq: 1 },
    { datetime: '2026-08-24T18:00:04.000Z', seq: 2 },
    { datetime: '2026-08-24T18:00:20.000Z', seq: 3 },
  ]);
  assert.equal(gaps.length, 1);
  assert.equal(gaps[0].kind, 'missing_interval');
  assert.equal(gaps[0].expected_samples, 3);
  const coverage = summarizeCoverage([
    { datetime: '2026-08-24T18:00:00.000Z' },
    { datetime: '2026-08-24T18:00:04.000Z' },
    { datetime: '2026-08-24T18:00:20.000Z' },
  ], gaps);
  assert.equal(coverage.gap_count, 1);
  assert.equal(coverage.complete, false);
});

test('B2 lifecycle prefixes match from the start of the key', () => {
  const rules = desiredLifecycleRules({ retentionPpgDays: 30, retentionImuDays: 30, retentionDiagDays: 7 });
  assert.equal(rules[0].fileNamePrefix, '');
  assert.ok(rules.some((r) => r.fileNamePrefix === 'v3/ppg/' && r.daysFromUploadingToHiding === 30));
  assert.ok(rules.some((r) => r.fileNamePrefix === 'v3/imu/'));
  assert.ok(rules.some((r) => r.fileNamePrefix === 'v3/diag/' && r.daysFromUploadingToHiding === 7));
  assert.ok(rules.some((r) => r.fileNamePrefix === 'v3/export/'));
  assert.equal(rules.some((r) => r.fileNamePrefix.includes('/raw/ppg/')), false);
  // The corpus prefix must carry an explicit never-hide rule, and no desired rule may hide it.
  assert.ok(rules.some(
    (r) => r.fileNamePrefix === 'v3/research/' && r.daysFromUploadingToHiding == null,
  ));
  assert.deepEqual(
    rules.filter((r) => 'v3/research/'.startsWith(r.fileNamePrefix) && r.daysFromUploadingToHiding != null),
    [],
    'a lifecycle rule would delete the corpus underneath its manifests',
  );
});

test('lifecycle check names the bucket so a bucket-restricted key is not 401d', async () => {
  const cfg = {
    b2KeyId: 'k', b2ApplicationKey: 's', b2Bucket: 'FRWHOOP',
    retentionPpgDays: 30, retentionImuDays: 30, retentionDiagDays: 7,
  };
  const seen = [];
  const fetchImpl = async (url, init = {}) => {
    if (String(url).includes('b2_authorize_account')) {
      return {
        ok: true,
        json: async () => ({
          accountId: 'acct',
          authorizationToken: 'tok',
          apiUrl: 'https://api004.backblazeb2.com',
          s3ApiUrl: 'https://s3.us-west-004.backblazeb2.com',
        }),
      };
    }
    const body = JSON.parse(init.body || '{}');
    seen.push(body);
    // Backblaze rejects an unscoped listing from a bucket-restricted key.
    if (!body.bucketName) {
      return { ok: false, status: 401, text: async () => '{"code":"unauthorized"}' };
    }
    return {
      ok: true,
      json: async () => ({
        buckets: [{
          bucketName: 'FRWHOOP',
          bucketId: 'b1',
          lifecycleRules: desiredLifecycleRules(cfg),
        }],
      }),
    };
  };

  const out = await applyB2Lifecycle({ cfg, fetchImpl });
  assert.equal(out.ok, true);
  assert.equal(out.matched, true);
  assert.equal(seen[0].bucketName, 'FRWHOOP');
});
