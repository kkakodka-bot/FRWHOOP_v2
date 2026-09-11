package com.noop.data

/** Durable post-offload stages. Values match the Apple `SyncJobKind` store contract. */
enum class SyncJobKind(val rawValue: String) {
    RESCORE("rescore"),
    HEALTH_WRITEBACK("healthWriteback"),
    WIDGET_PUBLISH("widgetPublish"),
}

/** Why Android is resuming a durable post-offload drain. */
enum class SyncWakeReason(val rawValue: String) {
    BACKLOG_TERMINAL("backlogTerminal"),
    DISCONNECT("disconnect"),
    NON_CONTINUING_EXIT("nonContinuingExit"),
    PROCESS_RESTART("processRestart"),
    FOREGROUND("foreground"),
    IDLE_BACKSTOP("idleBackstop"),
}

/** Pure fixed ordering for the Android post-offload subset. HTTP push keeps its own WorkManager queue. */
object SyncDrainPolicy {
    val stageOrder: List<SyncJobKind> = listOf(
        SyncJobKind.RESCORE,
        SyncJobKind.HEALTH_WRITEBACK,
        SyncJobKind.WIDGET_PUBLISH,
    )

    fun shouldRun(stage: SyncJobKind, owedKinds: Set<SyncJobKind>): Boolean =
        stage in owedKinds

    fun stagesToRun(owedKinds: Set<SyncJobKind>): List<SyncJobKind> =
        stageOrder.filter { shouldRun(it, owedKinds) }

    fun shouldContinue(after: SyncJobKind, succeeded: Boolean, rescoreStillOwed: Boolean): Boolean {
        if (rescoreStillOwed) return false
        return after != SyncJobKind.RESCORE || succeeded
    }
}

/** Pure twin of Apple `BacklogBurstDrainPolicy`; no BLE or Room dependency. */
object BacklogBurstDrainPolicy {
    enum class Action { CONTINUE_BURST, FINISH_BURST, DEFER_UNTIL_WAKE }

    fun action(
        linkUsable: Boolean,
        anotherSessionInFlight: Boolean,
        continuationAllowed: Boolean,
    ): Action = when {
        !linkUsable -> Action.DEFER_UNTIL_WAKE
        anotherSessionInFlight || continuationAllowed -> Action.CONTINUE_BURST
        else -> Action.FINISH_BURST
    }

    fun committedDataExit(
        historyComplete: Boolean,
        timedOut: Boolean,
        persistedSensorRows: Boolean,
    ): Boolean = historyComplete || (timedOut && persistedSensorRows)

    fun shouldDrain(hasOwedWork: Boolean, willAutoContinue: Boolean): Boolean =
        hasOwedWork && action(true, false, willAutoContinue) == Action.FINISH_BURST
}
