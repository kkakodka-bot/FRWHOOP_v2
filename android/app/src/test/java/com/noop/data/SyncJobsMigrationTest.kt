package com.noop.data

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/** GRDB `v44-sync-jobs` twin (Room v38), now used for durable Android post-offload debt. */
class SyncJobsMigrationTest {

    @Test
    fun migrationCreatesBothTablesAdditively() {
        val sql = WhoopDatabase.SYNC_JOBS_MIGRATION_SQL
        assertEquals(2, sql.size)
        val upper = sql.joinToString("\n").uppercase()
        assertTrue(upper.contains("CREATE TABLE IF NOT EXISTS `SYNCJOB`"))
        assertTrue(upper.contains("CREATE TABLE IF NOT EXISTS `SYNCJOURNALENTRY`"))
        for (banned in listOf("DROP ", "DELETE ", "UPDATE ", "INSERT ", "RENAME ", "ALTER ")) {
            assertTrue("migration must not contain $banned", !upper.contains(banned))
        }
    }

    @Test
    fun migrationSpansTheRightVersions() {
        assertEquals(37, WhoopDatabase.MIGRATION_37_38.startVersion)
        assertEquals(38, WhoopDatabase.MIGRATION_37_38.endVersion)
    }
}
