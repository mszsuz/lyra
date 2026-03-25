// Claude API adapter — direct HTTP to Anthropic API (zero npm dependencies)

import * as log from '../log.mjs';
import { readSSEWithTimeout, AdapterTimeoutError } from './sse-reader.mjs';

const API_URL = 'https://api.anthropic.com/v1/messages';
const API_VERSION = '2023-06-01';
const TAG = 'claude-api';

export class ClaudeApiAdapter {
  #apiKey;
  #model;

  async init(config) {
    this.#apiKey = config.api_key;
    this.#model = config.model || 'claude-sonnet-4-6';

    return {
      streaming: true,
      tool_calls: true,
      vision: true,
      thinking: true,
      max_context_tokens: 200000,
      max_output_tokens: 64000,
      history_mode: 'router',
      tool_mode: 'router',
    };
  }

  async *chat(request) {
    const body = this.#buildRequestBody(request);
    const chunkTimeout = request.options?.chunkTimeout || 60_000;
    const connectTimeout = request.options?.connectTimeout || 15_000;

    const controller = new AbortController();
    this._currentAbort = controller;
    this._abortReason = null;

    const connectTimer = setTimeout(() => {
      this._abortReason = 'timeout';
      controller.abort();
    }, connectTimeout);

    let res;
    try {
      res = await fetch(API_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': request.api_key || this.#apiKey,
          'anthropic-version': API_VERSION,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(connectTimer);
      this._currentAbort = null;
      if (err.name === 'AbortError') {
        if (this._abortReason === 'user_abort') {
          yield { type: 'error', code: 'user_abort', message: 'Aborted by user', retryable: false };
        } else {
          yield { type: 'error', code: 'adapter_timeout', stage: 'connect',
                  message: `Connect timeout (${connectTimeout}ms)`, retryable: true };
        }
        return;
      }
      yield { type: 'error', code: 'adapter_timeout', stage: 'connect',
              message: err.message, retryable: true };
      return;
    }
    clearTimeout(connectTimer);

    if (!res.ok) {
      this._currentAbort = null;
      const errorText = await res.text();
      yield { type: 'error', message: `API error ${res.status}: ${errorText}`, code: 'api_error', retryable: res.status >= 500 };
      return;
    }

    try {
      yield* this.#parseSSE(res.body, request, chunkTimeout, controller.signal);
    } catch (err) {
      if (err instanceof AdapterTimeoutError) {
        yield { type: 'error', code: 'adapter_timeout', stage: 'chunk',
                message: err.message, retryable: true };
        return;
      }
      if (err.name === 'AbortError') {
        if (this._abortReason === 'user_abort') {
          yield { type: 'error', code: 'user_abort', message: 'Aborted by user', retryable: false };
        } else {
          yield { type: 'error', code: 'adapter_timeout', stage: 'chunk',
                  message: 'Stream aborted', retryable: true };
        }
        return;
      }
      throw err;
    } finally {
      this._currentAbort = null;
    }
  }

  async abort(sessionId) {
    if (this._currentAbort) {
      this._abortReason = 'user_abort';
      this._currentAbort.abort();
      this._currentAbort = null;
    }
    return { ok: true };
  }

  #buildRequestBody(request) {
    const body = {
      model: request.options?.model || this.#model,
      stream: true,
      max_tokens: request.options?.max_tokens || 16384,
    };

    // System prompt
    if (request.system_prompt) {
      body.system = request.system_prompt;
    }

    // Messages — convert to Anthropic format
    body.messages = request.messages.map(msg => this.#convertMessage(msg));

    // Tools
    if (request.tools?.length) {
      body.tools = request.tools.map(t => ({
        name: t.name,
        description: t.description,
        input_schema: t.input_schema,
      }));
    }

    // Extended thinking
    if (request.options?.thinking) {
      body.thinking = {
        type: 'enabled',
        budget_tokens: request.options.thinking_budget || 10000,
      };
    }

    return body;
  }

  #convertMessage(msg) {
    const result = { role: msg.role === 'tool_result' ? 'user' : msg.role };

    if (msg.role === 'tool_result') {
      result.content = [{
        type: 'tool_result',
        tool_use_id: msg.tool_use_id,
        content: msg.content,
        is_error: msg.is_error || false,
      }];
      return result;
    }

    // Assistant with tool_use content blocks — pass through as-is for Anthropic API
    if (msg.role === 'assistant' && Array.isArray(msg.content)) {
      result.content = msg.content;
      return result;
    }

    // Multimodal content
    if (msg.attachments?.length) {
      result.content = [];
      for (const att of msg.attachments) {
        if (att.kind === 'image') {
          result.content.push({
            type: 'image',
            source: { type: 'base64', media_type: att.media_type, data: att.data },
          });
        }
      }
      if (msg.content) {
        result.content.push({ type: 'text', text: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content) });
      }
    } else {
      result.content = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
    }

