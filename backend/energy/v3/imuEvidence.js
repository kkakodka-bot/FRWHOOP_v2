/**
 * Energy V3 IMU evidence policy.
 *
 * In-process (hour-buffer derived) records may be diagnostic/provisional.
 * Persisted/finalized shadow (replay) consumes only manifest-verified imu_raw.
 * Live derivation and verified replay must converge: same derived_id, same
 * features, same candidate.
 */

import { dedupeImuRecords } from '../../protocol/imuArchive.js';

export function partitionImuEvidence(records = []) {
  const verified = [];
  const provisional = [];
  for (const rec of records) {
    if (rec?._manifest_verified === true && typeof rec._manifest_sha256 === 'string') {
      verified.push(rec);
    } else {
      provisional.push(rec);
    }
  }
  const status = !verified.length && !provisional.length
    ? 'none'
    : (verified.length && !provisional.length
      ? 'verified'
      : (!verified.length ? 'provisional' : 'mixed'));
  return { verified, provisional, status };
}

/**
 * @param {object[]} records
 * @param {{ finalized?: boolean }} opts  replay/persist-final uses verified only
 */
/** Complete 100 Hz v21 frames only. Compact ENMO / truncated ATT notifies do not count. */
export function hasCompleteV21Imu(records = []) {
  return (records || []).some((rec) => {
    const layout = String(rec?.layout || '');
    const kind = String(rec?.kind || '');
    if (layout !== 'v21' && kind !== 'hist_v21') return false;
    const ax = rec.accel_x || rec.accel_x_raw || rec.ax;
    return Array.isArray(ax) && ax.length >= 100;
  });
}

export function selectImuForEnergyV3(records = [], { finalized = false } = {}) {
  const unique = dedupeImuRecords(records);
  const part = partitionImuEvidence(unique);
  if (finalized) {
    return {
      records: part.verified,
      evidence: {
        status: part.verified.length ? 'verified' : 'none',
        eligibility: part.verified.length ? 'verified_ready' : 'no_verified_imu',
        finalized: true,
        verified_n: part.verified.length,
        provisional_n: part.provisional.length,
        unique_n: unique.length,
      },
    };
  }
  return {
    records: unique,
    evidence: {
      status: part.status,
      eligibility: part.status === 'none' ? 'no_imu' : 'provisional_or_verified',
      finalized: false,
      verified_n: part.verified.length,
      provisional_n: part.provisional.length,
      unique_n: unique.length,
    },
  };
}
