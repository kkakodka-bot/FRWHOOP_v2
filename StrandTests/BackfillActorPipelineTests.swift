import XCTest
@testable import Strand
import WhoopProtocol
import WhoopStore

/// Serial offload pipeline: FIFO frames, begin/timeout serialized with ingest.
final class BackfillActorPipelineTests: XCTestCase {
    private final class OrderedInsertStore: BackfillStoreWriting {
        private(set) var insertOrder: [Int] = []
        private(set) var activeInserts = 0
        private(set) var maxConcurrentInserts = 0
        var insertDelayNs: UInt64 = 150_000_000

        @discardableResult
        func insertAndMarkJobsOwed(_ streams: Streams, deviceId: String,
                                   postOffloadJobKinds: [String],
                                   note: String?) async throws -> BackfillInsertOutcome {
            activeInserts += 1
            maxConcurrentInserts = max(maxConcurrentInserts, activeInserts)
            try await Task.sleep(nanoseconds: insertDelayNs)
            insertOrder.append(insertOrder.count + 1)
            activeInserts -= 1
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
        frame[4] = 0x2f; frame[5] = 18
        frame[10] = UInt8(unix & 0xff); frame[11] = UInt8((unix >> 8) & 0xff)
        frame[12] = UInt8((unix >> 16) & 0xff); frame[13] = UInt8((unix >> 24) & 0xff)
        frame[14] = bpm
        let headerCRC = crc16Modbus(Array(frame[0..<6]))
        frame[6] = UInt8(headerCRC & 0xff); frame[7] = UInt8((headerCRC >> 8) & 0xff)
        let payloadEnd = frame.count - 4
        let bodyCRC = crc32(Array(frame[8..<payloadEnd]))
        frame[payloadEnd] = UInt8(bodyCRC & 0xff); frame[payloadEnd + 1] = UInt8((bodyCRC >> 8) & 0xff)
        frame[payloadEnd + 2] = UInt8((bodyCRC >> 16) & 0xff); frame[payloadEnd + 3] = UInt8((bodyCRC >> 24) & 0xff)
        return frame
    }

    private func makeActor(store: BackfillStoreWriting) async -> BackfillActor {
        let actor = BackfillActor()
        let hooks = BackfillMainHooks(
            ackTrim: { _, _ in },
            onBankedOffload: { _ in },
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
        let extract: Backfiller.Extractor = { _, _, _, _, _ in
            Streams(hr: [HRSample(ts: 1_700_000_100, bpm: 61)])
        }
        await actor.configure(store: store, deviceId: "dev", hooks: hooks,
                              enableRawCapture: false, postOffloadJobKinds: [],
                              extract: extract)
        return actor
    }

    func testBeginDuringDrainStartsNoConcurrentIngest() async {
        let store = OrderedInsertStore()
        let actor = await makeActor(store: store)
        await actor.begin(family: .whoop5, continuedAfterRows: false)
        actor.yieldFrame(makeHrFrame(unix: 1_500, bpm: 10))
        actor.yieldFrame(hexBytes(whoop5HistoryEndHex))
        let beginTask = Task { await actor.begin(family: .whoop5, continuedAfterRows: false) }
        try? await Task.sleep(nanoseconds: 30_000_000)
        await beginTask.value
        XCTAssertEqual(store.maxConcurrentInserts, 1)
        XCTAssertEqual(store.insertOrder, [1])
    }

    func testFramesAroundSessionStartPreserveArrivalOrder() async {
        let store = OrderedInsertStore()
        store.insertDelayNs = 10_000_000
        let actor = await makeActor(store: store)
        await actor.begin(family: .whoop5, continuedAfterRows: false)
        actor.yieldFrame(makeHrFrame(unix: 1_500, bpm: 11))
        actor.yieldFrame(hexBytes(whoop5HistoryEndHex))
        actor.yieldFrame(makeHrFrame(unix: 1_501, bpm: 12))
        actor.yieldFrame(hexBytes(whoop5HistoryEndHex))
        actor.yieldFrame(makeHrFrame(unix: 1_502, bpm: 13))
        actor.yieldFrame(hexBytes(whoop5HistoryEndHex))
        try? await Task.sleep(nanoseconds: 500_000_000)
        XCTAssertEqual(store.insertOrder, [1, 2, 3])
    }

    func testTimeoutDuringInFlightIngestFinishesIngestFirst() async {
        let store = OrderedInsertStore()
        store.insertDelayNs = 200_000_000
        let actor = await makeActor(store: store)
        await actor.begin(family: .whoop5, continuedAfterRows: false)
        actor.yieldFrame(makeHrFrame(unix: 1_500, bpm: 20))
        actor.yieldFrame(hexBytes(whoop5HistoryEndHex))
        let timeoutTask = Task { await actor.timeoutFired() }
        try? await Task.sleep(nanoseconds: 50_000_000)
        XCTAssertEqual(store.insertOrder, [], "timeout must wait for ingest")
        await timeoutTask.value
        XCTAssertEqual(store.insertOrder, [1])
        let stillBackfilling = await actor.isBackfilling()
        XCTAssertFalse(stillBackfilling)
    }
}
