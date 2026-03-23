// Claude API adapter — direct HTTP to Anthropic API (zero npm dependencies)

const API_URL = 'https://api.anthropic.com/v1/messages';
const API_VERSION = '2023-06-01';

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

    const res = await fetch(API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': request.api_key || this.#apiKey,
        'anthropic-version': API_VERSION,
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const errorText = await res.text();
      yield { type: 'error', message: `API error ${res.status}: ${errorText}`, code: 'api_error', retryable: res.status >= 500 };
      return;
    }

    yield* this.#parseSSE(res.body, request);
  }

  async abort(sessionId) {
    // API doesn't support abort — client just stops reading the stream
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

  async *#parseSSE(body, request) {
    const decoder = new TextDecoder();
    let buffer = '';
    let fullText = '';
    let inputTokens = 0;
    let outputTokens = 0;
    let cacheRead = 0;
    let cacheWrite = 0;
    let model = this.#model;
    let stopReason = '';

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
            // Tool use starts — accumulate input
            event._toolUse = { id: block.id, name: block.name, input: '' };
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
            // Accumulate tool input JSON
            if (this._currentToolUse) {
              this._currentToolUse.input += delta.partial_json;
            }
          }
        }

        if (eventType === 'content_block_start' && event.content_block?.type === 'tool_use') {
          this._currentToolUse = { id: event.content_block.id, name: event.content_block.name, input: '' };
        }

        if (eventType === 'content_block_stop') {
          if (this._currentToolUse) {
            let input = {};
            try { input = JSON.parse(this._currentToolUse.input); } catch {}
            yield {
              type: 'tool_use',
              id: this._currentToolUse.id,
              name: this._currentToolUse.name,
              input,
            };
            this._currentToolUse = null;
          }
          // Check if it was thinking block
          // (thinking_end after thinking content_block_stop)
        }

        if (eventType === 'message_delta') {
          stopReason = event.delta?.stop_reason || '';
          const usage = event.usage;
          if (usage) {
            outputTokens += usage.output_tokens || 0;
          }
        }

        if (eventType === 'message_stop') {
          // Calculate cost
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
