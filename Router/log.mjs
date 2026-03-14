// Structured logging to stderr + optional file

import { appendFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };
let minLevel = LEVELS.info;
let logFilePath = null;

export function setLevel(level) {
  minLevel = LEVELS[level] ?? LEVELS.info;
}

export function setLogFile(path) {
  logFilePath = path || resolve(__dirname, 'router.log');
}

function write(level, tag, msg, extra) {
  if (LEVELS[level] < minLevel) return;
  const ts = new Date().toISOString().replace('T', ' ').slice(0, 23);
  const parts = [`[${ts}] [${process.pid}] [${level.toUpperCase()}] [${tag}]`, msg];
  if (extra !== undefined) {
    parts.push(typeof extra === 'string' ? extra : JSON.stringify(extra));
  }
  const line = parts.join(' ') + '\n';
  process.stderr.write(line);
  if (logFilePath) {
    try { appendFileSync(logFilePath, line); } catch {}
  }
}

export function debug(tag, msg, extra) { write('debug', tag, msg, extra); }
export function info(tag, msg, extra) { write('info', tag, msg, extra); }
export function warn(tag, msg, extra) { write('warn', tag, msg, extra); }
export function error(tag, msg, extra) { write('error', tag, msg, extra); }
