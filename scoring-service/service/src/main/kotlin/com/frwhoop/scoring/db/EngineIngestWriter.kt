package com.frwhoop.scoring.db

import com.frwhoop.scoring.scoring.ServerScoreBundle
import com.noop.analytics.DetectedSleep
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONArray
import org.json.JSONObject
import java.time.Instant

/** Writes scoped scores through `engine_ingest_scored` with service-role auth. */
class EngineIngestWriter(
    private val supabaseUrl: String,
    private val serviceRoleKey: String,
    private val ingestSecret: String,
    private val http: OkHttpClient = OkHttpClient.Builder().build(),
    private val rpcPath: String = "rpc/engine_ingest_scored",
) {
    private val jsonType = "application/json".toMediaType()

    companion object {
        fun buildPayload(bundle: ServerScoreBundle): JSONObject {
            val daily = bundle.result.daily
            val mainSleep = bundle.result.sleepSessions.maxByOrNull { it.end - it.start }
            val inBedMin = mainSleep?.let { (it.end - it.start) / 60.0 }
            val asleepMin = daily.totalSleepMin
            val awakeMin = if (inBedMin != null && asleepMin != null) inBedMin - asleepMin else null
            val computedAt = Instant.now().toString()
            val dailyMetric = JSONObject()
                .put("day", bundle.day)
                .put("source_device_id", bundle.deviceId)
                .put("computed_at", computedAt)
                .put("hrv_rmssd_ms", daily.avgHrv)
                .put("hrv_sdnn_ms", daily.avgSdnn)
                .put("resting_hr_bpm", daily.restingHr)
                .put("resp_rate_bpm", daily.respRateBpm)
                .put("sleep_total_min", daily.totalSleepMin)
                .put("sleep_in_bed_min", inBedMin)
                .put("sleep_awake_min", awakeMin)
                .put("sleep_light_min", daily.lightMin)
                .put("sleep_deep_min", daily.deepMin)
                .put("sleep_rem_min", daily.remMin)
                .put("sleep_efficiency", daily.efficiency)
                .put("sleep_onset_at", mainSleep?.start?.let { Instant.ofEpochSecond(it).toString() })
                .put("wake_onset_at", mainSleep?.end?.let { Instant.ofEpochSecond(it).toString() })
                .put("overnight_hr_bpm", mainSleep?.restingHR)
                .put("disturbances", daily.disturbances)
                .put(
                    "provenance",
                    JSONObject().put("scorer", "frwhoop-scoring-service").put("scope", "hrv_sleep"),
                )

            val sleepNights = JSONArray()
            for (session in bundle.result.sleepSessions) {
                sleepNights.put(sessionToJson(session, bundle))
            }

            return JSONObject()
                .put("user_id", bundle.userId.toString())
                .put("algorithm_version", bundle.algorithmVersion)
                .put("daily_metrics", JSONArray().put(dailyMetric))
                .put("sleep_nights", sleepNights)
        }

        private fun sessionToJson(session: DetectedSleep, bundle: ServerScoreBundle): JSONObject {
            val stages = JSONArray()
            for (seg in session.stages) {
                stages.put(
                    JSONObject()
                        .put("start", seg.start)
                        .put("end", seg.end)
                        .put("stage", seg.stage),
                )
            }
            val asleepMin = session.stages
                .filter { it.stage != "wake" }
                .sumOf { (it.end - it.start) } / 60.0
            val inBedMin = (session.end - session.start) / 60.0
            return JSONObject()
                .put("period_day", bundle.day)
                .put("device_id", bundle.deviceId)
                .put("start_at", Instant.ofEpochSecond(session.start).toString())
                .put("end_at", Instant.ofEpochSecond(session.end).toString())
                .put("is_nap", false)
                .put("in_bed_min", inBedMin)
                .put("asleep_min", asleepMin)
                .put("efficiency", session.efficiency)
                .put("resting_hr_bpm", session.restingHR)
                .put("hrv_rmssd_ms", session.avgHRV)
                .put("stages", stages)
                .put("hypnogram", JSONArray())
                .put("computed_at", Instant.now().toString())
        }
    }

    fun write(bundle: ServerScoreBundle) {
        val payload = buildPayload(bundle)
        val body = JSONObject()
            .put("p_secret", ingestSecret)
            .put("p_payload", payload)
            .toString()
            .toRequestBody(jsonType)

        val req = Request.Builder()
            // Internal PostgREST serves RPCs at /rpc/<fn> (no Kong /rest/v1 prefix); the public
            // gateway path is /rest/v1/rpc/<fn>. The VPS container talks to http://rest:3000 directly,
            // so the default is the internal form (Phase 3 gate: engine_ingest_scored 404 PGRST125 on
            // /rest/v1/rpc against the internal endpoint).
            .url("$supabaseUrl/$rpcPath")
            .post(body)
            .header("apikey", serviceRoleKey)
            .header("Authorization", "Bearer $serviceRoleKey")
            .header("Content-Type", "application/json")
            .header("Prefer", "return=minimal")
            .build()

        http.newCall(req).execute().use { resp ->
            if (!resp.isSuccessful) {
                error("engine_ingest_scored failed: ${resp.code} ${resp.body?.string()}")
            }
        }
    }
}
