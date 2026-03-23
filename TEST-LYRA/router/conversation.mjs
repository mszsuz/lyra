// Conversation management — message history for router-managed adapters (openai, claude-api)
// CLI adapters (claude-cli, codex-cli) manage their own history internally

import * as log from './log.mjs';

const TAG = 'conversation';

/**
 * Add a user message to session history.
 */
export function addUserMessage(session, text) {
  if (!session.messages) session.messages = [];
  session.messages.push({ role: 'user', content: text });
}

/**
 * Add an assistant tool_use block to session history.
 */
export function addToolUse(session, { id, name, input }) {
  if (!session.messages) session.messages = [];
  session.messages.push({
    role: 'assistant',
    content: [{ type: 'tool_use', id, name, input }],
  });
}

/**
 * Add a tool result to session history. Truncates content > 4K chars.
 */
export function addToolResult(session, toolUseId, content, isError = false) {
  if (!session.messages) session.messages = [];
  let str = typeof content === 'string' ? content : JSON.stringify(content);
  if (str.length > 4000) {
    str = str.substring(0, 4000) + '\n... (обрезано, полный результат ' + str.length + ' символов)';
  }
  session.messages.push({
    role: 'tool_result',
    tool_use_id: toolUseId,
    content: str,
    is_error: isError,
  });
}

/**
 * Add an assistant text message to session history.
 */
export function addAssistantMessage(session, text) {
  if (!session.messages) session.messages = [];
  session.messages.push({ role: 'assistant', content: text });
}

/**
 * Get messages with emergency trimming to fit context budget.
 * Truncates old tool_result content to summaries when total exceeds maxChars.
 */
export function getMessages(session, maxChars = 80000) {
  if (!session.messages) return [];
  return trimMessages(session.messages, maxChars);
}

/**
 * Estimate total token count for the conversation (rough: 1 token ≈ 4 chars).
 */
export function estimateTokens(session) {
  if (!session.messages) return 0;
  const totalChars = session.messages.reduce(
    (sum, m) => sum + (typeof m.content === 'string' ? m.content.length : JSON.stringify(m.content).length),
    0
  );
  return Math.ceil(totalChars / 4);
}

/**
 * Check if conversation needs summarization.
 * Phase 3: always returns false (summarization is Phase 4-5).
 */
export function needsSummarization(session) {
  return false;
}

/**
 * Summarize conversation to reduce context size.
 * Phase 3: no-op stub (summarization is Phase 4-5).
 */
export async function summarize(session, adapter) {
  // Stub — will be implemented in Phase 4-5
}

// --- Internal ---

function trimMessages(messages, maxChars) {
  const totalChars = messages.reduce(
    (sum, m) => sum + (typeof m.content === 'string' ? m.content.length : JSON.stringify(m.content).length),
    0
  );
  if (totalChars <= maxChars) return [...messages];

  const result = [...messages];
  let trimCount = 0;
  // Truncate oldest tool_results first (keep last 3 intact)
  for (let i = 0; i < result.length - 6; i++) {
    if (result[i].role === 'tool_result' && typeof result[i].content === 'string' && result[i].content.length > 200) {
      result[i] = { ...result[i], content: result[i].content.substring(0, 200) + '\n... (сжато)' };
      trimCount++;
    }
  }
  if (trimCount > 0) log.info(TAG, `Trimmed ${trimCount} old tool_results (total was ${totalChars} chars)`);
  return result;
}
