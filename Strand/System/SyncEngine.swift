import Foundation
import WhoopStore
#if os(iOS)
import BackgroundTasks
import UIKit
#endif

/// Single orchestrator for post-offload work after strap data lands (#1538).
///
/// The strap→app offload (`Backfiller`) stays lossless and untouched. This engine owns what happens
/// AFTER rows are banked: re-score, cloud push, Apple Health write-back, and widget publish. Every
/// wake funnels through `drain(reason:)` so owed work is visible in `syncJob` and each pass is
/// recorded in `syncJournalEntry`.
@MainActor
final class SyncEngine {

    private weak var host: AppModel?

    init() {}

    func bind(_ host: AppModel) {
        self.host = host
    }

    /// Mark [kind] owed in the store. Returns the fresh token (#1681).
    @discardableResult
    func markOwed(_ kind: SyncJobKind, note: String? = nil) async -> String? {
        guard let store = await host?.repo.storeHandle() else { return nil }
        return try? await store.markJobOwed(kind: kind.rawValue, note: note)
    }

    /// Settle [kind] only when [token] still matches.
    func settle(_ kind: SyncJobKind, token: String?) async -> Bool {
        guard let token, !token.isEmpty,
              let store = await host?.repo.storeHandle() else { return false }
        return (try? await store.settleJob(kind: kind.rawValue, token: token)) ?? false
    }

    /// Whether any post-offload stage is still outstanding.
    func hasOwedWork() async -> Bool {
        await currentOwedKinds().isEmpty == false
    }

    /// The single entry point every wake calls.
    func drain(reason: SyncDrainPolicy.WakeReason) async {
        guard let host else { return }
        guard let store = await host.repo.storeHandle() else { return }

        await mirrorRescoreDebt(store: store)

        let owedRows = (try? await store.owedJobs()) ?? []
        let owedKinds = Set(owedRows.compactMap { SyncJobKind(rawValue: $0.kind) })

        let started = Date()
        var stagesRun: [SyncJobKind] = []
        var stagesFailed: [SyncJobKind] = []

        for stage in SyncDrainPolicy.stageOrder {
            guard SyncDrainPolicy.shouldRun(stage: stage, owedKinds: owedKinds, reason: reason) else {
                continue
            }
            #if !os(iOS)
            if stage == .cloudPush || stage == .healthWriteback || stage == .widgetPublish { continue }
            #endif

            try? await store.recordJobAttempt(kind: stage.rawValue)
            let ok = await runStage(stage, reason: reason, host: host)
            if ok { stagesRun.append(stage) } else { stagesFailed.append(stage) }
        }

        let stillOwed = (try? await store.owedJobs()) ?? []
        let stillOwedKinds = stillOwed.map(\.kind)
        let durationMs = Int(Date().timeIntervalSince(started) * 1000)
        let note = stagesFailed.isEmpty
            ? nil
            : "failed: \(stagesFailed.map(\.rawValue).joined(separator: ","))"
        try? await store.appendSyncJournal(
            wakeReason: reason.rawValue,
            stagesRun: stagesRun.map(\.rawValue),
            stagesOwed: stillOwedKinds,
            durationMs: durationMs,
            note: note
        )
    }

    // MARK: - Stage runners

    private func runStage(_ stage: SyncJobKind,
                            reason: SyncDrainPolicy.WakeReason,
                            host: AppModel) async -> Bool {
        switch stage {
        case .rescore:
            return await runRescore(reason: reason, host: host)
        case .cloudPush:
            return await runCloudPush(host: host)
        case .healthWriteback:
            return await runHealthWriteback(host: host)
        case .widgetPublish:
            return await runWidgetPublish(host: host)
        }
    }

    private func runRescore(reason: SyncDrainPolicy.WakeReason, host: AppModel) async -> Bool {
        switch reason {
        case .offloadComplete:
            await RescoreBackgroundScheduler.run(log: { [live = host.live] line in
                live.append(log: line)
            }) {
                await host.intelligence.analyzeRecent(skipIfUnchanged: true)
            }
        default:
            guard RescoreBackgroundScheduler.isRescoreOwed else { return true }
            await host.runDeferredRescoreIfOwed()
        }

        if !RescoreBackgroundScheduler.isRescoreOwed {
            try? await host.repo.storeHandle()?.clearJob(kind: SyncJobKind.rescore.rawValue)
            return true
        }
        return false
    }

