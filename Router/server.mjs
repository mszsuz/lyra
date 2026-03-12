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

const TAG = 'server';

// --- Load config and profile ---

const config = loadConfig();
log.setLevel(config.logLevel);
log.info(TAG, 'Starting Lyra Router');

const profile = loadProfile(config.profilePath);
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
    if (data.type === 'register' || data.type === 'confirm' || data.type === 'get_sessions') {
      handleMobileMessage(data, clientUUID);
    }
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
    }
  }
});

// --- Handlers ---

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

      // Subscribe client to session channel and send hello_ack
      const lobbyUser = 'lobby-user'; // sub from lobby JWT
      await centrifugo.apiSubscribe(lobbyUser, clientUUID, existing.channel);

      await centrifugo.apiPublish(existing.channel, {
        type: 'hello_ack',
        session_id: existing.sessionId,
        status: 'reconnected',
        chat_jwt: chatJwt,
        // No mobile_jwt/QR on reconnect
      });
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
  const lobbyUser = 'lobby-user'; // sub from lobby JWT — all lobby clients share this
  try {
    await centrifugo.apiSubscribe(lobbyUser, clientUUID, session.channel);
  } catch (err) {
    log.error(TAG, `Failed to subscribe client to session channel: ${err.message}`);
  }

  // Subscribe Router to session channel via Server API
  // (session: namespace has allow_subscribe_for_client: false)
  try {
    await centrifugo.apiSubscribe('router-1', centrifugo.clientId, session.channel);
  } catch (err) {
    log.error(TAG, `Failed to subscribe router to ${session.channel}: ${err.message}`);
  }

  // Publish hello_ack
  await centrifugo.apiPublish(session.channel, {
    type: 'hello_ack',
    session_id: session.sessionId,
    status: 'awaiting_auth',
    chat_jwt: chatJwt,
    mobile_jwt: mobileJwt,
  });

  log.info(TAG, `hello_ack sent for session ${session.sessionId}`);

  // MVP: auto-auth (skip QR flow for now)
  session.status = 'active';
  session.userId = 'mvp-user';

  await centrifugo.apiPublish(session.channel, {
    type: 'auth_ack',
    session_id: session.sessionId,
    status: 'ok',
  });

  // Spawn Claude CLI
  spawnClaudeForSession(session);
}

function handleChat(session, data) {
  const text = data.text || data.content || '';
  if (!text) return;

  log.info(TAG, `chat: session=${session.sessionId}, text="${text.slice(0, 100)}"`);

  if (!session.claudeProcess) {
    // Claude not running — spawn it
    spawnClaudeForSession(session);
    // Send after a short delay to let Claude initialize
    setTimeout(() => {
      if (session._sendChat) session._sendChat(text);
    }, 2000);
  } else {
    if (session._sendChat) session._sendChat(text);
  }
}

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

function handleMobileMessage(data, clientUUID) {
  // MVP: minimal mobile handling
  log.info(TAG, `mobile: type=${data.type}`);
  // TODO: implement register, confirm, get_sessions
}

function spawnClaudeForSession(session) {
  const { promptPath, mcpConfigPath } = writeTempFiles(session, profile, toolsPort);

  const { proc, sendChat } = spawnClaude(session, {
    claudePath: config.claude.path,
    profile,
    mcpConfigPath,
    systemPromptPath: promptPath,
    onEvent: (event) => {
      // Forward universal protocol events to session channel
      centrifugo.apiPublish(session.channel, event).catch(err => {
        log.error(TAG, `Failed to publish event: ${err.message}`);
      });
    },
  });

  session._sendChat = sendChat;
}

// --- Graceful shutdown ---

function shutdown() {
  log.info(TAG, 'Shutting down...');
  sessions.destroy();
  centrifugo.close();
  toolServer.close();
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

log.info(TAG, 'Lyra Router ready');
