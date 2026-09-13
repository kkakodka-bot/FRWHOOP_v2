#if canImport(Compression)
import XCTest
import WhoopProtocol
@testable import WhoopStore

final class RawOutboxTests: XCTestCase {
    private let frames: [[UInt8]] = [
        [0xAA, 0x18, 0x00, 0xFF, 0x28, 0x02, 0x0F, 0x01, 0x02, 0x03],
        [0xAA, 0x0C, 0x00, 0xFC, 0x24, 0x24, 0x03, 0x0A],
        [],                                   // empty frame must survive the round-trip
    ]
    private func meta(_ id: String, capturedAt: Int = 5000, synced: Bool = false) -> RawBatchMeta {
        RawBatchMeta(batchId: id, deviceId: "dev1",
                     clockRef: ClockRef(device: 31538447, wall: 1736365593),
                     capturedAt: capturedAt, startTs: 1736365593, endTs: 1736365600,
                     frameCount: frames.count, byteSize: frames.reduce(0) { $0 + $1.count })
    }

    func testEnqueueThenRawFramesRoundTrips() async throws {
        let store = try await WhoopStore.inMemory()
        try await store.upsertDevice(id: "dev1", mac: nil, name: nil)
        try await store.enqueueRawBatch(meta("b1"), frames: frames)
        let got = try await store.rawFrames(batchId: "b1")
        XCTAssertEqual(got, frames)
    }

    func testRawFramesUnknownBatchIsEmpty() async throws {
        let store = try await WhoopStore.inMemory()
        let got = try await store.rawFrames(batchId: "nope")
        XCTAssertEqual(got, [])
    }

    func testPendingExcludesSyncedAndRespectsLimitAndOrder() async throws {
        let store = try await WhoopStore.inMemory()
        try await store.upsertDevice(id: "dev1", mac: nil, name: nil)
        try await store.enqueueRawBatch(meta("old", capturedAt: 100), frames: frames)
        try await store.enqueueRawBatch(meta("mid", capturedAt: 200), frames: frames)
        try await store.enqueueRawBatch(meta("new", capturedAt: 300), frames: frames)
        try await store.markRawBatchSynced(batchId: "mid", at: 999)

        let pending = try await store.pendingRawBatches(limit: 10)
        XCTAssertEqual(pending.map { $0.batchId }, ["old", "new"])   // mid synced; oldest first

        let limited = try await store.pendingRawBatches(limit: 1)
        XCTAssertEqual(limited.map { $0.batchId }, ["old"])
    }

    func testMetaRoundTripsThroughPending() async throws {
        let store = try await WhoopStore.inMemory()
        try await store.upsertDevice(id: "dev1", mac: nil, name: nil)
        let m = meta("b1")
        try await store.enqueueRawBatch(m, frames: frames)
        let pending = try await store.pendingRawBatches(limit: 10)
        XCTAssertEqual(pending.count, 1)
        XCTAssertEqual(pending[0], m)
    }

    func testRoundTripLargeBatch() async throws {
        let store = try await WhoopStore.inMemory()
        try await store.upsertDevice(id: "dev1", mac: nil, name: nil)
        // 200 frames x 24 bytes → packed >> (byteSize + 256) hint; exercises the truncation path.
        let manyFrames = (0..<200).map { i in [UInt8](repeating: UInt8(i & 0xFF), count: 24) }
        let byteSize = manyFrames.reduce(0) { $0 + $1.count }
        let m = RawBatchMeta(batchId: "big", deviceId: "dev1",
                             clockRef: ClockRef(device: 0, wall: 0),
                             capturedAt: 1, startTs: 0, endTs: 0,
                             frameCount: manyFrames.count, byteSize: byteSize)
        try await store.enqueueRawBatch(m, frames: manyFrames)
        let gotLarge = try await store.rawFrames(batchId: "big")
        XCTAssertEqual(gotLarge, manyFrames)
    }

