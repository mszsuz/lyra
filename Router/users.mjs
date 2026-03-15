// In-memory user management (MVP)
// Will be replaced by MDM (1C extension) later

import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as log from './log.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TAG = 'users';

const users = new Map();

export function verifyAuth(userId, deviceId) {
  // MVP: accept all auths, create user on the fly
  if (!userId) return { ok: false, reason: 'missing user_id' };

  if (!users.has(userId)) {
    users.set(userId, { userId, deviceId, created: Date.now() });
    log.info(TAG, `New user registered: ${userId}`);
  }
  return { ok: true };
}

export function getUser(userId) {
  return users.get(userId) || null;
}

export function checkBalance(userId) {
  // MVP: always ok, unlimited
  return { ok: true, balance: 999999 };
}

/**
 * Read user config from .users/<userId>/.env
 * Returns { naparnikToken } or empty object
 */
export function getUserConfig(userId) {
  if (!userId) return {};
  const safeName = userId.replace(/[/\\]/g, '').replace(/^\.+/, '_');
  const envPath = resolve(__dirname, '.users', safeName, '.env');
  if (!existsSync(envPath)) return {};

  try {
    const content = readFileSync(envPath, 'utf-8');
    const result = {};
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq < 0) continue;
      const key = trimmed.slice(0, eq).trim();
      const val = trimmed.slice(eq + 1).trim();
      if (key === 'ONEC_AI_TOKEN') result.naparnikToken = val;
    }
    if (result.naparnikToken) {
      log.info(TAG, `User config loaded: ${userId} (naparnik token: ${result.naparnikToken.length} chars)`);
    }
    return result;
  } catch {
    return {};
  }
}
