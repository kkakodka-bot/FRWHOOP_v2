import XCTest
@testable import Strand

final class ImuCoverageTests: XCTestCase {
    private func segment(start: Int, end: Int, samplesPerSecond: Int = 100) -> ImuSessionFileStore.ExportSegment {
        ImuSessionFileStore.ExportSegment(name: "imu-test.imus", data: Data(),
                                          startTs: start, endTs: end, sampleCount: (end - start + 1) * samplesPerSecond)
    }

    func testMissingRangesReportsGapBetweenSegments() {
        let segments = [segment(start: 100, end: 102), segment(start: 106, end: 108)]
        let missing = ImuCoverage.missingRanges(segments: segments, from: 100, to: 108)
        XCTAssertEqual(missing, [ImuCoverage.MissingRange(startTs: 103, endTs: 105)])
    }

    func testPartialRateSegmentDoesNotClaimCoverage() {
        let partial = ImuSessionFileStore.ExportSegment(name: "partial.imus", data: Data(),
                                                          startTs: 100, endTs: 102, sampleCount: 50)
        let missing = ImuCoverage.missingRanges(segments: [partial], from: 100, to: 102)
        XCTAssertEqual(missing, [ImuCoverage.MissingRange(startTs: 100, endTs: 102)])
    }

    func testReportMarksIncompleteWhenConflictsPresent() {
        let segments = [segment(start: 100, end: 102)]
        let report = ImuCoverage.report(segments: segments, requestedFrom: 100, requestedTo: 102,
                                        requiredFrom: 100, conflicts: [101])
        XCTAssertEqual(report["complete"] as? Bool, false)
        XCTAssertEqual(report["conflict_count"] as? Int, 1)
        XCTAssertEqual(report["conflict_ts"] as? [Int64], [101])
        XCTAssertEqual(report["missing_ranges"] as? [[String: Int]], [])
    }

    func testReportMarksCompleteForFullCoverage() {
        let segments = [segment(start: 100, end: 102)]
        let report = ImuCoverage.report(segments: segments, requestedFrom: 100, requestedTo: 102,
                                        requiredFrom: 100, conflicts: [])
        XCTAssertEqual(report["complete"] as? Bool, true)
        XCTAssertEqual(report["startup_seconds"] as? Int, 0)
    }
}
