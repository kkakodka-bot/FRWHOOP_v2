import Foundation
import WhoopProtocol

/// Trailing-window "current HRV" — RMSSD over the most recent strap R-R rows, refreshed after each
/// successful sync. Separate from nightly `avgHrv` (sleep-window RMSSD fed into recovery); this is an
/// additive live readout only.
///
/// Swift parity twin of `android/.../analytics/CurrentHrv.kt`. Reuses `HRVAnalyzer` primitives only.
public enum CurrentHRV {

    public struct Snapshot: Equatable, Sendable {
        public let rmssdMs: Double
        public let cleanBeats: Int
        public let coverage: Double
        public let computedAtUnix: Int

        public init(rmssdMs: Double, cleanBeats: Int, coverage: Double, computedAtUnix: Int) {
            self.rmssdMs = rmssdMs
            self.cleanBeats = cleanBeats
            self.coverage = coverage
            self.computedAtUnix = computedAtUnix
        }
    }

    /// Trailing window length (seconds) for the current HRV readout.
    public static let windowSeconds = 30 * 60

    /// Rows newer than this many seconds before `nowUnix` are treated as stale by the app-layer caller.
    public static let staleThresholdSeconds = 900

    /// Derive a current HRV snapshot from R-R rows whose timestamps fall in
    /// `[nowUnix - windowSeconds, nowUnix]`. Returns nil when coverage fails the nightly RMSSD honesty
    /// gate (`successiveDiffIsTrustworthy`) or when fewer than `HRVAnalyzer.minBeats` clean beats survive.
    public static func derive(rows: [RRInterval], nowUnix: Int,
                              windowSeconds: Int = CurrentHRV.windowSeconds) -> Snapshot? {
        guard windowSeconds > 0 else { return nil }
        let windowStart = nowUnix - windowSeconds
        let seg = rows.filter { $0.ts >= windowStart && $0.ts <= nowUnix }
        guard !seg.isEmpty else { return nil }

        let ts = seg.map(\.ts)
        let rrMs = seg.map { Double($0.rrMs) }
        let coverage = HRVAnalyzer.rrCoverage(tsSec: ts, rrMs: rrMs)
        guard coverage > 0 else { return nil }

        // Same over-count refusal as `SleepStager.sessionAvgHRV` — `collapsed` pinned to `coverage` so
        // both over-count verdicts refuse without an extra sort (#1510).
        let verdict = HRVAnalyzer.classifyCoverage(coverage: coverage, collapsed: coverage)
        guard HRVAnalyzer.successiveDiffIsTrustworthy(verdict) else { return nil }

        let h = HRVAnalyzer.analyze(rawRR: rrMs)
        guard let rmssd = h.rmssd else { return nil }

        return Snapshot(rmssdMs: rmssd, cleanBeats: h.nClean, coverage: coverage, computedAtUnix: nowUnix)
    }
}
