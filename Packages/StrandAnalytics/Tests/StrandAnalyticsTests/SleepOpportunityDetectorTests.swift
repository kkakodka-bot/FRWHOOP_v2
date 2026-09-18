import XCTest
import WhoopProtocol
@testable import StrandAnalytics

final class SleepOpportunityDetectorTests: XCTestCase {
    private var day: Int { AnalyticsEngine.dayStartUtcSeconds("2026-09-17") }
    private var nap: Int { day+15*3600 }
    private func hr(_ sleep: [Range<Int>]) -> [HRSample] {
        stride(from: day,to: day+86400,by: 5).map { t in HRSample(ts: t,bpm: sleep.contains { $0.contains(t) } ? 55 : 80) }
    }
    private func gravity() -> [GravitySample] {
        stride(from: day,to: day+86400,by: 5).map { GravitySample(ts: $0,x: 0,y: 0,z: 1) }
    }
    func testTwentyMinuteAfternoonNapAndDaytimeShiftSleepHaveNoTimeOfDayGate() {
        let ranges = [(day+8*3600)..<(day+13*3600),nap..<(nap+1200)]
        let out = SleepOpportunityDetector.detect(start: day,end: day+86400,hr: hr(ranges),gravity: gravity())
        XCTAssertEqual(out.episodes.map(\.start),ranges.map(\.lowerBound))
        XCTAssertEqual(out.episodes.map(\.end),ranges.map(\.upperBound))
        XCTAssertTrue(out.episodes.last!.stages.allSatisfy { $0.state == "sleep_unstaged" && $0.sleepProbability == nil })
        XCTAssertEqual(out.referenceHr,80)
    }
    func testReadingPhoneUseAndOffBodyAreNotNapsAndStillnessAloneIsUnknown() {
        for kind in ["reading","phone_use","off_body"] {
            let out = SleepOpportunityDetector.detect(start: day,end: day+86400,hr: hr([nap..<(nap+1200)]),gravity: gravity(),
                context: [SleepContextSpan(start: nap,end: nap+1200,kind: kind,provenance: "independent_annotation")])
            XCTAssertTrue(out.episodes.isEmpty)
            XCTAssertEqual(out.epochs.first { $0.start == nap }?.state,kind == "off_body" ? "off_body" : "awake")
        }
        XCTAssertTrue(SleepOpportunityDetector.detect(start: day,end: day+86400,hr: hr([]),gravity: gravity()).episodes.isEmpty)
    }
    func testMissingMotionBreaksRunAndDuplicateBurstCannotInventCoverage() {
        let low = hr([nap..<(nap+1200)])
        XCTAssertTrue(SleepOpportunityDetector.detect(start: day,end: day+86400,hr: low,gravity: []).episodes.isEmpty)
        let gap = gravity().filter { !((nap+300)..<(nap+900)).contains($0.ts) }
        XCTAssertTrue(SleepOpportunityDetector.detect(start: day,end: day+86400,hr: low,gravity: gap).episodes.isEmpty)
        let burst = Array(repeating: GravitySample(ts: nap,x: 0,y: 0,z: 1),count: 100)
        XCTAssertTrue(SleepOpportunityDetector.detect(start: day,end: day+86400,hr: low,gravity: burst).episodes.isEmpty)
    }
    func testEngineKeepsNapSeparateAndCausalModeCannotRunRetrospectiveDetector() {
        let ranges = [(day+3600)..<(day+5*3600),nap..<(nap+1200)]
        let profile = UserProfile(weightKg: 70,heightCm: 170,age: 30,sex: "nonbinary")
        let out = AnalyticsEngine.analyzeDay(day: "2026-09-17",hr: hr(ranges),gravity: gravity(),profile: profile,
            useFullDaySleepOpportunities: true)
        XCTAssertEqual(out.sleepSessions.map(\.episodeType),["main_sleep","nap"])
        XCTAssertEqual(out.sleepSessions.last?.start,nap)
        let causal = AnalyticsEngine.analyzeDay(day: "2026-09-17",hr: hr(ranges),gravity: gravity(),profile: profile,
            sleepComputationMode: "causal",sleepObservedThrough: nap,useFullDaySleepOpportunities: true)
        XCTAssertTrue(causal.sleepSessions.isEmpty)
    }
    func testNapsOnlyDayCannotBecomeMainSleepOrNocturnalHrvContext() {
        let profile = UserProfile(weightKg: 70,heightCm: 170,age: 30,sex: "nonbinary")
        let out = AnalyticsEngine.analyzeDay(day: "2026-09-17",hr: hr([nap..<(nap+1200)]),gravity: gravity(),
            profile: profile,useFullDaySleepOpportunities: true)
        XCTAssertEqual(out.sleepSessions.first?.episodeType,"nap")
        XCTAssertNil(out.hrvNightSummary)
        XCTAssertFalse(out.hrvMeasurements.contains { $0.context == "sleep" })
    }
    func testGroupedOpportunityPreservesAwakeOffBodyAndMissingInterruptionsWithoutAddingSleep() {
        let sleep = (day+3600)..<(day+5*3600), gap = (day+2*3600)..<(day+2*3600+1800)
        let profile = UserProfile(weightKg: 70,heightCm: 170,age: 30,sex: "nonbinary")
        for kind in ["reading","off_body","missing"] {
            let context = kind == "missing" ? [] : [SleepContextSpan(start: gap.lowerBound,end: gap.upperBound,kind: kind,provenance: "independent_annotation")]
            let motion = gravity().filter { kind != "missing" || !gap.contains($0.ts) }
            let result = AnalyticsEngine.analyzeDay(day: "2026-09-17",hr: hr([sleep]),gravity: motion,profile: profile,
                sleepContext: context,useFullDaySleepOpportunities: true)
            let main = result.sleepSessions.filter { $0.episodeType == "main_sleep" }
            XCTAssertEqual(main.count,2)
            XCTAssertEqual(main.last?.start,main.first?.end)
            let epochs = main.flatMap(\.stages)
            let interrupted = epochs.filter { $0.start >= gap.lowerBound && $0.end <= gap.upperBound }
            XCTAssertEqual(interrupted.reduce(0) { $0+$1.end-$1.start },1800)
            let expected = kind == "reading" ? "awake" : kind == "off_body" ? "off_body" : "state_unknown"
            XCTAssertTrue(interrupted.allSatisfy { $0.state == expected })
            XCTAssertEqual(epochs.filter(SleepStageSemantics.isSleep).reduce(0) { $0+$1.end-$1.start },12600)
            XCTAssertFalse(result.hrvMeasurements.filter { $0.start >= gap.lowerBound && $0.end <= gap.upperBound }.contains { $0.context == "sleep" })
        }
    }
}
