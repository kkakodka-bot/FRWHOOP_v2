/**
 * WHOOP OOD / domain-support gate.
 *
 * Public-data accuracy does not transfer. Safety check against training-domain
 * support (robust ranges + Mahalanobis or diagonal robust-Z on CORE accel).
 * Not a calibrated accuracy probability. Thresholds come from the artifact
 * (held-out participant distances), never from WHOOP.
 */

const CORE = ['enmo_mean', 'dyn_enmo_mean', 'bandpass_motion_auc_20hz', 'vm_mean'];

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function featNum(imu, features, f) {
  const keys = f === 'bandpass_motion_auc_20hz'
    ? [f, 'mims_mean']
    : f === 'mims_mean'
      ? [f, 'bandpass_motion_auc_20hz']
      : [f];
  for (const k of keys) {
    const x = num(imu[k] ?? features[k]);
    if (x != null) return x;
  }
  return null;
}

function robustZ(x, median, mad) {
  if (x == null || median == null) return 0;
  const scale = (mad == null || mad < 1e-9) ? 1e-9 : 1.4826 * mad;
  return Math.abs(x - median) / scale;
}

function fail(reason, extra = {}) {
  return {
    in_support: false,
    reason,
    distance: extra.distance ?? null,
    threshold: extra.threshold ?? null,
    reference_dataset: extra.reference_dataset ?? null,
    distance_kind: extra.distance_kind ?? null,
    flags: extra.flags || ['v3_domain_fail'],
  };
}

/**
 * @param {object} features  minute IMU + HR
 * @param {object} domain    artifact.domain
 * @param {string[]} requiredGroups
 */
export function domainGate(features, domain, requiredGroups = [], family) {
  const imu = features?.imu || features;
  if (!imu) {
    return fail('missing_imu');
  }
  if ((imu.coverage != null && imu.coverage < 0.25) || (imu.n != null && imu.n < 20)) {
    return fail('poor_coverage');
  }
  if (imu.native_sample_rate != null && imu.native_sample_rate < 10) {
    return fail('sensor_rate');
  }
  if (requiredGroups.includes('hr')) {
    const hr = num(features.hr ?? features.hr_mean);
    if (hr == null) {
      return fail('missing_hr_group');
    }
  }
  if (requiredGroups.includes('gyro') && (imu.gyro_mean_dps == null || imu.gyro_present === false)) {
    return fail('missing_gyro_group');
  }
  const slice = (family && domain?.[family]?.median)
    ? domain[family]
    : (domain?.median ? domain : null);
  if (!slice || typeof slice !== 'object') {
    return {
      in_support: true,
      reason: 'no_domain_stats',
      distance: null,
      threshold: null,
      reference_dataset: null,
      distance_kind: null,
      flags: ['v3_domain_unspecified'],
    };
  }

  const meta = {
    reference_dataset: slice.reference_dataset || null,
    threshold: slice.mahal_limit ?? slice.k_mad ?? null,
    distance_kind: slice.distance_kind || (slice.cov_inv ? 'mahalanobis' : 'robust_z'),
  };
  const median = slice.median || {};
  const mad = slice.mad || {};
  const p01 = slice.p01 || {};
  const p99 = slice.p99 || {};
  const k = slice.k_mad ?? 8;
  let worst = 0;
  for (const f of (slice.features || CORE)) {
    const x = featNum(imu, features, f);
    if (x == null) continue;
    const lo = num(p01[f] ?? p01[f === 'bandpass_motion_auc_20hz' ? 'mims_mean' : f]);
    const hi = num(p99[f] ?? p99[f === 'bandpass_motion_auc_20hz' ? 'mims_mean' : f]);
    if (lo != null && hi != null && (x < lo - 0.5 * Math.abs(hi - lo) || x > hi + 0.5 * Math.abs(hi - lo))) {
      return fail(`range:${f}`, {
        ...meta,
        flags: ['v3_domain_fail', `v3_ood_${f}`],
      });
    }
    worst = Math.max(worst, robustZ(
      x,
      num(median[f] ?? median[f === 'bandpass_motion_auc_20hz' ? 'mims_mean' : f]),
      num(mad[f] ?? mad[f === 'bandpass_motion_auc_20hz' ? 'mims_mean' : f]),
    ));
  }
  if (worst > k) {
    return fail('robust_z', { ...meta, distance: worst, threshold: k, distance_kind: 'robust_z' });
  }

  let mahal = null;
  if (slice.mean && slice.cov_inv && slice.distance_kind !== 'diagonal_robust_z') {
    const keys = slice.mahal_features || slice.features || CORE;
    const z = keys.map((f) => {
      const x = featNum(imu, features, f);
      const m = num(slice.mean[f] ?? slice.mean[f === 'bandpass_motion_auc_20hz' ? 'mims_mean' : f]);
      return x == null || m == null ? 0 : x - m;
    });
    const inv = slice.cov_inv;
    let d = 0;
    for (let i = 0; i < z.length; i++) {
      let s = 0;
      for (let j = 0; j < z.length; j++) s += (inv[i]?.[j] ?? 0) * z[j];
      d += z[i] * s;
    }
    mahal = Math.sqrt(Math.max(0, d));
    const limit = slice.mahal_limit ?? 6;
    if (mahal > limit) {
      return fail('mahalanobis', {
        ...meta,
        distance: mahal,
        threshold: limit,
        distance_kind: slice.mahal_method || 'ledoit_wolf',
      });
    }
  }

  return {
    in_support: true,
    reason: 'in_support',
    distance: mahal ?? worst,
    threshold: slice.mahal_limit ?? k,
    reference_dataset: slice.reference_dataset || null,
    distance_kind: meta.distance_kind,
    flags: ['v3_domain_ok'],
  };
}

/** Summarize WHOOP vs public-data feature locations for the research log. */
export function compareDistributions(whoopRows, publicRows, features = CORE) {
  const summary = {};
  for (const f of features) {
    const alias = f === 'bandpass_motion_auc_20hz' ? 'mims_mean' : null;
    const a = whoopRows.map((r) => num(r[f] ?? r[alias])).filter((v) => v != null);
    const b = publicRows.map((r) => num(r[f] ?? r[alias])).filter((v) => v != null);
    summary[f] = {
      whoop_n: a.length,
      public_n: b.length,
      whoop_median: median(a),
      public_median: median(b),
      whoop_p10: percentile(a, 0.1),
      whoop_p90: percentile(a, 0.9),
      public_p10: percentile(b, 0.1),
      public_p90: percentile(b, 0.9),
    };
  }
  return summary;
}

function median(values) {
  if (!values.length) return null;
  const s = values.slice().sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function percentile(values, p) {
  if (!values.length) return null;
  const s = values.slice().sort((a, b) => a - b);
  const i = (s.length - 1) * p;
  const lo = Math.floor(i);
  const hi = Math.ceil(i);
  return lo === hi ? s[lo] : s[lo] * (hi - i) + s[hi] * (i - lo);
}
