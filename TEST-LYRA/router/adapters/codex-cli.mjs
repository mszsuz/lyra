// Codex CLI adapter — wraps OpenAI Codex CLI for GPT models via subscription
// For users with ChatGPT Plus/Pro subscription (no API billing)

import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { StringDecoder } from 'node:string_decoder';

export class CodexCliAdapter {
  #codexPath;
  #model;
  #threadId = null; // reuse session for subsequent messages

  async init(config) {
    this.#codexPath = config.codex_path || 'codex';
    this.#model = config.model || 'gpt-5.4';

    return {
      streaming: true,
      tool_calls: true,  // MCP tools available (Vega, mcp-1c-docs, etc.)
      vision: false,
      thinking: false,
      max_context_tokens: 200000,
      max_output_tokens: 32000,
      history_mode: 'adapter',
      tool_mode: 'adapter',
    };
  }

  async *chat(request) {
    // Build prompt: system + last user message
    const lastMsg = request.messages[request.messages.length - 1];
    const text = typeof lastMsg.content === 'string'
      ? lastMsg.content
      : lastMsg.content.map(c => c.text || '').join('\n');

    let prompt = text;
    if (request.system_prompt) {
      prompt = `${request.system_prompt}\n\n---\n\n${text}`;
    }

    const args = ['exec'];
    if (this.#threadId) {
      args.push('resume', this.#threadId);
    }
    args.push('--json', '-m', this.#model, '--skip-git-repo-check', '-');

    const proc = spawn(this.#codexPath, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env },
      shell: true,
    });

    // Send prompt via stdin
    proc.stdin.write(prompt);
    proc.stdin.end();

    // Parse JSONL stdout — yield events as they come
    const decoder = new StringDecoder('utf8');
    let buffer = '';
    this._lastText = '';

    const eventQueue = [];
    let eventResolve = null;
    let finished = false;

    proc.stdout.on('data', (chunk) => {
      buffer += decoder.write(chunk);
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const data = JSON.parse(line);
          const event = this.#mapEvent(data);
          if (event) {
            if (eventResolve) {
              const r = eventResolve;
              eventResolve = null;
              r(event);
            } else {
              eventQueue.push(event);
            }
          }
          // Save thread_id for resume
          if (data.type === 'thread.started' && data.thread_id) {
            this.#threadId = data.thread_id;
          }
          // Kill process after turn.completed (codex doesn't exit on its own)
          if (data.type === 'turn.completed') {
            finished = true;
            try { proc.kill(); } catch {}
          }
        } catch {}
      }
    });

    proc.stderr.on('data', () => {});
    proc.on('close', () => {
      finished = true;
      if (eventResolve) {
        const r = eventResolve;
        eventResolve = null;
        r(null);
      }
    });

    // Yield events as async generator
    while (!finished || eventQueue.length > 0) {
      if (eventQueue.length > 0) {
        const event = eventQueue.shift();
        yield event;
        if (event.type === 'assistant_end') return;
      } else {
        const event = await new Promise(r => { eventResolve = r; });
        if (event === null) return;
        yield event;
        if (event.type === 'assistant_end') return;
      }
    }
  }

  async abort(sessionId) {
    return { ok: true };
  }

  #mapEvent(data) {
    // item.started — MCP tool call in progress → show status in Chat
    if (data.type === 'item.started' && data.item?.type === 'mcp_tool_call') {
      // Map server names to match tool-labels.json keys
      const serverMap = {
        'lyra-1c': '1c',
        'mcp-1c-docs': 'mcp-1c-docs',
        'vega-accounting': 'vega',
        'vega-trade': 'vega',
        'vega-hrm': 'vega',
        'vega-enterprise20': 'vega',
        'vega-retail23': 'vega',
        'vega-demo': 'vega',
      };
      const server = data.item.server || '';
      const mappedServer = serverMap[server] || server.replace(/-/g, '_');
      return {
        type: 'tool_status',
        tool: `mcp__${mappedServer}__${data.item.tool}`,
        description: data.item.tool,
      };
    }

    // item.completed — model response
    if (data.type === 'item.completed' && data.item?.type === 'agent_message') {
      const text = data.item.text || '';
      this._lastText = text; // save for assistant_end
      return { type: 'text_delta', text };
    }

    // turn.completed — with usage
    if (data.type === 'turn.completed') {
      const u = data.usage || {};
      const inputTokens = u.input_tokens || 0;
      const outputTokens = u.output_tokens || 0;
      const cachedTokens = u.cached_input_tokens || 0;
      const costUsd = this.#calculateCost(inputTokens, outputTokens, cachedTokens);
      return {
        type: 'assistant_end',
        text: this._lastText || '',
        usage: {
          input_tokens: inputTokens,
          output_tokens: outputTokens,
          cache_read_tokens: cachedTokens,
          cache_write_tokens: 0,
        },
        cost_usd: costUsd,
        model: this.#model,
        stop_reason: 'stop',
      };
    }

    return null;
  }

  #calculateCost(inputTokens, outputTokens, cachedTokens) {
    // OpenAI pricing per million tokens (as of 2026)
    const pricing = {
      'gpt-5.4':      { input: 2.50, output: 15.00, cached: 1.25 },
      'gpt-5.4-mini': { input: 0.40, output: 1.60, cached: 0.20 },
      'gpt-5.4-pro':  { input: 10.00, output: 40.00, cached: 5.00 },
      'gpt-5.3':      { input: 2.00, output: 8.00, cached: 1.00 },
      'o4-mini':      { input: 1.10, output: 4.40, cached: 0.275 },
    };
    const p = pricing[this.#model] || pricing['gpt-5.4'];
    const uncachedInput = inputTokens - cachedTokens;
    return (
      (uncachedInput * p.input +
       cachedTokens * p.cached +
       outputTokens * p.output) / 1_000_000
    );
  }
}
