package com.frwhoop.scoring

import com.frwhoop.scoring.b2.B2Config
import java.time.Duration

/** Env-only configuration for the VPS scoring container. */
data class ScoringConfig(
    val databaseUrl: String,
    val ingestSecret: String,
    val supabaseUrl: String,
    val serviceRoleKey: String,
    val b2Config: B2Config? = null,
    val pollInterval: Duration = Duration.ofSeconds(8),
    val algorithmVersion: String = "frwhoop-physiology-2",
    val workerSecret: String? = null,
    val replayUserId: String? = null,
    val replayDay: String? = null,
    val replayDeviceId: String? = null,
) {
    init { require(pollInterval.toMillis() in 1..600_000) { "Scoring poll interval must be positive and at most 10 minutes" } }
    companion object {
        fun fromEnv(): ScoringConfig {
            val dbUrl = required("DATABASE_URL")
            val ingestSecret = required("INGEST_SECRET")
            val supabaseUrl = required("SUPABASE_URL").trimEnd('/')
            val serviceRoleKey = required("SUPABASE_SERVICE_ROLE_KEY")
            val pollSec = System.getenv("SCORING_POLL_SECONDS")?.toLongOrNull() ?: 8L
            return ScoringConfig(
                databaseUrl = dbUrl,
                ingestSecret = ingestSecret,
                supabaseUrl = supabaseUrl,
                serviceRoleKey = serviceRoleKey,
                b2Config = B2Config.fromEnv(),
                pollInterval = Duration.ofSeconds(pollSec),
                algorithmVersion = System.getenv("SCORING_ALGORITHM_VERSION") ?: "frwhoop-physiology-2",
                workerSecret = System.getenv("WORKER_SECRET"),
                replayUserId = System.getenv("REPLAY_USER_ID"),
                replayDay = System.getenv("REPLAY_DAY"),
                replayDeviceId = System.getenv("REPLAY_DEVICE_ID"),
            )
        }

        private fun required(name: String): String =
            System.getenv(name)?.trim()?.takeIf { it.isNotEmpty() }
                ?: error("Missing required env: $name")
    }
}
