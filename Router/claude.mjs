// Claude CLI spawner — replaces centrifugo_stdio (Rust)
// Spawns Claude CLI as child process, parses stream-json stdout

import { spawn } from 'node:child_process';
import { transformClaudeEvent, resetState } from './protocol.mjs';
import * as log from './log.mjs';

const TAG = 'claude';

export function spawnClaude(session, { claudePath, profile, mcpConfigPath, systemPromptPath, onEvent }) {
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
  log.info(TAG, `Claude PID=${proc.pid}`);

  // Parse stdout NDJSON
  let buf = '';
  proc.stdout.on('data', (chunk) => {
    buf += chunk;
    const lines = buf.split('\n');
    buf = lines.pop(); // keep incomplete last line

    for (const line of lines) {
      if (!line.trim()) continue;
      log.debug(TAG, `stdout: ${line.slice(0, 200)}`);

      const event = transformClaudeEvent(line);
      if (event) {
        onEvent(event);
      }
    }
  });

  proc.stderr.on('data', (chunk) => {
    const text = chunk.toString().trim();
    if (text) log.debug(TAG, `stderr: ${text.slice(0, 300)}`);
  });

  proc.on('exit', (code) => {
    log.info(TAG, `Claude exited, code=${code}, session=${session.sessionId}`);
    session.claudeProcess = null;
  });

  function sendChat(text) {
    if (proc.stdin.writable) {
      const msg = JSON.stringify({
        type: 'user',
        message: { role: 'user', content: text },
      });
      proc.stdin.write(msg + '\n');
      log.info(TAG, `Sent chat: ${text.slice(0, 100)}`);
    } else {
      log.warn(TAG, 'Claude stdin not writable');
    }
  }

  return { proc, sendChat };
}
