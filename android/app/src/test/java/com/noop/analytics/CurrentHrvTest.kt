package com.noop.analytics

import com.noop.data.RrInterval
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Trailing-window current HRV — Kotlin twin of `CurrentHRVTests.swift`.
 *
 * Expected literals for the fresh + ectopic cases are pasted from the Swift oracle:
 * `cd Packages/StrandAnalytics && swift test --filter CurrentHRVTests`.
 */
class CurrentHrvTest {

    private fun rr(ts: Long, ms: Int, seq: Int = 0) = RrInterval(deviceId = "d", ts = ts, rrMs = ms, seq = seq)

    private fun steadyRows(now: Int, count: Int, rrMs: Int = 820): List<RrInterval> =
        (0 until count).map { i -> rr((now - (count - 1 - i)).toLong(), rrMs) }

    @Test
    fun freshWindowProducesValue() {
        val now = 1_700_000_000
        val snap = CurrentHrv.derive(steadyRows(now, 30), now)
        assertNotNull(snap)
        assertEquals(30, snap!!.cleanBeats)
        assertTrue(snap.coverage > 0.5)
        // Swift oracle: rmssd=0.0 clean=30 cov=0.8482758620689655
        assertEquals(0.0, snap.rmssdMs, 1e-9)
        assertEquals(0.8482758620689655, snap.coverage, 1e-12)
        assertEquals(now, snap.computedAtUnix)
    }

    @Test
    fun midWindowEctopicIsGapAware() {
        val now = 1_700_000_100
        val rrMs = MutableList(24) { 800 }
        rrMs[12] = 5000
        val rows = rrMs.mapIndexed { i, ms -> rr((now - (rrMs.size - 1 - i)).toLong(), ms) }
        val snap = CurrentHrv.derive(rows, now)
        assertNotNull(snap)
        // Swift oracle: rmssd=0.0 clean=23 cov=0.8
        assertEquals(23, snap!!.cleanBeats)
        assertEquals(0.0, snap.rmssdMs, 1e-9)
        assertEquals(0.8, snap.coverage, 1e-12)
    }

    @Test
    fun sparseWindowReturnsNull() {
        val now = 1_700_000_200
        assertNull(CurrentHrv.derive(steadyRows(now, 8), now))
    }

    @Test
    fun overCountedWindowReturnsNull() {
        val now = 1_700_000_300
        val base = steadyRows(now, 25, 820)
        val doubled = base.flatMap { listOf(rr(it.ts, it.rrMs, 0), rr(it.ts, it.rrMs, 1)) }
        assertNull(CurrentHrv.derive(doubled, now))
    }

    @Test
    fun rowsOutsideWindowIgnored() {
        val now = 1_700_000_400
        val inside = steadyRows(now, 25)
        val outside = steadyRows(now - CurrentHrv.WINDOW_SECONDS - 60, 25)
        val snap = CurrentHrv.derive(inside + outside, now)
        assertNotNull(snap)
        assertEquals(25, snap!!.cleanBeats)
    }
}
