package com.noop.data

import java.lang.reflect.Proxy
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class SyncJobTokenTest {
    @Test fun staleTokenCannotSettleNewerDebt() = runBlocking {
        var current = "new-token"
        val dao = Proxy.newProxyInstance(
            WhoopDao::class.java.classLoader,
            arrayOf(WhoopDao::class.java),
        ) { _, method, args ->
            when (method.name) {
                "settleSyncJob" -> {
                    val supplied = args!![1] as String
                    if (supplied == current) { current = ""; 1 } else 0
                }
                else -> throw UnsupportedOperationException(method.name)
            }
        } as WhoopDao
        val repo = WhoopRepository(dao)
        val stale = SyncJobEntity("rescore", 1, "old-token")
        val fresh = SyncJobEntity("rescore", 2, "new-token")

        assertFalse(repo.settleSyncJob(stale))
        assertTrue(repo.settleSyncJob(fresh))
    }
}
