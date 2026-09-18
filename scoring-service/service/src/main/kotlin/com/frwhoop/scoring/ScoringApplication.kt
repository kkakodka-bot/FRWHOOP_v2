package com.frwhoop.scoring

import com.frwhoop.scoring.db.EngineIngestWriter
import com.frwhoop.scoring.db.PostgresClient
import com.frwhoop.scoring.db.ScoringWorkQueue
import com.frwhoop.scoring.db.SignalSampleReader
import com.frwhoop.scoring.derived.DerivedArtifactWriter
import com.frwhoop.scoring.derived.DerivedArchiveOutbox
import com.frwhoop.scoring.health.HeartbeatReporter
import com.frwhoop.scoring.scoring.DayScorer
import com.frwhoop.scoring.scoring.CanonicalScorePayload
import com.frwhoop.scoring.scoring.ScoringPoller
import com.frwhoop.scoring.b2.B2ObjectStore
import com.frwhoop.scoring.signals.PhysiologyShadowRunner
import org.slf4j.LoggerFactory
import java.util.UUID

private val log = LoggerFactory.getLogger("ScoringApplication")

fun main(args: Array<String>) {
    require(args.isEmpty() || args.contentEquals(arrayOf("--replay-day")) || args.contentEquals(arrayOf("--inventory-signals"))) {
        "Use no arguments, --replay-day, or --inventory-signals; commands cannot be combined"
    }
    if (args.contains("--inventory-signals")) {
        SignalInventoryCommand.run(System.getenv())
        return
    }
    val config = ScoringConfig.fromEnv()
    require(config.algorithmVersion == CanonicalScorePayload.ALGORITHM_VERSION) {
        "This build requires algorithm version ${CanonicalScorePayload.ALGORITHM_VERSION}; use the baseline build for rollback"
    }
    val db = PostgresClient(config.databaseUrl)
    val reader = SignalSampleReader(db)
    val queue = ScoringWorkQueue(db)
    val rawObjects=config.b2Config?.let { credentials ->
        val objects=B2ObjectStore(credentials)
        object : B2ObjectStore.GetClient {
            override fun getObject(key: String,maximumBytes: Int)=objects.getObject(key,maximumBytes)
        }
    }
    val scorer = DayScorer(PhysiologyShadowRunner.fromEnvironment(db.dataSource,rawObjects))
    val writer = EngineIngestWriter(config.supabaseUrl, config.serviceRoleKey, config.ingestSecret)
    val derivedWriter = config.b2Config?.let {
        DerivedArtifactWriter(it, config.supabaseUrl, config.serviceRoleKey)
    }
    if (derivedWriter == null) {
        log.warn("B2 credentials missing — derived artifact lane disabled (scores still write to Postgres)")
    }
    val heartbeat = HeartbeatReporter(db, config.algorithmVersion)
    val archiveOutbox = derivedWriter?.let { DerivedArchiveOutbox(db, it) }
    val poller = ScoringPoller(config, reader, queue, scorer, writer, heartbeat, archiveOutbox)

    if (args.contains("--replay-day") || config.replayUserId != null) {
        val userId = UUID.fromString(config.replayUserId ?: error("REPLAY_USER_ID required for --replay-day"))
        val day = config.replayDay ?: error("REPLAY_DAY required for --replay-day")
        val deviceId = resolveReplayDeviceId(reader, userId, config.replayDeviceId)
        log.info("replay mode: user={} device={} day={}", userId, deviceId, day)
        poller.scoreDay(userId, deviceId, day)
        return
    }

    poller.runForever()
}

private fun resolveReplayDeviceId(
    reader: SignalSampleReader,
    userId: UUID,
    replayDeviceId: String?,
): UUID {
    if (!replayDeviceId.isNullOrBlank()) {
        return UUID.fromString(replayDeviceId)
    }
    val devices = reader.listDeviceIds(userId)
    return when (devices.size) {
        0 -> error("REPLAY_DEVICE_ID required — user has no devices")
        1 -> devices.single()
        else -> error(
            "REPLAY_DEVICE_ID required — user has ${devices.size} devices; " +
                "set REPLAY_DEVICE_ID to one of: ${devices.joinToString()}",
        )
    }
}
