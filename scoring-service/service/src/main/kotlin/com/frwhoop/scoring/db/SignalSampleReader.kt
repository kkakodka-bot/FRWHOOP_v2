package com.frwhoop.scoring.db

import com.frwhoop.scoring.scoring.UserDayBounds
import com.noop.analytics.UserProfile
import com.noop.data.EventRow
import com.noop.data.GravitySample
import com.noop.data.HrSample
import com.noop.data.RespSample
import com.noop.data.RrInterval
import com.noop.protocol.DeviceFamily
import java.sql.Connection
import java.util.UUID

/** Maps Postgres `noop_*` projection rows into the Kotlin twin's on-device entity shapes. */
class SignalSampleReader(private val db: PostgresClient) : ScoreInputProvider {

    data class DayInputs(
        val userId: UUID,
        val day: String,
        val deviceId: String,
        val tzOffsetSeconds: Long,
        val dayLo: Long,
        val dayHi: Long,
        val profile: UserProfile,
        val nightLo: Long,
        val nightHi: Long,
        val hr: List<HrSample>,
        val rr: List<RrInterval>,
        val resp: List<RespSample>,
        val gravity: List<GravitySample>,
        val events: List<EventRow>,
        val deviceFamily: DeviceFamily,
    )

    override fun loadDay(userId: UUID, day: String, deviceId: UUID): DayInputs? =
        db.withConnection { conn ->
            val deviceIdText = deviceId.toString()
            if (!deviceExistsForUser(conn, userId, deviceId)) return@withConnection null
            val profileRow = loadProfile(conn, userId, deviceId)
            val bounds = UserDayBounds.forDay(day, profileRow.zoneId)

            DayInputs(
                userId = userId,
                day = day,
                deviceId = deviceIdText,
                tzOffsetSeconds = bounds.tzOffsetSeconds,
                dayLo = bounds.dayLo,
                dayHi = bounds.dayHi,
                profile = profileRow.profile,
                nightLo = bounds.nightLo,
                nightHi = bounds.nightHi,
                hr = loadHr(conn, userId, deviceIdText, bounds.nightLo, bounds.nightHi),
                rr = loadRr(conn, userId, deviceIdText, bounds.nightLo, bounds.nightHi),
                resp = loadResp(conn, userId, deviceIdText, bounds.nightLo, bounds.nightHi),
                gravity = loadGravity(conn, userId, deviceIdText, bounds.nightLo, bounds.nightHi),
                events = loadEvents(conn, userId, deviceIdText, bounds.nightLo, bounds.nightHi),
                deviceFamily = profileRow.deviceFamily,
            )
        }

    fun listDeviceIds(userId: UUID): List<UUID> =
        db.withConnection { conn ->
            conn.prepareStatement(
                """
                select id
                from public.devices
                where user_id = ?
                order by last_seen_at desc nulls last
                """.trimIndent(),
            ).use { ps ->
                ps.setObject(1, userId)
                ps.executeQuery().use { rs ->
                    buildList {
                        while (rs.next()) {
                            add(UUID.fromString(rs.getString("id")))
                        }
                    }
                }
            }
        }

    private data class ProfileRow(
        val profile: UserProfile,
        val zoneId: java.time.ZoneId,
        val deviceFamily: DeviceFamily,
    )

    private fun deviceExistsForUser(conn: Connection, userId: UUID, deviceId: UUID): Boolean =
        conn.prepareStatement(
            """
            select 1
            from public.devices
            where user_id = ? and id = ?
            """.trimIndent(),
        ).use { ps ->
            ps.setObject(1, userId)
            ps.setObject(2, deviceId)
            ps.executeQuery().use { rs -> rs.next() }
        }

    private fun loadProfile(conn: Connection, userId: UUID, deviceId: UUID): ProfileRow {
        conn.prepareStatement(
            """
            select
              coalesce(p.reported_age_years, 30)::double precision as age,
              coalesce(p.sex_model, 'nonbinary') as sex,
              coalesce(p.weight_kg, 70)::double precision as weight_kg,
              coalesce(p.height_cm, 170)::double precision as height_cm,
              coalesce(p.timezone, 'UTC') as timezone_name,
              coalesce(d.device_family, 'whoop5') as device_family
            from public.profiles p
            join public.devices d on d.user_id = p.id and d.id = ?
            where p.id = ?
            """.trimIndent(),
        ).use { ps ->
            ps.setObject(1, deviceId)
            ps.setObject(2, userId)
            ps.executeQuery().use { rs ->
                if (!rs.next()) {
                    return ProfileRow(UserProfile(), UserDayBounds.parseZone("UTC"), DeviceFamily.WHOOP5)
                }
                val zoneId = UserDayBounds.parseZone(rs.getString("timezone_name"))
                val family = when (rs.getString("device_family")?.lowercase()) {
                    "whoop4", "4.0", "whoop 4.0" -> DeviceFamily.WHOOP4
                    else -> DeviceFamily.WHOOP5
                }
                return ProfileRow(
                    profile = UserProfile(
                        age = rs.getDouble("age"),
                        sex = rs.getString("sex"),
                        weightKg = rs.getDouble("weight_kg"),
                        heightCm = rs.getDouble("height_cm"),
                    ),
                    zoneId = zoneId,
                    deviceFamily = family,
                )
            }
        }
    }

