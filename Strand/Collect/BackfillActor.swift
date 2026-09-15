import Foundation
import WhoopProtocol
import WhoopStore
import StrandAnalytics

/// Read-only offload session state for `BLEManager.exitBackfilling` (main actor).
struct BackfillSessionSnapshot: Sendable {
    let sessionRowsPersisted: Int
    let sessionMotionRows: Int
    let sessionSkinTempRows: Int
    let sessionNights: Int
    let sessionNightKeys: Set<Int>
    let sessionClockDevice: Int?
    let sessionClockWall: Int?
    let sessionUsedIdentityRef: Bool
    let sessionDroppedImplausible: Int
    let sessionDynAccel: Streams.DynAccelDiag
    let persistStalled: Bool
    let lastAckedTrim: UInt32?
    let family: DeviceFamily
    let phaseSamples: [BackfillChunkPhaseSample]
    let rrEmissionLine: String?
}

/// Main-actor callbacks the serial offload pipeline invokes (BLE writes, UI tallies, archives).
struct BackfillMainHooks: Sendable {
    let ackTrim: @Sendable (UInt32, [UInt8]) async -> Void
    let onBankedOffload: @Sendable ((hr: Int, rr: Int, events: Int, battery: Int,
                                    spo2: Int, skinTemp: Int, resp: Int, gravity: Int)) async -> Void
    let log: @Sendable (String) async -> Void
    let rejectedSink: @Sendable ([[UInt8]], UInt32, DeviceFamily) async -> Bool
    let onChunk: @Sendable (Bool, Bool) async -> Void
    let connectionActive: @Sendable () -> Bool
    let connectionLog: @Sendable (String) async -> Void
    let firmwareLayout: @Sendable (Int) async -> Void
    let onPersistCircuitBreak: @Sendable () async -> Void
    let onChunkCommitBegin: @Sendable () async -> Void
    let onChunkCommitAborted: @Sendable () async -> Void
    let onOffloadComplete: @Sendable () async -> Void
}

/// Thread-safe handoff for BLE notify-path frame yields into the actor pipeline.
private final class BackfillPipelineSink: @unchecked Sendable {
    var continuation: AsyncStream<BackfillPipelineItem>.Continuation?
}

private enum BackfillPipelineItem {
    case frame([UInt8])
    case begin(family: DeviceFamily, continuedAfterRows: Bool, done: CheckedContinuation<Void, Never>)
    case timeout(done: CheckedContinuation<Void, Never>)
}

