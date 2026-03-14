// Claude stream-json → Universal protocol transformer
//
// Parses NDJSON lines from Claude CLI stdout and emits universal protocol events
// that are forwarded to Chat EPF via Centrifugo.

// Strip HTML tags from text — Claude sometimes generates <h2 id="...">, <div>, <details> etc.
// despite system prompt prohibition. Clean at protocol level as a safety net.
const HTML_TAG_RE = /<\/?[a-zA-Z][^>]*>/g;

// Convert markdown headings (## Heading) to bold (**Heading**).
// Markdown renderer generates <h2 id="slug"> which 1C HTML field can't handle —
// shows raw id attribute as text. Bold is safe and looks good.
const MD_HEADING_RE = /^(#{1,6})\s+(.+)$/gm;

export function sanitizeText(text) {
  if (!text || typeof text !== 'string') return text;
  return text
    .replace(MD_HEADING_RE, '**$2**')
    .replace(HTML_TAG_RE, '');
}

/**
 * Per-session parser state. Each Claude process gets its own instance
 * to avoid cross-session interference when multiple sessions stream concurrently.
 */
export function createParser() {
  let _inThinking = false;

  function reset() {
    _inThinking = false;
  }

  function transform(line) {
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

      if (event.type === 'content_block_start' && event.content_block?.type === 'thinking') {
        _inThinking = true;
        return { type: 'thinking_start' };
      }

      if (event.type === 'content_block_stop' && _inThinking) {
        _inThinking = false;
        return { type: 'thinking_end' };
      }

      if (event.type === 'content_block_delta') {
        const delta = event.delta;
        if (!delta) return null;
        if (delta.type === 'thinking_delta' && delta.thinking) {
          return { type: 'thinking_delta', text: delta.thinking };
        }
        if (delta.type === 'text_delta' && delta.text) {
          return { type: 'text_delta', text: delta.text };
        }
      }

      return null;
    }

    // result → assistant_end
    if (ev.type === 'result') {
      _inThinking = false;
      const text = ev.result || '';
      const event = { type: 'assistant_end', text };
      if (ev.total_cost_usd !== undefined) event.cost_usd = ev.total_cost_usd;
      if (ev.usage) event.usage = ev.usage;
      if (ev.model) event.model = ev.model;
      if (ev.session_id) event.claude_session_id = ev.session_id;
      return event;
    }

    return null;
  }

  return { reset, transform };
}
