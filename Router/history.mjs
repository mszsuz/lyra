// Session log — unified JSONL log of all events in a session
// Sources: client (in/out), Claude CLI (claude), stdin to Claude (chat_to_claude)
// Attachments (attach array) are saved as files, replaced with relative paths

import { mkdirSync, appendFileSync, writeFileSync, renameSync } from 'node:fs';
import { resolve, join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

const LOG_FILE = 'log.jsonl';

/**
 * Get or create session directory
 */
function ensureSessionDir(session) {
  if (!session._historyDir) {
    const base = session.userId
      ? resolve(__dirname, '.users', session.userId, session.sessionId)
      : resolve(__dirname, '.lobby', session.sessionId);
    mkdirSync(base, { recursive: true });
    session._historyDir = base;
    session._logFile = join(base, LOG_FILE);
    session._attachCounter = 0;
  }
  return session._historyDir;
}

/**
 * Save attachments from attach array to subdirectory, replace with relative paths
 */
function extractAttachments(session, data) {
  if (!data || !Array.isArray(data.attach) || data.attach.length === 0) return data;

  const dir = ensureSessionDir(session);
  const attachDir = join(dir, 'attach');
  mkdirSync(attachDir, { recursive: true });

  const result = { ...data, attach: [] };

  for (const item of data.attach) {
    session._attachCounter++;
    const idx = String(session._attachCounter).padStart(4, '0');
    const ext = item.ext || item.type || 'bin';
    const rawName = item.name || `${idx}.${ext}`;
    // Sanitize: strip directory components, prevent path traversal
    const name = basename(rawName).replace(/^\.+/, '_') || `${idx}.${ext}`;
    const filePath = join(attachDir, name);

    // Decode base64 content and save
    if (item.content) {
      const buf = Buffer.from(item.content, 'base64');
      writeFileSync(filePath, buf);
    } else if (item.data) {
      const buf = Buffer.from(item.data, 'base64');
      writeFileSync(filePath, buf);
    }

    // Replace content with relative path
    result.attach.push({
      ...item,
      content: undefined,
      data: undefined,
      path: `attach/${name}`,
    });
  }

  return result;
}

// Fields that must never be written to log
const SENSITIVE_KEYS = ['naparnik_token', 'chat_jwt', 'mobile_jwt', 'token', 'api_key', 'secret'];

function stripSensitive(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  const result = Array.isArray(obj) ? [...obj] : { ...obj };
  for (const key of Object.keys(result)) {
    if (SENSITIVE_KEYS.includes(key)) {
      result[key] = '[REDACTED]';
    } else if (typeof result[key] === 'object' && result[key] !== null) {
      result[key] = stripSensitive(result[key]);
    }
  }
  return result;
}

function writeEntry(session, entry) {
  try {
    ensureSessionDir(session);
    appendFileSync(session._logFile, JSON.stringify(entry) + '\n', 'utf-8');
  } catch {
    // Log write should never break the router
  }
}

/**
 * Write a protocol event (client ↔ router)
 * @param {'in'|'out'} direction — 'in' = from client, 'out' = to client
 */
export function writeHistory(session, direction, data) {
  const cleaned = stripSensitive(extractAttachments(session, data));
  writeEntry(session, { ts: new Date().toISOString(), src: direction, ...cleaned });
}

/**
 * Write a raw Claude CLI event (stdout)
 * Skips stream_event (text_delta, thinking_delta, input_json_delta) — noise.
 * Keeps: system (init), assistant (tool_use), user (tool_result), result (cost/usage), rate_limit_event.
 */
export function writeClaude(session, line) {
  try {
    const ev = JSON.parse(line);
    // Skip all streaming deltas — assistant_end has the full text
    if (ev.type === 'stream_event') return;
    writeEntry(session, { ts: new Date().toISOString(), src: 'claude', ...ev });
  } catch {
    // Unparseable line — skip
  }
}

/**
 * Move session directory from .lobby to .users/<userId> after auth
 */
export function moveSessionToUser(session) {
  if (!session._historyDir || !session.userId) return;

  const currentDir = session._historyDir;
  const userDir = resolve(__dirname, '.users', session.userId, session.sessionId);

  // Skip if already in .users/
  if (currentDir === userDir) return;

  try {
    mkdirSync(resolve(__dirname, '.users', session.userId), { recursive: true });
    renameSync(currentDir, userDir);
    session._historyDir = userDir;
    session._logFile = join(userDir, LOG_FILE);
  } catch {
    // If rename fails (cross-device), keep in lobby
  }
}
