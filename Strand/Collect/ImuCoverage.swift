import Foundation

/// Conservative IMU coverage reporting for Raw Data Collector exports (FRWHOOP issue #1).
/// Twin of Android `GroundTruthCollector.missingRanges` / export coverage fields.
enum ImuCoverage {
    struct MissingRange: Equatable {
        let startTs: Int
        let endTs: Int
    }

    /// The seconds of [from, to] NOT covered by any full-rate segment, ascending. A segment whose
    /// sampleCount shows it is not full-rate is skipped entirely (the pre-existing coverage rule):
    /// partial-rate data must not claim coverage.
    static func missingRanges(segments: [ImuSessionFileStore.ExportSegment],
                              from: Int, to: Int) -> [MissingRange] {
        if from > to { return [] }
        var gaps: [MissingRange] = []
        var cursor = from
        for chunk in segments.sorted(by: { $0.startTs < $1.startTs }) {
            let start = chunk.startTs, end = chunk.endTs
            if chunk.sampleCount < (end - start + 1) * ImuSessionFileStore.sampleRate { continue }
            if start > cursor { gaps.append(MissingRange(startTs: cursor, endTs: min(start - 1, to))) }
            if end >= cursor { cursor = end + 1 }
            if cursor > to { break }
        }
        if cursor <= to { gaps.append(MissingRange(startTs: cursor, endTs: to)) }
        return gaps
    }

    static func covers(segments: [ImuSessionFileStore.ExportSegment], from: Int, to: Int) -> Bool {
        from <= to && missingRanges(segments: segments, from: from, to: to).isEmpty
    }

    static func report(segments: [ImuSessionFileStore.ExportSegment],
                       requestedFrom: Int, requestedTo: Int,
                       requiredFrom: Int, conflicts: [Int64]) -> [String: Any] {
        let missing = missingRanges(segments: segments, from: requiredFrom, to: requestedTo)
        let complete = missing.isEmpty && conflicts.isEmpty && requiredFrom <= requestedTo
        return [
            "requested_start_ts": requestedFrom,
            "requested_end_ts": requestedTo,
            "required_start_ts": requiredFrom,
            "startup_seconds": max(0, requiredFrom - requestedFrom),
            "complete": complete,
            "missing_ranges": missing.map { ["start_ts": $0.startTs, "end_ts": $0.endTs] },
            "conflict_count": conflicts.count,
            "conflict_ts": conflicts,
            "segments": segments.map {
                ["file": $0.name, "start_ts": $0.startTs, "end_ts": $0.endTs, "sample_count": $0.sampleCount]
            },
        ]
    }
}