    func testRoundTripHighlyCompressibleBatch() async throws {
        let store = try await WhoopStore.inMemory()
        try await store.upsertDevice(id: "dev1", mac: nil, name: nil)
        // All-zero frames compress to a tiny blob but decompress LARGE — the worst case for
        // any fixed-size decode buffer heuristic.
        let zeros = (0..<300).map { _ in [UInt8](repeating: 0, count: 64) }
        let byteSize = zeros.reduce(0) { $0 + $1.count }
        let m = RawBatchMeta(batchId: "z", deviceId: "dev1",
                             clockRef: ClockRef(device: 0, wall: 0),
                             capturedAt: 1, startTs: 0, endTs: 0,
                             frameCount: zeros.count, byteSize: byteSize)
        try await store.enqueueRawBatch(m, frames: zeros)
        let gotZeros = try await store.rawFrames(batchId: "z")
        XCTAssertEqual(gotZeros, zeros)
    }

    // MARK: - rawBatchMetas paged device enumeration (FRWHOOP issue #1 repair scan)

    private func deviceMeta(_ id: String, device: String, capturedAt: Int) -> RawBatchMeta {
        RawBatchMeta(batchId: id, deviceId: device,
                     clockRef: ClockRef(device: capturedAt, wall: capturedAt),
                     capturedAt: capturedAt, startTs: capturedAt, endTs: capturedAt,
                     frameCount: frames.count, byteSize: frames.reduce(0) { $0 + $1.count })
    }

    func testRawBatchMetasFiltersDeviceAndOrdersOldestFirst() async throws {
        let store = try await WhoopStore.inMemory()
        try await store.upsertDevice(id: "dev1", mac: nil, name: nil)
        try await store.upsertDevice(id: "dev2", mac: nil, name: nil)
        try await store.enqueueRawBatch(deviceMeta("c", device: "dev1", capturedAt: 300), frames: frames)
        try await store.enqueueRawBatch(deviceMeta("a", device: "dev1", capturedAt: 100), frames: frames)
        try await store.enqueueRawBatch(deviceMeta("b", device: "dev1", capturedAt: 200), frames: frames)
        try await store.enqueueRawBatch(deviceMeta("z", device: "dev2", capturedAt: 50), frames: frames)

        let page = try await store.rawBatchMetas(deviceId: "dev1")
        XCTAssertEqual(page.map { $0.batchId }, ["a", "b", "c"])
    }

    func testRawBatchMetasIncludesSyncedRows() async throws {
        let store = try await WhoopStore.inMemory()
        try await store.upsertDevice(id: "dev1", mac: nil, name: nil)
        try await store.enqueueRawBatch(deviceMeta("a", device: "dev1", capturedAt: 100), frames: frames)
        try await store.enqueueRawBatch(deviceMeta("b", device: "dev1", capturedAt: 200), frames: frames)
        try await store.markRawBatchSynced(batchId: "a", at: 999)

        let page = try await store.rawBatchMetas(deviceId: "dev1")
        XCTAssertEqual(page.map { $0.batchId }, ["a", "b"],
                       "the repair scan must see every retained batch, not only un-synced ones")
    }

    func testRawBatchMetasPagesByKeysetWithoutRepeats() async throws {
        let store = try await WhoopStore.inMemory()
        try await store.upsertDevice(id: "dev1", mac: nil, name: nil)
        // 5 batches, page size 2 → 3 pages; two batches SHARE a capturedAt so the batchId
        // tie-break is exercised (a capturedAt-only cursor would skip or repeat one).
        for (id, ts) in [("b1", 100), ("b2", 200), ("b3", 200), ("b4", 300), ("b5", 400)] {
            try await store.enqueueRawBatch(deviceMeta(id, device: "dev1", capturedAt: ts), frames: frames)
        }
        var seen: [String] = []
        var cursor: RawBatchMeta?
        while true {
            let page = try await store.rawBatchMetas(deviceId: "dev1", after: cursor, limit: 2)
            if page.isEmpty { break }
            seen += page.map { $0.batchId }
            cursor = page.last
            if seen.count > 8 { XCTFail("pagination did not terminate"); break }
        }
        XCTAssertEqual(seen, ["b1", "b2", "b3", "b4", "b5"])
    }

    func testRawBatchMetasRespectsLimit() async throws {
        let store = try await WhoopStore.inMemory()
        try await store.upsertDevice(id: "dev1", mac: nil, name: nil)
        for i in 0..<5 {
            try await store.enqueueRawBatch(deviceMeta("b\(i)", device: "dev1", capturedAt: 100 + i),
                                            frames: frames)
        }
        let page = try await store.rawBatchMetas(deviceId: "dev1", limit: 3)
        XCTAssertEqual(page.map { $0.batchId }, ["b0", "b1", "b2"])
    }
}
#endif
