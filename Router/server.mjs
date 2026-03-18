#!/usr/bin/env node
// Lyra Router — Node.js entry point
// Single process: Centrifugo WS client + HTTP tool server + Claude CLI spawner

import { loadConfig } from './config.mjs';
import { CentrifugoClient } from './centrifugo.mjs';
import { SessionManager } from './sessions.mjs';
import { makeSessionJWTs, makeRouterJWT } from './jwt.mjs';
import { loadProfile, writeTempFiles } from './profiles.mjs';
import { spawnClaude } from './claude.mjs';
import { createToolServer, handleToolResult } from './tools.mjs';
import { verifyAuth, checkBalance, getUserConfig, saveUserSettings } from './users.mjs';
import { sanitizeText } from './protocol.mjs';
import { writeHistory, moveSessionToUser } from './history.mjs';
import * as log from './log.mjs';
import { writeFileSync, readFileSync, unlinkSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const TAG = 'server';

// --- PID file (single-instance guard) ---

const __dirname = dirname(fileURLToPath(import.meta.url));
const PID_FILE = __dirname + '/router.pid';

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0); // signal 0 = check existence
    return true;
  } catch {
    return false;
  }
}

function isOurProcess(pid) {
  try {
    const out = execSync(`wmic process where "ProcessId=${pid}" get CommandLine /format:list`, { encoding: 'utf8' });
    return out.includes('server.mjs');
  } catch {
    return false;
  }
}

function killOldRouter() {
  try {
    const oldPid = parseInt(readFileSync(PID_FILE, 'utf8').trim(), 10);
    if (oldPid && oldPid !== process.pid && isProcessAlive(oldPid) && isOurProcess(oldPid)) {
      console.error(`Killing old router (PID ${oldPid})...`);
      try { execSync(`taskkill /PID ${oldPid} /T /F`, { stdio: 'ignore' }); } catch {}
    }
  } catch {}
}

function writePidFile() {
  try { writeFileSync(PID_FILE, String(process.pid)); } catch {}
}

function removePidFile() {
  try { unlinkSync(PID_FILE); } catch {}
}

killOldRouter();
writePidFile();

// --- Load config and profile ---

const config = loadConfig();
log.setLevel(config.logLevel);
log.setLogFile();  // router.log in Router/
log.info(TAG, 'Starting Lyra Router');

let profile = loadProfile(config.profilePath);
const sessions = new SessionManager(config.sessionTTL, {
  warningBefore: config.sessionWarningBefore || 5 * 60 * 1000,
  onWarning: async (sessionId, session, remainingMs) => {
    try {
      const remainingSeconds = Math.round(remainingMs / 1000);
      await centrifugo.apiPublish(session.channel, { type: 'session_warning', remaining_seconds: remainingSeconds });
      log.info(TAG, `session_warning published for ${sessionId} (${remainingSeconds}s remaining)`);
    } catch (e) {
      log.warn(TAG, `Failed to publish session_warning for ${sessionId}: ${e.message}`);
    }
  },
  onExpire: async (sessionId, session) => {
    try {
      await centrifugo.apiPublish(session.channel, { type: 'session_expired' });
      log.info(TAG, `session_expired published for ${sessionId}`);
    } catch (e) {
      log.warn(TAG, `Failed to publish session_expired for ${sessionId}: ${e.message}`);
    }
  },
});

// --- Start HTTP tool server ---

const centrifugo = new CentrifugoClient(
  config.centrifugo.wsUrl,
  config.centrifugo.apiUrl,
  config.centrifugo.apiKey,
);

const toolServer = createToolServer(sessions, centrifugo, () => profile, config.toolCallTimeout);

const toolsPort = await new Promise((resolve) => {
  toolServer.listen(config.toolsPort, '127.0.0.1', () => {
    const port = toolServer.address().port;
    log.info(TAG, `Tool server listening on 127.0.0.1:${port}`);
    resolve(port);
  });
});

// --- Connect to Centrifugo ---

