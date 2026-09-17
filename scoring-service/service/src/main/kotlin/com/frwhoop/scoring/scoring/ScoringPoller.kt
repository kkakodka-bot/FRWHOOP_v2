package com.frwhoop.scoring.scoring

import com.frwhoop.scoring.ScoringConfig
import com.frwhoop.scoring.db.EngineIngestWriter
import com.frwhoop.scoring.db.ScoreInputProvider
import com.frwhoop.scoring.db.ScoringWorkQueue
import com.frwhoop.scoring.health.HeartbeatReporter
import org.slf4j.LoggerFactory
import java.util.UUID

class ScoringPoller(
    private val config: ScoringConfig,
    private val inputs: ScoreInputProvider,
    private val queue: ScoringWorkQueue,
    private val scorer: DayScorer,
    private val writer: EngineIngestWriter,
    private val heartbeat: HeartbeatReporter,
) {
    private val log = LoggerFactory.getLogger(ScoringPoller::class.java)

    fun runForever() {
        log.info("scoring poller started (interval={}s, version={})", config.pollInterval.seconds, config.algorithmVersion)
        while (true) {
            try {
                pollOnce()
            } catch (err: Exception) {
                log.error("poll cycle failed: {}", err.message, err)
                heartbeat.recordError(err.message ?: err.javaClass.simpleName)
            }
            Thread.sleep(config.pollInterval.toMillis())
        }
    }

    fun pollOnce() {
        heartbeat.recordPoll()
        val watermark = queue.readWatermark()
        val readAt = java.time.Instant.now()
        val discovered = queue.discoverAndEnqueue(watermark, readAt)
        if (discovered > 0) {
            log.info("discovered {} work-item upsert(s) since {}", discovered, watermark)
        }

        val claimed = queue.claimDue()
        if (claimed.isEmpty()) {
            log.debug("no due work items")
            return
        }
        log.info("claimed {} work item(s)", claimed.size)
        for (item in claimed) {
            processWorkItem(item)
        }
    }

    fun scoreDay(userId: UUID, deviceId: UUID, day: String) {
        val inputs = inputs.loadDay(userId, day, deviceId)
        if (inputs == null) {
            log.warn("skip {} {} {} — no device/inputs", userId, deviceId, day)
            return
        }
        if (inputs.hr.isEmpty() && inputs.rr.isEmpty()) {
            log.warn("skip {} {} {} — no hr/rr samples in night window", userId, deviceId, day)
            return
        }
        val bundle = scorer.score(inputs, config.algorithmVersion)
        writer.write(bundle)
        heartbeat.recordScore(userId, day)
        log.info(
            "scored {} {} {} (hr={}, rr={}, sleeps={})",
            userId, deviceId, day, inputs.hr.size, inputs.rr.size, bundle.result.sleepSessions.size,
        )
    }

    private fun processWorkItem(item: ScoringWorkQueue.WorkItem) {
        val started = System.nanoTime()
        try {
            val inputs = inputs.loadDay(item.userId, item.day, item.deviceId)
            if (inputs == null) {
                queue.markFailed(item, "no device/inputs")
                return
            }
            if (inputs.hr.isEmpty() && inputs.rr.isEmpty()) {
                queue.markFailed(item, "no hr/rr samples in night window")
                return
            }
            val bundle = scorer.score(inputs, config.algorithmVersion)
            writer.write(bundle)
            val durationMs = ((System.nanoTime() - started) / 1_000_000).toInt()
            val done = queue.markDone(item, durationMs)
            if (done) {
                heartbeat.recordScore(item.userId, item.day)
                log.info(
                    "scored {} {} {} (hr={}, rr={}, sleeps={}, {}ms)",
                    item.userId, item.deviceId, item.day, inputs.hr.size, inputs.rr.size,
                    bundle.result.sleepSessions.size, durationMs,
                )
            } else {
                log.info(
                    "re-queue {} {} {} — dirty_at moved during scoring",
                    item.userId, item.deviceId, item.day,
                )
            }
        } catch (err: Exception) {
            queue.markFailed(item, err.message ?: err.javaClass.simpleName)
            heartbeat.recordError(err.message ?: err.javaClass.simpleName)
            log.error(
                "score failed for {} {} {}: {}",
                item.userId, item.deviceId, item.day, err.message, err,
            )
        }
    }
}
