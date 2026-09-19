package com.noop.push

import org.junit.After
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

class ServerScoringRescoreSkipTest {
    private val context = SelfHostedPushSettingsTest.FakePushPrefs()

    @Before
    fun setUp() {
        ServerScoringSettings.setEnabled(context, false)
        ServerScoringSettings.markOverlayLive(context, false)
    }

    @After
    fun tearDown() {
        ServerScoringSettings.setEnabled(context, false)
        ServerScoringSettings.markOverlayLive(context, false)
    }

    @Test
    fun skipsSyncCoupledRescoreWhenFlagOnAndOverlayLive() {
        ServerScoringSettings.setEnabled(context, true)
        assertFalse(ServerScoringSettings.skipsSyncCoupledRescore(context))
        ServerScoringSettings.markOverlayLive(context, true)
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
