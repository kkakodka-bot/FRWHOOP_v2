/**
 * Verify checksums and write immutable dataset manifests.
 * Run: node energy/v3/datasets.prepare.mjs
 */
import {
  WEEE, HABITS, verifyZip, weeeZip, habitsZip, weeeManifest, habitsManifest,
  writeManifest, manifestDir,
} from './datasets.js';

const weee = verifyZip(weeeZip(), WEEE);
const habits = verifyZip(habitsZip(), HABITS);
if (weee.ok) writeManifest(weeeManifest(weee), `${manifestDir()}/weee.json`);
if (habits.ok) writeManifest(habitsManifest(habits), `${manifestDir()}/habits-inlab.json`);
console.log(JSON.stringify({ weee, habits: { ok: habits.ok, md5: habits.md5, bytes: habits.bytes, reason: habits.reason } }, null, 2));
if (!weee.ok || !habits.ok) process.exit(1);
