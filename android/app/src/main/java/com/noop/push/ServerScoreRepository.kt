package com.noop.push

import android.content.Context
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch

class ServerScoreRepository(
    private val appContext: Context,
    private val scope: CoroutineScope,
) {
    private val cacheStore = ServerScoreCacheStore(appContext)
    private val memory = mutableMapOf<String, ServerScoreDayCache>()
    private var pollJob: Job? = null

    private val _lastError = MutableStateFlow<String?>(null)
    val lastError: StateFlow<String?> = _lastError.asStateFlow()

    private val _lastFetchedAtMs = MutableStateFlow<Long?>(null)
    val lastFetchedAtMs: StateFlow<Long?> = _lastFetchedAtMs.asStateFlow()

    private val _signedIn = MutableStateFlow(CloudAuthClient.storedSession(appContext) != null)
    val signedIn: StateFlow<Boolean> = _signedIn.asStateFlow()

    init {
        preloadRecentDays()
    }

    fun overlay(day: String): ServerScoreDayCache? {
        if (!ServerScoringSettings.isEnabled(appContext)) return null
        return memory[day]
    }

    suspend fun signIn(email: String, password: String) {
        runCatching {
            CloudAuthClient.signIn(appContext, email, password)
            _signedIn.value = true
            _lastError.value = null
        }.onFailure {
            _signedIn.value = false
            _lastError.value = "Sign-in failed"
        }
    }

    fun signOut() {
        CloudAuthClient.clearSession(appContext)
        _signedIn.value = false
        stopPolling()
    }

    fun startPolling(todayKey: String) {
        if (!ServerScoringSettings.ready(appContext) || !_signedIn.value) return
        stopPolling()
        pollJob = scope.launch {
            while (isActive) {
                refreshDay(todayKey)
                delay(ServerScoringSettings.POLL_INTERVAL_SECONDS * 1000L)
            }
        }
    }

    fun stopPolling() {
        pollJob?.cancel()
        pollJob = null
    }

    suspend fun refreshDay(day: String) {
        if (!ServerScoringSettings.ready(appContext) || !_signedIn.value) return
        runCatching {
            val cache = ServerScoreClient.fetchDaySnapshot(appContext, day)
            memory[day] = cache
            cacheStore.upsert(cache)
            _lastFetchedAtMs.value = cache.fetchedAtMs
            _lastError.value = null
        }.onFailure { err ->
            if (err.message == "unauthorized" || err.message == "session expired") {
                _signedIn.value = false
                _lastError.value = "Session expired — sign in again"
            } else {
                _lastError.value = "Server scores unavailable"
                memory[day]?.let { /* keep last-known */ }
                    ?: cacheStore.load(day)?.let { memory[day] = it }
            }
        }
    }

    private fun preloadRecentDays() {
        val cal = java.util.Calendar.getInstance()
        val fmt = java.text.SimpleDateFormat("yyyy-MM-dd", java.util.Locale.US)
        repeat(14) { offset ->
            cal.timeInMillis = System.currentTimeMillis()
            cal.add(java.util.Calendar.DAY_OF_YEAR, -offset)
            val key = fmt.format(cal.time)
            cacheStore.load(key)?.let { memory[key] = it }
        }
    }
}
