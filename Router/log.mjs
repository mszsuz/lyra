// Structured logging to stderr

const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };
let minLevel = LEVELS.info;

export function setLevel(level) {
  minLevel = LEVELS[level] ?? LEVELS.info;
}

function write(level, tag, msg, extra) {
  if (LEVELS[level] < minLevel) return;
  const ts = new Date().toISOString().replace('T', ' ').slice(0, 23);
  const parts = [`[${ts}] [${level.toUpperCase()}] [${tag}]`, msg];
  if (extra !== undefined) {
    parts.push(typeof extra === 'string' ? extra : JSON.stringify(extra));
  }
  process.stderr.write(parts.join(' ') + '\n');
}

export function debug(tag, msg, extra) { write('debug', tag, msg, extra); }
export function info(tag, msg, extra) { write('info', tag, msg, extra); }
export function warn(tag, msg, extra) { write('warn', tag, msg, extra); }
export function error(tag, msg, extra) { write('error', tag, msg, extra); }
