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
    const val WINDOW_SECONDS: Int = HrvWindow.SECONDS

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
        if (windowSeconds != HrvWindow.SECONDS) return null
        return deriveObservations(PhysiologyQuality.legacy(rows, "legacy-unscoped"), nowUnix)
    }

    /** The latest completed UTC window, never pooled with a previous sparse window. */
    fun deriveObservations(observations: List<PhysiologyQuality.IntervalObservation>, nowUnix: Int,
                           policy: HrvWindow.Policy = HrvWindow.Policy(), inputRevision: String = "unversioned"): Snapshot? {
        val result = HrvWindow.measure(HrvWindow.alignedStart(nowUnix) - HrvWindow.SECONDS,
            observations, policy = policy, inputRevision = inputRevision, computationMode = "causal")
        val rmssd = result.observedRMSSD ?: return null
        if (!result.measurementValid) return null
        return Snapshot(rmssd, Math.round(result.validIntervalFraction * result.originalIds.size).toInt(),
            result.observedTimeFraction, nowUnix)
    }
}
