/**
 * Deterministic, provenance-preserving deduplication for HR observations.
 *
 * Three layers (V2_DESIGN.md section 5):
 *  L1  Same-second same-source collapse: rows at the same sensor second from
 *      the same device+source are one measurement cycle (coalesced BLE
 *      notifies / lost-ack re-sends); the freshest seq wins the measurement
 *      fields and every arrival path is preserved in `arrivals`. Rows at
 *      DIFFERENT sensor seconds are distinct beats and are never collapsed.
 *  L2  Cross-source resolution at the same sensor second: when two DIFFERENT
 *      sources measured the same underlying beat and their clock domains are
 *      aligned, the documented priority wins (history > live > gatt >
 *      healthkit) and the loser is retained as `suppressed` with a reason -
 *      never silently dropped. When clock domains are NOT aligned (live rows
 *      are receive-domain, historical rows strap-domain; the 7-day bound in
 *      time/clockCorrection.js means sub-week strap offsets are uncorrected),
 *      both observations are kept and the disagreement is surfaced as a
 *      quality feature instead of being resolved by a guess.
 *  L3  Consecutive identical BPMs at different times are NEVER collapsed:
 *      grouping is strictly per-sensor-second, so an athlete parked at 62 bpm
 *      for an hour still yields 3600 observations.
 *
 * Determinism: input order is preserved, ties broken by (priority, seq, src).
 */

import { SRC_CLASS_PRIORITY } from './observation.js';

const SOURCE_DISAGREEMENT_DELTA_BPM = 8;

function rrKey(obs) {
  return (obs.rr_ms || []).join(',');
}

/**
 * L1 identity: same device, same millisecond, same source class. BPM is
 * deliberately NOT part of the key: the producer coalesces BLE notifies and
 * re-sends after lost acks, so two rows at the same sensor instant from the
 * same source are one measurement delivered twice (the fresher seq wins);
 * two rows at DIFFERENT instants are distinct beats and are never collapsed.
 */
function identityKey(obs) {
  return [
    obs.device_id ?? '',
    Math.floor(obs.tMs / 1000),
    obs.src_class,
    obs.connection_epoch ?? '',
  ].join('|');
}

function priorityOf(obs) {
  return SRC_CLASS_PRIORITY[obs.src_class] ?? 0;
}

function mergeInto(kept, obs) {
  kept.arrivals.push({
    src: obs.src,
    src_class: obs.src_class,
    seq: obs.seq,
    decoder: obs.decoder,
    layout: obs.layout,
    received_as: obs.clock_domain,
  });
  // Enrich kept fields from later arrivals only where the kept row is missing.
  if (kept.rr_ms.length === 0 && obs.rr_ms.length > 0) kept.rr_ms = obs.rr_ms;
  if (kept.motion == null && obs.motion != null) kept.motion = obs.motion;
  if (kept.q_reported == null && obs.q_reported != null) kept.q_reported = obs.q_reported;
  if (kept.firmware == null && obs.firmware != null) kept.firmware = obs.firmware;
  if (kept.layout == null && obs.layout != null) kept.layout = obs.layout;
  if (kept.family == null && obs.family != null) kept.family = obs.family;
  if (kept.t_strap == null && obs.t_strap != null) kept.t_strap = obs.t_strap;
  if (kept.clock_offset_sec == null && obs.clock_offset_sec != null) kept.clock_offset_sec = obs.clock_offset_sec;
  if (kept.stage == null && obs.stage != null) kept.stage = obs.stage;
}

/**
 * Deduplicate canonical observations.
 *
 * @param {Array} observations canonical observations (may be unsorted; will not be mutated)
 * @returns {{kept: Array, suppressed: Array, stats: object}}
 */
