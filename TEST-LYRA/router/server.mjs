#!/usr/bin/env node
// Lyra Router — Node.js entry point
// Single process: Centrifugo WS client + HTTP tool server + Claude CLI spawner

import { loadConfig } from './config.mjs';
import { CentrifugoClient } from './centrifugo.mjs';
import { SessionManager } from './sessions.mjs';
import { makeSessionJWTs, makeRouterJWT } from './jwt.mjs';
import { loadProfile, writeTempFiles, renderSystemPrompt } from './profiles.mjs';
import { spawnClaude } from './claude.mjs';
import { createAdapter } from './adapters/index.mjs';
import { createToolServer, handleToolResult } from './tools.mjs';
import { verifyAuth, checkBalance, getUserConfig, saveUserSettings } from './users.mjs';
import { sanitizeText } from './protocol.mjs';
import { executeTool } from './tool-execution.mjs';
import { processEvent as billingProcessEvent, billAccumulatedCost, initBilling } from './billing.mjs';
import * as conversation from './conversation.mjs';
import { findRelevantLinks, warmup as ragWarmup } from './rag.mjs';
import { writeHistory, moveSessionToUser } from './history.mjs';
import * as log from './log.mjs';
import { writeFileSync, readFileSync, unlinkSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';

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
initBilling(config);
log.setLevel(config.logLevel);
log.setLogFile(resolve(config.dataDir, 'var', 'router.log'));
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
    if (data.type === 'get_sessions') handleGetSessions(data, clientUUID);
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
const _pendingRegistrations = new Map(); // reg_id → { phone, deviceId, code, clientUUID, attempts, created }
const _phoneToUser = new Map(); // phone → userId (in-memory cache for re-registration)

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

  // Session awaits mobile auth (QR scan)
  session.status = 'awaiting_auth';

  // Publish hello_ack with mobile_jwt for QR display
  const helloAck = {
    type: 'hello_ack',
    session_id: session.sessionId,
    status: 'new',
    chat_jwt: chatJwt,
    mobile_jwt: mobileJwt,
  };
  await centrifugo.apiPublish(session.channel, helloAck);
  writeHistory(session, 'out', helloAck);

  log.info(TAG, `hello_ack sent for session ${session.sessionId} (awaiting mobile auth)`);
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

  // Adapter-based session
  if (session.adapter) {
    if (session.streaming) {
      session._aborted = true;
      session.pendingMessage = text;
      session.adapter.abort(session.sessionId);
      return;
    }
    runAdapterChat(session, text);
    return;
  }

  // CLI-based session (legacy)
  if (session.streaming && session.claudeProcess) {
    log.info(TAG, `Interrupting stream for session ${session.sessionId}`);
    session.pendingMessage = text;
    if (session._abort) session._abort();
    return;
  }

  if (!session.claudeProcess) {
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

    // Close old sessions for the same user + base
    const allSessions = sessions.getAll();
    for (const old of allSessions) {
      if (old.sessionId === session.sessionId) continue;
      if (old.userId === user_id && old.configName === session.configName) {
        log.info(TAG, `Closing old session ${old.sessionId} (same user+base, replaced by ${session.sessionId})`);
        if (old.claudeProcess) {
          try { old.claudeProcess.kill(); } catch {}
          old.claudeProcess = null;
        }
        sessions.remove(old.sessionId);
      }
    }

    const userConfig = getUserConfig(user_id, session.baseIds);
    session.naparnikToken = userConfig.naparnikToken || '';
    session.userName = userConfig.userName || '';
    session.dbName = userConfig.dbName || '';
    session.dbId = userConfig.dbId || '';
    session.settingsFile = userConfig.settingsFile || '';
    const ack = {
      type: 'auth_ack', session_id: session.sessionId, status: 'ok',
      balance: balanceResult.balance,
      currency: 'руб',
      config_name: session.configName || '',
      created: new Date(session.created).toISOString(),
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

    // Spawn model if not already running
    if (!session.claudeProcess && !session.adapter) {
      const adapterName = config.adapter || config.claude.adapter || 'claude-cli';
      if (adapterName === 'claude-cli') {
        spawnClaudeForSession(session);
      } else {
        startAdapterSession(session, adapterName);
      }
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

  // Adapter-based sessions
  if (session.adapter && session.streaming) {
    session._aborted = true;
    session.adapter.abort(session.sessionId);
    const abortEnd = { type: 'assistant_end', text: '', aborted: true };
    centrifugo.apiPublish(session.channel, abortEnd);
    writeHistory(session, 'out', abortEnd);
    return;
  }

  // CLI-based sessions
  if (session.streaming && session._abort) {
    session._aborted = true;
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

// --- Mobile registration ---

const REG_TTL = 5 * 60 * 1000; // 5 minutes
const REG_MAX_ATTEMPTS = 3;

async function handleMobileRegister(data, clientUUID) {
  const { phone, device_id } = data;
  log.info(TAG, `mobile register: phone=${phone}, device_id=${device_id}`);

  if (!phone) {
    log.warn(TAG, 'register: missing phone');
    return;
  }

  const regId = randomUUID();
  const code = String(Math.floor(1000 + Math.random() * 9000)); // 4-digit code

  _pendingRegistrations.set(regId, {
    phone,
    deviceId: device_id || null,
    code,
    clientUUID,
    attempts: 0,
    created: Date.now(),
  });

  log.info(TAG, `📱 REGISTRATION CODE for ${phone}: ${code} (reg_id=${regId})`);

  // Send sms_sent to mobile:lobby — client is subscribed via channels claim in JWT
  await centrifugo.apiPublish('mobile:lobby', { type: 'sms_sent', reg_id: regId, phone });
}

async function handleMobileConfirm(data, clientUUID) {
  const { reg_id, code } = data;
  log.info(TAG, `mobile confirm: reg_id=${reg_id}, code=${code}`);

  const reg = _pendingRegistrations.get(reg_id);

  // Not found or expired
  if (!reg || (Date.now() - reg.created > REG_TTL)) {
    if (reg) _pendingRegistrations.delete(reg_id);
    await centrifugo.apiPublish('mobile:lobby', { type: 'confirm_error', reg_id, reason: 'expired' });
    return;
  }

  // Wrong code
  if (reg.code !== code) {
    reg.attempts++;
    if (reg.attempts >= REG_MAX_ATTEMPTS) {
      _pendingRegistrations.delete(reg_id);
      await centrifugo.apiPublish('mobile:lobby', { type: 'confirm_error', reg_id, reason: 'max_attempts' });
      return;
    }
    await centrifugo.apiPublish('mobile:lobby', {
      type: 'confirm_error',
      reg_id,
      reason: 'invalid_code',
      attempts_remaining: REG_MAX_ATTEMPTS - reg.attempts,
    });
    return;
  }

  // Code matches — register user
  const existingUserId = _phoneToUser.get(reg.phone);
  const userId = existingUserId || randomUUID();

  // Register in users.mjs (creates user if not exists)
  verifyAuth(userId, reg.deviceId);

  // Save phone in user profile
  saveUserSettings(userId, { phone: reg.phone }, null);

  // Update phone→user mapping
  _phoneToUser.set(reg.phone, userId);

  // Publish success
  await centrifugo.apiPublish('mobile:lobby', { type: 'register_ack', reg_id, status: 'ok', user_id: userId });
  _pendingRegistrations.delete(reg_id);

  log.info(TAG, `📱 Registration complete: phone=${reg.phone}, user_id=${userId}`);
}

// --- Get sessions (mobile) ---

async function handleGetSessions(data, clientUUID) {
  const { user_id } = data;
  log.info(TAG, `get_sessions: user_id=${user_id}`);

  if (!user_id) {
    log.warn(TAG, 'get_sessions: missing user_id');
    return;
  }

  const allSessions = sessions.getAll();
  const activeStatuses = new Set(['active', 'insufficient_balance', 'disconnected']);

  const list = allSessions
    .filter(s => s.userId === user_id && activeStatuses.has(s.status))
    .map(s => ({
      session_id: s.sessionId,
      channel: s.channel,
      config_name: s.configName,
      config_version: s.configVersion,
      status: s.status,
      balance: checkBalance(user_id).balance,
      created: new Date(s.created).toISOString(),
      last_activity: new Date(s.lastActivity).toISOString(),
      mobile_jwt: s.mobileJwt || null,
    }));

  await centrifugo.apiPublish('mobile:lobby', {
    type: 'sessions_list',
    user_id,
    sessions: list,
  });
  log.info(TAG, `sessions_list sent: ${list.length} sessions for user ${user_id}`);
}

// --- Cleanup expired registrations (every 60s) ---

setInterval(() => {
  const now = Date.now();
  for (const [regId, reg] of _pendingRegistrations) {
    if (now - reg.created > REG_TTL) {
      _pendingRegistrations.delete(regId);
      log.info(TAG, `Expired registration removed: reg_id=${regId}, phone=${reg.phone}`);
    }
  }
}, 60 * 1000);

// --- Adapter-based session ---

async function startAdapterSession(session, adapterName) {
  profile = loadProfile(config.profilePath);

  // Adapter config from router config (operator-level, not per-user)
  const adapterConfig = {
    base_url: config.adapterConfig.base_url,
    api_key: config.adapterConfig.api_key,
    model: config.adapterConfig.model,
  };

  const { adapter, capabilities } = await createAdapter(adapterName, adapterConfig);
  session.adapter = adapter;
  session.adapterCapabilities = capabilities;
  session.messages = [];

  // Build MCP server configs for this session (Vega, mcp-1c-docs)
  session.mcpServers = {};
  if (profile.vegaConfig && session.configName) {
    const port = profile.vegaConfig.configs?.[session.configName]?.port;
    if (port) {
      session.mcpServers.vega = {
        url: `http://localhost:${port}/mcp`,
        headers: profile.vegaConfig.headers || {},
      };
    }
  }
  session.mcpServers.docs = { url: 'http://localhost:6280/mcp', headers: {} };

  // Pre-render system prompt and tools once per session (cache-friendly)
  session.systemPrompt = renderSystemPrompt(profile.systemPromptTemplate, session, profile);
  session.tools = buildSessionTools(profile, session);

  // Pre-warm MCP sessions for fast RAG on first message
  if (config.rag?.enabled) {
    ragWarmup(session.mcpServers);
  }

  log.info(TAG, `Adapter "${adapterName}" started for session ${session.sessionId} (model: ${adapterConfig.model}, mcp: ${Object.keys(session.mcpServers).join(',')}, tools: ${session.tools.length}, caps: ${JSON.stringify(capabilities)})`);
}

const _VEGA_TOOLS = new Set(['search_code', 'search_metadata', 'search_metadata_by_description']);
const _DOCS_TOOLS = new Set(['search_docs', 'fetch_url', 'list_libraries']);

function resolveToolKey(toolName, session) {
  if (_VEGA_TOOLS.has(toolName) && session.mcpServers?.vega) return `mcp__vega__${toolName}`;
  if (_DOCS_TOOLS.has(toolName) && session.mcpServers?.docs) return `mcp__mcp-1c-docs__${toolName}`;
  return `mcp__1c__${toolName}`;
}

function buildSessionTools(profile, session) {
  const tools = (profile.clientTools || []).map(t => ({
    name: t.name,
    description: t.description,
    input_schema: t.input_schema || {},
  }));

  if (session.mcpServers?.vega) {
    tools.push(
      { name: 'search_metadata', description: 'Поиск объектов метаданных конфигурации 1С по имени (точное или частичное совпадение). Справочники, документы, регистры, реквизиты, табличные части.', input_schema: { type: 'object', properties: { query: { type: 'string', description: 'Имя или часть имени объекта метаданных' } }, required: ['query'] } },
      { name: 'search_metadata_by_description', description: 'Семантический поиск объектов метаданных по описанию назначения. Пример: «хранение цен номенклатуры» → найдёт РегистрСведений.ЦеныНоменклатуры', input_schema: { type: 'object', properties: { query: { type: 'string', description: 'Описание назначения объекта' } }, required: ['query'] } },
      { name: 'search_code', description: 'Поиск в BSL-коде конфигурации (модули, процедуры, функции). Ищет по тексту кода.', input_schema: { type: 'object', properties: { query: { type: 'string', description: 'Текст для поиска в коде' } }, required: ['query'] } },
    );
  }

  if (session.mcpServers?.docs) {
    tools.push(
      { name: 'search_docs', description: 'Поиск по документации 1С (справочник языка, примеры, решения, статьи). Используй для вопросов о встроенных функциях, методах, свойствах, синтаксисе.', input_schema: { type: 'object', properties: { library: { type: 'string', description: 'Библиотека: 1c-language-8.3.27, 1c-examples, 1c-solutions, 1c-knowledge' }, query: { type: 'string', description: 'Поисковый запрос' } }, required: ['library', 'query'] } },
      { name: 'fetch_url', description: 'Получить полный текст страницы документации по URL из результатов search_docs', input_schema: { type: 'object', properties: { url: { type: 'string', description: 'URL страницы документации' }, library: { type: 'string', description: 'Библиотека' } }, required: ['url', 'library'] } },
      { name: 'list_libraries', description: 'Список доступных библиотек документации 1С', input_schema: { type: 'object', properties: {} } },
    );
  }

  return tools;
}

async function runAdapterChat(session, text) {
  session.streaming = true;
  session._aborted = false;
  session._chatReceivedTime = Date.now();

  // Set env vars for codex-cli adapter (MCP tools-mcp.mjs needs these via env_vars forwarding)
  process.env.LYRA_TOOLS_URL = `http://127.0.0.1:${toolsPort}/tool-call`;
  process.env.LYRA_SESSION_ID = session.sessionId;
  process.env.LYRA_CONFIG_NAME = session.configName || '';
  process.env.LYRA_USER_ID = session.userId || '';
  process.env.LYRA_DB_ID = session.dbId || '';
  process.env.LYRA_DB_NAME = session.dbName || '';

  const caps = session.adapterCapabilities || {};

  if (caps.history_mode === 'adapter') {
    // Subflow B: adapter manages history (codex-cli, claude-cli)
    // Pass only the current message — adapter handles conversation internally
    await runAdapterChatPassthrough(session, text);
  } else {
    // Subflow A: router manages history (openai, claude-api)
    await runAdapterChatManaged(session, text);
  }

  session.streaming = false;

  // Handle pending message
  if (session.pendingMessage) {
    const pending = session.pendingMessage;
    session.pendingMessage = null;
    runAdapterChat(session, pending);
  }
}

// Subflow A: Router manages history + tool execution (openai, claude-api)
async function runAdapterChatManaged(session, text) {
  // RAG — enrich question with relevant metadata/docs links
  if (config.rag?.enabled && (session.mcpServers?.vega || session.mcpServers?.docs) && text.length >= 5) {
    const ragResult = await findRelevantLinks(text, session.mcpServers, config.rag, session.configName);
    if (ragResult?.rag) {
      text = text + '\n' + ragResult.rag;
      log.info(TAG, `RAG enriched (${ragResult.ms}ms)`);
    }
  }

  conversation.addUserMessage(session, text);

  const request = {
    session_id: session.sessionId,
    system_prompt: session.systemPrompt,
    messages: conversation.getMessages(session),
    tools: session.tools,
    options: {
      chunkTimeout: config.adapterTimeout.chunkTimeout,
      connectTimeout: config.adapterTimeout.connectTimeout,
    },
    _configName: session.configName,
    _userId: session.userId,
  };

  let accumulatedCostUsd = 0;
  const maxToolTurns = 10;
  const maxRetries = config.adapterTimeout.maxRetries;
  let toolTurnCount = 0;

  try {
    // Outer loop: semantic turns (tool calls + final answer)
    while (true) {
      const toolsExhausted = toolTurnCount >= maxToolTurns;
      const currentRequest = {
        ...request,
        messages: conversation.getMessages(session),
        tools: toolsExhausted ? [] : request.tools,
      };
      if (toolsExhausted) {
        log.warn(TAG, `Tool limit (${maxToolTurns}) reached, final request without tools, session ${session.sessionId}`);
      }

      let pendingTools = [];
      let turnSuccess = false;

      // Inner loop: transport retries for one request
      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        pendingTools = [];
        let gotTimeout = false;

        for await (const event of session.adapter.chat(currentRequest)) {
          // User abort — silent exit (bill accumulated cost)
          if (event.type === 'error' && event.code === 'user_abort') {
            log.info(TAG, `User abort, session ${session.sessionId}`);
            if (accumulatedCostUsd > 0) billAccumulatedCost(session, accumulatedCostUsd, centrifugo);
            return;
          }

          // Adapter timeout — retry or give up
          if (event.type === 'error' && event.code === 'adapter_timeout' && event.retryable) {
            if (attempt < maxRetries) {
              log.warn(TAG, `Adapter timeout [${event.stage}] attempt ${attempt + 1}/${maxRetries + 1}, session ${session.sessionId}`);
              gotTimeout = true;
              break;
            } else {
              log.error(TAG, `Adapter timeout [${event.stage}] after ${maxRetries + 1} attempts, session ${session.sessionId}`);
              if (accumulatedCostUsd > 0) billAccumulatedCost(session, accumulatedCostUsd, centrifugo);
              publishAdapterError(session, 'Ошибка: сервер не ответил вовремя (код 01). Попробуйте повторить.');
              return;
            }
          }

          // Other errors
          if (event.type === 'error') {
            log.error(TAG, `Adapter error: ${event.message}`);
            if (accumulatedCostUsd > 0) billAccumulatedCost(session, accumulatedCostUsd, centrifugo);
            publishAdapterError(session, 'Ошибка: сервис временно недоступен (код 02). Попробуйте повторить.');
            return;
          }

          // Tool use
          if (event.type === 'tool_use') {
            pendingTools.push(event);
            if (session._aborted) continue;
            log.info(TAG, `Tool use from adapter: ${event.name}`);
            const toolKey = resolveToolKey(event.name, session);
            const toolLabel = profile.toolLabels?.[toolKey] || event.name;
            centrifugo.apiPublish(session.channel, {
              type: 'tool_status', tool: toolKey, description: toolLabel,
            }).catch(() => {});
            continue;
          }

          // Assistant end
          if (event.type === 'assistant_end') {
            turnSuccess = true;

            if (pendingTools.length > 0) {
              // Guard: tools after limit exhausted — do NOT execute
              if (toolsExhausted) {
                log.error(TAG, `Model returned tool_use after tool limit, ignoring tools, session ${session.sessionId}`);
                if (event.text) {
                  if (accumulatedCostUsd > 0) {
                    event.cost_usd = (event.cost_usd || 0) + accumulatedCostUsd;
                    event.cost_rub = Math.round(event.cost_usd * config.exchangeRate * 100) / 100;
                  }
                  handleAdapterEvent(session, event);
                  conversation.addAssistantMessage(session, event.text);
                  billingProcessEvent(session, event, centrifugo);
                } else {
                  const totalCostUsd = (accumulatedCostUsd || 0) + (event.cost_usd || 0);
                  if (totalCostUsd > 0) {
                    billAccumulatedCost(session, totalCostUsd, centrifugo);
                  }
                  publishAdapterError(session, 'Ошибка: превышен лимит обращений к данным (код 03). Попробуйте упростить вопрос.');
                }
                return;
              }

              // Normal tool turn — execute tools, accumulate cost
              accumulatedCostUsd += event.cost_usd || 0;
              for (const tu of pendingTools) {
                if (session._aborted) {
                  log.info(TAG, `Aborted before tool execution, session ${session.sessionId}`);
                  if (accumulatedCostUsd > 0) billAccumulatedCost(session, accumulatedCostUsd, centrifugo);
                  return;
                }
                const toolResult = await executeTool(session, tu, {
                  centrifugo,
                  toolCallTimeout: config.toolCallTimeout,
                });
                // Check again after tool execution — abort may have arrived during await
                if (session._aborted) {
                  log.info(TAG, `Aborted after tool execution, discarding result, session ${session.sessionId}`);
                  if (accumulatedCostUsd > 0) billAccumulatedCost(session, accumulatedCostUsd, centrifugo);
                  return;
                }
                conversation.addToolUse(session, { id: tu.id, name: tu.name, input: tu.input });
                conversation.addToolResult(session, tu.id, toolResult.content, toolResult.isError);
              }
              log.info(TAG, `Tool results received (${pendingTools.length} tools, accumulated cost: $${accumulatedCostUsd.toFixed(4)}), continuing...`);
            } else {
              // Final answer — skip if aborted (handleAbort already sent terminal event)
              if (session._aborted) {
                log.info(TAG, `Aborted, skipping final answer, session ${session.sessionId}`);
                return;
              }
              // Include accumulated cost from all turns
              if (accumulatedCostUsd > 0) {
                event.cost_usd = (event.cost_usd || 0) + accumulatedCostUsd;
                event.cost_rub = Math.round(event.cost_usd * config.exchangeRate * 100) / 100;
              }
              handleAdapterEvent(session, event);
              conversation.addAssistantMessage(session, event.text);
              billingProcessEvent(session, event, centrifugo);
            }
            break;
          }

          // Forward other events (text_delta, tool_status, etc.) to client
          handleAdapterEvent(session, event);
        }

        if (turnSuccess || !gotTimeout) break;
      }
      // End inner loop

      if (!turnSuccess) break;
      if (pendingTools.length === 0) break;
      if (session._aborted) {
        log.info(TAG, `Aborted before next semantic turn, session ${session.sessionId}`);
        if (accumulatedCostUsd > 0) billAccumulatedCost(session, accumulatedCostUsd, centrifugo);
        break;
      }

      toolTurnCount++;
    }
  } catch (err) {
    log.error(TAG, `Adapter error: ${err.message} ${err.stack || ''}`);
    publishAdapterError(session, 'Ошибка: непредвиденная ситуация (код 04). Попробуйте повторить.');
  }
}

// Subflow B: Adapter manages history (codex-cli, claude-cli as adapter)
async function runAdapterChatPassthrough(session, text) {
  const request = {
    session_id: session.sessionId,
    system_prompt: session.systemPrompt,
    messages: [{ role: 'user', content: text }],
    tools: session.tools,
    options: {
      chunkTimeout: config.adapterTimeout.chunkTimeout,
      connectTimeout: config.adapterTimeout.connectTimeout,
    },
    _configName: session.configName,
    _userId: session.userId,
  };

  try {
    for await (const event of session.adapter.chat(request)) {
      // User abort — silent exit
      if (event.type === 'error' && event.code === 'user_abort') {
        return;
      }

      // Adapter timeout — no retry for passthrough, just notify
      if (event.type === 'error' && event.code === 'adapter_timeout') {
        log.error(TAG, `Passthrough adapter timeout [${event.stage}], session ${session.sessionId}`);
        publishAdapterError(session, 'Ошибка: сервер не ответил вовремя (код 05). Попробуйте повторить.');
        return;
      }

      handleAdapterEvent(session, event);

      if (event.type === 'assistant_end') {
        billingProcessEvent(session, event, centrifugo);
        break;
      }
    }
  } catch (err) {
    log.error(TAG, `Adapter error: ${err.message} ${err.stack || ''}`);
    publishAdapterError(session, 'Ошибка: непредвиденная ситуация (код 06). Попробуйте повторить.');
  }
}

/** Publish error to client — sends as error event (Chat handles timer reset) */
function publishAdapterError(session, message) {
  centrifugo.apiPublish(session.channel, { type: 'error', message });
}

function handleAdapterEvent(session, event) {
  // Suppress all events after abort — handleAbort() already sent terminal event
  if (session._aborted) return;

  // Skip thinking (not shown to user)
  if (event.type === 'thinking_delta' || event.type === 'thinking_start' || event.type === 'thinking_end') return;
  // Skip text_delta for now (same as CLI behavior — only assistant_end)
  if (event.type === 'text_delta') return;

  // Memory hint suppression
  if (session._memoryHintActive) {
    if (event.type === 'assistant_end') {
      session._memoryHintActive = false;
      writeHistory(session, 'out', { ...event, _memory_hint: true });
      return;
    }
    if (event.type !== 'tool_status') return;
  }

  // Suppress — don't publish, only write history
  if (event._suppress) {
    writeHistory(session, 'out', { ...event, _suppressed: true });
    return;
  }

  // Sanitize
  if (event.type === 'assistant_end' && event.text) {
    event.text = sanitizeText(event.text);
  }

  // Apply tool labels for tool_status
  if (event.type === 'tool_status' && profile.toolLabels) {
    event.description = profile.toolLabels[event.tool] || event.description;
  }

  // Add cost in rubles for Chat display
  if (event.type === 'assistant_end' && event.cost_usd) {
    event.cost_rub = Math.round(event.cost_usd * config.exchangeRate * 100) / 100;
  }

  // Publish to client
  writeHistory(session, 'out', event);
  centrifugo.apiPublish(session.channel, event).catch(err => {
    log.error(TAG, `Failed to publish: ${err.message}`);
  });

  // Timing
  if (event.type === 'assistant_end' && session._chatReceivedTime) {
    const totalMs = Date.now() - session._chatReceivedTime;
    log.info(TAG, `⏱ SUMMARY: total=${totalMs}ms, session=${session.sessionId}`);
  }
}

// --- Spawn Claude (CLI) ---

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

      // Add cost in rubles for Chat display
      if (event.type === 'assistant_end' && event.cost_usd) {
        event.cost_rub = Math.round(event.cost_usd * config.exchangeRate * 100) / 100;
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

      // Deduct balance after each response
      billingProcessEvent(session, event, centrifugo);

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