// Router JWT with lobby channels in claim — auto-subscribe on connect
// (session: namespace has allow_subscribe_for_client: false)
const routerToken = makeRouterJWT(config.centrifugo.hmacSecret, [
  'session:lobby',
  'mobile:lobby',
]);

try {
  await centrifugo.connect(routerToken);
  log.info(TAG, 'Connected to Centrifugo, auto-subscribed to lobbies');
} catch (err) {
  log.error(TAG, `Failed to connect to Centrifugo: ${err.message}`);
  process.exit(1);
}

// Re-subscribe router to all active session channels after Centrifugo reconnect
centrifugo.onReconnect(() => {
  const activeSessions = sessions.getAll();
  log.info(TAG, `Reconnect: re-subscribing to ${activeSessions.length} session channels`);
  for (const s of activeSessions) {
    centrifugo.apiSubscribe('router-1', centrifugo.clientId, s.channel).catch(err => {
      log.error(TAG, `Reconnect re-subscribe failed for ${s.channel}: ${err.message}`);
    });
  }
});

// --- Push dispatcher ---

centrifugo.onPush((push) => {
  const channel = push.channel;
  const data = push.pub?.data;
  if (!data || !data.type) return;

  const clientUUID = push.pub?.info?.client;

  // --- session:lobby ---
  if (channel === 'session:lobby') {
    if (data.type === 'hello') {
      // Dedup by Centrifugo client UUID (unique per WS connection).
      // 1C Chat sends multiple hellos from one connection — only first passes.
      // Reconnect = new WS connection = new clientUUID, so reconnect is not affected.
      const dedup = clientUUID || data.form_id;
      if (dedup) {
        if (_pendingHellos.has(dedup)) {
          log.info(TAG, `Duplicate hello ignored: client=${clientUUID}`);
          return;
        }
        _pendingHellos.add(dedup);
        setTimeout(() => _pendingHellos.delete(dedup), 10000);
      }
      handleHello(data, clientUUID);
    }
    return;
  }

  // --- mobile:lobby ---
  if (channel === 'mobile:lobby') {
    if (data.type === 'register') handleMobileRegister(data, clientUUID);
    if (data.type === 'confirm') handleMobileConfirm(data, clientUUID);
    return;
  }

  // --- session:* (session channels) ---
  if (channel.startsWith('session:')) {
    const session = sessions.getByChannel(channel);
    if (!session) return;

    writeHistory(session, 'in', data);

    // Обновлять lastActivity только при действиях пользователя (не при push от Роутера)
    if (['chat', 'tool_result', 'auth', 'abort', 'disconnect', 'settings_save'].includes(data.type)) {
      sessions.touch(session.sessionId);
    }

    switch (data.type) {
      case 'chat':
        handleChat(session, data);
        break;
      case 'tool_result':
        handleToolResult(session, data);
        break;
      case 'auth':
        handleAuth(session, data);
        break;
      case 'abort':
        handleAbort(session);
        break;
      case 'disconnect':
        handleDisconnect(session);
        break;
      case 'settings_save':
        handleSettingsSave(session, data);
        break;
    }
  }
});

// --- Hello ---

const _pendingHellos = new Set(); // guard against concurrent hellos with same form_id

