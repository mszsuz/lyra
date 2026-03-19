// User management — profile + database registry + per-database settings
// Structure:
//   .users/<userId>/profile.json     — user-level settings (name, level, token)
//   .users/<userId>/databases.json   — registry [{base_ids, db_name, settings_file}]
//   .users/<userId>/db-<id>.json      — per-database settings (id = stable UUID)

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
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

// --- File helpers ---

function userDir(userId) {
  const safeName = userId.replace(/[/\\]/g, '').replace(/^\.+/, '_');
  return resolve(__dirname, '.users', safeName);
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

