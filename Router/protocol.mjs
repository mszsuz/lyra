// Claude stream-json → Universal protocol transformer
//
// Parses NDJSON lines from Claude CLI stdout and emits universal protocol events
// that are forwarded to Chat EPF via Centrifugo.

let _inThinking = false;

export function resetState() {
  _inThinking = false;
}

export function transformClaudeEvent(line) {
  if (!line.trim()) return null;

  let ev;
  try {
    ev = JSON.parse(line);
  } catch {
    return null;
  }

  // stream_event → content_block_delta / content_block_start / content_block_stop
  if (ev.type === 'stream_event') {
    const event = ev.event;
    if (!event) return null;

    // content_block_start (thinking)
    if (event.type === 'content_block_start' && event.content_block?.type === 'thinking') {
      _inThinking = true;
      return { type: 'thinking_start' };
    }

    // content_block_stop (after thinking)
    if (event.type === 'content_block_stop' && _inThinking) {
      _inThinking = false;
      return { type: 'thinking_end' };
    }

    // content_block_delta
    if (event.type === 'content_block_delta') {
      const delta = event.delta;
      if (!delta) return null;

      // thinking_delta
      if (delta.type === 'thinking_delta' && delta.thinking) {
        return { type: 'thinking_delta', text: delta.thinking };
      }

      // text_delta
      if (delta.type === 'text_delta' && delta.text) {
        return { type: 'text_delta', text: delta.text };
      }
    }

    return null; // other stream events ignored
  }

  // result → assistant_end
  if (ev.type === 'result') {
    _inThinking = false;
    // Extract full text from result
    const text = ev.result || '';
    return { type: 'assistant_end', text };
  }

  // assistant message (full) — can contain tool_use
  if (ev.type === 'assistant') {
    const content = ev.message?.content;
    if (Array.isArray(content)) {
      for (const block of content) {
        if (block.type === 'tool_use') {
          return {
            type: 'tool_call',
            tool_use_id: block.id,
            tool: block.name,
            params: block.input,
          };
        }
      }
    }
    return null; // text already streamed via text_delta
  }

  return null;
}
