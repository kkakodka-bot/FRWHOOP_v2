package com.frwhoop.scoring.db

import com.frwhoop.scoring.scoring.CanonicalScorePayload
import com.frwhoop.scoring.scoring.ServerScoreBundle
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONArray
import org.json.JSONObject

/** Publishes a device/revision snapshot while the database validates its live lease. */
class EngineIngestWriter(
    private val supabaseUrl: String,
    private val serviceRoleKey: String,
    private val ingestSecret: String,
    private val http: OkHttpClient = OkHttpClient.Builder().build(),
    private val rpcPath: String = "rpc/engine_publish_physiology",
) {
    companion object {
        /** Compatibility envelope retained for tooling that consumes the v1 payload shape. */
        fun buildPayload(bundle: ServerScoreBundle): JSONObject {
            val canonical = CanonicalScorePayload.build(bundle)
            return JSONObject().put("user_id", bundle.userId.toString())
                .put("algorithm_version", bundle.algorithmVersion)
                .put("daily_metrics", JSONArray().put(canonical.getJSONObject("daily")))
                .put("sleep_nights", canonical.getJSONArray("nights"))
        }

        fun publicationPayload(bundle: ServerScoreBundle, item: ScoringWorkQueue.WorkItem): JSONObject {
            require(bundle.userId == item.userId && bundle.deviceId == item.deviceId.toString() &&
                bundle.day == item.day) { "publication owner differs from claim" }
            return CanonicalScorePayload.build(bundle)
                .put("input_revision", item.inputRevision)
                .put("run_id", item.runId.toString())
                .put("lease_token", item.leaseToken.toString())
                .put("timezone_id", item.timezoneId)
        }
    }

    fun write(bundle: ServerScoreBundle, item: ScoringWorkQueue.WorkItem): JSONObject {
        val payload = publicationPayload(bundle, item)
        val body = JSONObject().put("p_secret", ingestSecret).put("p_payload", payload)
            .toString().toRequestBody("application/json".toMediaType())
        val request = Request.Builder().url("$supabaseUrl/$rpcPath").post(body)
            .header("apikey", serviceRoleKey)
            .header("Authorization", "Bearer $serviceRoleKey")
            .header("Content-Type", "application/json").build()
        http.newCall(request).execute().use { response ->
            check(response.isSuccessful) { "physiology publication failed: HTTP ${response.code}" }
        }
        return payload
    }
}
