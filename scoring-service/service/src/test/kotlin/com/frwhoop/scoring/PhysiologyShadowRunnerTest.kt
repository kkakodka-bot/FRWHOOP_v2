package com.frwhoop.scoring

import com.frwhoop.scoring.signals.PhysiologyShadowRunner
import com.noop.analytics.PhysiologyQuality
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.nio.file.Path
import java.util.UUID
import kotlin.math.PI
import kotlin.math.sin

class PhysiologyShadowRunnerTest {
    private val user = UUID.fromString("11111111-1111-1111-1111-111111111111")
    private val device = UUID.fromString("22222222-2222-2222-2222-222222222222")
    private fun request(): PhysiologyShadowRunner.Request {
        var time = 0.0
        val rows = (0 until 400).map { i ->
            val duration = 0.8 + 0.04 * sin(2 * PI * 0.2 * time)
            val start = time; time += duration
            PhysiologyQuality.IntervalObservation("i:$i", user.toString(), device.toString(), source = "synthetic_not_reference",
                eventTime = start, originalRRMs = duration * 1000, startBeatId = "b:$i", endBeatId = "b:${i+1}",
                continuityGroup = "fixture", verifiedSpan = PhysiologyQuality.Span(start, time), timestampPrecisionSeconds = 0.001,
                decoderVersion = "fixture", clockVersion = "fixture")
        }
        return PhysiologyShadowRunner.Request(user, device, "revision-1", 0, 300, rows,
            listOf(PhysiologyShadowRunner.Context(0.0, 300.0, "qualified_sleep")))
    }

    @Test fun `missing raw does not disable independently verified interval respiration`() {
        val result = PhysiologyShadowRunner().evaluate(request())
        assertEquals(4, result.windows.size)
        assertTrue(result.windows.any { it.breathsPerMinute != null })
        assertEquals(12.0, result.summaries.single().summary.median!!, 0.5)
        assertTrue(result.rawReasons.contains("raw_object_reader_not_configured"))
        assertEquals(8, result.modelResults.size)
        assertFalse(result.json().getBoolean("canonical_outputs_allowed"))
        assertTrue(result.json().has("respiration_summaries"))
        val encoded=result.json().getJSONArray("respiration_summaries").getJSONObject(0)
        assertEquals(result.summaries.single().summary.distributionBpm,encoded.getJSONArray("distribution_bpm").toList())
        assertEquals("sorted_accepted_window_estimates",encoded.getString("distribution_kind"))
    }

    @Test fun `coarse timing and wrong owner do not produce measurements`() {
        val request = request()
        val coarse = PhysiologyShadowRunner().evaluate(request.copy(intervals = request.intervals.map { it.copy(verifiedSpan = null) }))
        assertTrue(coarse.windows.all { it.breathsPerMinute == null && it.reason == "timing_unverified" })
        assertNull(coarse.summaries.single().summary.median)
        assertEquals(0,coarse.json().getJSONArray("respiration_summaries").getJSONObject(0).getJSONArray("distribution_bpm").length())
        val wrong = PhysiologyShadowRunner().evaluate(request.copy(intervals = request.intervals.map { it.copy(userId = "other") }))
        assertTrue(wrong.windows.all { it.reason == "interval_owner_mismatch" })
    }

    @Test fun `configured job path executes but cannot switch owner or revision`() {
        var calls = 0
        val model = PhysiologyShadowRunner.Model("neurokit2", JSONObject(), Path.of("."))
        val assembler = PhysiologyShadowRunner.JobAssembler { _, request, _ -> PhysiologyShadowRunner.PreparedJob(JSONObject()
            .put("user_id", request.userId).put("device_id", request.deviceId).put("input_revision", request.inputRevision)) }
        val executor = PhysiologyShadowRunner.Executor { selected, job -> calls++; JSONObject().put("model_id", selected.id)
            .put("canonical_outputs_allowed", false).put("publication_mode", "shadow")
            .put("user_id",job.payload.get("user_id")).put("device_id",job.payload.get("device_id"))
            .put("input_revision",job.payload.get("input_revision")) }
        val result = PhysiologyShadowRunner(models = listOf(model), executor = executor, assembler = assembler).evaluate(request())
        assertEquals(1, calls); assertEquals(8, result.modelResults.size)
        val invalid = PhysiologyShadowRunner.JobAssembler { _, _, _ -> PhysiologyShadowRunner.PreparedJob(JSONObject().put("user_id", "other")) }
        val failed = PhysiologyShadowRunner(models = listOf(model), executor = executor, assembler = invalid).evaluate(request())
        assertEquals(1, calls)
        assertEquals("model_input_owner_or_revision_mismatch", failed.modelResults.first { it.getString("model_id") == "neurokit2" }.getString("reason"))
    }

    @Test fun `total deadline preserves deterministic respiration and interrupts model`() {
        val model = PhysiologyShadowRunner.Model("neurokit2", JSONObject(), Path.of("."))
        val assembler = PhysiologyShadowRunner.JobAssembler { _, request, _ -> PhysiologyShadowRunner.PreparedJob(JSONObject()
            .put("user_id", request.userId).put("device_id", request.deviceId).put("input_revision", request.inputRevision)) }
        val slow = PhysiologyShadowRunner.Executor { _, _ -> Thread.sleep(5000); JSONObject() }
        val runner = PhysiologyShadowRunner(models=listOf(model),executor=slow,assembler=assembler,totalTimeoutSeconds=1)
        val result = runner.evaluate(request())
        assertTrue(result.rawReasons.contains("shadow_request_timeout"))
        assertEquals(12.0,result.summaries.single().summary.median!!,0.5)
        assertTrue(result.windows.any { it.breathsPerMinute != null })
    }
    @Test fun `invalid oversized shadow request abstains without failing caller or poisoning slot`() {
        val input=request()
        val runner=PhysiologyShadowRunner()
        val failed=runner.evaluate(input.copy(contexts=List(513) { i ->
            PhysiologyShadowRunner.Context(i*2.0,i*2.0+1,"qualified_sleep") }))
        assertTrue(failed.rawReasons.contains("shadow_input_contract_invalid"))
        assertTrue(failed.modelResults.all { it.getString("reason")=="shadow_input_contract_invalid" })
        assertTrue(runner.evaluate(input).windows.any { it.breathsPerMinute!=null })
    }
}
