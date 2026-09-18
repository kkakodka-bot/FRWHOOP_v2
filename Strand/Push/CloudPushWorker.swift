import Foundation
import GRDB
import NoopPush

enum CloudPushRunOutcome: Equatable {
    case completed, deferred, terminalFailure
}

/// A captured writer binding is the only authority for choosing upload ownership.
enum CloudPushWorker {
    private static let maxDevicesPerRun = 4
    private static let runLock = NSLock()
    private static var isRunning = false

    private static func beginRun() -> Bool {
        runLock.lock(); defer { runLock.unlock() }
        guard !isRunning else { return false }
        isRunning = true
        return true
    }
    private static func endRun() {
        runLock.lock(); defer { runLock.unlock() }; isRunning = false
    }

    static func enqueueAfterSuccessfulOffload(db: any DatabaseWriter) {
        guard CloudPushSettings.ready, CloudPushCaptureBindings.binding(for: db) != nil else { return }
        Task { await runOnce(db: db, trigger: "offload") }
        #if os(iOS)
        CloudPushBackgroundScheduler.scheduleIfNeeded()
        #endif
    }

    static func runOnce(
        db: any DatabaseWriter,
        trigger: String,
        markOwed: (@Sendable () async -> Void)? = nil,
        settleOwed: (@Sendable () async -> Bool)? = nil
    ) async -> CloudPushRunOutcome {
        var traceOutcome = SyncPipelineTrace.Outcome.pending
        defer { SyncPipelineTrace.event(.uploadScheduling, outcome: traceOutcome) }
        guard let endpoint = CloudPushSettings.enabledEndpoint() else { return .deferred }
        guard let binding = CloudPushCaptureBindings.binding(for: db),
              let initial = CloudAuthClient.currentContext(), binding.scope == initial.scope else {
            traceOutcome = .authenticationRequired
            // Root must retain debt for the original/unassigned writer. No account is inferred here.
            return .deferred
        }
        guard beginRun() else { return .deferred }
        defer { endRun() }
        #if os(iOS)
        if !CloudPushNetworkPolicy.isNetworkAvailable(wifiOnly: CloudPushSettings.wifiOnly) {
            traceOutcome = CloudPushSettings.wifiOnly ? .waitingForWiFi : .offline
            return .deferred
        }
        #endif

        let authorization: AuthorizedCloudSession
        let admission: AccountPushAdmission
        let transport: AccountFencedTransport
        let accountTransport: CloudAccountPushTransport
        do {
            let interval = SyncPipelineTrace.begin(.uploadPreparation)
            var preparationOutcome = SyncPipelineTrace.Outcome.failed
            defer { SyncPipelineTrace.end(interval, outcome: preparationOutcome) }
            authorization = try await CloudAuthClient.authorizedSession()
            guard authorization.context == initial else { throw AccountAuthError.staleOperation }
            try await CloudPushCaptureBindings.validateOwner(db: db, scope: initial.scope)
            admission = try AccountPushAdmission(
                context: initial, captureScope: binding.scope, sourceID: binding.sourceID,
                isCurrent: { context in
                    CloudAuthClient.isCurrent(context) && CloudPushSettings.enabledEndpoint()?.url == endpoint.url
                }
            )
            accountTransport = try CloudAccountPushTransport(endpoint: endpoint, authorization: authorization)
            transport = AccountFencedTransport(
                transport: accountTransport,
                admission: admission
            )
            preparationOutcome = .succeeded
        } catch let error as AccountAuthError {
            traceOutcome = error == .unboundCapture ? .pending :
                (error == .staleOperation ? .cancelled : .authenticationRequired)
            if error == .unboundCapture {
                CloudPushSettings.recordScopedRun(context: initial, state: .retrying,
                    message: "unboundCapture: upload is waiting for the captured database owner.")
            }
            return .deferred
        } catch {
            traceOutcome = .failed
            return .deferred
        }
        CloudPushSettings.recordScopedRun(context: initial, state: .running)

        let capabilities: PushCapabilities
        do {
            let interval = SyncPipelineTrace.begin(.uploadPreparation)
            var preparationOutcome = SyncPipelineTrace.Outcome.failed
            defer { SyncPipelineTrace.end(interval, outcome: preparationOutcome) }
            switch try await transport.capabilities() {
            case .available(let value): capabilities = value
            case .rejected(_, let retryable, let failure):
                traceOutcome = failure?.code == .httpAuth ? .authenticationRequired : .failed
                CloudPushSettings.recordScopedRun(context: initial, state: .retrying,
                    message: "Upload is waiting for an authenticated, available receiver.")
                return retryable || failure?.code == .httpAuth ? .deferred : .terminalFailure
            }
            try admission.check()
            preparationOutcome = .succeeded
        } catch {
            traceOutcome = CloudAuthClient.isCurrent(initial) ? .failed : .cancelled
            return .deferred
        }

        let namespace = admission.namespace(endpoint: endpoint.url, protocolVersion: capabilities.protocolVersion,
                                             receiverStateID: capabilities.receiverStateId)
        let capturedSnapshot = CloudPushSnapshot(db: db, imuPushSource: binding.imuSource)
        let snapshot = AccountFencedSnapshot(source: capturedSnapshot, admission: admission)
        let durableProgress: CloudPushProgressStore
        let committer: CloudPushSourceCommitter
        do {
            let runtime = try CloudPushBackgroundRuntime.current(for: initial)
            let makeCommitter: (CloudPushProgressStore) -> CloudPushSourceCommitter = { progress in
                CloudPushSourceCommitter(progress: progress, check: { try admission.check() },
                    acknowledge: { try await capturedSnapshot.acknowledgeCommitted($0, scope: initial.scope) },
                    cleanup: { try await accountTransport.base.sourceCommitted(batchID: $0) },
                    didApply: { try admission.check(); try capturedSnapshot.sourceProgressApplied($0, scope: initial.scope) },
                    didCleanup: { try admission.check(); try capturedSnapshot.sourceCleanupCompleted($0, scope: initial.scope) })
            }
            durableProgress = try await CloudPushProgressRecovery.recover(admission: admission,
                endpoint: endpoint.url, receiverStateID: capabilities.receiverStateId,
                currentVersion: capabilities.protocolVersion, directory: runtime.progressDirectory,
                committer: makeCommitter)
            committer = makeCommitter(durableProgress)
        } catch { traceOutcome = .failed; return .deferred }
        let progress = AccountFencedProgress(progress: durableProgress, admission: admission)
        let coordinator = PushCoordinator(
            source: snapshot, transport: transport, progress: progress, sourceId: binding.sourceID,
            destinationStillCurrent: { (try? admission.check()) != nil },
            receiptOwner: initial.scope,
            objectProtocolVersion: PushProtocol.isObjectVersion(capabilities.protocolVersion)
                ? capabilities.protocolVersion : PushProtocol.objectVersion,
            associateReceipt: { batch, rows, receipt in
                try admission.check()
                try await capturedSnapshot.associateReceipt(batch: batch, rows: rows, receipt: receipt, scope: initial.scope)
                try admission.check()
                try await durableProgress.associate(batch: batch, rows: rows, receipt: receipt)
            },
            associateInlineReceipt: { batch, receipt in
                try admission.check()
                try await durableProgress.associateInline(batch: batch, receipt: receipt)
            },
            commitSource: { try await committer.commit($0) }
        )
        let run = await coordinator.pushKnownDevices(
            startDeviceIndex: CloudPushSettings.nextDeviceIndex(namespace: namespace),
            maxDevices: maxDevicesPerRun, capabilities: capabilities,
            binaryEnabled: CloudPushSettings.binaryObjectsEnabled
        )
        guard (try? admission.check()) != nil else { traceOutcome = .cancelled; return .deferred }
        if !run.hasRetryableFailure {
            CloudPushSettings.saveNextDeviceIndex(namespace: namespace, index: run.nextDeviceIndex)
        }
        let more = CloudPushSettings.cycleNeedsAnotherPass(namespace: namespace) ||
            run.hasMoreAppendRows || run.hasMoreBinaryRows
        let cycleCompleted = run.nextDeviceIndex == 0
        CloudPushSettings.saveCycleNeedsAnotherPass(namespace: namespace, needed: cycleCompleted ? false : more)

        if run.hasRetryableFailure {
            traceOutcome = .failed
            CloudPushSettings.recordScopedRun(context: initial, state: .retrying,
                message: "Upload will retry.", batches: run.acceptedBatches, records: run.acceptedRecords)
            if (try? admission.check()) != nil { await markOwed?() }
            return .deferred
        }
        if run.rejectedBatches > 0 {
            traceOutcome = .failed
            CloudPushSettings.recordScopedRun(context: initial, state: .failed,
                message: "Upload requires attention.", batches: run.acceptedBatches, records: run.acceptedRecords)
            return .terminalFailure
        }
        if !cycleCompleted || more {
            CloudPushSettings.recordScopedRun(context: initial, state: .continuing,
                batches: run.acceptedBatches, records: run.acceptedRecords)
            if (try? admission.check()) != nil { await markOwed?() }
            #if os(iOS)
            CloudPushBackgroundScheduler.scheduleIfNeeded()
            #endif
            return .deferred
        }
        guard (try? admission.check()) != nil else { traceOutcome = .cancelled; return .deferred }
        // Callback belongs to the same captured writer; root must never close over a mutable active store.
        _ = await settleOwed?()
        guard (try? admission.check()) != nil else { traceOutcome = .cancelled; return .deferred }
        CloudPushSettings.recordScopedRun(context: initial, state: .complete,
            batches: run.acceptedBatches, records: run.acceptedRecords)
        traceOutcome = .succeeded
        return .completed
    }
}
