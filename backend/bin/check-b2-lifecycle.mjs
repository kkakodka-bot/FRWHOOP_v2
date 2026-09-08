// Read-only: report the live bucket lifecycle rules and whether any hide v3/research/.
import { applyB2Lifecycle } from '../storage/b2Lifecycle.js';

const out = await applyB2Lifecycle({ apply: false });
console.log(JSON.stringify(out, null, 2));
if (!out.ok) process.exit(1);
const rules = out.before || out.rules || [];
const hiding = rules.filter(
  (r) => 'v3/research/'.startsWith(String(r.fileNamePrefix || ''))
    && r.daysFromUploadingToHiding != null,
);
console.log(hiding.length
  ? `DANGER: ${hiding.length} rule(s) hide v3/research/: ${JSON.stringify(hiding)}`
  : 'OK: no live rule hides v3/research/');
