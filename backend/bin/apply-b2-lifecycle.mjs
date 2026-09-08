// Applies the desired B2 lifecycle rules to the configured bucket, then verifies no rule hides
// v3/research/. Exits non-zero unless the bucket ends up in the desired state.
import { applyB2Lifecycle } from '../storage/b2Lifecycle.js';

const out = await applyB2Lifecycle({ apply: true });
console.log(JSON.stringify(out, null, 2));
if (!out.ok || !out.matched) process.exit(1);
const rules = out.rules || [];
const hiding = rules.filter(
  (r) => 'v3/research/'.startsWith(String(r.fileNamePrefix || ''))
    && r.daysFromUploadingToHiding != null,
);
if (hiding.length) {
  console.error(`DANGER: rules still hide v3/research/: ${JSON.stringify(hiding)}`);
  process.exit(1);
}
console.log('OK: bucket matches desired rules; no rule hides v3/research/');
