package com.noop.data

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class PostBackfillDebtPolicyTest {
    @Test fun scoringInputsMarkDebt() {
        assertTrue(shouldMarkPostBackfillDebt(InsertCounts(hr = 1), 0))
        assertTrue(shouldMarkPostBackfillDebt(InsertCounts(rr = 1), 0))
        assertTrue(shouldMarkPostBackfillDebt(InsertCounts(gravity = 1), 0))
        assertTrue(shouldMarkPostBackfillDebt(InsertCounts(events = 1), 0))
        assertTrue(shouldMarkPostBackfillDebt(InsertCounts(), sleepStateInserted = 1))
    }

    @Test fun duplicateOrBatteryOnlyChunkDoesNotMarkDebt() {
        assertFalse(shouldMarkPostBackfillDebt(InsertCounts(), 0))
        assertFalse(shouldMarkPostBackfillDebt(InsertCounts(battery = 12), 0))
    }
}
