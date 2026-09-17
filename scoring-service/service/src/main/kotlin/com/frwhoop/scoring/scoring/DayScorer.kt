package com.frwhoop.scoring.scoring

import com.frwhoop.scoring.db.SignalSampleReader
import com.noop.analytics.AnalyticsEngine
import com.noop.analytics.DayResult
import com.noop.protocol.DeviceFamily

/**
 * Runs the scoped server kernel (HRV/RR + sleep) via the extracted Kotlin twin.
 * Charge/Effort/Rest outputs are computed internally but discarded at ingest write time.
 */
class DayScorer {
    fun score(inputs: SignalSampleReader.DayInputs, algorithmVersion: String): ServerScoreBundle {
        // Local-day bounds (from the user's profile timezone via UserDayBounds) — the SAME local-day
        // semantics queue discovery uses. UTC-midnight bounds would shift the scored window for any
        // non-UTC user (Phase 3 gate failure: "DayScorer currently uses a UTC day boundary").
        val dayLo = inputs.dayLo
        val dayHi = inputs.dayHi
        val dayHr = AnalyticsEngine.daySliceFromNight(
            inputs.hr, inputs.nightLo, inputs.nightHi, dayLo, dayHi,
        ) { it.ts } ?: inputs.hr.filter { it.ts in dayLo..dayHi }
        val dayGravity = AnalyticsEngine.daySliceFromNight(
            inputs.gravity, inputs.nightLo, inputs.nightHi, dayLo, dayHi,
        ) { it.ts } ?: inputs.gravity.filter { it.ts in dayLo..dayHi }

        val wristOff = AnalyticsEngine.offWristIntervals(inputs.events, inputs.nightHi)

        val result = AnalyticsEngine.analyzeDay(
            day = inputs.day,
            hr = inputs.hr,
            rr = inputs.rr,
            resp = inputs.resp,
            gravity = inputs.gravity,
            dayHr = dayHr,
            dayGravity = dayGravity,
            profile = inputs.profile,
            tzOffsetSeconds = inputs.tzOffsetSeconds,
            wristOff = wristOff,
            skinTempFamily = inputs.deviceFamily,
            useSleepStagerV2 = true,
            useMotionAwareWake = inputs.deviceFamily != DeviceFamily.WHOOP4,
        )

        return ServerScoreBundle(
            userId = inputs.userId,
            day = inputs.day,
            deviceId = inputs.deviceId,
            algorithmVersion = algorithmVersion,
            result = result,
        )
    }
}

data class ServerScoreBundle(
    val userId: java.util.UUID,
    val day: String,
    val deviceId: String,
    val algorithmVersion: String,
    val result: DayResult,
)
