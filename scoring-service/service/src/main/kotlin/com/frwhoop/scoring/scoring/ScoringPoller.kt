package com.frwhoop.scoring.scoring

import com.frwhoop.scoring.ScoringConfig
import com.frwhoop.scoring.db.EngineIngestWriter
import com.frwhoop.scoring.db.ScoreInputProvider
import com.frwhoop.scoring.db.ScoringWorkQueue
import com.frwhoop.scoring.derived.DerivedArchiveOutbox
import com.frwhoop.scoring.derived.ArchiveRetryWorker
import com.frwhoop.scoring.health.HeartbeatReporter
import org.slf4j.LoggerFactory
import java.util.UUID
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

class ScoringPoller(
    private val config: ScoringConfig,
    private val inputs: ScoreInputProvider,
    private val queue: ScoringWorkQueue,
    private val scorer: DayScorer,
    private val writer: EngineIngestWriter,
    private val heartbeat: HeartbeatReporter,
    private val archiveOutbox: DerivedArchiveOutbox? = null,
) {
    private val log = LoggerFactory.getLogger(ScoringPoller::class.java)

    fun runForever() {
        log.info("scoring poller started (interval={}s, version={})", config.pollInterval.seconds, config.algorithmVersion)
        val archive=archiveOutbox?.let { outbox -> ArchiveRetryWorker(config.pollInterval,
            work={ outbox.processOne();Unit },
            onError={ log.warn("Archive queue unavailable: {}",it.javaClass.simpleName) }) }
        try {
            while (!Thread.currentThread().isInterrupted) {
                try {
                    pollOnce()
                } catch (err: Exception) {
                    log.error("poll cycle failed: {}", err.message, err)
                    heartbeat.recordError(err.message ?: err.javaClass.simpleName)
                }
                Thread.sleep(config.pollInterval.toMillis())
            }
        } finally { archive?.close() }
    }

    fun pollOnce() {
        heartbeat.recordPoll()
        repeat(8) {
            val item = queue.claimOne() ?: return
            processWorkItem(item)
        }
    }

    fun scoreDay(userId: UUID, deviceId: UUID, day: String) {
        queue.dirtyWorkItem(userId, deviceId, day)
        val item = queue.claimOne(userId, deviceId, day)
            ?: error("Replay revision is owned by another worker")
        check(processWorkItem(item)) { "Replay did not finish publication; inspect the durable work status" }
    }

    private fun processWorkItem(item: ScoringWorkQueue.WorkItem): Boolean {
        val started = System.nanoTime()
        val leaseLost = AtomicBoolean(false)
        val renewal = Executors.newSingleThreadScheduledExecutor { task ->
            Thread(task, "scoring-lease-renewal").apply { isDaemon = true }
        }
        val periodMs = (queue.claimLease.toMillis() / 3).coerceAtLeast(100)
        renewal.scheduleAtFixedRate({
            try {
                if (!queue.renew(item)) leaseLost.set(true)
            } catch (err: Exception) {
                leaseLost.set(true)
                log.warn("lease renewal failed for run {}: {}", item.runId, err.message)
            }
        }, periodMs, periodMs, TimeUnit.MILLISECONDS)
        try {
            val inputs = inputs.loadDay(item.userId, item.day, item.deviceId, item.timezoneId)
            if (inputs == null) {
                queue.markWaiting(item, "no device/inputs")
                return false
            }
            // Empty inputs can be an intentional correction/deletion. Publish an unavailable
            // snapshot so an old generated episode cannot survive a tombstone or removed data.
            val bundle = scorer.score(inputs, config.algorithmVersion,item.inputRevision.toString())
            check(!leaseLost.get()) { "Scoring lease was lost before publication" }
            writer.write(bundle, item)
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
                    "completion fenced for {} {} {} because lease or revision changed",
                    item.userId, item.deviceId, item.day,
                )
            }
            return done
        } catch (err: Exception) {
            log.error(
                "score failed for {} {} {}: {}",
                item.userId, item.deviceId, item.day, err.message, err,
            )
            if (queue.markFailed(item, err.message ?: err.javaClass.simpleName)) {
                heartbeat.recordError(err.message ?: err.javaClass.simpleName)
            } else {
                log.info("discarded superseded scoring run {}", item.runId)
            }
            return false
        } finally {
            renewal.shutdownNow()
        }
    }

}
