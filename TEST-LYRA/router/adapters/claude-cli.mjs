// Claude CLI adapter — wraps Claude Code CLI (stdin/stdout, stream-json)
// For users with Claude subscription (no API billing)

import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { StringDecoder } from 'node:string_decoder';

export class ClaudeCliAdapter {
  #claudePath;
  #model;
  #proc = null;
  #sessionId = null;
  #sendChat = null;
  #abortFn = null;
  #eventQueue = [];
  #eventResolve = null;
  #done = false;
  #systemPromptFile = null;
  #mcpConfigFile = null;
  #cwd = null;
  #disallowedTools = [];

  async init(config) {
    this.#claudePath = config.claude_path || 'claude';
    this.#model = config.model || 'claude-sonnet-4-6';
    this.#systemPromptFile = config.system_prompt_file || null;
    this.#mcpConfigFile = config.mcp_config_file || null;
    this.#cwd = config.cwd || process.cwd();
    this.#disallowedTools = config.disallowed_tools || [];

    return {
      streaming: true,
      tool_calls: true,
      vision: false,  // CLI doesn't support vision through stdin
      thinking: true,
      max_context_tokens: 200000,
      max_output_tokens: 64000,
    };
  }

  async *chat(request) {
    // Extract last user message
    const lastMsg = request.messages[request.messages.length - 1];
    const text = typeof lastMsg.content === 'string'
      ? lastMsg.content
      : lastMsg.content.map(c => c.text || '').join('\n');

    // Spawn CLI if not running
    if (!this.#proc) {
      this.#spawn(request);
    }

    // Reset event queue
    this.#eventQueue = [];
    this.#done = false;

    // Send message to stdin
    const msg = JSON.stringify({
      type: 'user',
      message: { role: 'user', content: text },
    }) + '\n';
    this.#proc.stdin.write(msg);

    // Yield events as they come
    while (!this.#done) {
      const event = await this.#nextEvent();
      if (event === null) break;
      yield event;
    }
  }

  async abort(sessionId) {
    if (this.#proc) {
      // Send abort via stdin
      try {
        this.#proc.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content: '/abort' } }) + '\n');
      } catch {}
    }
    return { ok: true };
  }

  #spawn(request) {
    const args = [
      '-p',
      '--output-format', 'stream-json',
      '--input-format', 'stream-json',
      '--verbose',
      '--model', this.#model,
      '--dangerously-skip-permissions',
    ];

    if (this.#systemPromptFile) {
      args.push('--system-prompt-file', this.#systemPromptFile);
    }
    if (this.#mcpConfigFile) {
      args.push('--mcp-config', this.#mcpConfigFile);
    }
    if (this.#disallowedTools.length) {
      args.push('--disallowedTools', this.#disallowedTools.join(','));
    }

    // Clean env
    const env = { ...process.env };
    delete env.CLAUDECODE;
    delete env.CLAUDE_CODE_ENTRYPOINT;
    delete env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS;

    mkdirSync(this.#cwd, { recursive: true });

    this.#proc = spawn(this.#claudePath, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: this.#cwd,
      env,
    });

    // Parse stdout
    const decoder = new StringDecoder('utf8');
    let buffer = '';

    this.#proc.stdout.on('data', (chunk) => {
      buffer += decoder.write(chunk);
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const data = JSON.parse(line);
          const event = this.#mapEvent(data);
          if (event) this.#pushEvent(event);
        } catch {}
      }
    });

    this.#proc.on('exit', () => {
      this.#proc = null;
      this.#pushEvent(null); // Signal end
    });

    this.#proc.stderr.on('data', () => {}); // Suppress stderr
  }

  #mapEvent(data) {
    // Claude CLI stream-json → our universal events

    if (data.type === 'stream_event') {
      const ev = data.event;
      if (!ev) return null;

      // Text delta
      if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta') {
        return { type: 'text_delta', text: ev.delta.text };
      }

      // Thinking
      if (ev.type === 'content_block_start' && ev.content_block?.type === 'thinking') {
        return { type: 'thinking_start' };
      }
      if (ev.type === 'content_block_delta' && ev.delta?.type === 'thinking_delta') {
        return { type: 'thinking_delta', text: ev.delta.thinking };
      }
      if (ev.type === 'content_block_stop') {
        // Could be thinking_end — but we need context.
        // For now, skip — thinking_end inferred from next text block
        return null;
      }

      return null;
    }

    // Tool use
    if (data.type === 'assistant') {
      const content = data.message?.content;
      if (content) {
        for (const block of content) {
          if (block.type === 'tool_use') {
            return {
              type: 'tool_use',
              id: block.id,
              name: block.name,
              input: block.input,
            };
          }
        }
      }
      return null;
    }

    // Result (assistant_end)
    if (data.type === 'result') {
      return {
        type: 'assistant_end',
        text: data.result || '',
        usage: {
          input_tokens: data.usage?.input_tokens || 0,
          output_tokens: data.usage?.output_tokens || 0,
          cache_read_tokens: data.usage?.cache_read_input_tokens || 0,
          cache_write_tokens: data.usage?.cache_creation_input_tokens || 0,
        },
        cost_usd: data.total_cost_usd || data.cost_usd || null,
        model: data.message?.model || data.modelUsage ? Object.keys(data.modelUsage)[0] : this.#model,
        stop_reason: data.stop_reason || 'end_turn',
      };
    }

    return null;
  }

  #pushEvent(event) {
    if (event === null) this.#done = true;
    if (this.#eventResolve) {
      const resolve = this.#eventResolve;
      this.#eventResolve = null;
      resolve(event);
    } else {
      this.#eventQueue.push(event);
    }
  }

  #nextEvent() {
    if (this.#eventQueue.length > 0) {
      return Promise.resolve(this.#eventQueue.shift());
    }
    if (this.#done) return Promise.resolve(null);
    return new Promise(resolve => {
      this.#eventResolve = resolve;
    });
  }
}
