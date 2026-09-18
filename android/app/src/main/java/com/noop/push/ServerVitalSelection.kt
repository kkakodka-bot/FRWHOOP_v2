package com.noop.push

/** Explicit Today vital mode: an absent selected-day server value never borrows local history. */
data class ServerVitalSelection(
    val value: Double?, val fromServer: Boolean, val day: String, val status: String?, val stale: Boolean,
    val sourceFeature: String? = null, val deviceId: String? = null, val algorithmVersion: String? = null,
) {
    enum class Metric { HRV, RESTING_HR, RESPIRATORY }

    companion object {
        /** [overlay] must already be owner scoped and configuration/authentication qualified. */
        fun resolve(metric: Metric, serverEnabled: Boolean, selectedDay: String,
                    overlay: ServerScoreDayCache?, localValue: Double?): ServerVitalSelection {
            if (!serverEnabled) return ServerVitalSelection(localValue, false, selectedDay, null, false)
            if (overlay == null || overlay.day != selectedDay)
                return ServerVitalSelection(null, true, selectedDay, "unavailable", false)
            val (value, featureKey) = when (metric) {
                Metric.HRV -> overlay.daily?.hrvRmssdMs to "hrv"
                Metric.RESTING_HR -> overlay.daily?.restingHrBpm?.toDouble() to "hrv"
                Metric.RESPIRATORY -> overlay.daily?.respRateBpm to "respiration"
            }
            val feature = overlay.features[featureKey]
            val status = feature?.status ?: "unavailable"
            val available = status == "available" || status == "stale"
            return ServerVitalSelection(if (available) value else null, true, selectedDay,
                if (available && value == null) "unavailable" else status, overlay.stale || status == "stale",
                feature?.let { featureKey }, feature?.deviceId, feature?.algorithmVersion)
        }
    }
}
