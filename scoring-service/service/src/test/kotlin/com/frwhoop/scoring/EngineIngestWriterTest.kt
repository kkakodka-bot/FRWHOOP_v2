package com.frwhoop.scoring

import com.frwhoop.scoring.db.EngineIngestWriter
import com.frwhoop.scoring.scoring.ServerScoreBundle
import com.noop.analytics.DayResult
import com.noop.analytics.DetectedSleep
import com.noop.analytics.StageSegment
import com.noop.data.DailyMetric
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.UUID

class EngineIngestWriterTest {
    @Test fun snapshotHasStableSessionIdentityAndCompleteNonnegativeStageAccounting() {
        val start=java.time.Instant.parse("2026-09-15T00:00:00Z").epochSecond
        val result=DayResult(
            daily=DailyMetric(deviceId="device",day="2026-09-15",totalSleepMin=40.0),
            sleepSessions=listOf(DetectedSleep(start,start+3600,40.0/60,
                listOf(StageSegment(start,start+1200,"wake"),
                    StageSegment(start+1200,start+2400,"light"),
                    StageSegment(start+2400,start+3000,"deep"),
                    StageSegment(start+3000,start+3600,"rem")),50,42.0)),
            workouts=emptyList(),recovery=null,strain=null)
        val bundle=ServerScoreBundle(UUID.randomUUID(),"2026-09-15","device","frwhoop-server-1",
            result,dataThrough=start+3600,hrSamples=120)
        val first=EngineIngestWriter.buildSnapshot(bundle)
        val second=EngineIngestWriter.buildSnapshot(bundle)
        assertTrue(first.similar(second))
        assertEquals("partial",first.getString("status"))
        val sleep=first.getJSONArray("sleep").getJSONObject(0)
        assertEquals(4,sleep.getJSONArray("stages").length())
        assertEquals(40.0,sleep.getDouble("asleep_min"),0.0)
        assertEquals(20.0,sleep.getDouble("awake_min"),0.0)
        assertEquals(20.0,sleep.getDouble("light_min"),0.0)
        assertEquals(10.0,sleep.getDouble("deep_min"),0.0)
        assertEquals(10.0,sleep.getDouble("rem_min"),0.0)
        assertFalse(first.getJSONObject("coverage").getBoolean("historicalStateAvailable"))
    }

    @Test fun noObservationsYieldAuthoritativeNullAndNoFabricatedZeroMetrics() {
        val result=DayResult(DailyMetric(deviceId="device",day="2026-09-15"),
            emptyList(),emptyList(),null,null)
        val snapshot=EngineIngestWriter.buildSnapshot(ServerScoreBundle(
            UUID.randomUUID(),"2026-09-15","device","frwhoop-server-1",result))
        assertEquals("no_data",snapshot.getString("status"))
        assertTrue(snapshot.isNull("daily")); assertTrue(snapshot.isNull("dataThrough"))
        assertEquals(0,snapshot.getJSONArray("sleep").length())
    }

    @Test
    fun payloadHasAlgorithmVersionAtRootAndOmitsForbiddenKeys() {
        val bundle = ServerScoreBundle(
            userId = UUID.fromString("00000000-0000-4000-8000-000000000001"),
            day = "2026-06-15",
            deviceId = "test-device",
            algorithmVersion = "frwhoop-server-1",
            result = DayResult(
                daily = DailyMetric(
                    deviceId = "test-device",
                    day = "2026-06-15",
                    avgHrv = 42.0,
                    avgSdnn = 55.0,
                    restingHr = 50,
                    respRateBpm = 14.0,
                    totalSleepMin = 420.0,
                    lightMin = 200.0,
                    deepMin = 90.0,
                    remMin = 130.0,
                    efficiency = 0.92,
                    disturbances = 2,
                ),
                sleepSessions = listOf(
                    DetectedSleep(
                        start = 1_749_513_600L,
                        end = 1_749_516_600L,
                        stages = emptyList(),
                        restingHR = 48,
                        avgHRV = 40.0,
                        efficiency = 0.9,
                    ),
                ),
                workouts = emptyList(),
                recovery = null,
                strain = null,
            ),
        )

        val payload = EngineIngestWriter.buildPayload(bundle)
        assertEquals("frwhoop-server-1", payload.getString("algorithm_version"))
        assertEquals("00000000-0000-4000-8000-000000000001", payload.getString("user_id"))

        val daily = payload.getJSONArray("daily_metrics").getJSONObject(0)
        assertEquals("test-device", daily.getString("source_device_id"))
        assertFalse(daily.has("algorithm_version"))
        for (key in listOf("charge", "effort", "rest", "steps", "kcal", "vo2", "stress", "Charge", "Effort", "Rest")) {
            assertFalse("forbidden key present: $key", daily.has(key))
        }
        assertFalse(payload.has("Charge"))
        assertFalse(payload.has("Effort"))
        assertFalse(payload.has("Rest"))
        val nights = payload.getJSONArray("sleep_nights")
        assertEquals(1, nights.length())
        assertEquals("test-device", nights.getJSONObject(0).getString("device_id"))
    }
}
