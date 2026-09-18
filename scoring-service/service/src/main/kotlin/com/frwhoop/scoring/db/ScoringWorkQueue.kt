package com.frwhoop.scoring.db

import org.json.JSONObject
import java.time.Duration
import java.time.Instant
import java.util.UUID

/** All mutations are fenced in Postgres; one claim represents one immediately runnable job. */
class ScoringWorkQueue(
    internal val db: PostgresClient,
    val algorithmVersion: String = "frwhoop-server-1",
    val claimLease: Duration = Duration.ofMinutes(5),
) {
    init { require(claimLease.seconds in 1..3600) }

    data class WorkItem(
        val userId: UUID,
        val deviceId: UUID,
        val day: String,
        val algorithmVersion: String,
        val inputRevision: Long,
        val leaseToken: UUID,
        val leaseUntil: Instant,
    )

    fun maintain(limit: Int = 128) {
        db.withConnection { c ->
            c.prepareStatement("select public.register_scoring_algorithm_v2(?)").use {
                it.setString(1, algorithmVersion); it.execute()
            }
            c.prepareStatement("select public.repair_legacy_scoring_v2(?), public.expand_scoring_invalidations_v2(?)").use {
                it.setInt(1, limit); it.setInt(2, limit); it.execute()
            }
            c.prepareStatement("select public.reconcile_scoring_versions_v2(?)").use {
                it.setInt(1, limit); it.execute()
            }
        }
    }

    fun dirtyWorkItem(userId: UUID, deviceId: UUID, day: String): Long = db.withConnection { c ->
        c.prepareStatement("select public.enqueue_scoring_v2(?, ?, ?::date, ?, 'explicit_replay')").use {
            it.setObject(1, userId); it.setObject(2, deviceId); it.setString(3, day); it.setString(4, algorithmVersion)
            it.executeQuery().use { r -> r.next(); r.getLong(1) }
        }
    }

    fun claim(): WorkItem? = db.withConnection { c ->
        c.prepareStatement("select * from public.claim_scoring_v2(?, ?)").use {
            it.setString(1, algorithmVersion); it.setInt(2, claimLease.seconds.toInt())
            it.executeQuery().use { r ->
                if (!r.next()) null else WorkItem(
                    UUID.fromString(r.getString("user_id")), UUID.fromString(r.getString("device_id")),
                    r.getString("day"), r.getString("algorithm_version"), r.getLong("input_revision"),
                    UUID.fromString(r.getString("lease_token")), r.getTimestamp("lease_until").toInstant(),
                )
            }
        }
    }

    fun renew(item: WorkItem): Boolean = db.withConnection { c ->
        c.prepareStatement("select public.renew_scoring_v2(?, ?)").use {
            it.setObject(1, item.leaseToken); it.setInt(2, claimLease.seconds.toInt())
            it.executeQuery().use { r -> r.next(); r.getBoolean(1) }
        }
    }

    fun markFailed(item: WorkItem, error: String): Boolean = db.withConnection { c ->
        c.prepareStatement("select public.fail_scoring_v2(?, ?, ?)").use {
            it.setObject(1, item.leaseToken); it.setLong(2, item.inputRevision); it.setString(3, error.take(2000))
            it.executeQuery().use { r -> r.next(); r.getBoolean(1) }
        }
    }

    fun publish(item: WorkItem, payload: JSONObject, durationMs: Long): Long? = db.withConnection { c ->
        c.prepareStatement("select public.publish_scoring_snapshot_v2(?, ?, ?::jsonb, ?)").use {
            it.setObject(1, item.leaseToken); it.setLong(2, item.inputRevision)
            it.setString(3, payload.toString()); it.setLong(4, durationMs)
            it.executeQuery().use { r -> r.next(); r.getLong(1).let { v -> if (r.wasNull()) null else v } }
        }
    }

    fun metrics(): JSONObject = db.withConnection { c ->
        c.createStatement().use { s ->
            s.executeQuery("select row_to_json(m)::text from public.scoring_queue_metrics_v2 m").use { r ->
                r.next(); JSONObject(r.getString(1))
            }
        }
    }
}