async function handleHello(data, clientUUID) {
  log.info(TAG, `hello from client=${clientUUID}`, {
    config: data.config_name || data.configuration,
    form_id: data.form_id,
  });

  // Check for reconnect by form_id
  if (data.form_id) {
    const existing = sessions.getByFormId(data.form_id);
    if (existing) {
      log.info(TAG, `Reconnect: form_id=${data.form_id}, session=${existing.sessionId}`);

      // Generate new chat_jwt for reconnected client
      const { chatJwt } = makeSessionJWTs(existing.sessionId, config.centrifugo.hmacSecret);
      existing.chatJwt = chatJwt;
      existing.clientId = clientUUID;
      existing.status = existing.userId ? 'active' : 'awaiting_auth';

      // Subscribe client to session channel and send hello_ack
      try {
        await centrifugo.apiSubscribe('lobby-user', clientUUID, existing.channel);
      } catch (err) {
        log.error(TAG, `Reconnect subscribe error: ${err.message}`);
      }

      const reconnectAck = {
        type: 'hello_ack',
        session_id: existing.sessionId,
        status: 'reconnected',
        chat_jwt: chatJwt,
        // No mobile_jwt/QR on reconnect
      };
      await centrifugo.apiPublish(existing.channel, reconnectAck);
      writeHistory(existing, 'in', data);
      writeHistory(existing, 'out', reconnectAck);

      // If active and Claude not running — respawn with resume
      if (existing.status === 'active' && !existing.claudeProcess) {
        spawnClaudeForSession(existing, null, { resume: true });
      }
      return;
    }
  }

  // New session
  const session = sessions.create(data, clientUUID);
  writeHistory(session, 'in', data);

  // Generate JWTs
  const { chatJwt, mobileJwt } = makeSessionJWTs(session.sessionId, config.centrifugo.hmacSecret);
  session.chatJwt = chatJwt;
  session.mobileJwt = mobileJwt;

  // Subscribe the chat client to session channel (for hello_ack delivery)
  try {
    await centrifugo.apiSubscribe('lobby-user', clientUUID, session.channel);
  } catch (err) {
    log.error(TAG, `Failed to subscribe client to session channel: ${err.message}`);
  }

  // Subscribe Router to session channel via Server API
  try {
    await centrifugo.apiSubscribe('router-1', centrifugo.clientId, session.channel);
  } catch (err) {
    log.error(TAG, `Failed to subscribe router to ${session.channel}: ${err.message}`);
  }

  // MVP: auto-auth — include auth status directly in hello_ack
  // (In production, auth_ack comes later after mobile QR scan)
  session.status = 'active';
  session.userId = 'mvp-user';

  // Read user config (naparnik token etc.)
  const userConfig = getUserConfig(session.userId, session.baseIds);
  session.naparnikToken = userConfig.naparnikToken || '';
  session.userName = userConfig.userName || '';
  session.dbName = userConfig.dbName || '';
  session.dbId = userConfig.dbId || '';
  session.settingsFile = userConfig.settingsFile || '';

  // Publish hello_ack with auto_auth flag and user settings
  const helloAck = {
    type: 'hello_ack',
    session_id: session.sessionId,
    status: 'new',
    chat_jwt: chatJwt,
    mobile_jwt: mobileJwt,
    auto_auth: true,
    naparnik_token: userConfig.naparnikToken || '',
    settings: {
      user_name: userConfig.userName || '',
      user_level: userConfig.userLevel || '',
      db_name: userConfig.dbName || '',
    },
  };
  await centrifugo.apiPublish(session.channel, helloAck);
  writeHistory(session, 'out', helloAck);

  log.info(TAG, `hello_ack sent for session ${session.sessionId} (auto_auth=true)`);

  // Spawn Claude CLI immediately (auth already done)
  spawnClaudeForSession(session);
}

// --- Chat ---

function handleChat(session, data) {
  const text = data.text || data.content || '';
  if (!text) return;

  session._chatReceivedTime = Date.now();
  log.info(TAG, `⏱ chat RECEIVED: session=${session.sessionId}, text="${text.slice(0, 100)}"`);

  if (session.status !== 'active') {
    centrifugo.apiPublish(session.channel, {
      type: 'error',
      message: 'Сессия не авторизована',
    });
    return;
  }

  // If Claude is streaming — abort current, queue new message
  if (session.streaming && session.claudeProcess) {
    log.info(TAG, `Interrupting stream for session ${session.sessionId}`);
    session.pendingMessage = text;
    if (session._abort) session._abort();
    return;
  }

  if (!session.claudeProcess) {
    // Claude not running — respawn with resume and send after ready
    spawnClaudeForSession(session, text, { resume: true });
  } else {
    if (session._sendChat) session._sendChat(text);
  }
}

// --- Auth ---

