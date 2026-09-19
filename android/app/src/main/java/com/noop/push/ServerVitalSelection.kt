package com.noop.push

/** Explicit Today vital mode: an absent selected-day server value never borrows local history. */
data class ServerVitalSelection(
    val value: Double?, val fromServer: Boolean, val day: String, val status: String?, val stale: Boolean,
    val sourceFeature: String? = null, val deviceId: String? = null, val algorithmVersion: String? = null,
) {
    enum class Metric { HRV, RESTING_HR, RESPIRATORY, SLEEP, CHARGE, STRAIN, SPO2, SKIN_TEMP }

    companion object {
        /** [overlay] must already be owner scoped and configuration/authentication qualified. */
        fun resolve(metric: Metric, serverEnabled: Boolean, selectedDay: String,
                    overlay: ServerScoreDayCache?, localValue: Double?): ServerVitalSelection {
            if (!serverEnabled) return ServerVitalSelection(localValue, false, selectedDay, null, false)
            // No overlay yet: keep showing locally scored values until the hosted scorer publishes.
            if (overlay == null || overlay.day != selectedDay)
                return ServerVitalSelection(localValue, false, selectedDay, null, false)
            val (value, featureKey) = when (metric) {
                Metric.HRV -> overlay.daily?.hrvRmssdMs to "hrv"
                Metric.RESTING_HR -> overlay.daily?.restingHrBpm?.toDouble() to "hrv"
                Metric.RESPIRATORY -> overlay.daily?.respRateBpm to "respiration"
                Metric.SLEEP -> overlay.daily?.sleepTotalMin to "sleep"
                Metric.CHARGE -> overlay.daily?.recovery to "hrv"
                Metric.STRAIN -> overlay.daily?.strain to "hrv"
                Metric.SPO2 -> overlay.daily?.spo2Pct to "hrv"
                Metric.SKIN_TEMP -> (overlay.daily?.skinTempC ?: overlay.daily?.skinTempDevC) to "hrv"
            }
            val feature = overlay.features[featureKey]
            val status = feature?.status ?: "unavailable"
            val available = status == "available" || status == "stale"
            // A published feature with this metric still null is not live for the card.
            // Keep the local number until the hosted kernel actually writes this key.
            if (!available || value == null) {
                return ServerVitalSelection(localValue, false, selectedDay, status, overlay.stale,
                    feature?.let { featureKey }, feature?.deviceId, feature?.algorithmVersion)
            }
            return ServerVitalSelection(value, true, selectedDay, status, overlay.stale || status == "stale",
                feature?.let { featureKey }, feature?.deviceId, feature?.algorithmVersion)
        }
    }
}
