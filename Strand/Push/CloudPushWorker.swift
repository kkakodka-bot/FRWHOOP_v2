import Foundation
import GRDB
import NoopPush

/// Runs one bounded cloud-push cycle after a successful offload or manual trigger.
enum CloudPushWorker {
    private static let maxDevicesPerRun = 4
    private static var isRunning = false

    static func enqueueAfterSuccessfulOffload(db: any DatabaseWriter) {
        guard CloudPushSettings.ready else { return }
        CloudPushSettings.recordPushStarted()
        Task { await runOnce(db: db, trigger: "offload") }
        #if os(iOS)
        CloudPushBackgroundScheduler.scheduleIfNeeded()
        #endif
    }

    static func runOnce(db: any DatabaseWriter, trigger: String) async {
        guard CloudPushSettings.enabledEndpoint() != nil else { return }
        guard !isRunning else { return }
        isRunning = true
        defer { isRunning = false }

        #if os(iOS)
        if !CloudPushNetworkPolicy.isNetworkAvailable(wifiOnly: CloudPushSettings.wifiOnly) {
            CloudPushSettings.recordRetrying(
                message: String(localized: "Waiting for a network allowed by the Wi‑Fi only setting.")
            )
            CloudPushBackgroundScheduler.scheduleIfNeeded()
            return
        }
        #endif

        guard let endpoint = CloudPushSettings.enabledEndpoint(),
              let token = CloudPushSettings.resolvedToken() else {
            CloudPushSettings.recordError(
                String(localized: "The saved token is unavailable. Save it again.")
            )
            return
        }

        CloudPushSettings.recordRunning()

        let sourceId = CloudPushSettings.sourceId()
        let transport = CloudPushTransport(endpoint: endpoint, bearerToken: token)
        let capabilitiesResult = (try? await transport.capabilities()) ?? .rejected(
            reason: PushFailure(code: .networkIO).safeCode,
            retryable: true,
            failure: PushFailure(code: .networkIO)
        )
        guard case .available(let capabilities) = capabilitiesResult else {
            if case .rejected(_, let retryable, let failure) = capabilitiesResult {
                let message = CloudPushMessaging.pushFailureMessage(
                    failure ?? PushFailure(code: .capabilitiesInvalid)
                )
                if retryable {
                    CloudPushSettings.recordRetrying(message: message)
                    #if os(iOS)
                    CloudPushBackgroundScheduler.scheduleIfNeeded()
                    #endif
                } else {
                    CloudPushSettings.recordError(message)
                }
            }
            return
        }
        CloudPushSettings.recordCapabilities(endpoint: endpoint, capabilities: capabilities)
        let namespace = CloudPushSettings.progressNamespace(
            sourceId: sourceId,
            endpoint: endpoint,
            protocolVersion: capabilities.protocolVersion,
            receiverStateId: capabilities.receiverStateId
        )

        let imuPushSource = await MainActor.run { ImuSessionFileStore.shared as ImuSessionPushSource }
        let snapshot = CloudPushSnapshot(db: db, imuPushSource: imuPushSource)
        let progress = CloudPushProgressStore(namespace: namespace)
        let startIndex = CloudPushSettings.nextDeviceIndex(namespace: namespace)
        let coordinator = PushCoordinator(
            source: snapshot,
            transport: transport,
            progress: progress,
            sourceId: sourceId,
            destinationStillCurrent: { CloudPushSettings.enabledEndpoint()?.url == endpoint.url }
        )
        let run = await coordinator.pushKnownDevices(
            startDeviceIndex: startIndex,
            maxDevices: maxDevicesPerRun,
            capabilities: capabilities,
            binaryEnabled: CloudPushSettings.binaryObjectsEnabled
        )

        CloudPushSettings.saveNextDeviceIndex(namespace: namespace, index: run.nextDeviceIndex)
        let cycleNeedsAnotherPass = CloudPushSettings.cycleNeedsAnotherPass(namespace: namespace)
            || run.hasMoreAppendRows
            || run.hasMoreBinaryRows
        let cycleCompleted = run.nextDeviceIndex == 0
        CloudPushSettings.saveCycleNeedsAnotherPass(
            namespace: namespace,
            needed: cycleCompleted ? false : cycleNeedsAnotherPass
        )

        if run.acceptedBatches > 0 {
            CloudPushSettings.recordAcceptedBatches(batches: run.acceptedBatches, records: run.acceptedRecords)
        }

        if run.hasRetryableFailure {
            CloudPushSettings.recordRetrying(
                message: CloudPushMessaging.pushFailureMessage(run.failure ?? PushFailure(code: .networkIO))
            )
            #if os(iOS)
            CloudPushBackgroundScheduler.scheduleIfNeeded()
            #endif
            return
        }
        if run.rejectedBatches > 0 {
            CloudPushSettings.recordError(
                CloudPushMessaging.pushFailureMessage(run.failure ?? PushFailure(code: .httpClient))
            )
            return
        }
        if !cycleCompleted || cycleNeedsAnotherPass {
            CloudPushSettings.recordContinuation()
            #if os(iOS)
            CloudPushBackgroundScheduler.scheduleIfNeeded()
            #endif
            return
        }
        CloudPushSettings.recordSuccess()
    }
}
