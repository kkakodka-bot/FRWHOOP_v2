import XCTest
@testable import Strand
import WhoopProtocol
import WhoopStore

/// Serial offload pipeline: FIFO frames, begin/timeout serialized with ingest.
final class BackfillActorPipelineTests: XCTestCase {
    private actor OrderedInsertStore: BackfillStoreWriting {
        private(set) var insertOrder: [Int] = []
        private(set) var activeInserts = 0
        private(set) var maxConcurrentInserts = 0
        private var pauseFirstInsert: Bool
        private var enteredFirstInsert = false
        private var enteredWaiter: CheckedContinuation<Void, Never>?
        private var releaseWaiter: CheckedContinuation<Void, Never>?
        private let pauseCursorAfterInserts: Int?
        private var cursorPaused = false
        private var cursorWaiter: CheckedContinuation<Void, Never>?
        private var cursorRelease: CheckedContinuation<Void, Never>?

        init(pauseFirstInsert: Bool = false, pauseCursorAfterInserts: Int? = nil) {
            self.pauseFirstInsert = pauseFirstInsert
            self.pauseCursorAfterInserts = pauseCursorAfterInserts
        }

        func waitForFirstInsert() async {
            if enteredFirstInsert { return }
            await withCheckedContinuation { enteredWaiter = $0 }
        }

        func releaseFirstInsert() {
            pauseFirstInsert = false
            releaseWaiter?.resume()
            releaseWaiter = nil
        }

        func waitForPausedCursor() async {
            if cursorPaused { return }
            await withCheckedContinuation { cursorWaiter = $0 }
        }

        func releaseCursor() {
            cursorRelease?.resume()
            cursorRelease = nil
        }

        @discardableResult
        func insertAndMarkJobsOwed(_ streams: Streams, deviceId: String,
                                   postOffloadJobKinds: [String],
                                   note: String?) async throws -> BackfillInsertOutcome {
            activeInserts += 1
            maxConcurrentInserts = max(maxConcurrentInserts, activeInserts)
            if !enteredFirstInsert {
                enteredFirstInsert = true
                enteredWaiter?.resume()
                enteredWaiter = nil
                if pauseFirstInsert { await withCheckedContinuation { releaseWaiter = $0 } }
            }
            insertOrder.append(streams.hr.first?.bpm ?? -1)
            activeInserts -= 1
            return BackfillInsertOutcome(counts: (1, 0, 0, 0, 0, 0, 0, 0), markedJobs: true)
        }

        @discardableResult
        func insert(_ streams: Streams, deviceId: String) async throws
            -> (hr: Int, rr: Int, events: Int, battery: Int, spo2: Int, skinTemp: Int, resp: Int, gravity: Int) {
            (0, 0, 0, 0, 0, 0, 0, 0)
        }
        func enqueueRawBatch(_ meta: RawBatchMeta, frames: [[UInt8]]) async throws {}
        func setCursor(_ name: String, _ value: Int) async throws {
            guard insertOrder.count == pauseCursorAfterInserts, !cursorPaused else { return }
            cursorPaused = true
            cursorWaiter?.resume()
            cursorWaiter = nil
            await withCheckedContinuation { cursorRelease = $0 }
        }
        func cursor(_ name: String) async throws -> Int? { nil }
    }

    private let whoop5HistoryEndHex =
        "aa011c00010023d1316a0284a3266a0a373d00000041b601001000000000000044d21e3d"

    private func hexBytes(_ hex: String) -> [UInt8] {
        var out = [UInt8](); out.reserveCapacity(hex.count / 2); var index = hex.startIndex
        while index < hex.endIndex {
            let next = hex.index(index, offsetBy: 2)
            out.append(UInt8(hex[index..<next], radix: 16)!)
            index = next
        }
        return out
    }

