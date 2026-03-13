// Claude stream-json → Universal protocol transformer
//
// Parses NDJSON lines from Claude CLI stdout and emits universal protocol events
// that are forwarded to Chat EPF via Centrifugo.

let _inThinking = false;

export function resetState() {
  _inThinking = false;
}

// Strip HTML tags from text — Claude sometimes generates <h2 id="...">, <div>, <details> etc.
// despite system prompt prohibition. Clean at protocol level as a safety net.
const HTML_TAG_RE = /<\/?[a-zA-Z][^>]*>/g;

export function stripHtmlTags(text) {
  if (!text || typeof text !== 'string') return text;
  return text.replace(HTML_TAG_RE, '');
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

  // assistant message — informational only (tool_use handled by MCP internally)
  // Don't emit tool_call here — real tool_calls go through tools-mcp.mjs → tools.mjs

  return null;
}
