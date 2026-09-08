package com.noop.push

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class PushRegistryTest {
    @Test
    fun v1_2WireStreamsMatchCloudIngestionRegistry() {
        val stream = javaClass.classLoader!!.getResourceAsStream("cloud_ingestion_registry.json")
        val registry = JSONObject(stream!!.bufferedReader().use { it.readText() })
        val tables = registry.getJSONObject("tables")
        val shipped = tables.keys().asSequence()
            .map { tables.getJSONObject(it) }
            .filter { it.getString("classification") == "shipped" }
            .map { it.getString("wireStream") }
            .toSet()
        assertEquals(PushRegistryV1_2.streamNames, shipped)
    }

    @Test
    fun v1_1ExcludesV1_2OnlyBinaryStreams() {
        val stream = javaClass.classLoader!!.getResourceAsStream("cloud_ingestion_registry.json")
        val registry = JSONObject(stream!!.bufferedReader().use { it.readText() })
        val tables = registry.getJSONObject("tables")
        val shipped = tables.keys().asSequence()
            .map { tables.getJSONObject(it) }
            .filter { it.getString("classification") == "shipped" }
            .map { it.getString("wireStream") }
            .toSet()
        assertEquals(
            PushRegistryV1_1.streamNames,
            shipped - PushRegistryV1_2.additionalBinaryStreams,
        )
    }
}
