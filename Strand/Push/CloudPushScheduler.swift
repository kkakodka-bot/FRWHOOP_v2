import Foundation
import GRDB

/// The only entry point that queues cloud-push work from UI and lifecycle hooks.
enum CloudPushScheduler {
    static func enqueueLaunchCatchUp(db: any DatabaseWriter) {
        guard CloudPushSettings.enabledEndpoint() != nil else { return }
        CloudPushSettings.recordPushStarted()
        Task { await CloudPushWorker.runOnce(db: db, trigger: "launch") }
        #if os(iOS)
        CloudPushBackgroundScheduler.scheduleIfNeeded()
        #endif
    }

    static func enqueueManualCatchUp(db: any DatabaseWriter) {
        guard CloudPushSettings.ready else { return }
        CloudPushSettings.recordPushStarted()
        Task { await CloudPushWorker.runOnce(db: db, trigger: "manual") }
        #if os(iOS)
        CloudPushBackgroundScheduler.scheduleIfNeeded()
        #endif
    }

    static func networkPolicyChanged(db: any DatabaseWriter) {
        guard CloudPushSettings.enabledEndpoint() != nil else { return }
        cancelScheduledWork()
        CloudPushSettings.recordPushStarted()
        Task { await CloudPushWorker.runOnce(db: db, trigger: "network") }
        #if os(iOS)
        CloudPushBackgroundScheduler.scheduleIfNeeded()
        #endif
    }

    static func cancelScheduledWork() {
        #if os(iOS)
        CloudPushBackgroundScheduler.cancelScheduled()
        #endif
    }
}