async function handleAuth(session, data) {
  const { user_id, device_id } = data;
  log.info(TAG, `auth: session=${session.sessionId}, user=${user_id}`);

  const authResult = verifyAuth(user_id, device_id);
  const balanceResult = checkBalance(user_id);

  if (authResult.ok && balanceResult.ok) {
    session.status = 'active';
    session.userId = user_id;

    const userConfig = getUserConfig(user_id, session.baseIds);
    session.naparnikToken = userConfig.naparnikToken || '';
    session.userName = userConfig.userName || '';
    session.dbName = userConfig.dbName || '';
    session.dbId = userConfig.dbId || '';
    session.settingsFile = userConfig.settingsFile || '';
    const ack = {
      type: 'auth_ack', session_id: session.sessionId, status: 'ok',
      naparnik_token: session.naparnikToken,
      settings: {
        user_name: userConfig.userName || '',
        user_level: userConfig.userLevel || '',
        db_name: userConfig.dbName || '',
      },
    };
    await centrifugo.apiPublish(session.channel, ack);
    writeHistory(session, 'out', ack);
    moveSessionToUser(session);

    // Spawn Claude if not already running
    if (!session.claudeProcess) {
      spawnClaudeForSession(session);
    }
  } else {
    const ack = {
      type: 'auth_ack',
      session_id: session.sessionId,
      status: authResult.ok ? 'insufficient_balance' : 'auth_failed',
    };
    await centrifugo.apiPublish(session.channel, ack);
    writeHistory(session, 'out', ack);
  }
}

// --- Abort ---

function handleAbort(session) {
  log.info(TAG, `abort: session=${session.sessionId}`);
  if (session.streaming && session._abort) {
    session._abort();
    const abortEnd = { type: 'assistant_end', text: '', aborted: true };
    centrifugo.apiPublish(session.channel, abortEnd);
    writeHistory(session, 'out', abortEnd);
  }
}

// --- Settings ---

function handleSettingsSave(session, data) {
  const settings = {};
  if (data.naparnik_token !== undefined) settings.naparnik_token = data.naparnik_token;
  if (data.user_name !== undefined) settings.user_name = data.user_name;
  if (data.user_level !== undefined) settings.user_level = data.user_level;
  if (data.db_name !== undefined) settings.db_name = data.db_name;

  log.info(TAG, `settings_save: session=${session.sessionId}, keys=${Object.keys(settings).join(',')}`);

  const result = saveUserSettings(session.userId, settings, session.baseIds);

  // Update session
  if (result.naparnikToken) session.naparnikToken = result.naparnikToken;

  // Confirm to client
  centrifugo.apiPublish(session.channel, {
    type: 'settings_saved',
    status: 'ok',
  });
}

// --- Disconnect ---

function handleDisconnect(session) {
  log.info(TAG, `disconnect: session=${session.sessionId}`);

  // Claude процесс НЕ убиваем — при переподключении используем тот же процесс.
  // Убьётся при TTL expire или при graceful shutdown.

  session.streaming = false;
  session.status = 'disconnected';

  // Не удаляем сессию — клиент может переподключиться по form_id (TTL 30 мин)
}

// --- Mobile registration (MVP stubs) ---

async function handleMobileRegister(data, clientUUID) {
  const { phone } = data;
  log.info(TAG, `mobile register: phone=${phone}`);

  // MVP: accept any phone, generate fake code
  // In production: send SMS, rate limit, store in MDM
  // For now just acknowledge — mobile app will show confirm screen
  // We don't have a way to publish back to mobile:lobby for specific client
  // so the mobile app should subscribe to its own channel after register
}

async function handleMobileConfirm(data, clientUUID) {
  const { phone, code, reg_id } = data;
  log.info(TAG, `mobile confirm: phone=${phone}, code=${code}`);

  // MVP: accept any code
  // In production: verify code, create user in MDM, return user_id + device_id
}

// --- Spawn Claude ---

