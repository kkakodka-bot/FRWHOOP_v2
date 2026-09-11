package com.noop.data

import com.noop.ble.WhoopBleClient
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class SyncDrainPolicyTest {
    @Test fun stageOrderMatchesSharedPostOffloadOrderWithoutHttpWorker() {
        assertEquals(
            listOf(SyncJobKind.RESCORE, SyncJobKind.HEALTH_WRITEBACK, SyncJobKind.WIDGET_PUBLISH),
            SyncDrainPolicy.stageOrder,
        )
        assertEquals(
            listOf("rescore", "healthWriteback", "widgetPublish"),
            SyncDrainPolicy.stageOrder.map { it.rawValue },
        )
        assertEquals(
            listOf(SyncJobKind.RESCORE, SyncJobKind.WIDGET_PUBLISH),
            SyncDrainPolicy.stagesToRun(setOf(SyncJobKind.WIDGET_PUBLISH, SyncJobKind.RESCORE)),
        )
    }

    @Test fun backlogActionsMatchAppleVectors() {
        assertEquals(
            BacklogBurstDrainPolicy.Action.DEFER_UNTIL_WAKE,
            BacklogBurstDrainPolicy.action(false, false, true),
        )
        assertEquals(
            BacklogBurstDrainPolicy.Action.CONTINUE_BURST,
            BacklogBurstDrainPolicy.action(true, true, false),
        )
        assertEquals(
            BacklogBurstDrainPolicy.Action.CONTINUE_BURST,
            BacklogBurstDrainPolicy.action(true, false, true),
        )
        assertEquals(
            BacklogBurstDrainPolicy.Action.FINISH_BURST,
            BacklogBurstDrainPolicy.action(true, false, false),
        )
        assertTrue(BacklogBurstDrainPolicy.committedDataExit(true, false, false))
        assertTrue(BacklogBurstDrainPolicy.committedDataExit(false, true, true))
        assertFalse(BacklogBurstDrainPolicy.committedDataExit(false, true, false))
    }

    @Test fun failedOrSupersededRescoreStopsExportStages() {
        assertFalse(SyncDrainPolicy.shouldContinue(SyncJobKind.RESCORE, false, false))
        assertFalse(SyncDrainPolicy.shouldContinue(SyncJobKind.RESCORE, true, true))
        assertTrue(SyncDrainPolicy.shouldContinue(SyncJobKind.RESCORE, true, false))
        assertFalse(SyncDrainPolicy.shouldContinue(SyncJobKind.HEALTH_WRITEBACK, false, true))
        assertTrue(SyncDrainPolicy.shouldContinue(SyncJobKind.HEALTH_WRITEBACK, false, false))
    }

    @Test fun matchingBurstVectorsCoalesceToOneTerminalDrain() {
        data class Vector(
            val name: String,
            val owed: Boolean,
            val continuations: List<Boolean>,
            val expectedDrains: Int,
        )
        val vectors = listOf(
            Vector("ordinary-morning-empty-tail", true, listOf(true, false), 1),
            Vector("productive-deep-backlog", true, listOf(true, true, true, false), 1),
            Vector("intermediate-history-complete", true, listOf(true), 0),
            Vector("productive-timeout-continuation", true, listOf(true, false), 1),
            Vector("final-empty-tail-retains-debt", true, listOf(false), 1),
            Vector("duplicate-or-phantom", false, listOf(false), 0),
            Vector("future-clock-rejected-rows", false, listOf(false), 0),
            Vector("restart-with-durable-debt", true, listOf(false), 1),
            Vector(
                "cap-terminal",
                true,
                List(WhoopBleClient.MAX_AUTO_CONTINUES) { true } + false,
                1,
            ),
        )
        for (vector in vectors) {
            val drains = vector.continuations.count { willContinue ->
                BacklogBurstDrainPolicy.shouldDrain(
                    hasOwedWork = vector.owed,
                    willAutoContinue = willContinue,
                )
            }
            assertEquals(vector.name, vector.expectedDrains, drains)
        }
    }

    @Test fun deepBurstRunsEachExpensiveStageExactlyOnceAfterTerminal() {
        val runs = SyncDrainPolicy.stageOrder.associateWith { 0 }.toMutableMap()
        val boundaries = List(WhoopBleClient.MAX_AUTO_CONTINUES) { true } + false
        for (willContinue in boundaries) {
            if (!BacklogBurstDrainPolicy.shouldDrain(true, willContinue)) continue
            for (stage in SyncDrainPolicy.stagesToRun(SyncDrainPolicy.stageOrder.toSet())) {
                runs[stage] = runs.getValue(stage) + 1
            }
        }
        assertEquals(SyncDrainPolicy.stageOrder.associateWith { 1 }, runs)
    }

    @Test fun emptyDuplicateBurstWithoutDebtDoesNotDrain() {
        assertFalse(BacklogBurstDrainPolicy.shouldDrain(hasOwedWork = false, willAutoContinue = false))
    }

    @Test fun everyTerminalReasonCanDrainDurableDebt() {
        for (reason in SyncWakeReason.entries) {
            assertTrue(reason.rawValue, BacklogBurstDrainPolicy.shouldDrain(true, false))
        }
    }
}
