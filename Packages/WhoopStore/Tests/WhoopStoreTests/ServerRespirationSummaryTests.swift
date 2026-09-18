import XCTest
@testable import WhoopStore

final class ServerRespirationSummaryTests: XCTestCase {
    private func cache(version: String = "frwhoop-physiology-2", status: String = "available",
                       scalar: Any = 16.0, context: String = "main_sleep", median: Any = 16.0,
                       coverage: Any = 0.5) throws -> ServerScoreDayCache {
        let payload: [String: Any] = ["server_scoring": ["schema_version": 2, "user_id": "owner", "day": "2026-09-18",
            "algorithm_version": version, "features": ["respiration": ["status": status, "device_id": "strap", "algorithm_version": version]],
            "daily": ["resp_rate_bpm": scalar, "respiration_summary": ["median_bpm": median, "mean_bpm": 16.0,
                "distribution_bpm": [18.0, 14.0, 16.0], "accepted_seconds": 180.0, "coverage": coverage,
                "accepted_windows": 3, "total_windows": 6, "context": context,
                "method_version": "resp-spectrum-acf-1", "calibration_status": "not_reference_validated"]], "nights": []]]
        return try ServerScoreCacheCodec.parseSnapshot(JSONSerialization.data(withJSONObject: payload), day: "2026-09-18", ownerId: "owner")
    }

    func testSelectedSummaryRetainsMethodCoverageAndSortedDistribution() throws {
        let input = try cache()
        let value = try XCTUnwrap(ServerRespirationSummary.project(input, day: input.day))
        XCTAssertEqual(value.breathsPerMinute, 16)
        XCTAssertEqual(value.mean, 16)
        XCTAssertEqual(value.distribution, [14, 16, 18])
        XCTAssertEqual(value.coverage, 0.5)
        XCTAssertEqual(value.acceptedSeconds, 180)
        XCTAssertEqual(value.acceptedWindows, 3)
        XCTAssertEqual(value.totalWindows, 6)
        XCTAssertEqual(value.context, "main_sleep")
        XCTAssertEqual(value.method, "resp-spectrum-acf-1")
        XCTAssertEqual(value.calibrationStatus, "not_reference_validated")
        XCTAssertNil(value.reason)
    }

    func testStaleSummaryIsRetainedWithoutLocalFallback() throws {
        let input = try cache(status: "stale")
        XCTAssertEqual(ServerRespirationSummary.project(input, day: input.day)?.breathsPerMinute, 16)
        XCTAssertEqual(input.features["respiration"]?.status, "stale")
    }

    func testWrongDayOwnerOrSelectedSourceCannotReadSummary() throws {
        var input = try cache()
        XCTAssertNil(ServerRespirationSummary.project(input, day: "2026-09-17"))
        input.ownerId = "another-owner"
        XCTAssertNil(ServerRespirationSummary.project(input, day: input.day))
        input = try cache()
        input.rawSnapshotJSON = input.rawSnapshotJSON?.replacingOccurrences(of: "strap", with: "other-strap")
        XCTAssertNil(ServerRespirationSummary.project(input, day: input.day))
    }

    func testUnavailableOrUnsupportedRateIsNotZero() throws {
        for input in [try cache(status: "unavailable"), try cache(scalar: NSNull()), try cache(scalar: 0), try cache(scalar: true)] {
            let value = try XCTUnwrap(ServerRespirationSummary.project(input, day: input.day))
            XCTAssertNil(value.breathsPerMinute)
            XCTAssertNotNil(value.reason)
        }
    }

    func testAwakeRestAndInconsistentSummaryCannotBecomeNightlyRate() throws {
        let active = try cache(context: "awake_rest")
        XCTAssertEqual(ServerRespirationSummary.project(active, day: active.day)?.reason, "incompatible_respiration_context")
        for input in [try cache(median: 14), try cache(coverage: 1.1), try cache(coverage: true)] {
            XCTAssertNil(ServerRespirationSummary.project(input, day: input.day)?.breathsPerMinute)
            XCTAssertEqual(ServerRespirationSummary.project(input, day: input.day)?.reason, "inconsistent_respiration_summary")
        }
    }

    func testLegacyRateNeverClaimsV2QualityEvenWithUnexpectedSummaryFields() throws {
        let input = try cache(version: "frwhoop-server-1")
        let value = try XCTUnwrap(ServerRespirationSummary.project(input, day: input.day))
        XCTAssertEqual(value.breathsPerMinute, 16)
        XCTAssertTrue(value.legacy)
        XCTAssertNil(value.mean)
        XCTAssertNil(value.coverage)
        XCTAssertNil(value.method)
        XCTAssertTrue(value.distribution.isEmpty)
        XCTAssertEqual(value.reason, "legacy_quality_unavailable")
    }
}
