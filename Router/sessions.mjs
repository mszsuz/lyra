// Session management — in-memory Map with form_id index and TTL cleanup

import { randomUUID } from 'node:crypto';
import * as log from './log.mjs';

const TAG = 'sessions';

export class SessionManager {
  constructor(ttl = 30 * 60 * 1000) {
    this.sessions = new Map();      // sessionId → Session
    this.byFormId = new Map();      // formId → sessionId
    this.ttl = ttl;
    this._cleanupTimer = setInterval(() => this._cleanup(), 5 * 60 * 1000);
  }

  create(hello, clientId) {
    const sessionId = randomUUID();
    const session = {
      sessionId,
      formId: hello.form_id || null,
      channel: `session:${sessionId}`,
      configName: hello.config_name || hello.configuration || '',
      configVersion: hello.config_version || hello.version || '',
      configId: hello.config_id || '',
      computer: hello.computer || '',
      connectionString: hello.connection_string || '',
      baseIds: hello.base_ids || {},   // {ssl_id, user_id, storage_id, connect_id}
      clientId,           // Centrifugo client UUID (pub.info.client)
      status: 'awaiting_auth',
      userId: null,
      chatJwt: null,
      mobileJwt: null,
      claudeProcess: null,
      claudeSessionId: randomUUID(),
      streaming: false,
      pendingMessage: null,
      pendingToolCalls: new Map(),
      _sendChat: null,
      _abort: null,
      created: Date.now(),
      lastActivity: Date.now(),
    };

    this.sessions.set(sessionId, session);
    if (session.formId) {
      this.byFormId.set(session.formId, sessionId);
    }

    log.info(TAG, `Created session ${sessionId}`, {
      formId: session.formId,
      config: session.configName,
    });

    return session;
  }

  get(sessionId) {
    const s = this.sessions.get(sessionId);
    if (s) s.lastActivity = Date.now();
    return s;
  }

  getByFormId(formId) {
    const sessionId = this.byFormId.get(formId);
    return sessionId ? this.get(sessionId) : null;
  }

  getAll() {
    return [...this.sessions.values()];
  }

  getByChannel(channel) {
    // channel = "session:<sessionId>"
    const sessionId = channel.replace('session:', '');
    return this.get(sessionId);
  }

  remove(sessionId) {
    const s = this.sessions.get(sessionId);
    if (s) {
      if (s.formId) this.byFormId.delete(s.formId);
      if (s.claudeProcess) {
        try { s.claudeProcess.kill(); } catch {}
      }
      // Clear pending tool calls
      for (const [, p] of s.pendingToolCalls) {
        clearTimeout(p.timer);
        p.reject(new Error('Session removed'));
      }
      s.pendingToolCalls.clear();
      this.sessions.delete(sessionId);
      log.info(TAG, `Removed session ${sessionId}`);
    }
  }

  _cleanup() {
    const now = Date.now();
    for (const [id, s] of this.sessions) {
      if (now - s.lastActivity > this.ttl) {
        log.info(TAG, `TTL expired for session ${id}`);
        this.remove(id);
      }
    }
  }

  killAll() {
    for (const [, s] of this.sessions) {
      if (s.claudeProcess) {
        try { s.claudeProcess.kill(); } catch {}
      }
    }
  }

  destroy() {
    clearInterval(this._cleanupTimer);
    this.killAll();
  }
}