    return result;
  }

  async *#parseSSE(body, request, chunkTimeout, signal) {
    let buffer = '';
    let fullText = '';
    let inputTokens = 0;
    let outputTokens = 0;
    let cacheRead = 0;
    let cacheWrite = 0;
    let model = this.#model;
    let stopReason = '';
    let currentToolUse = null;

    for await (const text of readSSEWithTimeout(body, chunkTimeout, signal)) {
      buffer += text;

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

        const eventType = event.type;

        if (eventType === 'message_start') {
          model = event.message?.model || model;
          const usage = event.message?.usage;
          if (usage) {
            inputTokens += usage.input_tokens || 0;
            cacheRead += usage.cache_read_input_tokens || 0;
            cacheWrite += usage.cache_creation_input_tokens || 0;
          }
        }

        if (eventType === 'content_block_start') {
          const block = event.content_block;
          if (block?.type === 'thinking') {
            yield { type: 'thinking_start' };
          }
          if (block?.type === 'tool_use') {
            currentToolUse = { id: block.id, name: block.name, input: '' };
          }
        }

        if (eventType === 'content_block_delta') {
          const delta = event.delta;
          if (delta?.type === 'text_delta') {
            fullText += delta.text;
            yield { type: 'text_delta', text: delta.text };
          }
          if (delta?.type === 'thinking_delta') {
            yield { type: 'thinking_delta', text: delta.thinking };
          }
          if (delta?.type === 'input_json_delta') {
            if (currentToolUse) {
              currentToolUse.input += delta.partial_json;
            }
          }
        }

        if (eventType === 'content_block_stop') {
          if (currentToolUse) {
            let input = {};
            try { input = JSON.parse(currentToolUse.input); } catch {}
            yield {
              type: 'tool_use',
              id: currentToolUse.id,
              name: currentToolUse.name,
              input,
            };
            currentToolUse = null;
          }
        }

        if (eventType === 'message_delta') {
          stopReason = event.delta?.stop_reason || '';
          const usage = event.usage;
          if (usage) {
            outputTokens += usage.output_tokens || 0;
          }
        }

        if (eventType === 'message_stop') {
          const costUsd = this.#calculateCost(model, inputTokens, outputTokens, cacheRead, cacheWrite);

          yield {
            type: 'assistant_end',
            text: fullText,
            usage: {
              input_tokens: inputTokens,
              output_tokens: outputTokens,
              cache_read_tokens: cacheRead,
              cache_write_tokens: cacheWrite,
            },
            cost_usd: costUsd,
            model,
            stop_reason: stopReason,
          };
        }
      }
    }
  }

  #calculateCost(model, inputTokens, outputTokens, cacheRead, cacheWrite) {
    // Pricing per million tokens (as of 2026)
    const pricing = {
      'claude-sonnet-4-6':  { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
      'claude-opus-4-6':    { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 },
      'claude-haiku-4-5':   { input: 0.8, output: 4, cacheRead: 0.08, cacheWrite: 1 },
    };

    const p = pricing[model] || pricing['claude-sonnet-4-6'];
    return (
      (inputTokens * p.input +
       outputTokens * p.output +
       cacheRead * p.cacheRead +
       cacheWrite * p.cacheWrite) / 1_000_000
    );
  }
}
