#!/usr/bin/env node
import assert from 'node:assert/strict';
import { assertCanonicalMigrationLineage } from '../metrics/schemaReadiness.js';
import { assertProductionRuntime, storageConfig } from '../storage/config.js';

const lineage = assertCanonicalMigrationLineage();
assert.ok(lineage.files.length > 0, 'canonical migrations must exist');

const emptyProd = {
  NODE_ENV: 'production',
  FRWHOOP_RUNTIME: 'production',
};
const missing = assertProductionRuntime(storageConfig(emptyProd), emptyProd);
assert.ok(missing.includes('SUPABASE_URL'));
assert.ok(missing.includes('SUPABASE_SERVICE_ROLE_KEY'));
assert.ok(missing.includes('INGEST_SECRET'));
assert.ok(missing.includes('B2_KEY_ID/B2_APPLICATION_KEY'));
assert.ok(missing.includes('FRWHOOP_DEVICE_TOKEN'));

console.log(`validate-runtime ok migrations=${lineage.files.length}`);
