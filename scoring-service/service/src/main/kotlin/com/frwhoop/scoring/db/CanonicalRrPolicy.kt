package com.frwhoop.scoring.db

import com.noop.data.RrInterval
import com.noop.protocol.DeviceFamily
import com.noop.protocol.RrSourceChannel

/** Mirrors WhoopStore.rrIntervals: one verified transport for the entire requested interval. */
object CanonicalRrPolicy {
    const val VERSION = "whoop-canonical-rr-1"
    const val TIMESTAMP_PRECISION_SECONDS = 1.0

    fun select(rows: List<RrInterval>, family: DeviceFamily): List<RrInterval> {
        val eligible = rows.filter { it.tsSuspect != 1 && it.srcChannel != RrSourceChannel.SPO2_IBI.code }
        val source = if (family == DeviceFamily.WHOOP5) {
            eligible.mapNotNull { it.srcChannel }
                .filter { it == 5 || it == 7 }.minOrNull()
                ?: return emptyList()
        } else null
        return eligible.filter { source == null || it.srcChannel == source }
            .sortedWith(compareBy<RrInterval> { it.ts }
                .thenBy(nullsFirst()) { it.ord }.thenBy { it.rrMs }.thenBy { it.seq })
    }
}
