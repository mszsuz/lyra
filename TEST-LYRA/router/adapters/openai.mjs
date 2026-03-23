// OpenAI-compatible adapter — works with any provider that implements OpenAI API
// OpenRouter, Gemini, GPT, Ollama, cli-proxy-api, etc.

import * as log from '../log.mjs';
const TAG = 'openai';

export class OpenAiAdapter {
  #apiKey;
  #baseUrl;
  #model;

  async init(config) {
    this.#apiKey = config.api_key || '';
    this.#baseUrl = (config.base_url || 'https://api.openai.com/v1').replace(/\/+$/, '');
    this.#model = config.model || 'gpt-4o';

    return {
      streaming: true,
      tool_calls: true,
      vision: true,
      thinking: false,
      max_context_tokens: 128000,
      max_output_tokens: 16384,
      history_mode: 'router',
      tool_mode: 'router',
    };
  }

  async *chat(request) {
    const body = this.#buildRequestBody(request);
    const url = `${this.#baseUrl}/chat/completions`;

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${request.api_key || this.#apiKey}`,
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const errorText = await res.text();
      yield { type: 'error', message: `API error ${res.status}: ${errorText}`, code: 'api_error', retryable: res.status >= 500 };
      return;
    }

    if (body.stream) {
      yield* this.#parseSSE(res.body);
    } else {
      const data = await res.json();
      yield* this.#parseNonStream(data);
    }
  }

  async abort(sessionId) {
    return { ok: true };
  }

