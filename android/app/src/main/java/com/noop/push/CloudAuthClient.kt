package com.noop.push

import android.content.Context
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL

/** Supabase GoTrue session for authenticated score reads (JWT only). */
object CloudAuthClient {
    data class Session(
        val accessToken: String,
        val refreshToken: String,
        val expiresAtMs: Long,
        val userId: String,
    ) {
        fun isExpired(nowMs: Long = System.currentTimeMillis()): Boolean =
            nowMs + 60_000 >= expiresAtMs
    }

    private const val PREFS = "noop_cloud_auth"
    private const val KEY_SESSION = "session_json"

    fun storedSession(context: Context): Session? {
        val raw = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .getString(KEY_SESSION, null) ?: return null
        return runCatching {
            val o = JSONObject(raw)
            Session(
                accessToken = o.getString("accessToken"),
                refreshToken = o.getString("refreshToken"),
                expiresAtMs = o.getLong("expiresAtMs"),
                userId = o.getString("userId"),
            )
        }.getOrNull()
    }

    fun clearSession(context: Context) {
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().remove(KEY_SESSION).apply()
    }

    suspend fun signIn(context: Context, email: String, password: String): Session =
        withContext(Dispatchers.IO) {
            val base = ServerScoringSettings.supabaseProjectUrl()
                ?: error("not configured")
            val anon = ServerScoringSettings.anonKey()
                ?: error("not configured")
            val url = URL("$base/auth/v1/token?grant_type=password")
            val conn = (url.openConnection() as HttpURLConnection).apply {
                requestMethod = "POST"
                setRequestProperty("Content-Type", "application/json")
                setRequestProperty("apikey", anon)
                doOutput = true
            }
            conn.outputStream.use {
                it.write(JSONObject(mapOf("email" to email, "password" to password)).toString().toByteArray())
            }
            if (conn.responseCode != 200) error("invalid credentials")
            val body = conn.inputStream.bufferedReader().readText()
            val session = parseSession(body)
            persist(context, session)
            ServerScoringSettings.setAuthEmail(context, email)
            session
        }

    suspend fun validAccessToken(context: Context): String =
        withContext(Dispatchers.IO) {
            var session = storedSession(context) ?: error("not signed in")
            if (!session.isExpired()) return@withContext session.accessToken
            session = refresh(context, session)
            session.accessToken
        }

    private fun refresh(context: Context, session: Session): Session {
        val base = ServerScoringSettings.supabaseProjectUrl() ?: error("not configured")
        val anon = ServerScoringSettings.anonKey() ?: error("not configured")
        val url = URL("$base/auth/v1/token?grant_type=refresh_token")
        val conn = (url.openConnection() as HttpURLConnection).apply {
            requestMethod = "POST"
            setRequestProperty("Content-Type", "application/json")
            setRequestProperty("apikey", anon)
            doOutput = true
        }
        conn.outputStream.use {
            it.write(JSONObject(mapOf("refresh_token" to session.refreshToken)).toString().toByteArray())
        }
        if (conn.responseCode != 200) {
            clearSession(context)
            error("session expired")
        }
        val refreshed = parseSession(conn.inputStream.bufferedReader().readText())
        persist(context, refreshed)
        return refreshed
    }

    private fun parseSession(body: String): Session {
        val o = JSONObject(body)
        val user = o.getJSONObject("user")
        val expiresIn = o.getLong("expires_in")
        return Session(
            accessToken = o.getString("access_token"),
            refreshToken = o.getString("refresh_token"),
            expiresAtMs = System.currentTimeMillis() + expiresIn * 1000L,
            userId = user.getString("id"),
        )
    }

    private fun persist(context: Context, session: Session) {
        val json = JSONObject()
            .put("accessToken", session.accessToken)
            .put("refreshToken", session.refreshToken)
            .put("expiresAtMs", session.expiresAtMs)
            .put("userId", session.userId)
            .toString()
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putString(KEY_SESSION, json).apply()
    }
}