    private func runCloudPush(host: AppModel) async -> Bool {
        guard CloudPushSettings.ready else { return true }
        guard let writer = await host.repo.registryWriterForPush() else { return true }
        await CloudPushWorker.runOnce(
            db: writer,
            trigger: "sync-engine",
            markOwed: { [weak self] in await self?.markOwed(.cloudPush) },
            settleOwed: { [weak self] in
                guard let store = await host.repo.storeHandle(),
                      let job = try? await store.owedJobs().first(where: {
                          $0.kind == SyncJobKind.cloudPush.rawValue
                      }) else { return false }
                return await self?.settle(.cloudPush, token: job.token) ?? false
            }
        )
        let stillOwed = (try? await host.repo.storeHandle()?.owedJobs())?
            .contains(where: { $0.kind == SyncJobKind.cloudPush.rawValue }) ?? false
        return !stillOwed
    }

    private func runHealthWriteback(host: AppModel) async -> Bool {
        #if os(iOS)
        let token = await markOwed(.healthWriteback, note: "health write-back")
        let ok = await host.healthWriteBack?() ?? true
        if ok {
            if let token { _ = await settle(.healthWriteback, token: token) }
            return true
        }
        return false
        #else
        return true
        #endif
    }

    private func runWidgetPublish(host: AppModel) async -> Bool {
        #if os(iOS)
        let token = await markOwed(.widgetPublish, note: "widget publish")
        await WidgetSnapshot.publish(from: host)
        if let token { _ = await settle(.widgetPublish, token: token) }
        return true
        #else
        return true
        #endif
    }

    // MARK: - Rescore mirror

    /// `RescoreBackgroundScheduler` remains the rescore source of truth; mirror its debt into
    /// `syncJob` so all owed work is visible in one place.
    private func mirrorRescoreDebt(store: WhoopStore) async {
        if RescoreBackgroundScheduler.isRescoreOwed,
           let token = RescoreBackgroundScheduler.currentOwedToken {
            try? await store.mirrorRescoreJob(token: token)
        } else {
            try? await store.clearJob(kind: SyncJobKind.rescore.rawValue)
        }
    }

    private func currentOwedKinds() async -> Set<SyncJobKind> {
        guard let store = await host?.repo.storeHandle() else { return [] }
        await mirrorRescoreDebt(store: store)
        let rows = (try? await store.owedJobs()) ?? []
        return Set(rows.compactMap { SyncJobKind(rawValue: $0.kind) })
    }
}

#if os(iOS)
/// BGProcessing backstop that drains every owed post-offload stage when foreground/BLE wakes are not enough.
enum SyncMaintenanceBackgroundScheduler {

    private static var drainHandler: (@MainActor () async -> Void)?

    static let taskIdentifier = (Bundle.main.bundleIdentifier ?? "com.noopapp.noop") + ".syncmaintenance"

    static func register(drain: @escaping @MainActor () async -> Void) {
        drainHandler = drain
        BGTaskScheduler.shared.register(forTaskWithIdentifier: taskIdentifier, using: nil) { task in
            let completion = TaskCompletionGuard(task: task)
            let worker = Task { @MainActor in
                await drainHandler?()
                guard !Task.isCancelled else { return }
                if await SyncMaintenanceBackgroundScheduler.shouldRearm() {
                    schedule()
                }
                let stillOwed = await SyncMaintenanceBackgroundScheduler.shouldRearm()
                completion.finish(success: !stillOwed)
            }
            task.expirationHandler = {
                worker.cancel()
                schedule()
                completion.finish(success: false)
            }
        }
    }

    static func scheduleIfNeeded() {
        Task { @MainActor in
            guard await shouldRearm() else { return }
            schedule()
        }
    }

    @MainActor
    private static func shouldRearm() async -> Bool {
        guard let model = AppModel.shared else { return false }
        return await model.syncEngine.hasOwedWork()
    }

    static func schedule() {
        BGTaskScheduler.shared.cancel(taskRequestWithIdentifier: taskIdentifier)
        let request = BGProcessingTaskRequest(identifier: taskIdentifier)
        request.requiresNetworkConnectivity = false
        request.requiresExternalPower = false
        try? BGTaskScheduler.shared.submit(request)
    }

    private final class TaskCompletionGuard: @unchecked Sendable {
        private let task: BGTask
        private let lock = NSLock()
        private var finished = false

        init(task: BGTask) { self.task = task }

        func finish(success: Bool) {
            lock.lock()
            defer { lock.unlock() }
            guard !finished else { return }
            finished = true
            task.setTaskCompleted(success: success)
        }
    }
}
#endif
