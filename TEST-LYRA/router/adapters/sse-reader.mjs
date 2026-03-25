// SSE stream reader with chunk-timeout watchdog.
// Used by openai.mjs and claude-api.mjs to detect hung API connections.

export class AdapterTimeoutError extends Error {
  constructor(stage, timeoutMs) {
    super(`No data for ${timeoutMs}ms (stage: ${stage})`);
    this.name = 'AdapterTimeoutError';
    this.stage = stage;
    this.timeoutMs = timeoutMs;
  }
}

/**
 * Read SSE stream with a watchdog timer between chunks.
 * Yields decoded string chunks. Throws AdapterTimeoutError on silence.
 *
 * The watchdog starts IMMEDIATELY — so the very first chunk must arrive
 * within chunkTimeout after the HTTP 200 response, closing the gap between
 * connectTimeout (covers fetch) and chunkTimeout (covers streaming).
 *
 * @param {ReadableStream} body — res.body from fetch
 * @param {number} chunkTimeout — ms, max silence between chunks
 * @param {AbortSignal} [signal] — for external abort (user interrupt / retry cleanup)
 */
export async function* readSSEWithTimeout(body, chunkTimeout, signal) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let firstChunk = true;

  try {
    while (true) {
      if (signal?.aborted) return;

      let timer;
      const stage = firstChunk ? 'first_chunk' : 'chunk';
      const timeoutPromise = new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new AdapterTimeoutError(stage, chunkTimeout)),
          chunkTimeout,
        );
      });

      try {
        const result = await Promise.race([reader.read(), timeoutPromise]);
        clearTimeout(timer);

        if (result.done) break;
        firstChunk = false;
        yield decoder.decode(result.value, { stream: true });
      } catch (err) {
        clearTimeout(timer);
        if (err instanceof AdapterTimeoutError) {
          reader.cancel().catch(() => {});
          throw err;
        }
        throw err;
      }
    }
  } finally {
    reader.releaseLock();
  }
}
