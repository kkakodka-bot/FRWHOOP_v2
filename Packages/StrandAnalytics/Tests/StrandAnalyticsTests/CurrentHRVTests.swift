import XCTest
@testable import StrandAnalytics
import WhoopProtocol

/// Trailing-window current HRV — Swift twin of Android `CurrentHrvTest`.
final class CurrentHRVTests: XCTestCase {

    private func steadyRows(now: Int, count: Int, rrMs: Int = 820, stepSec: Int = 1) -> [RRInterval] {
        (0..<count).map { i in
            RRInterval(ts: now - (count - 1 - i) * stepSec, rrMs: rrMs)
        }
    }

    func testFreshWindowProducesValue() {
        let now = 1_700_000_000
        let rows = steadyRows(now: now, count: 30)
        let snap = CurrentHRV.derive(rows: rows, nowUnix: now)
        XCTAssertNotNil(snap)
        XCTAssertEqual(snap!.cleanBeats, 30)
        XCTAssertGreaterThan(snap!.coverage, 0.5)
        XCTAssertEqual(snap!.rmssdMs, 0.0, accuracy: 1e-9)
        XCTAssertEqual(snap!.computedAtUnix, now)
    }

    func testMidWindowEctopicIsGapAware() {
        let now = 1_700_000_100
        var rr = Array(repeating: 800, count: 24)
        rr[12] = 5000   // ectopic — dropped by Malik; neighbours must not splice
        let rows = rr.enumerated().map { RRInterval(ts: now - (rr.count - 1 - $0.offset), rrMs: $0.element) }
        let snap = CurrentHRV.derive(rows: rows, nowUnix: now)
        XCTAssertNotNil(snap)
        XCTAssertEqual(snap!.cleanBeats, 23)
        XCTAssertEqual(snap!.rmssdMs, 0.0, accuracy: 1e-9)
    }

    func testSparseWindowReturnsNil() {
        let now = 1_700_000_200
        let rows = steadyRows(now: now, count: 8)
        XCTAssertNil(CurrentHRV.derive(rows: rows, nowUnix: now))
    }

    func testOverCountedWindowReturnsNil() {
        let now = 1_700_000_300
        let base = steadyRows(now: now, count: 25, rrMs: 820)
        // Stack two beats on every second → beat-time exceeds wall span (> 1.10× coverage).
        let doubled = base.flatMap { [RRInterval(ts: $0.ts, rrMs: $0.rrMs, seq: 0),
                                      RRInterval(ts: $0.ts, rrMs: $0.rrMs, seq: 1)] }
        XCTAssertNil(CurrentHRV.derive(rows: doubled, nowUnix: now))
    }

    func testRowsOutsideWindowIgnored() {
        let now = 1_700_000_400
        let inside = steadyRows(now: now, count: 25)
        let outside = steadyRows(now: now - CurrentHRV.windowSeconds - 60, count: 25)
        let snap = CurrentHRV.derive(rows: inside + outside, nowUnix: now)
        XCTAssertNotNil(snap)
        XCTAssertEqual(snap!.cleanBeats, 25)
    }
}
