package com.frwhoop.scoring.derived

import java.time.Duration
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

/** One bounded retry lane; slow object storage never occupies the scoring claim loop. */
internal class ArchiveRetryWorker(interval: Duration,work: () -> Unit,onError: (Exception) -> Unit) : AutoCloseable {
    private val executor=Executors.newSingleThreadScheduledExecutor { task ->
        Thread(task,"derived-archive-retry").apply { isDaemon=true }
    }
    init {
        require(interval.toMillis() in 1..600_000)
        executor.scheduleWithFixedDelay({
            try { work() } catch(error: Exception) { onError(error) }
        },0,interval.toMillis(),TimeUnit.MILLISECONDS)
    }
    override fun close() { executor.shutdownNow() }
}
