// Centrifugo WebSocket client + Server API (fetch)
// Node.js 22+ built-in WebSocket, zero dependencies

import * as log from './log.mjs';

const TAG = 'centrifugo';

export class CentrifugoClient {
  constructor(wsUrl, apiUrl, apiKey) {
    this.wsUrl = wsUrl;
    this.apiUrl = apiUrl;
    this.apiKey = apiKey;
    this.ws = null;
    this.cmdId = 1;
    this.handlers = [];       // [{predicate, resolve, reject, timer}]
    this.pushHandler = null;  // onPush callback
    this.joinHandler = null;  // onJoin callback
    this.leaveHandler = null; // onLeave callback
    this.connected = false;
    this._reconnectTimer = null;
    this._token = null;
  }

  // --- WebSocket connection ---

  connect(token) {
    this._token = token;
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.wsUrl);
      let connectCmdId;

      this.ws.addEventListener('open', () => {
        connectCmdId = this.cmdId++;
        this.ws.send(JSON.stringify({ id: connectCmdId, connect: { token, name: 'lyra-router' } }));
      });

      this.ws.addEventListener('message', (event) => {
        const text = typeof event.data === 'string' ? event.data : event.data.toString();
        for (const line of text.split('\n')) {
          if (!line.trim()) continue;
          if (line.trim() === '{}') {
            // Centrifugo ping → pong
            this.ws.send('{}');
            continue;
          }
          try {
            const msg = JSON.parse(line);
            this._handleMessage(msg);
          } catch { /* ignore non-JSON */ }
        }
      });

      this.ws.addEventListener('close', () => {
        const wasConnected = this.connected;
        this.connected = false;
        if (wasConnected) {
          log.warn(TAG, 'WebSocket closed, reconnecting in 3s');
          this._scheduleReconnect();
        }
      });

      this.ws.addEventListener('error', (e) => {
        log.error(TAG, `WebSocket error: ${e.message || e}`);
        if (!this.connected) reject(new Error('WS connection failed'));
      });

      // Wait for connect response — match any msg with .connect (id check via closure)
      this._addHandler(
        (msg) => {
          if (msg.id === connectCmdId && msg.connect) return msg.connect;
          if (msg.id === connectCmdId && msg.error) throw new Error(`Connect error: ${JSON.stringify(msg.error)}`);
        },
        (result) => {
          this.connected = true;
          this.clientId = result.client;
          const autoSubs = result.subs ? Object.keys(result.subs) : [];
          log.info(TAG, `Connected, client=${result.client}, autoSubs=${autoSubs.join(',') || 'none'}`);
          resolve(result);
        },
        reject,
        10000,
      );
    });
  }

  _scheduleReconnect() {
    if (this._reconnectTimer) return;
    this._reconnectTimer = setTimeout(async () => {
      this._reconnectTimer = null;
      try {
        await this.connect(this._token);
        log.info(TAG, 'Reconnected');
        if (this._onReconnect) this._onReconnect();
      } catch (err) {
        log.error(TAG, `Reconnect failed: ${err.message}`);
        this._scheduleReconnect();
      }
    }, 3000);
  }

  subscribe(channel) {
    return new Promise((resolve, reject) => {
      const id = this.cmdId++;
      this.ws.send(JSON.stringify({ id, subscribe: { channel } }));
      this._addHandler(
        (msg) => {
          if (msg.id === id && msg.subscribe !== undefined) return true;
          if (msg.id === id && msg.error) throw new Error(`Subscribe error: ${JSON.stringify(msg.error)}`);
        },
        () => {
          log.info(TAG, `Subscribed to ${channel}`);
          resolve();
        },
        reject,
        10000,
      );
    });
  }

  publish(channel, data) {
    const id = this.cmdId++;
    this.ws.send(JSON.stringify({ id, publish: { channel, data } }));
  }

  onPush(callback) {
    this.pushHandler = callback;
  }

  onJoin(callback) {
    this.joinHandler = callback;
  }

  onLeave(callback) {
    this.leaveHandler = callback;
  }

  onReconnect(callback) {
    this._onReconnect = callback;
  }

  // --- Server API (HTTP) ---

  async apiPublish(channel, data) {
    return this._apiCall('publish', { channel, data });
  }

  async apiSubscribe(user, client, channel, data) {
    const params = { user, client, channel };
    if (data !== undefined) params.data = data;
    return this._apiCall('subscribe', params);
  }

  async apiUnsubscribe(user, client, channel) {
    return this._apiCall('unsubscribe', { user, client, channel });
  }

  async _apiCall(method, params) {
    const res = await fetch(`${this.apiUrl}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-API-Key': this.apiKey },
      body: JSON.stringify(params),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Centrifugo API ${method} error ${res.status}: ${text}`);
    }
    const body = await res.json();
    if (body.error) {
      throw new Error(`Centrifugo API ${method}: ${body.error.message} (code ${body.error.code})`);
    }
    return body;
  }

  // --- Internal ---

  _handleMessage(msg) {
    // Check registered handlers
    for (let i = this.handlers.length - 1; i >= 0; i--) {
      const h = this.handlers[i];
      try {
        const result = h.predicate(msg);
        if (result !== undefined && result !== false) {
          clearTimeout(h.timer);
          this.handlers.splice(i, 1);
          h.resolve(result);
          return;
        }
      } catch (err) {
        clearTimeout(h.timer);
        this.handlers.splice(i, 1);
        h.reject(err);
        return;
      }
    }

    // Push messages: pub, join, leave
    if (msg.push) {
      if (msg.push.pub && this.pushHandler)    this.pushHandler(msg.push);
      if (msg.push.join && this.joinHandler)   this.joinHandler(msg.push.channel, msg.push.join.info);
      if (msg.push.leave && this.leaveHandler) this.leaveHandler(msg.push.channel, msg.push.leave.info);
    }
  }

  _addHandler(predicate, resolve, reject, timeoutMs) {
    const timer = setTimeout(() => {
      const idx = this.handlers.findIndex(h => h.timer === timer);
      if (idx >= 0) this.handlers.splice(idx, 1);
      reject(new Error('Timeout'));
    }, timeoutMs);
    this.handlers.push({ predicate, resolve, reject, timer });
  }

  close() {
    if (this._reconnectTimer) clearTimeout(this._reconnectTimer);
    if (this.ws) this.ws.close();
    this.connected = false;
  }
}