/// Serial offload pipeline: FIFO frame/control queue, chunk commits, and IMU session persistence off the main actor.
actor BackfillActor {
    private var backfiller: Backfiller?
    private let pipelineSink = BackfillPipelineSink()
    private var processingTask: Task<Void, Never>?
    private var onOffloadComplete: (() async -> Void)?
    /// False after `timeout` until the next `begin`; stray frames from a torn-down session are dropped.
    private var acceptingFrames = false
    /// True while `runLoop` is inside `ingest` (or between dequeue and loop exit for one frame).
    private var ingestInFlight = false
    private var queuedFrameCount = 0

    func configure(store: BackfillStoreWriting,
                   deviceId: String,
                   hooks: BackfillMainHooks,
                   enableRawCapture: Bool,
                   postOffloadJobKinds: [String],
                   extract: @escaping Backfiller.Extractor = { extractHistoricalStreams($0, deviceClockRef: $1, wallClockRef: $2,
                                                                                         sessionOldestUnix: $3, sessionNewestUnix: $4,
                                                                                         subLagInterp: PuffinExperiment.ppgHrSubLagInterpEnabled) }) {
        onOffloadComplete = hooks.onOffloadComplete
        backfiller = Backfiller(
            store: store,
            deviceId: deviceId,
            ackTrim: { trim, endData in await hooks.ackTrim(trim, endData) },
            onBankedOffload: { counts in await hooks.onBankedOffload(counts) },
            enableRawCapture: enableRawCapture,
            log: { line in await hooks.log(line) },
            rejectedSink: { frames, trim, family in await hooks.rejectedSink(frames, trim, family) },
            imuSessionSink: { deviceId, records in
                ImuSessionFileStore.shared.persistHistoricalImu(deviceId: deviceId, records: records)
            },
            onChunk: { decoded, console in await hooks.onChunk(decoded, console) },
            connectionActive: hooks.connectionActive,
            connectionLog: { line in await hooks.connectionLog(line) },
            firmwareLayout: { version in await hooks.firmwareLayout(version) },
            postOffloadJobKinds: postOffloadJobKinds,
            onPersistCircuitBreak: { await hooks.onPersistCircuitBreak() },
            onChunkCommitBegin: { await hooks.onChunkCommitBegin() },
            onChunkCommitAborted: { await hooks.onChunkCommitAborted() },
            extract: extract)
        let (stream, continuation) = AsyncStream<BackfillPipelineItem>.makeStream()
        pipelineSink.continuation = continuation
        processingTask?.cancel()
        processingTask = Task { await self.runLoop(stream) }
    }

    /// Thread-safe frame handoff from the BLE notify path — no per-frame `Task`.
    nonisolated func yieldFrame(_ frame: [UInt8]) {
        pipelineSink.continuation?.yield(.frame(frame))
    }

    func setDeviceId(_ id: String) {
        backfiller?.deviceId = id
    }

    func setClockRef(_ ref: ClockRef?) {
        backfiller?.clockRef = ref
    }

    func setSessionOldestUnix(_ value: Int?) {
        backfiller?.sessionOldestUnix = value
    }

    func setSessionNewestUnix(_ value: Int?) {
        backfiller?.sessionNewestUnix = value
    }

    /// Reset session state. Does not return until any in-flight ingest and prior queued items finish.
    func begin(family: DeviceFamily, continuedAfterRows: Bool) async {
        await withCheckedContinuation { done in
            pipelineSink.continuation?.yield(.begin(family: family, continuedAfterRows: continuedAfterRows, done: done))
        }
    }

    /// Tear down backfiller state after the idle watchdog fires. Serialized behind any in-flight ingest.
    func timeoutFired() async {
        await withCheckedContinuation { done in
            pipelineSink.continuation?.yield(.timeout(done: done))
        }
    }

    func isBackfilling() async -> Bool {
        backfiller?.isBackfilling ?? false
    }

    func historyInFlight() -> Bool {
        ingestInFlight || queuedFrameCount > 0 || (backfiller?.isBackfilling ?? false)
    }

    func sessionSnapshot() -> BackfillSessionSnapshot? {
        guard let bf = backfiller else { return nil }
        return BackfillSessionSnapshot(
            sessionRowsPersisted: bf.sessionRowsPersisted,
            sessionMotionRows: bf.sessionMotionRows,
            sessionSkinTempRows: bf.sessionSkinTempRows,
            sessionNights: bf.sessionNights,
            sessionNightKeys: bf.sessionNightKeys,
            sessionClockDevice: bf.sessionClockDevice,
            sessionClockWall: bf.sessionClockWall,
            sessionUsedIdentityRef: bf.sessionUsedIdentityRef,
            sessionDroppedImplausible: bf.sessionDroppedImplausible,
            sessionDynAccel: bf.sessionDynAccel,
            persistStalled: bf.persistStalled,
            lastAckedTrim: bf.lastAckedTrim,
            family: bf.family,
            phaseSamples: bf.sessionPhaseTimingSamples(),
            rrEmissionLine: bf.sessionRrEmissionLine())
    }

    private func runLoop(_ stream: AsyncStream<BackfillPipelineItem>) async {
        for await item in stream {
            switch item {
            case .begin(let family, let continuedAfterRows, let done):
                acceptingFrames = true
                backfiller?.begin(family: family, continuedAfterRows: continuedAfterRows)
                done.resume()
            case .timeout(let done):
                acceptingFrames = false
                backfiller?.timeoutFired()
                done.resume()
            case .frame(let frame):
                guard acceptingFrames else { continue }
                queuedFrameCount += 1
                ingestInFlight = true
                defer {
                    ingestInFlight = false
                    queuedFrameCount -= 1
                }
                guard let backfiller else { continue }
                await backfiller.ingest(frame)
                if !backfiller.isBackfilling {
                    acceptingFrames = false
                    await onOffloadComplete?()
                }
            }
        }
    }
}
