package com.noop.push

import android.content.Context
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL

object ServerScoreClient {
    class Unauthorized(val accessToken: String) : IllegalStateException("unauthorized")
    class Conflict : IllegalStateException("override revision changed")

    suspend fun saveSleepOverride(context: Context,target: ServerSleepEditTarget,start: Long,end: Long,tombstone: Boolean): Long =
        withContext(Dispatchers.IO) {
            val arguments=target.rpcArguments(start,end,tombstone)
            val base=ServerScoringSettings.supabaseProjectUrl() ?: error("not configured")
            val anon=ServerScoringSettings.anonKey() ?: error("not configured")
            val token=CloudAuthClient.validAccessToken(context)
            check(CloudAuthClient.storedSession(context)?.userId?.lowercase()==target.ownerId.lowercase()) { "session changed" }
            currentCoroutineContext().ensureActive()
            val conn=(URL("$base/rest/v1/rpc/${target.rpcName}").openConnection() as HttpURLConnection).apply {
                requestMethod="POST"; connectTimeout=15_000; readTimeout=30_000; doOutput=true
                setRequestProperty("Content-Type","application/json"); setRequestProperty("apikey",anon)
                setRequestProperty("Authorization","Bearer $token")
            }
            try {
                conn.outputStream.use { it.write(arguments.toString().toByteArray()) }
                val code=conn.responseCode
                if(code==401 || code==403) throw Unauthorized(token)
                val body=(if(code in 200..299) conn.inputStream else conn.errorStream)?.bufferedReader()?.use { it.readText() } ?: ""
                currentCoroutineContext().ensureActive()
                if(code==409 || runCatching { JSONObject(body).optString("code") }.getOrNull()=="40001") throw Conflict()
                check(code==200) { "boundary update failed" }
                body.trim().toLong().also { check(it>target.expectedRevision) { "invalid override revision" } }
            } finally { conn.disconnect() }
        }
    suspend fun fetchDaySnapshot(context: Context, day: String, ownerId: String): ServerScoreDayCache =
        withContext(Dispatchers.IO) {
            val base = ServerScoringSettings.supabaseProjectUrl() ?: error("not configured")
            val anon = ServerScoringSettings.anonKey() ?: error("not configured")
            val token = CloudAuthClient.validAccessToken(context)
            check(CloudAuthClient.storedSession(context)?.userId?.lowercase() == ownerId.lowercase()) { "session changed" }
            val conn = (URL("$base/rest/v1/rpc/get_day_snapshot").openConnection() as HttpURLConnection).apply {
                requestMethod = "POST"
                connectTimeout = 15_000; readTimeout = 30_000
                setRequestProperty("Content-Type", "application/json")
                setRequestProperty("apikey", anon)
                setRequestProperty("Authorization", "Bearer $token")
                doOutput = true
            }
            try {
                conn.outputStream.use { it.write(JSONObject(mapOf("p_day" to day)).toString().toByteArray()) }
                if (conn.responseCode == 401 || conn.responseCode == 403) throw Unauthorized(token)
                check(conn.responseCode == 200) { "fetch failed" }
                val body = conn.inputStream.bufferedReader().use { it.readText() }
                currentCoroutineContext().ensureActive()
                parseSnapshot(body, day, ownerId)
            } finally { conn.disconnect() }
        }