  async #fetchGenerationCost(generationId, apiKey) {
    try {
      const res = await fetch(`https://openrouter.ai/api/v1/generation?id=${generationId}`, {
        headers: { 'Authorization': `Bearer ${apiKey || this.#apiKey}` },
      });
      if (!res.ok) return null;
      const data = await res.json();
      const cost = data.data?.total_cost ?? data.data?.usage?.total_cost ?? null;
      if (cost != null) log.info(TAG, `generation cost: $${cost} (id=${generationId})`);
      else log.info(TAG, `generation cost: null, response: ${JSON.stringify(data).substring(0, 200)}`);
      return cost;
    } catch { return null; }
  }

  #buildRequestBody(request) {
    const body = {
      model: request.options?.model || this.#model,
      stream: true,
      stream_options: { include_usage: true },
      max_tokens: request.options?.max_tokens || 16384,
    };

    // Messages
    body.messages = [];

    // System prompt as first message
    if (request.system_prompt) {
      body.messages.push({ role: 'system', content: request.system_prompt });
    }

    // Conversation messages
    for (const msg of request.messages) {
      body.messages.push(this.#convertMessage(msg));
    }

    // Tools
    if (request.tools?.length) {
      body.tools = request.tools.map(t => ({
        type: 'function',
        function: {
          name: t.name,
          description: t.description,
          parameters: t.input_schema || {},
        },
      }));
    }

    return body;
  }

  #convertMessage(msg) {
    if (msg.role === 'tool_result') {
      return {
        role: 'tool',
        tool_call_id: msg.tool_use_id,
        content: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content),
      };
    }

    const result = { role: msg.role };

    // Multimodal
    if (msg.attachments?.length) {
      result.content = [];
      for (const att of msg.attachments) {
        if (att.kind === 'image') {
          result.content.push({
            type: 'image_url',
            image_url: { url: `data:${att.media_type};base64,${att.data}` },
          });
        }
      }
      if (msg.content) {
        result.content.push({
          type: 'text',
          text: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content),
        });
      }
    } else {
      result.content = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
    }

    // Assistant with tool calls
    if (msg.role === 'assistant' && Array.isArray(msg.content)) {
      const toolUses = msg.content.filter(c => c.type === 'tool_use');
      if (toolUses.length) {
        result.content = msg.content.filter(c => c.type === 'text').map(c => c.text).join('') || null;
        result.tool_calls = toolUses.map(t => ({
          id: t.id,
          type: 'function',
          function: { name: t.name, arguments: JSON.stringify(t.input) },
        }));
      }
    }

    return result;
  }

  async *#parseSSE(body) {
    const decoder = new TextDecoder();
    let buffer = '';
    let fullText = '';
    let toolCalls = new Map(); // id → {name, arguments}
    let model = this.#model;
    let usage = null;
    let cost = null;
    let generationId = null;

    for await (const chunk of body) {
      buffer += decoder.decode(chunk, { stream: true });

      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const data = line.slice(6).trim();
        if (data === '[DONE]') continue;

        let event;
        try {
          event = JSON.parse(data);
        } catch {
          continue;
        }

        model = event.model || model;
        if (event.id) { generationId = event.id; this._lastGenerationId = event.id; }
        if (event.usage) {
          usage = event.usage;
          if (event.usage.cost !== undefined) cost = event.usage.cost;
        }

        const choice = event.choices?.[0];
        if (!choice) continue;

        const delta = choice.delta;
        if (delta?.content) {
          fullText += delta.content;
          yield { type: 'text_delta', text: delta.content };
        }

        // Reasoning/thinking (some models)
        if (delta?.reasoning_content) {
          yield { type: 'thinking_delta', text: delta.reasoning_content };
        }

        // Tool calls
        if (delta?.tool_calls) {
          for (const tc of delta.tool_calls) {
            const idx = tc.index ?? 0;
            if (!toolCalls.has(idx)) {
              toolCalls.set(idx, { id: tc.id || '', name: '', arguments: '' });
            }
            const existing = toolCalls.get(idx);
            if (tc.id) existing.id = tc.id;
            if (tc.function?.name) existing.name = tc.function.name;
            if (tc.function?.arguments) existing.arguments += tc.function.arguments;
          }
        }

        // Finish
        if (choice.finish_reason) {
          // Emit accumulated tool calls
          if (choice.finish_reason === 'tool_calls' || toolCalls.size > 0) {
            for (const [, tc] of toolCalls) {
              let input = {};
              try { input = JSON.parse(tc.arguments); } catch {}
              yield { type: 'tool_use', id: tc.id, name: tc.name, input };
            }
            toolCalls.clear();
          }

          // Mark finished — don't yield yet, wait for usage chunk
          if (choice.finish_reason === 'stop' || choice.finish_reason === 'end_turn') {
            this._finished = choice.finish_reason;
          }
        }
      }
    }

    // Emit assistant_end after stream fully consumed (all chunks including usage)
    if (this._finished) {
      log.info(TAG, `assistant_end: cost=${cost}, model=${model}`);
      yield {
        type: 'assistant_end',
        text: fullText,
        usage: {
          input_tokens: usage?.prompt_tokens || 0,
          output_tokens: usage?.completion_tokens || 0,
          cache_read_tokens: usage?.prompt_tokens_details?.cached_tokens || 0,
          cache_write_tokens: usage?.prompt_tokens_details?.cache_write_tokens || 0,
        },
        cost_usd: cost,
        model,
        stop_reason: this._finished,
      };
      this._finished = null;
    }
  }

  async *#parseNonStream(data) {
    const choice = data.choices?.[0];
    if (!choice) {
      yield { type: 'error', message: 'No choices in response', code: 'empty_response', retryable: false };
      return;
    }

    const text = choice.message?.content || '';
    yield { type: 'text_delta', text };

    // Tool calls
    if (choice.message?.tool_calls) {
      for (const tc of choice.message.tool_calls) {
        let input = {};
        try { input = JSON.parse(tc.function?.arguments || '{}'); } catch {}
        yield { type: 'tool_use', id: tc.id, name: tc.function?.name, input };
      }
    }

    yield {
      type: 'assistant_end',
      text,
      usage: {
        input_tokens: data.usage?.prompt_tokens || 0,
        output_tokens: data.usage?.completion_tokens || 0,
        cache_read_tokens: 0,
        cache_write_tokens: 0,
      },
      cost_usd: null,
      model: data.model || this.#model,
      stop_reason: choice.finish_reason || 'stop',
    };
  }
}
