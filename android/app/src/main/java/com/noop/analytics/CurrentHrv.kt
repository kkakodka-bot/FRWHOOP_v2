package com.noop.analytics

import com.noop.data.RrInterval

/**
 * Trailing-window "current HRV" — RMSSD over the most recent strap R-R rows, refreshed after each
 * successful sync. Separate from nightly `avgHrv` (sleep-window RMSSD fed into recovery); this is an
 * additive live readout only.
 *
 * Kotlin parity twin of `Packages/StrandAnalytics/.../CurrentHRV.swift`. Reuses [HrvAnalyzer] primitives only.
 */
object CurrentHrv {

    data class Snapshot(
        val rmssdMs: Double,
        val cleanBeats: Int,
        val coverage: Double,
        val computedAtUnix: Int,
    )

    /** Trailing window length (seconds) for the current HRV readout. */
    const val WINDOW_SECONDS: Int = 30 * 60

    /** Rows newer than this many seconds before `nowUnix` are treated as stale by the app-layer caller. */
    const val STALE_THRESHOLD_SECONDS: Int = 900

    /**
     * Derive a current HRV snapshot from R-R rows whose timestamps fall in
     * `[nowUnix - windowSeconds, nowUnix]`. Returns null when coverage fails the nightly RMSSD honesty
     * gate ([HrvAnalyzer.successiveDiffIsTrustworthy]) or when fewer than [HrvAnalyzer.MIN_BEATS] clean
     * beats survive.
     */
    fun derive(
        rows: List<RrInterval>,
        nowUnix: Int,
        windowSeconds: Int = WINDOW_SECONDS,
    ): Snapshot? {
        if (windowSeconds <= 0) return null
        val windowStart = nowUnix - windowSeconds
        val seg = rows.filter { it.ts >= windowStart && it.ts <= nowUnix }
        if (seg.isEmpty()) return null

        val ts = seg.map { it.ts }
        val rrMs = seg.map { it.rrMs.toDouble() }
        val coverage = HrvAnalyzer.rrCoverage(ts, rrMs)
        if (coverage <= 0.0) return null

        val verdict = HrvAnalyzer.classifyCoverage(coverage, coverage)
        if (!HrvAnalyzer.successiveDiffIsTrustworthy(verdict)) return null

        val h = HrvAnalyzer.analyzeRaw(rrMs)
        val rmssd = h.rmssd ?: return null

        return Snapshot(
            rmssdMs = rmssd,
            cleanBeats = h.nClean,
            coverage = coverage,
            computedAtUnix = nowUnix,
        )
    }
}
