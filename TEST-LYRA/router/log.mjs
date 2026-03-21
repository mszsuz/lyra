// Structured logging to stderr + file with daily rotation
// Uses WriteStream (async, non-blocking) instead of appendFileSync

import { createWriteStream, renameSync, existsSync, statSync, openSync, readSync, closeSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };
let minLevel = LEVELS.info;
let logDir = __dirname;
let logStream = null;
let currentDate = ''; // YYYY-MM-DD of current log file

export function setLevel(level) {
  minLevel = LEVELS[level] ?? LEVELS.info;
}

function todayString() {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD
}

function openStream() {
  currentDate = todayString();
  const path = resolve(logDir, 'router.log');
  logStream = createWriteStream(path, { flags: 'a' });
  logStream.on('error', () => {}); // ignore write errors
}

function rotateIfNeeded() {
  const today = todayString();
  if (today === currentDate) return;

  // Close current stream
  if (logStream) {
    logStream.end();
    logStream = null;
  }

  // Rename router.log → router-YYYY-MM-DD.log (previous day)
  const currentPath = resolve(logDir, 'router.log');
  const archivePath = resolve(logDir, `router-${currentDate}.log`);
  if (existsSync(currentPath)) {
    try { renameSync(currentPath, archivePath); } catch {}
  }

  // Open new stream for today
  openStream();
}

export function setLogFile(path) {
  // path can be full path or just dir — we always use router.log in that dir
  if (path) {
    const dir = dirname(path);
    logDir = dir === '.' ? __dirname : dir;
  }

  // Rotate old log if it has no entries from today
  const currentPath = resolve(logDir, 'router.log');
  if (existsSync(currentPath)) {
    try {
      const stat = statSync(currentPath);
      if (stat.size > 0) {
        // Read last 500 bytes to find the date of most recent entry
        const fd = openSync(currentPath, 'r');
        const readFrom = Math.max(0, stat.size - 500);
        const buf = Buffer.alloc(Math.min(500, stat.size));
        readSync(fd, buf, 0, buf.length, readFrom);
        closeSync(fd);
        const tail = buf.toString('utf-8');
        const dates = [...tail.matchAll(/\[(\d{4}-\d{2}-\d{2})/g)].map(m => m[1]);
        const lastDate = dates.length > 0 ? dates[dates.length - 1] : '';
        if (lastDate && lastDate !== todayString()) {
          const archivePath = resolve(logDir, `router-${lastDate}.log`);
          renameSync(currentPath, archivePath);
        }
      }
    } catch {}
  }

  openStream();

  // Check rotation every hour
  setInterval(rotateIfNeeded, 3600_000);
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
  if (logStream) {
    logStream.write(line);
  }
}

export function debug(tag, msg, extra) { write('debug', tag, msg, extra); }
export function info(tag, msg, extra) { write('info', tag, msg, extra); }
export function warn(tag, msg, extra) { write('warn', tag, msg, extra); }
export function error(tag, msg, extra) { write('error', tag, msg, extra); }
