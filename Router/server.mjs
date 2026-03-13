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
import { verifyAuth, checkBalance } from './users.mjs';
import * as log from './log.mjs';
import { writeFileSync, unlinkSync } from 'node:fs';

const TAG = 'server';

// --- PID file ---

const PID_FILE = new URL('./router.pid', import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1');

function writePidFile() {
  try { writeFileSync(PID_FILE, String(process.pid)); } catch {}
}

function removePidFile() {
  try { unlinkSync(PID_FILE); } catch {}
}

writePidFile();

// --- Load config and profile ---

const config = loadConfig();
log.setLevel(config.logLevel);
log.setLogFile();  // router.log in Router/
log.info(TAG, 'Starting Lyra Router');

let profile = loadProfile(config.profilePath);
const sessions = new SessionManager(config.sessionTTL);

// --- Start HTTP tool server ---

const centrifugo = new CentrifugoClient(
  config.centrifugo.wsUrl,
  config.centrifugo.apiUrl,
  config.centrifugo.apiKey,
);

const toolServer = createToolServer(sessions, centrifugo, profile);

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

// --- Push dispatcher ---

centrifugo.onPush((push) => {
  const channel = push.channel;
  const data = push.pub?.data;
  if (!data || !data.type) return;

  const clientUUID = push.pub?.info?.client;

  // --- session:lobby ---
  if (channel === 'session:lobby') {
    if (data.type === 'hello') {
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

    session.lastActivity = Date.now();

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
    }
  }
});

// --- Hello ---

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

      await centrifugo.apiPublish(existing.channel, {
        type: 'hello_ack',
        session_id: existing.sessionId,
        status: 'reconnected',
        chat_jwt: chatJwt,
        // No mobile_jwt/QR on reconnect
      });

      // If active and Claude not running — respawn with resume
      if (existing.status === 'active' && !existing.claudeProcess) {
        spawnClaudeForSession(existing, null, { resume: true });
      }
      return;
    }
  }

  // New session
  const session = sessions.create(data, clientUUID);

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

  // Publish hello_ack with auto_auth flag
  await centrifugo.apiPublish(session.channel, {
    type: 'hello_ack',
    session_id: session.sessionId,
    status: 'new',
    chat_jwt: chatJwt,
    mobile_jwt: mobileJwt,
    auto_auth: true,
  });

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

    await centrifugo.apiPublish(session.channel, {
      type: 'auth_ack',
      session_id: session.sessionId,
      status: 'ok',
    });

    // Spawn Claude if not already running
    if (!session.claudeProcess) {
      spawnClaudeForSession(session);
    }
  } else {
    await centrifugo.apiPublish(session.channel, {
      type: 'auth_ack',
      session_id: session.sessionId,
      status: authResult.ok ? 'insufficient_balance' : 'auth_failed',
    });
  }
}

// --- Abort ---

function handleAbort(session) {
  log.info(TAG, `abort: session=${session.sessionId}`);
  if (session.streaming && session._abort) {
    session._abort();
    centrifugo.apiPublish(session.channel, {
      type: 'assistant_end',
      text: '',
      aborted: true,
    });
  }
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
  const { promptPath, mcpConfigPath } = writeTempFiles(session, profile, toolsPort);

  const { proc, sendChat, abort } = spawnClaude(session, {
    claudePath: config.claude.path,
    profile,
    mcpConfigPath,
    systemPromptPath: promptPath,
    resume,
    onEvent: (event) => {
      // Skip thinking_delta — client only shows "Думаю...", no need to flood with thinking text.
      // This reduces Centrifugo traffic and prevents disconnect 3012 (no pong) on long responses.
      if (event.type === 'thinking_delta') return;

      // Forward universal protocol events to session channel
      centrifugo.apiPublish(session.channel, event).catch(err => {
        log.error(TAG, `Failed to publish event: ${err.message}`);
      });

      // Timing summary at end of response
      if (event.type === 'assistant_end' && session._chatReceivedTime) {
        const totalMs = Date.now() - session._chatReceivedTime;
        log.info(TAG, `⏱ SUMMARY: total=${totalMs}ms (from chat received to assistant_end), session=${session.sessionId}`);
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