function spawnClaudeForSession(session, initialMessage, { resume = false } = {}) {
  // Reload profile on each spawn — pick up tools.json/model.json changes without restart
  profile = loadProfile(config.profilePath);

  // Filter out naparnik tool if no token
  if (!session.naparnikToken) {
    profile.allowedTools = profile.allowedTools.filter(t => t !== 'mcp__1c__lyra_ask_naparnik');
    profile.clientTools = profile.clientTools.filter(t => t.name !== 'lyra_ask_naparnik');
  }

  const { promptPath, mcpConfigPath } = writeTempFiles(session, profile, toolsPort, config);

  const { proc, sendChat, abort } = spawnClaude(session, {
    claudePath: config.claude.path,
    profile,
    mcpConfigPath,
    systemPromptPath: promptPath,
    resume,
    onEvent: (event) => {
      // Skip thinking_delta and text_delta — client shows preparation statuses during streaming,
      // final rendered markdown at assistant_end only.
      // This reduces Centrifugo traffic and prevents disconnect 3012 (no pong) on long responses.
      if (event.type === 'thinking_delta') return;
      if (event.type === 'text_delta') return;

      // Suppress memory hint response — don't forward to client
      if (session._memoryHintActive) {
        if (event.type === 'assistant_end') {
          session._memoryHintActive = false;
          log.info(TAG, `Memory hint response suppressed: ${(event.text || '').slice(0, 100)}`);
          writeHistory(session, 'out', { ...event, _memory_hint: true });
          return; // don't publish to client
        }
        // Allow tool_status through (shows "Сохраняю знание..." in UI)
        if (event.type !== 'tool_status') return;
      }

      // Sanitize assistant_end text: markdown headings → bold, strip HTML tags
      if (event.type === 'assistant_end' && event.text) {
        event.text = sanitizeText(event.text);
      }

      // Forward universal protocol events to session channel
      writeHistory(session, 'out', event);
      centrifugo.apiPublish(session.channel, event).catch(err => {
        log.error(TAG, `Failed to publish event: ${err.message}`);
      });

      // Timing summary at end of response
      if (event.type === 'assistant_end' && session._chatReceivedTime) {
        const totalMs = Date.now() - session._chatReceivedTime;
        log.info(TAG, `⏱ SUMMARY: total=${totalMs}ms (from chat received to assistant_end), session=${session.sessionId}`);
      }

      // After assistant_end, hint to save knowledge if response was expensive
      if (event.type === 'assistant_end' && event._turnMs > 30000 && event._turnToolCount > 3 && event._turnResearchTools) {
        const secs = Math.round(event._turnMs / 1000);
        const hint = `[Системное уведомление] На подготовку ответа ушло ${secs} сек, использовано ${event._turnToolCount} инструментов, включая исследование конфигурации. Если ты провела исследование, которое может пригодиться другим пользователям — сохрани ключевые находки (запросы, структуры, счета) через lyra_memory_save. Если сохранять нечего — просто ответь одним словом «ок».`;
        log.info(TAG, `Memory hint sent (${secs}s, ${event._turnToolCount} tools)`);
        session._memoryHintActive = true; // suppress next assistant_end from reaching client
        setTimeout(() => sendChat(hint), 500);
      }

      // After assistant_end, check for pending message (abort + resend)
      if (event.type === 'assistant_end' && session.pendingMessage) {
        const text = session.pendingMessage;
        session.pendingMessage = null;
        log.info(TAG, `Sending pending message: ${text.slice(0, 100)}`);
        sendChat(text);
      }
    },
    onReady: () => {
      // For non-resume spawns, send initial message after init
      if (initialMessage && !resume) {
        sendChat(initialMessage);
      }
    },
    onExit: (code) => {
      // If Claude exited while we have a pending message — respawn with resume
      if (session.pendingMessage) {
        const text = session.pendingMessage;
        session.pendingMessage = null;
        log.info(TAG, `Respawning Claude (resume) for pending message: ${text.slice(0, 100)}`);
        spawnClaudeForSession(session, text, { resume: true });
      }
    },
  });

  session._sendChat = sendChat;
  session._abort = abort;

  // Resume mode: send message immediately — Claude CLI 2.1.74 triggers init on first stdin message
  if (resume && initialMessage) {
    sendChat(initialMessage);
  }
}

// --- Graceful shutdown ---

function shutdown() {
  log.info(TAG, 'Shutting down...');
  sessions.destroy();
  centrifugo.close();
  toolServer.close();
  removePidFile();
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

log.info(TAG, 'Lyra Router ready');
