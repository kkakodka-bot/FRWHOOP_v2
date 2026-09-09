import Foundation
import WhoopStore

/// Pure decision rules for which post-offload stages a sync drain should run.
///
/// Keeps the orchestration testable without a store, background tasks, or BLE. The engine reads
/// outstanding debts and the wake reason, then asks here whether each stage in order should start.
enum SyncDrainPolicy {

    /// Why the process woke to drain post-offload work.
    enum WakeReason: String, CaseIterable, Sendable {
        case bleEvent
        case foreground
        case backgroundTask
        case stateRestoration
        case offloadComplete
        case manual
    }

    /// Fixed stage order: scored data first, then export surfaces.
    static let stageOrder: [SyncJobKind] = [
        .rescore, .cloudPush, .healthWriteback, .widgetPublish,
    ]

    /// Whether [stage] should run for this wake. Offload completion is the natural trigger for every
    /// post-offload stage (#980 widget, #1021 Health, cloud push after a successful offload). Every
    /// other wake runs only work that is still marked owed.
    static func shouldRun(stage: SyncJobKind,
                          owedKinds: Set<SyncJobKind>,
                          reason: WakeReason) -> Bool {
        if owedKinds.contains(stage) { return true }
        return reason == .offloadComplete
    }
}
