import XCTest
@testable import Strand
import WhoopProtocol

/// Behavioral coverage for the canonical .imus session store (FRWHOOP issue #1).
@MainActor
final class ImuSessionFileStoreTests: XCTestCase {
    private var directory: URL!
    private var suiteName: String!
    private var defaults: UserDefaults!
    private var store: ImuSessionFileStore!

    override func setUp() {
        super.setUp()
        directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        suiteName = "imu-store-\(UUID().uuidString)"
        defaults = UserDefaults(suiteName: suiteName)!
        store = ImuSessionFileStore(directory: directory, defaultsKey: "windows", defaults: defaults)
    }

    override func tearDown() {
        try? FileManager.default.removeItem(at: directory)
        defaults.removePersistentDomain(forName: suiteName)
        super.tearDown()
    }

    private func imuFrame(ts: Int64, seed: UInt8 = 0) -> [UInt8] {
        var frame = [UInt8](repeating: 0, count: 1244)
        frame[15] = UInt8(ts & 0xff); frame[16] = UInt8((ts >> 8) & 0xff)
        frame[17] = UInt8((ts >> 16) & 0xff); frame[18] = UInt8((ts >> 24) & 0xff)
        frame[24] = 100; frame[630] = 100
        if seed != 0 { frame[28] = seed }
        return frame
    }

    func testColumnsDigestMatchesCrossPlatformOracle() {
        var columns = [Int16]()
        columns.reserveCapacity(600)
        for index in 0..<600 { columns.append(Int16(index * 7 - 300)) }
        XCTAssertEqual(ImuSessionFileStore.columnsDigest(columns), 3_602_392_056_726_433_541)
        XCTAssertEqual(ImuSessionFileStore.columnsDigest([]), 0xcbf29ce484222325)
    }

    func testAppendRoutesMatchingWindowAndDedupesExactRedelivery() {
        store.register(id: "s1", deviceId: "devA", fromMs: 1_000_000, toMs: 2_000_000)
        let ts: Int64 = 1_500
        XCTAssertEqual(store.append(deviceId: "devA", frame: imuFrame(ts: ts), receivedAtMs: 9_000), 1)
        XCTAssertEqual(store.append(deviceId: "devA", frame: imuFrame(ts: ts), receivedAtMs: 9_001), 0)
        let stats = store.stats("s1", from: Int(ts), to: Int(ts))
        XCTAssertEqual(stats.coveredSeconds, 1)
    }

    func testConflictingRedeliveryRecordsEvidence() {
        store.register(id: "s1", deviceId: "devA", fromMs: 1_000_000, toMs: 2_000_000)
        let ts: Int64 = 1_500
        XCTAssertEqual(store.append(deviceId: "devA", frame: imuFrame(ts: ts, seed: 1), receivedAtMs: 1), 1)
        XCTAssertEqual(store.append(deviceId: "devA", frame: imuFrame(ts: ts, seed: 2), receivedAtMs: 2), 0)
        XCTAssertEqual(store.conflictTimestamps("s1"), [ts])
    }

    func testPersistHistoricalImuFlushesBeforeReportingSuccess() {
        store.register(id: "s1", deviceId: "devA", fromMs: 1_000_000, toMs: 2_000_000)
        let frames = (0..<3).map { imuFrame(ts: 1_500 + Int64($0)) }
        XCTAssertTrue(store.persistHistoricalImu(deviceId: "devA", frames: frames, receivedAtMs: 42))
        store.prepareForRead("s1")
        let stats = store.stats("s1", from: 1_500, to: 1_502)
        XCTAssertEqual(stats.coveredSeconds, 3)
    }

    func testContinuousNamespaceIsSeparateFromSharedSessions() {
        XCTAssertFalse(ImuSessionFileStore.continuous === ImuSessionFileStore.shared)
        XCTAssertTrue(ImuSessionFileStore.continuous.registeredWindows().isEmpty)
    }
}
