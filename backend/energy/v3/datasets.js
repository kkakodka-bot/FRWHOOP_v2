/**
 * Public calorimetry datasets for Energy V3 research.
 *
 * WEEE Zenodo 6420886 — Empatica E4 wrist ACC + VO2 Master.
 * HAbitsLab in-lab Zenodo 14858226 — 20 Hz wrist acc/gyro + MetCart.
 *
 * Never used as labels: Apple Watch, Fitbit, WHOOP, Google Fit, Freedson,
 * VM3, Ainsworth/Compendium, Study_Information MET_*, in-wild estimates.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const here = path.dirname(fileURLToPath(import.meta.url));
const BACKEND = path.join(here, '../..');

export const WEEE = Object.freeze({
  zenodo: '6420886',
  doi: '10.5281/zenodo.6420886',
  license: 'CC BY 4.0',
  filename: 'dataset.zip',
  md5: '23e411c566f1c734e74e23fa76bd1ab0',
  bytes: 651557047,
  url: 'https://zenodo.org/records/6420886/files/dataset.zip?download=1',
});

export const HABITS = Object.freeze({
  zenodo: '14858226',
  doi: '10.5281/zenodo.14858226',
  license: 'CC BY 4.0',
  filename: 'Phase 2 - Data.zip',
  md5: '1840803700111c0a1871e9af3eacc9be',
  bytes: 800154464,
  url: 'https://zenodo.org/records/14858226/files/Phase%202%20-%20Data.zip?download=1',
});

export const REFUSED_LABELS = Object.freeze([
  'Apple Watch calories',
  'Fitbit calories',
  'WHOOP calories',
  'Google Fit calories',
  'Freedson MET',
  'VM3 MET',
  'Ainsworth / Compendium MET',
  'Study_Information MET_* protocol labels',
  'in-wild / free-living estimates',
]);

export function weeeRoot(env = process.env) {
  return env.WEEE_ROOT || path.join(BACKEND, 'data/weee/dataset');
}

export function weeeZip(env = process.env) {
  return env.WEEE_ZIP || path.join(BACKEND, 'data/weee/dataset.zip');
}

export function habitsRoot(env = process.env) {
  return env.HABITS_INLAB_ROOT || path.join(BACKEND, 'data/habits/inlab');
}

export function habitsZip(env = process.env) {
  return env.HABITS_ZIP || path.join(BACKEND, 'data/habits/Phase 2 - Data.zip');
}

function hashFile(file, algo) {
  const h = crypto.createHash(algo);
  const fd = fs.openSync(file, 'r');
  const buf = Buffer.alloc(1024 * 1024);
  let n;
  while ((n = fs.readSync(fd, buf, 0, buf.length, null)) > 0) h.update(buf.subarray(0, n));
  fs.closeSync(fd);
  return h.digest('hex');
}

export function md5File(file) {
  return hashFile(file, 'md5');
}

export function sha256File(file) {
  return hashFile(file, 'sha256');
}

export function verifyZip(file, expected) {
  if (!fs.existsSync(file)) return { ok: false, reason: 'missing', file };
  const st = fs.statSync(file);
  if (expected.bytes && st.size !== expected.bytes) {
    return { ok: false, reason: 'size', file, bytes: st.size, expected: expected.bytes };
  }
  const md5 = md5File(file);
  if (md5 !== expected.md5) return { ok: false, reason: 'md5', file, md5, expected: expected.md5 };
  return { ok: true, file, bytes: st.size, md5, sha256: sha256File(file) };
}

function mkdirp(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

export function downloadIfNeeded(spec, destZip) {
  mkdirp(path.dirname(destZip));
  if (fs.existsSync(destZip) && fs.statSync(destZip).size === spec.bytes) {
    return { downloaded: false, path: destZip };
  }
  execFileSync('curl', ['-L', '--fail', '--retry', '3', '-o', destZip, spec.url], {
    stdio: 'inherit',
  });
  return { downloaded: true, path: destZip };
}

export function extractZip(zipPath, destDir) {
  mkdirp(destDir);
  execFileSync('unzip', ['-n', zipPath, '-d', destDir], { stdio: 'inherit' });
  return destDir;
}

export function refuseVendorLabel(name) {
  const n = String(name || '').toLowerCase();
  if (/(apple|whoop|fitbit|garmin|google\s*fit|ainsworth|compendium|freedson|\bvm3\b|in[_-]?wild)/.test(n)) {
    throw new Error(`vendor_or_estimate_label_refused:${name}`);
  }
}

export function weeeManifest(checksum) {
  return {
    id: 'weee-zenodo-6420886',
    source: { zenodo: WEEE.zenodo, doi: WEEE.doi, url: WEEE.url, title: 'WEEE multi-device energy expenditure' },
    license: WEEE.license,
    checksums: { 'dataset.zip': { md5: checksum.md5, sha256: checksum.sha256, bytes: checksum.bytes } },
    participants: 'P01–P17',
    device: 'Empatica E4',
    placement: 'wrist',
    sampling_rate_hz: { accel: 32, hr: 1, gyro: null },
    units: { accel: 'g after 1/64 g/LSB', gyro: 'absent', hr: 'bpm' },
    label: {
      derivation: 'gross_MET = mean(VO2[mL/kg/min]) / 3.5 from PXX/VO2/DataAverage.csv',
      refused: REFUSED_LABELS,
    },
    notes: 'Apple watch/ and Fitbit/ folders exist in the zip and are never read as labels.',
  };
}

export function habitsManifest(checksum) {
  return {
    id: 'habits-inlab-zenodo-14858226',
    source: { zenodo: HABITS.zenodo, doi: HABITS.doi, url: HABITS.url, title: 'HAbitsLab Wrist-Based EE Estimation in-lab' },
    license: HABITS.license,
    checksums: { 'Phase 2 - Data.zip': { md5: checksum.md5, sha256: checksum.sha256, bytes: checksum.bytes } },
    participants: '26 in-lab folders; 24 with MetCart 60s (P1007/P1011 lack 60s cart); 22 with resampled wrist IMU (P1009/P1014 missing acc_resample)',
    device: 'wrist smartwatch acc+gyro',
    placement: 'wrist',
    sampling_rate_hz: { accel: 20, gyro: 20 },
    units: { accel: 'converted to g', gyro: 'converted to deg/s' },
    label: {
      derivation: 'MET (MetCart) only from metabolic cart',
      refused: REFUSED_LABELS,
    },
    notes: 'In-wild / free-living portion is not cart ground truth and is refused.',
  };
}

export function writeManifest(obj, dest) {
  mkdirp(path.dirname(dest));
  fs.writeFileSync(dest, `${JSON.stringify(obj, null, 2)}\n`);
  return dest;
}

export function manifestDir() {
  return path.join(here, 'artifact/manifests');
}
