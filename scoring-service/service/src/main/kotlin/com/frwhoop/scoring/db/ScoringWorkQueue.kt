package com.frwhoop.scoring.db

import java.sql.Connection
import java.sql.Timestamp
import java.time.Duration
import java.time.Instant
import java.util.UUID

/** Durable score-on-arrival queue backed by scoring_work_items + scorer_state. */
class ScoringWorkQueue(
    private val db: PostgresClient,
    private val discoveryOverlap: Duration = Duration.ofSeconds(30),
    private val claimLease: Duration = Duration.ofMinutes(5),
    private val maxAttempts: Int = 8,
    private val claimBatchSize: Int = 8,
) {
    data class WorkItem(
        val userId: UUID,
        val deviceId: UUID,
        val day: String,
        val dirtyAt: Instant,
        val claimedAt: Instant,
    )

    fun readWatermark(): Instant =
        db.withConnection { conn ->
            conn.prepareStatement(
                "select discovery_watermark from public.scorer_state where id = 1",
            ).use { ps ->
                ps.executeQuery().use { rs ->
                    if (rs.next()) rs.getTimestamp("discovery_watermark").toInstant()
                    else Instant.EPOCH
                }
            }
        }

    /**
     * Discover newly ingested signal rows since [since], upsert work items (bump dirty_at), then
     * advance the discovery watermark to [readAt] minus the overlap margin.
     */
    fun discoverAndEnqueue(since: Instant, readAt: Instant = Instant.now()): Int =
        db.withConnection { conn ->
            conn.autoCommit = false
            try {
                val discovered = discoverLocalDays(conn, since)
                var upserted = 0
                for ((userId, deviceId, day, dirtyAt) in discovered) {
                    upserted += upsertWorkItem(conn, userId, deviceId, day, dirtyAt)
                }
                val watermark = readAt.minus(discoveryOverlap)
                conn.prepareStatement(
                    """
                    update public.scorer_state
                    set discovery_watermark = ?, updated_at = now()
                    where id = 1
                    """.trimIndent(),
                ).use { ps ->
                    ps.setTimestamp(1, Timestamp.from(watermark))
                    ps.executeUpdate()
                }
                conn.commit()
                upserted
            } catch (err: Exception) {
                conn.rollback()
                throw err
            } finally {
                conn.autoCommit = true
            }
        }

    fun claimDue(): List<WorkItem> =
        db.withConnection { conn ->
            conn.autoCommit = false
            try {
                val due = selectDue(conn)
                val claimed = mutableListOf<WorkItem>()
                for (item in due) {
                    val work = claimOne(conn, item.userId, item.deviceId, item.day) ?: continue
                    claimed.add(work)
                }
                conn.commit()
                claimed
            } catch (err: Exception) {
                conn.rollback()
                throw err
            } finally {
                conn.autoCommit = true
            }
        }

    fun markDone(item: WorkItem, durationMs: Int): Boolean =
        db.withConnection { conn ->
            val updated = conn.prepareStatement(
                """
                update public.scoring_work_items
                set done_at = now(),
                    claimed_at = null,
                    last_duration_ms = ?,
                    last_error = null
                where user_id = ? and device_id = ? and day = ?::date
                  and dirty_at <= ?
                """.trimIndent(),
            ).use { ps ->
                ps.setInt(1, durationMs)
                ps.setObject(2, item.userId)
                ps.setObject(3, item.deviceId)
                ps.setString(4, item.day)
                ps.setTimestamp(5, Timestamp.from(item.dirtyAt))
                ps.executeUpdate()
            }
            if (updated == 0) {
                conn.prepareStatement(
                    """
                    update public.scoring_work_items
                    set claimed_at = null
                    where user_id = ? and device_id = ? and day = ?::date
                    """.trimIndent(),
                ).use { ps ->
                    ps.setObject(1, item.userId)
                    ps.setObject(2, item.deviceId)
                    ps.setString(3, item.day)
                    ps.executeUpdate()
                }
            }
            updated > 0
        }

    fun markFailed(item: WorkItem, error: String) {
        db.withConnection { conn ->
            conn.prepareStatement(
                """
                update public.scoring_work_items
                set claimed_at = null, last_error = ?
                where user_id = ? and device_id = ? and day = ?::date
                """.trimIndent(),
            ).use { ps ->
                ps.setString(1, error.take(2000))
                ps.setObject(2, item.userId)
                ps.setObject(3, item.deviceId)
                ps.setString(4, item.day)
                ps.executeUpdate()
            }
        }
    }

    /** Re-enqueue a specific (user, device, day) for queue-path verification. */
    fun dirtyWorkItem(userId: UUID, deviceId: UUID, day: String, dirtyAt: Instant = Instant.now()): Int =
        db.withConnection { conn ->
            upsertWorkItem(conn, userId, deviceId, day, dirtyAt)
        }

    private data class DueRow(val userId: UUID, val deviceId: UUID, val day: String)

    private fun selectDue(conn: Connection): List<DueRow> =
        conn.prepareStatement(
            """
            select user_id, device_id, day::text as day
            from public.scoring_work_items
            where done_at is null
              and (claimed_at is null or claimed_at < now() - (? || ' seconds')::interval)
              and attempts < ?
            order by dirty_at asc
            limit ?
            """.trimIndent(),
        ).use { ps ->
            ps.setLong(1, claimLease.seconds)
            ps.setInt(2, maxAttempts)
            ps.setInt(3, claimBatchSize)
            ps.executeQuery().use { rs ->
                buildList {
                    while (rs.next()) {
                        add(
                            DueRow(
                                userId = UUID.fromString(rs.getString("user_id")),
                                deviceId = UUID.fromString(rs.getString("device_id")),
                                day = rs.getString("day"),
                            ),
                        )
                    }
                }
            }
        }

    private fun claimOne(conn: Connection, userId: UUID, deviceId: UUID, day: String): WorkItem? =
        conn.prepareStatement(
            """
            update public.scoring_work_items
            set claimed_at = now(), attempts = attempts + 1
            where user_id = ? and device_id = ? and day = ?::date
              and done_at is null
              and (claimed_at is null or claimed_at < now() - (? || ' seconds')::interval)
              and attempts < ?
            returning user_id, device_id, day::text as day, dirty_at, claimed_at
            """.trimIndent(),
        ).use { ps ->
            ps.setObject(1, userId)
            ps.setObject(2, deviceId)
            ps.setString(3, day)
            ps.setLong(4, claimLease.seconds)
            ps.setInt(5, maxAttempts)
            ps.executeQuery().use { rs ->
                if (!rs.next()) return null
                WorkItem(
                    userId = UUID.fromString(rs.getString("user_id")),
                    deviceId = UUID.fromString(rs.getString("device_id")),
                    day = rs.getString("day"),
                    dirtyAt = rs.getTimestamp("dirty_at").toInstant(),
                    claimedAt = rs.getTimestamp("claimed_at").toInstant(),
                )
            }
        }

    private data class DiscoveredDay(
        val userId: UUID,
        val deviceId: UUID,
        val day: String,
        val dirtyAt: Instant,
    )

    private fun discoverLocalDays(conn: Connection, since: Instant): List<DiscoveredDay> =
        conn.prepareStatement(DISCOVER_LOCAL_DAYS_SQL).use { ps ->
            val ts = Timestamp.from(since)
            ps.setTimestamp(1, ts)
            ps.setTimestamp(2, ts)
            ps.setTimestamp(3, ts)
            ps.executeQuery().use { rs ->
                buildList {
                    while (rs.next()) {
                        add(
                            DiscoveredDay(
                                userId = UUID.fromString(rs.getString("user_id")),
                                deviceId = UUID.fromString(rs.getString("device_id")),
                                day = rs.getString("day"),
                                dirtyAt = rs.getTimestamp("dirty_at").toInstant(),
                            ),
                        )
                    }
                }
            }
        }

    private fun upsertWorkItem(
        conn: Connection,
        userId: UUID,
        deviceId: UUID,
        day: String,
        dirtyAt: Instant,
    ): Int =
        conn.prepareStatement(
            """
            insert into public.scoring_work_items (user_id, device_id, day, dirty_at)
            values (?, ?, ?::date, ?)
            on conflict (user_id, device_id, day) do update set
              dirty_at = greatest(scoring_work_items.dirty_at, excluded.dirty_at),
              done_at = case
                when excluded.dirty_at > coalesce(scoring_work_items.dirty_at, '-infinity'::timestamptz)
                then null
                else scoring_work_items.done_at
              end
            """.trimIndent(),
        ).use { ps ->
            ps.setObject(1, userId)
            ps.setObject(2, deviceId)
            ps.setString(3, day)
            ps.setTimestamp(4, Timestamp.from(dirtyAt))
            ps.executeUpdate()
        }

    companion object {
        /** Exposed for unit tests that assert discovery shape without a live DB. */
        val DISCOVER_LOCAL_DAYS_SQL: String =
            """
            with touched as (
              select h.user_id, h.device_id, h.ts, h.ingested_at, coalesce(p.timezone, 'UTC') as tz
              from public.noop_hr_samples h
              join public.profiles p on p.id = h.user_id
              where h.ingested_at > ? and h.device_id is not null
              union all
              select r.user_id, r.device_id, r.ts, r.ingested_at, coalesce(p.timezone, 'UTC') as tz
              from public.noop_rr_intervals r
              join public.profiles p on p.id = r.user_id
              where r.ingested_at > ? and r.device_id is not null
              union all
              select w.user_id, w.device_id, w.hour_start as ts, w.updated_at as ingested_at,
                     coalesce(p.timezone, 'UTC') as tz
              from public.noop_signal_windows w
              join public.profiles p on p.id = w.user_id
              where w.updated_at > ? and w.device_id is not null
            )
            select user_id, device_id,
                   (to_timestamp(ts) at time zone tz)::date::text as day,
                   max(ingested_at) as dirty_at
            from touched
            group by user_id, device_id, (to_timestamp(ts) at time zone tz)::date
            """.trimIndent()
    }
}