    private fun loadHr(
        conn: Connection,
        userId: UUID,
        deviceId: String,
        fromTs: Long,
        toTs: Long,
    ): List<HrSample> = conn.prepareStatement(
        """
        select ts, bpm
        from public.noop_hr_samples
        where user_id = ? and device_id::text = ? and ts between ? and ?
        order by ts asc
        """.trimIndent(),
    ).use { ps ->
        ps.setObject(1, userId)
        ps.setString(2, deviceId)
        ps.setLong(3, fromTs)
        ps.setLong(4, toTs)
        ps.executeQuery().use { rs ->
            buildList {
                while (rs.next()) {
                    add(HrSample(deviceId = deviceId, ts = rs.getLong("ts"), bpm = rs.getInt("bpm")))
                }
            }
        }
    }

    fun loadRr(
        conn: Connection,
        userId: UUID,
        deviceId: String,
        fromTs: Long,
        toTs: Long,
    ): List<RrInterval> = conn.prepareStatement(
        """
        select ts, "rrMs", seq, ord, "srcChannel", "tsSuspect"
        from public.noop_rr_intervals
        where user_id = ? and device_id::text = ? and ts between ? and ?
        order by ts asc, ord asc nulls first, "rrMs" asc, seq asc
        """.trimIndent(),
    ).use { ps ->
        ps.setObject(1, userId)
        ps.setString(2, deviceId)
        ps.setLong(3, fromTs)
        ps.setLong(4, toTs)
        ps.executeQuery().use { rs ->
            buildList {
                while (rs.next()) {
                    add(
                        RrInterval(
                            deviceId = deviceId,
                            ts = rs.getLong("ts"),
                            rrMs = rs.getInt("rrMs"),
                            seq = rs.getInt("seq"),
                            ord = rs.getObject("ord") as? Int,
                            srcChannel = rs.getObject("srcChannel") as? Int,
                            tsSuspect = rs.getObject("tsSuspect") as? Int,
                        ),
                    )
                }
            }
        }
    }

    private fun loadResp(
        conn: Connection,
        userId: UUID,
        deviceId: String,
        fromTs: Long,
        toTs: Long,
    ): List<RespSample> = conn.prepareStatement(
        """
        select ts, raw
        from public.noop_resp_samples
        where user_id = ? and device_id::text = ? and ts between ? and ?
        order by ts asc
        """.trimIndent(),
    ).use { ps ->
        ps.setObject(1, userId)
        ps.setString(2, deviceId)
        ps.setLong(3, fromTs)
        ps.setLong(4, toTs)
        ps.executeQuery().use { rs ->
            buildList {
                while (rs.next()) {
                    add(RespSample(deviceId = deviceId, ts = rs.getLong("ts"), raw = rs.getInt("raw")))
                }
            }
        }
    }

    private fun loadGravity(
        conn: Connection,
        userId: UUID,
        deviceId: String,
        fromTs: Long,
        toTs: Long,
    ): List<GravitySample> = conn.prepareStatement(
        """
        select ts, x, y, z
        from public.noop_gravity_samples
        where user_id = ? and device_id::text = ? and ts between ? and ?
        order by ts asc
        """.trimIndent(),
    ).use { ps ->
        ps.setObject(1, userId)
        ps.setString(2, deviceId)
        ps.setLong(3, fromTs)
        ps.setLong(4, toTs)
        ps.executeQuery().use { rs ->
            buildList {
                while (rs.next()) {
                    add(
                        GravitySample(
                            deviceId = deviceId,
                            ts = rs.getLong("ts"),
                            x = rs.getDouble("x"),
                            y = rs.getDouble("y"),
                            z = rs.getDouble("z"),
                        ),
                    )
                }
            }
        }
    }

    private fun loadEvents(
        conn: Connection,
        userId: UUID,
        deviceId: String,
        fromTs: Long,
        toTs: Long,
    ): List<EventRow> = conn.prepareStatement(
        """
        select ts, kind, "payloadJSON"
        from public.noop_events
        where user_id = ? and device_id::text = ? and ts between ? and ?
        order by ts asc
        """.trimIndent(),
    ).use { ps ->
        ps.setObject(1, userId)
        ps.setString(2, deviceId)
        ps.setLong(3, fromTs)
        ps.setLong(4, toTs)
        ps.executeQuery().use { rs ->
            buildList {
                while (rs.next()) {
                    add(
                        EventRow(
                            deviceId = deviceId,
                            ts = rs.getLong("ts"),
                            kind = rs.getString("kind"),
                            payloadJSON = rs.getString("payloadJSON"),
                        ),
                    )
                }
            }
        }
    }
}
