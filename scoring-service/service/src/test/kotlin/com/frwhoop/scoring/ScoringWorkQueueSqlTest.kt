package com.frwhoop.scoring

import com.frwhoop.scoring.db.ScoringWorkQueue
import org.junit.Assert.assertTrue
import org.junit.Test

/** SQL-shape assertions for device-aware discovery and queue keys (no live DB). */
class ScoringWorkQueueSqlTest {
    @Test
    fun discoveryGroupsByUserDeviceAndLocalDay() {
        val sql = ScoringWorkQueue.DISCOVER_LOCAL_DAYS_SQL
        assertTrue(sql.contains("h.device_id"))
        assertTrue(sql.contains("r.device_id"))
        assertTrue(sql.contains("w.device_id"))
        assertTrue(sql.contains("group by user_id, device_id"))
        assertTrue(sql.contains("(to_timestamp(ts) at time zone tz)::date"))
    }

    @Test
    fun discoveryRequiresDeviceIdOnEachSource() {
        val sql = ScoringWorkQueue.DISCOVER_LOCAL_DAYS_SQL
        assertTrue(sql.contains("h.device_id is not null"))
        assertTrue(sql.contains("r.device_id is not null"))
        assertTrue(sql.contains("w.device_id is not null"))
    }
}
