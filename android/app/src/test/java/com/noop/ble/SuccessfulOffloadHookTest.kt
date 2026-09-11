package com.noop.ble

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class SuccessfulOffloadHookTest {
    @Test fun completeOrProductiveTimeoutMarksBurstForDownstream() {
        assertTrue(WhoopBleClient.shouldNotifySuccessfulOffload("HISTORY_COMPLETE", bankedRows = true))
        assertTrue(WhoopBleClient.shouldNotifySuccessfulOffload("timeout", bankedRows = true))
        assertFalse(WhoopBleClient.shouldNotifySuccessfulOffload("timeout", bankedRows = false))
        assertFalse(WhoopBleClient.shouldNotifySuccessfulOffload("aborted by user", bankedRows = true))
        assertFalse(WhoopBleClient.shouldNotifySuccessfulOffload("disconnect", bankedRows = true))
    }

    @Test fun productiveContinuationBurstFlushesCloudOnceAtTerminalBoundary() {
        var owed = false
        var pushes = 0
        repeat(WhoopBleClient.MAX_AUTO_CONTINUES) {
            owed = owed || WhoopBleClient.shouldNotifySuccessfulOffload("timeout", bankedRows = true)
            // Existing continuation predicate said true: production retains the latch and does not flush.
        }
        assertTrue(owed)
        assertEquals(0, pushes)

        // Final caught-up HISTORY_COMPLETE ends the physical burst and flushes the one retained signal.
        owed = owed || WhoopBleClient.shouldNotifySuccessfulOffload("HISTORY_COMPLETE", bankedRows = false)
        if (owed) { pushes += 1; owed = false }
        assertEquals(1, pushes)
        assertFalse(owed)
    }
}
