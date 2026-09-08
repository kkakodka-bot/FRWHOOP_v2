package com.noop.push

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * SHARED cloud-ingestion coverage oracle — the Kotlin half of the "every table has a destination" guard.
 *
 * Uses the same `cloud_ingestion_registry.json` as Swift's `CloudIngestionRegistryTests`, but validates
 * coverage against every table pinned in `schema_oracle.json` (Room + GRDB union), including android_only
 * tables that never exist on iOS.
 */
class CloudIngestionRegistryTest {

    private fun loadRegistry(): JSONObject {
        val stream = javaClass.classLoader!!.getResourceAsStream("cloud_ingestion_registry.json")
        assertNotNull("cloud_ingestion_registry.json missing from test classpath", stream)
        return JSONObject(stream!!.bufferedReader().use { it.readText() })
    }

    private fun loadSchemaOracle(): JSONObject {
        val stream = javaClass.classLoader!!.getResourceAsStream("schema_oracle.json")
        assertNotNull("schema_oracle.json missing from test classpath", stream)
        return JSONObject(stream!!.bufferedReader().use { it.readText() })
    }

    @Test
    fun everySchemaOracleTableHasCloudDestination() {
        val registry = loadRegistry()
        val oracle = loadSchemaOracle()
        val tables = registry.getJSONObject("tables")
        val oracleTables = oracle.getJSONObject("tables")
        val problems = mutableListOf<String>()

        val keys = oracleTables.keys().asSequence().toList().sorted()
        for (name in keys) {
            if (!tables.has(name)) {
                problems += "$name: pinned by schema_oracle.json but missing from cloud_ingestion_registry.json"
                continue
            }
            val entry = tables.getJSONObject(name)
            val why = entry.optString("why", "").trim()
            if (why.isEmpty()) problems += "$name: `why` must be non-empty"
            when (entry.getString("classification")) {
                "shipped" -> {
                    for (field in listOf(
                            "wireStream", "delivery", "b2Stream", "b2Extension",
                            "b2RetentionClass", "supabaseTable",
                        )) {
                        if (!entry.has(field) || entry.isNull(field)) {
                            problems += "$name: shipped row missing $field"
                        }
                    }
                }
                "local_only" -> {
                    for (field in listOf(
                            "wireStream", "delivery", "b2Stream", "b2Extension",
                            "b2RetentionClass", "supabaseTable",
                        )) {
                        if (entry.has(field) && !entry.isNull(field)) {
                            problems += "$name: local_only row must not name cloud destinations"
                        }
                    }
                }
                else -> problems += "$name: unknown classification ${entry.getString("classification")}"
            }
        }

        val oracleKeySet = keys.toSet()
        val extra = tables.keys().asSequence()
            .filter { !oracleKeySet.contains(it) }
            .sorted()
            .toList()
        for (name in extra) {
            val platform = tables.getJSONObject(name).optString("platform")
            if (platform != "android_only" && platform != "both_file") {
                problems += "$name: declared in cloud_ingestion_registry.json but absent from schema_oracle.json"
            }
        }

        assertTrue(
            "cloud ingestion registry drift (${problems.size}):\n  - ${problems.joinToString("\n  - ")}",
            problems.isEmpty(),
        )
    }

    @Test
    fun registryCopiesAreIdentical() {
        val androidStream = javaClass.classLoader!!.getResourceAsStream("cloud_ingestion_registry.json")
        assertNotNull(androidStream)
        val androidBytes = androidStream!!.readBytes()
        // CloudIngestionRegistryTest.kt -> com/noop/push -> test -> src -> app -> android -> repo root
        val repoRoot = File(javaClass.protectionDomain.codeSource.location.toURI())
            .parentFile.parentFile.parentFile.parentFile.parentFile.parentFile
        val swiftPath = File(
            repoRoot,
            "Packages/WhoopStore/Tests/WhoopStoreTests/Resources/cloud_ingestion_registry.json",
        )
        if (!swiftPath.isFile) return
        val swiftBytes = swiftPath.readBytes()
        assertTrue("cloud_ingestion_registry.json copies differ", swiftBytes.contentEquals(androidBytes))
    }
}
