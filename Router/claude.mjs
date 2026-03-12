// Claude CLI spawner — replaces centrifugo_stdio (Rust)
// Spawns Claude CLI as child process, parses stream-json stdout

import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { transformClaudeEvent, resetState } from './protocol.mjs';
import * as log from './log.mjs';

const TAG = 'claude';

export function spawnClaude(session, { claudePath, profile, mcpConfigPath, systemPromptPath, onEvent, onReady, onExit }) {
  resetState();

  const args = [
    '-p',
    '--verbose',
    '--input-format', 'stream-json',
    '--output-format', 'stream-json',
    '--include-partial-messages',
    '--disable-slash-commands',
    '--session-id', session.claudeSessionId,
    '--model', profile.model,
    '--system-prompt-file', systemPromptPath,
    '--mcp-config', mcpConfigPath,
    '--dangerously-skip-permissions',
    '--strict-mcp-config',
    '--settings', JSON.stringify({ disableAllHooks: true }),
  ];

  // Add allowedTools if specified
  if (profile.allowedTools.length > 0) {
    args.push('--allowedTools', profile.allowedTools.join(','));
  }

  log.info(TAG, `Spawning Claude CLI for session ${session.sessionId}`);

  // Remove CLAUDECODE env to allow nested Claude
  const env = { ...process.env };
  delete env.CLAUDECODE;

  const proc = spawn(claudePath, args, {
    stdio: ['pipe', 'pipe', 'pipe'],
    env,
  });

  session.claudeProcess = proc;
  session.streaming = false;
  log.info(TAG, `Claude PID=${proc.pid}`);

  let ready = false;

  // Parse stdout NDJSON (StringDecoder handles split multi-byte UTF-8 chars)
  const decoder = new StringDecoder('utf8');
  let buf = '';
  proc.stdout.on('data', (chunk) => {
    buf += decoder.write(chunk);
    const lines = buf.split('\n');
    buf = lines.pop(); // keep incomplete last line

    for (const line of lines) {
      if (!line.trim()) continue;
      log.debug(TAG, `stdout: ${line.slice(0, 200)}`);

      // Detect init event — Claude is ready
      try {
        const raw = JSON.parse(line);
        if (raw.type === 'system' && raw.subtype === 'init' && !ready) {
          ready = true;
          log.info(TAG, `Claude ready for session ${session.sessionId}`);
          if (onReady) onReady();
        }
      } catch {}

      const event = transformClaudeEvent(line);
      if (event) {
        // Track streaming state
        if (event.type === 'text_delta' || event.type === 'thinking_start') {
          session.streaming = true;
        }
        if (event.type === 'assistant_end') {
          session.streaming = false;
        }
        onEvent(event);
      }
    }
  });

  const stderrDecoder = new StringDecoder('utf8');
  proc.stderr.on('data', (chunk) => {
    const text = stderrDecoder.write(chunk).trim();
    if (text) log.debug(TAG, `stderr: ${text.slice(0, 300)}`);
  });

  proc.on('exit', (code) => {
    log.info(TAG, `Claude exited, code=${code}, session=${session.sessionId}`);
    session.claudeProcess = null;
    session.streaming = false;
    if (onExit) onExit(code);
  });

  function sendChat(text) {
    if (proc.stdin.writable) {
      const msg = JSON.stringify({
        type: 'user',
        message: { role: 'user', content: text },
      });
      proc.stdin.write(msg + '\n');
      session.streaming = true;
      log.info(TAG, `Sent chat: ${text.slice(0, 100)}`);
    } else {
      log.warn(TAG, 'Claude stdin not writable');
    }
  }

  function abort() {
    if (proc && !proc.killed) {
      log.info(TAG, `Aborting Claude (SIGINT) for session ${session.sessionId}`);
      proc.kill('SIGINT');
    }
  }

  return { proc, sendChat, abort };
}