    fun parseSnapshot(body: String, day: String, ownerId: String, fetchedAtMs: Long = System.currentTimeMillis()): ServerScoreDayCache {
        val o = JSONObject(body).getJSONObject("server_scoring")
        require(ownerId.isNotBlank() && o.optInt("schema_version") == 2 &&
            o.optString("user_id").lowercase() == ownerId.lowercase() && o.optString("day") == day) { "invalid score scope" }
        val rawFeatures = o.getJSONObject("features")
        require(rawFeatures.length() > 0) { "missing source selection" }
        val features = rawFeatures.keys().asSequence().associateWith { key ->
            val f = rawFeatures.getJSONObject(key)
            val status = f.optString("status", "unavailable")
            val device = f.str("device_id"); val version = f.str("algorithm_version")
            require(status == "unavailable" || (!device.isNullOrBlank() && !version.isNullOrBlank())) { "invalid source selection" }
            ServerScoreFeatureCache(status, f.str("reason"), device, version, f.long("input_revision"), f.long("required_revision"),
                f.str("computed_at"), f.str("observed_through"), f.str("publication_status"), f.str("archive_status"), f.str("manifest_hash"), f.bool("supports_boundary_overrides"),
                f.str("processing_status"), f.str("timezone_id"), f.optJSONArray("timezone_ids")?.let { a ->
                    (0 until a.length()).mapNotNull { a.opt(it) as? String }
                })
        }
        val daily = o.optJSONObject("daily")?.let { d -> ServerScoreDailyCache(
            hrvRmssdMs = d.num("hrv_rmssd_ms"), restingHrBpm = d.num("resting_hr_bpm")?.toInt(),
            sleepTotalMin = d.num("sleep_total_min"), sleepInBedMin = d.num("sleep_in_bed_min"),
            sleepAwakeMin = d.num("sleep_awake_min"), sleepLightMin = d.num("sleep_light_min"),
            sleepDeepMin = d.num("sleep_deep_min"), sleepRemMin = d.num("sleep_rem_min"),
            sleepEfficiency = d.num("sleep_efficiency"), respRateBpm = d.num("resp_rate_bpm"), computedAt = d.str("computed_at"),
            sleepUnstagedMin = d.num("sleep_unstaged_min"), stateUnknownMin = d.num("state_unknown_min"),
            offBodyMin = d.num("off_body_min"), opportunityKind = d.str("opportunity_kind")) }
        val nights = (o.optJSONArray("nights") ?: JSONArray()).objects().map { n ->
            val device = n.str("device_id")
            require(features["sleep"]?.deviceId == null || device == features["sleep"]?.deviceId) { "night device scope mismatch" }
            val sourceVersion = n.str("algorithm_version") ?: features["sleep"]?.algorithmVersion
            val legacy = sourceVersion == "frwhoop-server-1"
            val stages = (n.optJSONArray("stages") ?: n.optJSONArray("hypnogram") ?: JSONArray()).objects().map { s ->
                val lo = s.num("start") ?: error("missing epoch start")
                val hi = s.num("end") ?: error("missing epoch end")
                require(hi > lo && lo >= -62135596800.0 && hi <= 253402300799.0) { "invalid epoch span" }
                val stage = s.str("stage") ?: "unknown"
                val stageLegacy = legacy && (s.str("algorithm_version") ?: sourceVersion) == "frwhoop-server-1"
                val legacyState = when (stage) { "light", "deep", "rem" -> "sleep"; "wake", "awake" -> "awake"; else -> "state_unknown" }
                ServerScoreStageCache(lo.toLong(), hi.toLong(), stage, s.str("state") ?: if (stageLegacy) legacyState else "state_unknown",
                    s.num("p_sleep"), s.num("p_wake"), s.num("p_light"), s.num("p_deep"), s.num("p_rem"),
                    s.num("evidence_coverage"), s.str("reason") ?: if (stageLegacy) "legacy_quality_unavailable" else null,
                    s.str("calibration_status") ?: if (stageLegacy) "legacy_unvalidated" else null,
                    s.str("algorithm_version") ?: if (stageLegacy) sourceVersion else null, s.str("computation_mode"))
            }
            ServerScoreNightCache(id = n.getString("id").also { require(it.isNotBlank()) }, startAt = n.getString("start_at"),
                endAt = n.getString("end_at"), isNap = n.optBoolean("is_nap"), asleepMin = n.num("asleep_min"),
                inBedMin = n.num("in_bed_min"), lightMin = n.num("light_min"), deepMin = n.num("deep_min"),
                remMin = n.num("rem_min"), awakeMin = n.num("awake_min"), efficiency = n.num("efficiency"),
                hrvRmssdMs = n.num("hrv_rmssd_ms"), restingHrBpm = n.num("resting_hr_bpm")?.toInt(), stages = stages,
                deviceId = device, episodeType = n.str("episode_type") ?: if (legacy) (if (n.optBoolean("is_nap")) "nap" else "main_sleep") else null, mainSleepGroupId = n.str("main_sleep_group_id"),
                boundaryProvenance = n.str("boundary_provenance"), opportunityKind = n.str("opportunity_kind"),
                startTimezoneId = n.str("start_timezone_id"), endTimezoneId = n.str("end_timezone_id"),
                measurementAvailable = n.bool("measurement_available") ?: if (legacy) n.num("asleep_min")?.let { it >= 0 } else null, sleepUnstagedMin = n.num("sleep_unstaged_min"),
                stateUnknownMin = n.num("state_unknown_min"), offBodyMin = n.num("off_body_min"), stateCoverage = n.num("state_coverage"),
                manualEdit = n.bool("manual_edit"))
        }
        return ServerScoreDayCache(day, o.getString("algorithm_version"), daily, nights, o.str("computed_at"),
            o.optBoolean("stale", true), fetchedAtMs, ownerId.lowercase(), 2, features, body)
    }

    private fun JSONObject.str(key: String) = (opt(key) as? String)?.takeIf { it.isNotBlank() }
    private fun JSONObject.num(key: String) = (opt(key) as? Number)?.toDouble()?.takeIf { it.isFinite() }
    private fun JSONObject.long(key: String) = (opt(key) as? Number)?.toLong()
    private fun JSONObject.bool(key: String) = opt(key) as? Boolean
    private fun JSONArray.objects() = (0 until length()).map { getJSONObject(it) }
}
