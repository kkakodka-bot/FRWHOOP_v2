import XCTest
@testable import Strand
import WhoopProtocol
import WhoopStore

@MainActor
final class BackfillIdleWatchdogTests: XCTestCase {
    private final class CommitHookStore: BackfillStoreWriting {
        @discardableResult
        func insertAndMarkJobsOwed(_ streams: Streams, deviceId: String,
                                   postOffloadJobKinds: [String],
                                   note: String?) async throws -> BackfillInsertOutcome {
            try await Task.sleep(nanoseconds: 500_000_000)
            return BackfillInsertOutcome(counts: (1, 0, 0, 0, 0, 0, 0, 0), markedJobs: true)
        }
        @discardableResult
        func insert(_ streams: Streams, deviceId: String) async throws
            -> (hr: Int, rr: Int, events: Int, battery: Int, spo2: Int, skinTemp: Int, resp: Int, gravity: Int) {
            (0, 0, 0, 0, 0, 0, 0, 0)
        }
        func enqueueRawBatch(_ meta: RawBatchMeta, frames: [[UInt8]]) async throws {}
        func setCursor(_ name: String, _ value: Int) async throws {}
        func cursor(_ name: String) async throws -> Int? { nil }
    }

    private final class WatchdogSpy: @unchecked Sendable {
        var paused = 0
        var resumed = 0
        var acked = 0
    }

    private let whoop5HistoryEndHex =
        "aa011c00010023d1316a0284a3266a0a373d00000041b601001000000000000044d21e3d"

    private func hexBytes(_ hex: String) -> [UInt8] {
        var out = [UInt8](); var index = hex.startIndex
        while index < hex.endIndex {
            let next = hex.index(index, offsetBy: 2)
            out.append(UInt8(hex[index..<next], radix: 16)!)
            index = next
        }
        return out
    }

    private func makeHrFrame(unix: UInt32) -> [UInt8] {
        var frame = [UInt8](repeating: 0, count: 64)
        frame[0] = 0xAA; frame[1] = 0x01
        frame[4] = 0x2f; frame[5] = 18
        frame[10] = UInt8(unix & 0xff); frame[11] = UInt8((unix >> 8) & 0xff)
        frame[12] = UInt8((unix >> 16) & 0xff); frame[13] = UInt8((unix >> 24) & 0xff)
        frame[14] = 70
        let headerCRC = crc16Modbus(Array(frame[0..<6]))
        frame[6] = UInt8(headerCRC & 0xff); frame[7] = UInt8((headerCRC >> 8) & 0xff)
        let payloadEnd = frame.count - 4
        let bodyCRC = crc32(Array(frame[8..<payloadEnd]))
        frame[payloadEnd] = UInt8(bodyCRC & 0xff); frame[payloadEnd + 1] = UInt8((bodyCRC >> 8) & 0xff)
        frame[payloadEnd + 2] = UInt8((bodyCRC >> 16) & 0xff); frame[payloadEnd + 3] = UInt8((bodyCRC >> 24) & 0xff)
        return frame
    }

    override func tearDown() {
        BLEManager.backfillIdleTimeoutSecondsForTesting = nil
        super.tearDown()
    }

    func testCommitHooksPauseAndAckRearms() async {
        let spy = WatchdogSpy()
        let live = LiveState()
        let manager = BLEManager(state: live)
        manager.test_simulateActiveBackfillSessionForWatchdog()
        manager.pauseBackfillIdleWatchdogForCommit()
        XCTAssertTrue(manager.chunkCommitInFlight)
        manager.ackHistoricalChunk(trim: 1, endData: [0, 0, 0, 0, 0, 0, 0, 0])
        XCTAssertFalse(manager.chunkCommitInFlight)

        let store = CommitHookStore()
        let actor = BackfillActor()
        let hooks = BackfillMainHooks(
            ackTrim: { trim, endData in
                await MainActor.run {
                    spy.acked += 1
                    manager.ackHistoricalChunk(trim: trim, endData: endData)
                }
            },
            onBankedOffload: { _ in },
            log: { _ in },
            rejectedSink: { _, _, _ in true },
            onChunk: { _, _ in },
            connectionActive: { false },
            connectionLog: { _ in },
            firmwareLayout: { _ in },
            onPersistCircuitBreak: {},
            onChunkCommitBegin: { await MainActor.run { spy.paused += 1; manager.pauseBackfillIdleWatchdogForCommit() } },
            onChunkCommitAborted: { await MainActor.run { spy.resumed += 1; manager.resumeBackfillIdleWatchdogAfterAbortedCommit() } },
            onOffloadComplete: {})
        let extract: Backfiller.Extractor = { _, _, _, _, _ in
            Streams(hr: [HRSample(ts: 1_700_000_100, bpm: 61)])
        }
        await actor.configure(store: store, deviceId: "dev", hooks: hooks,
                              enableRawCapture: false, postOffloadJobKinds: [],
                              extract: extract)
        await actor.begin(family: .whoop5, continuedAfterRows: false)
        actor.yieldFrame(makeHrFrame(unix: 1_500))
        actor.yieldFrame(hexBytes(whoop5HistoryEndHex))
        try? await Task.sleep(nanoseconds: 800_000_000)
        XCTAssertEqual(spy.paused, 1)
        XCTAssertEqual(spy.acked, 1)
        XCTAssertFalse(manager.chunkCommitInFlight)
    }

    func testIdleWatchdogFiresWhenNoCommitInFlight() async {
        BLEManager.backfillIdleTimeoutSecondsForTesting = 1
        let live = LiveState()
        let manager = BLEManager(state: live)
        manager.test_simulateActiveBackfillSessionForWatchdog()
        manager.armBackfillTimeout()
        try? await Task.sleep(nanoseconds: 1_500_000_000)
        XCTAssertFalse(live.backfilling)
    }

    func testCommitLongerThanIdleWindowDoesNotExitViaIdleTimer() async {
        BLEManager.backfillIdleTimeoutSecondsForTesting = 5
        let live = LiveState()
        let manager = BLEManager(state: live)
        manager.test_simulateActiveBackfillSessionForWatchdog()
        manager.armBackfillTimeout()
        manager.pauseBackfillIdleWatchdogForCommit()
        try? await Task.sleep(nanoseconds: 1_500_000_000)
        XCTAssertTrue(live.backfilling, "idle timer must stay paused during commit")
        manager.ackHistoricalChunk(trim: 2, endData: [0, 0, 0, 0, 0, 0, 0, 0])
        XCTAssertFalse(manager.chunkCommitInFlight)
    }
}