    private func makeHrFrame(unix: UInt32, bpm: UInt8) -> [UInt8] {
        var frame = [UInt8](repeating: 0, count: 64)
        frame[0] = 0xAA; frame[1] = 0x01
        frame[2] = UInt8(frame.count - 8)
        frame[4] = 1; frame[5] = 0
        frame[8] = 0x2f; frame[9] = bpm
        frame[15] = UInt8(unix & 0xff); frame[16] = UInt8((unix >> 8) & 0xff)
        frame[17] = UInt8((unix >> 16) & 0xff); frame[18] = UInt8((unix >> 24) & 0xff)
        let headerCRC = crc16Modbus(Array(frame[0..<6]))
        frame[6] = UInt8(headerCRC & 0xff); frame[7] = UInt8((headerCRC >> 8) & 0xff)
        let payloadEnd = frame.count - 4
        let bodyCRC = crc32(Array(frame[8..<payloadEnd]))
        frame[payloadEnd] = UInt8(bodyCRC & 0xff); frame[payloadEnd + 1] = UInt8((bodyCRC >> 8) & 0xff)
        frame[payloadEnd + 2] = UInt8((bodyCRC >> 16) & 0xff); frame[payloadEnd + 3] = UInt8((bodyCRC >> 24) & 0xff)
        return frame
    }

    private func makeActor(store: BackfillStoreWriting,
                           ack: @escaping @Sendable () async -> Void = {},
                           banked: @escaping @Sendable () async -> Void = {}) async -> BackfillActor {
        let actor = BackfillActor()
        let hooks = BackfillMainHooks(
            ackTrim: { _, _ in await ack() },
            onBankedOffload: { _ in await banked() },
            log: { _ in },
            rejectedSink: { _, _, _ in true },
            onChunk: { _, _ in },
            connectionActive: { false },
            connectionLog: { _ in },
            firmwareLayout: { _ in },
            onPersistCircuitBreak: {},
            onChunkCommitBegin: {},
            onChunkCommitAborted: {},
            onOffloadComplete: {})
        let extract: Backfiller.Extractor = { parsed, _, _, _, _ in
            Streams(hr: [HRSample(ts: 1_700_000_100, bpm: parsed.first?.seq ?? -1)])
        }
        await actor.configure(store: store, deviceId: "dev", hooks: hooks,
                              enableRawCapture: false, postOffloadJobKinds: [],
                              extract: extract)
        return actor
    }

    func testBeginDuringDrainStartsNoConcurrentIngest() async {
        let store = OrderedInsertStore(pauseFirstInsert: true)
        let actor = await makeActor(store: store)
        await actor.begin(family: .whoop5, continuedAfterRows: false)
        actor.yieldFrame(makeHrFrame(unix: 1_500, bpm: 10))
        actor.yieldFrame(hexBytes(whoop5HistoryEndHex))
        await store.waitForFirstInsert()
        let beginTask = Task { await actor.begin(family: .whoop5, continuedAfterRows: false) }
        await store.releaseFirstInsert()
        await beginTask.value
        let maximum = await store.maxConcurrentInserts
        let order = await store.insertOrder
        XCTAssertEqual(maximum, 1)
        XCTAssertEqual(order, [10])
    }

    func testFramesAroundSessionStartPreserveArrivalOrder() async {
        let store = OrderedInsertStore()
        let acked = expectation(description: "three chunks acknowledged")
        acked.expectedFulfillmentCount = 3
        let actor = await makeActor(store: store, ack: { acked.fulfill() })
        await actor.begin(family: .whoop5, continuedAfterRows: false)
        actor.yieldFrame(makeHrFrame(unix: 1_500, bpm: 11))
        actor.yieldFrame(hexBytes(whoop5HistoryEndHex))
        actor.yieldFrame(makeHrFrame(unix: 1_501, bpm: 12))
        actor.yieldFrame(hexBytes(whoop5HistoryEndHex))
        actor.yieldFrame(makeHrFrame(unix: 1_502, bpm: 13))
        actor.yieldFrame(hexBytes(whoop5HistoryEndHex))
        await fulfillment(of: [acked], timeout: 5)
        let order = await store.insertOrder
        XCTAssertEqual(order, [11, 12, 13])
    }

    func testTimeoutDuringInFlightIngestFinishesIngestFirst() async {
        let store = OrderedInsertStore(pauseFirstInsert: true)
        let acked = expectation(description: "invalidated chunk must not acknowledge")
        acked.isInverted = true
        let actor = await makeActor(store: store, ack: { acked.fulfill() })
        await actor.begin(family: .whoop5, continuedAfterRows: false)
        actor.yieldFrame(makeHrFrame(unix: 1_500, bpm: 20))
        actor.yieldFrame(hexBytes(whoop5HistoryEndHex))
        await store.waitForFirstInsert()
        actor.invalidateSession()
        let timeoutTask = Task { await actor.timeoutFired() }
        let before = await store.insertOrder
        XCTAssertEqual(before, [], "timeout must wait for ingest")
        await store.releaseFirstInsert()
        await timeoutTask.value
        let after = await store.insertOrder
        XCTAssertEqual(after, [20])
        let stillBackfilling = await actor.isBackfilling()
        XCTAssertFalse(stillBackfilling)
        await fulfillment(of: [acked], timeout: 0.05)
    }

