import Foundation
import WhoopProtocol

/// Full-day binary candidate detector. Engineering shadow policy, not calibrated sleep truth.
public enum SleepOpportunityDetector {
    public static let version = "full-day-binary-shadow-1"
    public static let minimumMainSleepSeconds = 90 * 60 // Engineering grouping rule, independent of bedtime.
    public struct Policy: Sendable {
        public var minimumSleepSeconds = 15 * 60
        public var minimumFeatureBinCoverage = 5.0 / 6
        public var maximumRelativeHr = 0.9
        public var maximumMeanOrientationChange = 0.03
        public init() {}
    }
    public struct Result: Sendable {
        public let epochs: [StageSegment], episodes: [SleepSession]
        public let referenceHr: Double?
    }

    /// No clock-of-day gate. Missing HR/motion and ambiguous stillness remain unknown, not sleep.
    public static func detect(start: Int, end: Int, hr: [HRSample], gravity: [GravitySample],
                              steps: [StepSample] = [], context: [SleepContextSpan] = [],
                              policy: Policy = Policy()) -> Result {
        precondition(end > start && end-start <= 76*3600 && (300...14400).contains(policy.minimumSleepSeconds))
        precondition((0.5...1).contains(policy.minimumFeatureBinCoverage) && (0.5...0.99).contains(policy.maximumRelativeHr)
            && (0.001...0.2).contains(policy.maximumMeanOrientationChange))
        func floorBin(_ value: Int, _ width: Int) -> Int { Int(floor(Double(value)/Double(width))) }
        var seenHr = Set<Int>(), seenGravity = Set<Int>()
        let h = hr.filter { $0.ts >= start && $0.ts < end && (25...240).contains($0.bpm) && seenHr.insert($0.ts).inserted }
            .sorted { $0.ts < $1.ts }
        let g = gravity.filter { $0.ts >= start && $0.ts < end && $0.x.isFinite && $0.y.isFinite && $0.z.isFinite
            && $0.x*$0.x+$0.y*$0.y+$0.z*$0.z > 1e-12 && seenGravity.insert($0.ts).inserted }.sorted { $0.ts < $1.ts }
        // Per-minute medians prevent dense bursts from dominating the retrospective reference.
        let medians = Dictionary(grouping: h, by: { floorBin($0.ts,60) }).values.map { rows -> Double in
            let values = rows.map(\.bpm).sorted()
            return Double(values[(values.count-1)/2]+values[values.count/2])/2
        }.sorted()
        let reference = medians.count >= 60 ? medians[Int(Double(medians.count-1)*0.75)] : nil
        let hrEpochs = Dictionary(grouping: h, by: { floorBin($0.ts,30)*30 })
        let gravityEpochs = Dictionary(grouping: g, by: { floorBin($0.ts,30)*30 })
        let sortedSteps = steps.filter { $0.ts >= start-10 && $0.ts < end }.sorted { $0.ts < $1.ts }
        let moving = Set(zip(sortedSteps, sortedSteps.dropFirst()).filter { a,b in
            (1...10).contains(b.ts-a.ts) && b.counter>a.counter
        }.map { floorBin($0.1.ts,30)*30 })
        var epochs: [StageSegment] = [], t = floorBin(start+29,30)*30
        while t+30 <= end {
            let rows = hrEpochs[t] ?? [], motion = gravityEpochs[t] ?? []
            // Six sampled 5-second feature bins, not continuous beat-observation coverage.
            let coverage = Double(min(Set(rows.map { floorBin($0.ts-t,5) }).count,
                Set(motion.map { floorBin($0.ts-t,5) }).count))/6
            let annotations = context.filter { $0.start < t+30 && $0.end > t }
            let offBody = annotations.contains { $0.kind == "off_body" }
            let awake = annotations.contains { ["awake","reading","phone_use"].contains($0.kind) }
            let unit = motion.map { row -> [Double] in
                let norm = sqrt(row.x*row.x+row.y*row.y+row.z*row.z)
                return [row.x/norm,row.y/norm,row.z/norm]
            }
            let changes = zip(unit,unit.dropFirst()).map { a,b -> Double in
                sqrt(a.indices.reduce(0.0) { $0+(a[$1]-b[$1])*(a[$1]-b[$1]) })
            }
            let movement = changes.isEmpty ? nil : changes.reduce(0,+)/Double(changes.count)
            let state: String
            if offBody { state = "off_body" }
            else if awake || moving.contains(t) { state = "awake" }
            else if coverage < policy.minimumFeatureBinCoverage || movement == nil { state = "state_unknown" }
            else if movement! > policy.maximumMeanOrientationChange { state = "awake" }
            else if let reference, !rows.isEmpty,
                    rows.reduce(0.0, { $0+Double($1.bpm) })/Double(rows.count) <= reference*policy.maximumRelativeHr { state = "sleep_unstaged" }
            else { state = "state_unknown" }
            let reason: String
            switch state {
            case "off_body": reason = "off_body_context"
            case "awake": reason = awake ? "awake_behavior_context" : "observed_motion"
            case "sleep_unstaged": reason = "uncalibrated_hr_motion_candidate"
            default: reason = coverage < policy.minimumFeatureBinCoverage ? "missing_hr_motion_features" : "quiet_wake_or_sleep_uncertain"
            }
            epochs.append(StageSegment(start: t, end: t+30, stage: state == "awake" ? "wake" : "unknown", state: state,
                evidenceCoverage: coverage, abstentionReason: reason, computationMode: "retrospective",
                algorithmVersion: version, probabilitiesCalibrated: false))
            t += 30
        }
        var episodes: [SleepSession] = [], run: [StageSegment] = []
        func finish() {
            if let first = run.first, let last = run.last, last.end-first.start >= policy.minimumSleepSeconds {
                episodes.append(SleepSession(start: first.start, end: last.end, efficiency: 1, stages: run,
                    restingHR: SleepStager.sessionRestingHR(start: first.start, end: last.end, hr: h), avgHRV: nil,
                    boundaryProvenance: "algorithm_estimated_shadow",
                    denominatorKind: "estimated_sleep_opportunity"))
            }
            run.removeAll(keepingCapacity: true)
        }
        for epoch in epochs { if SleepStageSemantics.isSleep(epoch) { run.append(epoch) } else { finish() } }; finish()
        return Result(epochs: epochs, episodes: episodes, referenceHr: reference)
    }
}