export function dedupeObservations(observations) {
  const obs = [...(observations || [])].sort((a, b) => (a.tMs - b.tMs));
  const stats = {
    input: obs.length,
    exactDuplicates: 0,
    crossSourceSuppressed: 0,
    unresolvedDomains: 0,
  };

  // ---- L1: exact identity collapse (same device, same ms, same bpm/rr) ----
  const exact = new Map();
  for (const o of obs) {
    const key = identityKey(o);
    if (exact.has(key)) {
      const kept = exact.get(key);
      // Latest seq wins the measurement fields (a re-send supersedes the
      // queued value); the superseded row is preserved in arrivals.
      const oNewer = (o.seq ?? -1) >= (kept.seq ?? -1);
      const body = oNewer ? o : kept;
      const other = oNewer ? kept : o;
      const merged = { ...body, arrivals: [...(body.arrivals || [{ src: body.src, src_class: body.src_class, seq: body.seq, decoder: body.decoder, received_as: body.clock_domain }])] };
      mergeInto(merged, other);
      exact.set(key, merged);
      stats.exactDuplicates += 1;
    } else {
      const row = { ...o, arrivals: [{ src: o.src, src_class: o.src_class, seq: o.seq, decoder: o.decoder, received_as: o.clock_domain }] };
      exact.set(key, row);
    }
  }
  const rows = [...exact.values()].sort((a, b) => (a.tMs - b.tMs));

  // ---- L2: cross-source resolution per sensor second ----
  const bySecond = new Map();
  for (const r of rows) {
    const sec = Math.floor(r.tMs / 1000);
    if (!bySecond.has(sec)) bySecond.set(sec, []);
    bySecond.get(sec).push(r);
  }

  const kept = [];
  const suppressed = [];
  for (const [sec, group] of bySecond) {
    if (group.length === 1) {
      kept.push(group[0]);
      continue;
    }
    // Distinct src_classes present at this second.
    const classes = [...new Set(group.map((g) => g.src_class))];
    if (classes.length === 1) {
      // Same class, different content (e.g. bpm differs): keep all - a genuine
      // measurement disagreement inside one source must not be hidden.
      kept.push(...group);
      continue;
    }
    const domains = new Set(group.map((g) => g.clock_domain));
    const liveVsGatt = classes.every((c) => c === 'live' || c === 'gatt');
    if (domains.size > 1 && !liveVsGatt) {
      // Mixed clock domains: cross-second alignment is unproven, so resolving
      // by priority could silently merge two DIFFERENT beats. Keep both; the
      // quality layer flags the ambiguity.
      stats.unresolvedDomains += group.length - 1;
      kept.push(...group);
      for (const g of group) g.flags = [...(g.flags || []), 'source_disagreement'];
      continue;
    }
    // Aligned domains: deterministic priority, then seq, then src string.
    const ordered = [...group].sort((a, b) => (
      (SRC_CLASS_PRIORITY[b.src_class] ?? 0) - (SRC_CLASS_PRIORITY[a.src_class] ?? 0)
      || (a.seq ?? 0) - (b.seq ?? 0)
      || String(a.src).localeCompare(String(b.src))
    ));
    const winner = ordered[0];
    winner.arrivals = [...winner.arrivals];
    for (const loser of ordered.slice(1)) {
      mergeInto(winner, loser);
      stats.crossSourceSuppressed += 1;
      suppressed.push({
        tMs: loser.tMs,
        src: loser.src,
        src_class: loser.src_class,
        bpm: loser.bpm,
        reason: `cross_source_priority:${winner.src_class}`,
        kept_src: winner.src_class,
        delta_bpm: winner.bpm != null && loser.bpm != null ? Math.abs(winner.bpm - loser.bpm) : null,
      });
    }
    // Explicit disagreement marker on the KEPT row when the loser disagreed materially.
    const maxDelta = Math.max(...ordered.slice(1).map((loser) => (
      winner.bpm != null && loser.bpm != null ? Math.abs(winner.bpm - loser.bpm) : 0
    )), 0);
    if (maxDelta > SOURCE_DISAGREEMENT_DELTA_BPM) {
      winner.flags = [...(winner.flags || []), 'source_disagreement'];
    }
    kept.push(winner);
  }

  kept.sort((a, b) => (a.tMs - b.tMs));
  return { kept, suppressed, stats };
}