    func testInvalidationDropsOldQueuedChunkAndAllowsNewSession() async {
        let store = OrderedInsertStore(pauseFirstInsert: true)
        let acked = expectation(description: "only new session acknowledges")
        acked.assertForOverFulfill = true
        let banked = expectation(description: "only new session publishes banked count")
        banked.assertForOverFulfill = true
        let actor = await makeActor(store: store, ack: { acked.fulfill() }, banked: { banked.fulfill() })
        let old = UUID(), next = UUID()
        actor.reserveSession(old)
        await actor.begin(family: .whoop5, continuedAfterRows: false, sessionID: old)
        actor.yieldFrame(makeHrFrame(unix: 1_500, bpm: 21), sessionID: old)
        actor.yieldFrame(hexBytes(whoop5HistoryEndHex), sessionID: old)
        await store.waitForFirstInsert()
        actor.yieldFrame(makeHrFrame(unix: 1_501, bpm: 22), sessionID: old)
        actor.yieldFrame(hexBytes(whoop5HistoryEndHex), sessionID: old)
        actor.invalidateSession(old)
        actor.reserveSession(next)
        await store.releaseFirstInsert()
        let began = await actor.begin(family: .whoop5, continuedAfterRows: false, sessionID: next)
        XCTAssertTrue(began)
        actor.yieldFrame(makeHrFrame(unix: 1_502, bpm: 23), sessionID: next)
        actor.yieldFrame(hexBytes(whoop5HistoryEndHex), sessionID: next)
        await fulfillment(of: [acked, banked], timeout: 5)
        let order = await store.insertOrder
        XCTAssertEqual(order, [21, 23], "already running persistence can finish; stale queued frames cannot")
        await actor.timeoutFired(sessionID: next)
    }

    func testInvalidatedReservationCannotStartAndOldTimeoutCannotStopNewSession() async {
        let actor = await makeActor(store: OrderedInsertStore())
        let old = UUID(), next = UUID()
        actor.reserveSession(old)
        actor.invalidateSession(old)
        let staleBegan = await actor.begin(family: .whoop5, continuedAfterRows: false, sessionID: old)
        XCTAssertFalse(staleBegan)
        actor.reserveSession(next)
        let began = await actor.begin(family: .whoop5, continuedAfterRows: false, sessionID: next)
        XCTAssertTrue(began)
        await actor.timeoutFired(sessionID: old)
        let active = await actor.isBackfilling()
        XCTAssertTrue(active)
        await actor.timeoutFired(sessionID: next)
    }

    func testSnapshotExcludesPartialChunkWhileCursorWriteIsSuspended() async {
        let store = OrderedInsertStore(pauseCursorAfterInserts: 2)
        let acked = expectation(description: "two complete chunks acknowledged")
        acked.expectedFulfillmentCount = 2
        let actor = await makeActor(store: store, ack: { acked.fulfill() })
        await actor.begin(family: .whoop5, continuedAfterRows: false)
        actor.yieldFrame(makeHrFrame(unix: 1_500, bpm: 31))
        actor.yieldFrame(hexBytes(whoop5HistoryEndHex))
        actor.yieldFrame(makeHrFrame(unix: 1_501, bpm: 32))
        actor.yieldFrame(hexBytes(whoop5HistoryEndHex))
        await store.waitForPausedCursor()

        let stored = await store.insertOrder
        XCTAssertEqual(stored, [31, 32], "the second insert is durable but its chunk has not finished")
        let during = await actor.sessionSnapshot()
        XCTAssertEqual(during?.sessionRowsPersisted, 1)
        XCTAssertEqual(during?.phaseSamples.count, 1)

        await store.releaseCursor()
        await fulfillment(of: [acked], timeout: 5)
        await actor.timeoutFired()
        let after = await actor.sessionSnapshot()
        XCTAssertEqual(after?.sessionRowsPersisted, 2)
        XCTAssertEqual(after?.phaseSamples.count, 2)
    }
}
