package com.noop.push

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import org.junit.After
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

@RunWith(RobolectricTestRunner::class)
class ServerScoringRescoreSkipTest {
    private val context: Context = ApplicationProvider.getApplicationContext()

    @Before
    fun setUp() {
        ServerScoringSettings.setEnabled(context, false)
    }

    @After
    fun tearDown() {
        ServerScoringSettings.setEnabled(context, false)
    }

    @Test
    fun skipsSyncCoupledRescoreWhenFlagOn() {
        ServerScoringSettings.setEnabled(context, true)
        assertTrue(ServerScoringSettings.skipsSyncCoupledRescore(context))
    }

    @Test
    fun runsSyncCoupledRescoreWhenFlagOff() {
        assertFalse(ServerScoringSettings.skipsSyncCoupledRescore(context))
    }

    @Test
    fun pushIntervalsMatchSpec() {
        assertTrue(ServerScoringSettings.IDLE_PUSH_INTERVAL_MS in 30_000L..60_000L)
        assertTrue(ServerScoringSettings.SYNC_PUSH_INTERVAL_MS <= 10_000L)
    }
}
