// User management — profile + database registry + per-database settings
// Structure:
//   .users/<userId>/profile.json     — user-level settings (name, level, token, device_id)
//   .users/<userId>/databases.json   — registry [{base_ids, db_name, settings_file}]
//   .users/<userId>/db-<id>.json      — per-database settings (id = stable UUID)

import { readFileSync, writeFileSync, appendFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import * as log from './log.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TAG = 'users';

// device_id → user_id mapping (loaded from disk at startup)
const deviceToUser = new Map();

/**
 * Load device_id → user_id mapping from existing profile.json files.
 * Called once at startup.
 */
export function listKnownUserIds() {
  return [...new Set(deviceToUser.values())];
}

export function loadDeviceMapping() {
  const usersRoot = resolve(process.env.LYRA_DATA_DIR || __dirname, 'users');
  if (!existsSync(usersRoot)) return;

  let count = 0;
  for (const entry of readdirSync(usersRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const profilePath = resolve(usersRoot, entry.name, 'profile.json');
    const profile = readJSON(profilePath);
    if (profile && profile.device_id) {
      deviceToUser.set(profile.device_id, entry.name);
      count++;
    }
  }
  log.info(TAG, `Loaded ${count} device→user mappings`);
}

/**
 * Register user by device_id.
 * Known device_id → return existing user_id.
 * New device_id → create user_id, save mapping.
 */
export function registerByDeviceId(deviceId) {
  if (!deviceId) return { ok: false, reason: 'missing device_id' };

  const existingUserId = deviceToUser.get(deviceId);
  if (existingUserId) {
    log.info(TAG, `Known device ${deviceId} → user ${existingUserId}`);
    return { ok: true, userId: existingUserId, isNew: false };
  }

  // New device — create user
  const userId = randomUUID();
  const profile = {
    device_id: deviceId,
    created_at: new Date().toISOString(),
  };
  saveProfile(userId, profile);
  deviceToUser.set(deviceId, userId);
  log.info(TAG, `New user registered: ${userId} (device=${deviceId})`);
  return { ok: true, userId, isNew: true };
}

/**
 * Verify auth: check that device_id is linked to user_id.
 * Migration: if user exists but has no device_id yet — bind on first auth.
 */
export function verifyAuth(userId, deviceId) {
  if (!userId) return { ok: false, reason: 'missing user_id' };
  if (!deviceId) return { ok: false, reason: 'missing device_id' };

  const linkedUser = deviceToUser.get(deviceId);
  if (linkedUser) {
    if (linkedUser !== userId) {
      log.warn(TAG, `Auth failed: device ${deviceId} belongs to ${linkedUser}, not ${userId}`);
      return { ok: false, reason: 'device_user_mismatch' };
    }
    return { ok: true };
  }

  // device_id unknown — check if user exists and has no device_id (migration)
  const profile = getProfile(userId);
  if (Object.keys(profile).length === 0) {
    log.warn(TAG, `Auth failed: unknown user_id=${userId}`);
    return { ok: false, reason: 'unknown_user' };
  }

  if (!profile.device_id) {
    // Migration: existing user without device_id — bind this device
    profile.device_id = deviceId;
    saveProfile(userId, profile);
    deviceToUser.set(deviceId, userId);
    log.info(TAG, `Migration: bound device ${deviceId} → user ${userId}`);
    return { ok: true };
  }

  // User has a different device_id already
  log.warn(TAG, `Auth failed: unknown device_id=${deviceId} for user ${userId}`);
  return { ok: false, reason: 'unknown_device' };
}

export function getUser(userId) {
  const profile = getProfile(userId);
  return Object.keys(profile).length > 0 ? { userId, ...profile } : null;
}

export function checkBalance(userId) {
  const profile = getProfile(userId);
  const balance = profile.balance ?? 0;
  return { ok: balance > 0, balance };
}

let usdToRub = 100;

export function setExchangeRate(rate) {
  usdToRub = rate;
}

export function deductBalance(userId, costUsd, sessionId, providerCostUsd) {
  const profile = getProfile(userId);
  if (profile.balance === undefined) profile.balance = 0;
  const costRub = Math.round(costUsd * usdToRub * 100) / 100;
  profile.balance = Math.round((profile.balance - costRub) * 100) / 100;
  saveProfile(userId, profile);
  const tx = {
    type: 'debit',
    amount: -costRub,
    balance: profile.balance,
    cost_usd: costUsd,
    session_id: sessionId,
  };
  if (providerCostUsd != null && providerCostUsd !== costUsd) {
    tx.provider_cost_usd = providerCostUsd;
  }
  writeTransaction(userId, tx);
  return profile.balance;
}

export function topupBalance(userId, amount, source = 'manual') {
  const profile = getProfile(userId);
  if (profile.balance === undefined) profile.balance = 0;
  profile.balance = Math.round((profile.balance + amount) * 100) / 100;
  saveProfile(userId, profile);
  writeTransaction(userId, {
    type: 'topup',
    amount,
    balance: profile.balance,
    source,
  });
  log.info(TAG, `Topup: user=${userId}, +${amount} руб → ${profile.balance} руб`);
  return profile.balance;
}

function writeTransaction(userId, data) {
  const dir = userDir(userId);
  mkdirSync(dir, { recursive: true });
  const entry = { ts: new Date().toISOString(), ...data };
  appendFileSync(resolve(dir, 'transactions.jsonl'), JSON.stringify(entry) + '\n', 'utf-8');
}

// --- File helpers ---

function userDir(userId) {
  const safeName = userId.replace(/[/\\]/g, '').replace(/^\.+/, '_');
  return resolve(process.env.LYRA_DATA_DIR || __dirname, 'users', safeName);
}

function readJSON(path) {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf-8'));
  } catch {
    log.warn(TAG, `Failed to parse ${path}`);
    return null;
  }
}

function writeJSON(path, data) {
  writeFileSync(path, JSON.stringify(data, null, 2), 'utf-8');
}

// --- Profile ---

function getProfile(userId) {
  const dir = userDir(userId);
  return readJSON(resolve(dir, 'profile.json')) || {};
}

function saveProfile(userId, data) {
  const dir = userDir(userId);
  mkdirSync(dir, { recursive: true });
  writeJSON(resolve(dir, 'profile.json'), data);
}

// --- Database registry ---

function getDatabases(userId) {
  const dir = userDir(userId);
  return readJSON(resolve(dir, 'databases.json')) || [];
}

function saveDatabases(userId, databases) {
  const dir = userDir(userId);
  mkdirSync(dir, { recursive: true });
  writeJSON(resolve(dir, 'databases.json'), databases);
}

/**
 * Find database in registry by matching any of base_ids.
 * Priority: ssl_id > user_id > storage_id > connect_id
 * @param {Array} databases - registry entries
 * @param {Object} baseIds - {ssl_id?, user_id?, storage_id?, connect_id?}
 * @returns {Object|null} matched database entry
 */
function findDatabase(databases, baseIds) {
  if (!baseIds || typeof baseIds !== 'object') return null;

  // Priority order for matching
  const keys = ['ssl_id', 'user_id', 'storage_id', 'connect_id'];

  for (const key of keys) {
    if (!baseIds[key]) continue;
    const found = databases.find(db => db.base_ids && db.base_ids[key] === baseIds[key]);
    if (found) return found;
  }

  return null;
}

// --- Database settings ---

function getDbSettings(userId, settingsFile) {
  if (!settingsFile) return {};
  const dir = userDir(userId);
  return readJSON(resolve(dir, settingsFile)) || {};
}

function saveDbSettings(userId, settingsFile, data) {
  const dir = userDir(userId);
  mkdirSync(dir, { recursive: true });
  writeJSON(resolve(dir, settingsFile), data);
}

// --- Public API ---

/**
 * Read user config: profile + database settings matched by base_ids.
 * Returns { naparnikToken, userName, userLevel, dbName }
 */
export function getUserConfig(userId, baseIds) {
  if (!userId) return {};

  const profile = getProfile(userId);

  // Update last_connected in profile
  profile.last_connected = new Date().toISOString();
  saveProfile(userId, profile);

  const result = {
    naparnikToken: profile.naparnik_token || '',
    userName: profile.user_name || '',
    userLevel: profile.user_level || '',
  };

  // Find database in registry by base_ids
  if (baseIds && typeof baseIds === 'object') {
    const databases = getDatabases(userId);
    const db = findDatabase(databases, baseIds);
    if (db) {
      result.dbId = db.id || '';
      result.dbName = db.db_name || '';
      result.settingsFile = db.settings_file || '';
      // Update last_connected timestamp
      db.last_connected = new Date().toISOString();
      db.base_ids = { ...db.base_ids, ...baseIds };
      saveDatabases(userId, databases);
      log.info(TAG, `Database matched: ${db.db_name} (file: ${db.settings_file})`);
    }
  }

  log.info(TAG, `User config loaded: ${userId}`);
  return result;
}

/**
 * Save user settings. Splits into profile vs database.
 * baseIds used to find/create database entry in registry.
 */
export function saveUserSettings(userId, settings, baseIds) {
  if (!userId) return;

  // --- Profile (user-level) ---
  const profile = getProfile(userId);
  let profileChanged = false;

  if (settings.naparnik_token !== undefined) {
    profile.naparnik_token = settings.naparnik_token;
    profileChanged = true;
  }
  if (settings.user_name !== undefined) {
    profile.user_name = settings.user_name;
    profileChanged = true;
  }
  if (settings.user_level !== undefined) {
    profile.user_level = settings.user_level;
    profileChanged = true;
  }
  if (settings.device_id !== undefined) {
    profile.device_id = settings.device_id;
    deviceToUser.set(settings.device_id, userId);
    profileChanged = true;
  }
  if (settings.phone !== undefined) {
    profile.phone = settings.phone;
    profileChanged = true;
  }

  if (profileChanged) {
    if (!profile.created_at) profile.created_at = new Date().toISOString();
    saveProfile(userId, profile);
    log.info(TAG, `Profile saved: ${userId}`);
  }

  // --- Database (per-base) ---
  if (settings.db_name !== undefined && baseIds && typeof baseIds === 'object') {
    const databases = getDatabases(userId);
    let db = findDatabase(databases, baseIds);

    if (!db) {
      // New database — add to registry with stable UUID
      const dbId = randomUUID();
      db = {
        id: dbId,
        base_ids: { ...baseIds },
        db_name: settings.db_name,
        settings_file: `db-${dbId}.json`,
        created_at: new Date().toISOString(),
        last_connected: new Date().toISOString(),
      };
      databases.push(db);
      log.info(TAG, `New database registered: ${db.db_name}`);
    } else {
      db.db_name = settings.db_name;
      // Update base_ids — merge new IDs (e.g. BSP constant appeared after update)
      db.base_ids = { ...db.base_ids, ...baseIds };
    }

    saveDatabases(userId, databases);

    // Save per-database settings file
    const dbSettings = getDbSettings(userId, db.settings_file);
    dbSettings.db_name = settings.db_name;
    dbSettings.base_ids = db.base_ids;
    saveDbSettings(userId, db.settings_file, dbSettings);

    log.info(TAG, `Database settings saved: ${db.db_name}`);
  }

  return {
    naparnikToken: profile.naparnik_token || '',
    userName: profile.user_name || '',
    userLevel: profile.user_level || '',
  };
}

