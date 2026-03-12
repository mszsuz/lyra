// In-memory user management (MVP)
// Will be replaced by MDM (1C extension) later

import * as log from './log.mjs';

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
