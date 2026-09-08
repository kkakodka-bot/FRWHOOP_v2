
// coach/streaming.js — streaming completion for SSE. DeepInfra emits tool-call fragments by
// INDEX (not id); this assembler recombines them correctly and never emits duplicate output
// across retries. Returns the response shape the loop expects plus _ttftMs/_genMs/_sseChunks.
import { OpenAI } from 'openai';

export function createStreamingClient({ apiKey, baseURL }) {
  const llm = new OpenAI({ apiKey, baseURL });
  return async function streamComplete(body, { onDelta, signal } = {}) {
    const t0 = Date.now();
    let ttft = null;
    let content = '';
    const toolCalls = [];
    let usage = null;
    let stream;
    try {
      stream = await llm.chat.completions.create({ ...body, model: body.model || process.env.MODEL || 'deepseek-ai/DeepSeek-V4-Flash-0731', stream: true }, { signal });
    } catch (e) {
      if (e.name === 'AbortError') throw e;
      // provider rejects some resumed tool-round streams; fall back to non-stream
      const res = await llm.chat.completions.create({ ...body, model: body.model || process.env.MODEL || 'deepseek-ai/DeepSeek-V4-Flash-0731' }, { signal });
      const m = res.choices?.[0]?.message || {};
      return { choices: [{ message: m }], usage: res.usage, _ttftMs: null, _genMs: null, _sseChunks: [] };
    }
    try {
      let ti = 0;
      for await (const chunk of stream) {
        const delta = chunk.choices?.[0]?.delta || {};
        if (ttft == null && (delta.content || (delta.tool_calls || []).length)) ttft = Date.now() - t0;
        if (delta.content) {
          content += delta.content;
          if (onDelta) onDelta(delta.content);
        }
        for (const tc of delta.tool_calls || []) {
          const idx = tc.index != null ? tc.index : ti++;
          let target = toolCalls[idx];
          if (!target) { target = { id: '', type: 'function', function: { name: '', arguments: '' } }; toolCalls[idx] = target; }
          if (tc.id) target.id = tc.id;
          if (tc.function?.name) target.function.name += tc.function.name;
          if (tc.function?.arguments) target.function.arguments += tc.function.arguments;
        }
        if (chunk.usage) usage = chunk.usage;
      }
    } catch (e) {
      if (e.name === 'AbortError') throw e;
      try {
        const res = await llm.chat.completions.create({ ...body, model: body.model || process.env.MODEL || 'deepseek-ai/DeepSeek-V4-Flash-0731' }, { signal });
        const m = res.choices?.[0]?.message || {};
        return { choices: [{ message: m }], usage: res.usage, _ttftMs: null, _genMs: null, _sseChunks: [] };
      } catch (e2) {
        if (e2.name === 'AbortError') throw e2;
        return null;
      }
    }
    const total = Date.now() - t0;
    const calls = toolCalls.filter((tc) => tc.function.name && tc.function.name.trim())
      .map((tc) => ({ id: tc.id || `tool-${Math.random().toString(36).slice(2, 8)}`, type: 'function', function: { name: tc.function.name, arguments: tc.function.arguments || '{}' } }));
    return {
      choices: [{
        message: {
          role: 'assistant',
          content: calls.length ? (content || '') : (content || null),
          tool_calls: calls.length ? calls : undefined,
        },
      }],
      usage: usage || { prompt_tokens: 0, completion_tokens: Math.ceil(content.length / 4) },
      _ttftMs: ttft && ttft < total ? ttft : total,
      _genMs: ttft != null ? Math.max(0, total - ttft) : total,
      _sseChunks: [],
    };
  };
}
