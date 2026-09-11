package com.noop.ble

import org.junit.Assert.assertThrows
import org.junit.Test

class TrimCursorCommitTest {
    @Test fun successfulCommitMayProceedToAck() {
        requireDurableCursorCommit(true)
    }

    @Test fun failedCommitThrowsSoBackfillerHoldsAck() {
        assertThrows(IllegalStateException::class.java) {
            requireDurableCursorCommit(false)
        }
    }
}
