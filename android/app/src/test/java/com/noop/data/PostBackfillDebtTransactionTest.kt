package com.noop.data

import java.lang.reflect.Proxy
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class PostBackfillDebtTransactionTest {
    @Test fun productiveInsertMarksEveryStageInsideTheRawTransaction() = runBlocking {
        var inTransaction = false
        val marked = mutableListOf<String>()
        val dao = Proxy.newProxyInstance(
            WhoopDao::class.java.classLoader,
            arrayOf(WhoopDao::class.java),
        ) { _, method, args ->
            when (method.name) {
                "insertHr" -> listOf(1L)
                "markSyncJobOwed" -> {
                    assertTrue("debt must be marked before the raw transaction commits", inTransaction)
                    marked += args!![0] as String
                    Unit
                }
                else -> throw UnsupportedOperationException("unexpected DAO call ${method.name}")
            }
        } as WhoopDao
        val tx = object : WhoopRepository.Transactor {
            override suspend fun <R> run(block: suspend () -> R): R {
                assertFalse(inTransaction)
                inTransaction = true
                return try { block() } finally { inTransaction = false }
            }
        }
        val repo = WhoopRepository(dao, tx)

        val counts = repo.insert(
            StreamBatch(hr = listOf(HrRow(1_700_000_000L, 60))),
            deviceId = "test",
            markPostBackfillDebt = true,
        )

        assertEquals(1, counts.hr)
        assertEquals(SyncDrainPolicy.stageOrder.map { it.rawValue }, marked)
        assertFalse(inTransaction)
    }

    @Test fun duplicateOnlyInsertCreatesNoDebt() = runBlocking {
        val calls = mutableListOf<String>()
        val dao = Proxy.newProxyInstance(
            WhoopDao::class.java.classLoader,
            arrayOf(WhoopDao::class.java),
        ) { _, method, _ ->
            calls += method.name
            when (method.name) {
                "insertHr" -> listOf(-1L)
                else -> throw AssertionError("duplicate insert must not call ${method.name}")
            }
        } as WhoopDao
        val repo = WhoopRepository(dao)

        repo.insert(
            StreamBatch(hr = listOf(HrRow(1_700_000_000L, 60))),
            deviceId = "test",
            markPostBackfillDebt = true,
        )
        assertEquals(listOf("insertHr"), calls)
    }
}
