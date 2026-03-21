// Claude CLI spawner — replaces centrifugo_stdio (Rust)
// Spawns Claude CLI as child process, parses stream-json stdout

import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { createParser } from './protocol.mjs';
import { writeClaude } from './history.mjs';
import { renderReminder } from './profiles.mjs';
import * as log from './log.mjs';

const TAG = 'claude';

function getToolDescription(toolName, toolLabels) {
  return toolLabels?.[toolName] || toolName;
}

export function spawnClaude(session, { claudePath, profile, mcpConfigPath, systemPromptPath, onEvent, onReady, onExit, resume = false }) {
  const parser = createParser();

  const args = [
    '-p',
    '--verbose',
    '--input-format', 'stream-json',
    '--output-format', 'stream-json',
    '--include-partial-messages',
    '--disable-slash-commands',
    '--model', profile.model,
    '--system-prompt-file', systemPromptPath,
    '--mcp-config', mcpConfigPath,
    '--dangerously-skip-permissions',
    '--strict-mcp-config',
    '--disallowedTools', 'Bash,Glob,Grep,Read,Edit,Write,NotebookEdit,WebFetch,WebSearch,TodoWrite,Task,TaskOutput,TaskStop,EnterPlanMode,ExitPlanMode,EnterWorktree,ExitWorktree,SendMessage,TeamCreate,TeamDelete,CronCreate,CronDelete,CronList,ToolSearch,Skill,LSP,ListMcpResourcesTool,ReadMcpResourceTool,AskUserQuestion',
    '--settings', JSON.stringify({ disableAllHooks: true }),
  ];

  // First spawn: --session-id (create new), respawn: --resume (reuse existing)
  if (resume) {
    args.push('--resume', session.claudeSessionId);
  } else {
    args.push('--session-id', session.claudeSessionId);
  }

  // Add allowedTools — merge model.json + vega.json (if Vega connected for this session)
  const allTools = [...profile.allowedTools];
  if (profile.vegaConfig?.allowedTools && session.configName) {
    const hasVega = profile.vegaConfig.configs?.[session.configName];
    if (hasVega) {
      allTools.push(...profile.vegaConfig.allowedTools);
    }
  }
  if (allTools.length > 0) {
    args.push('--allowedTools', allTools.join(','));
  }

  log.info(TAG, `Spawning Claude CLI for session ${session.sessionId}`);

  // Remove Claude Code env vars — child CLI must not think it's inside another session
  // CLAUDECODE=1 and CLAUDE_CODE_ENTRYPOINT=cli cause billing to switch from subscription to API
  const env = { ...process.env };
  delete env.CLAUDECODE;
  delete env.CLAUDE_CODE_ENTRYPOINT;
  delete env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS;

  // cwd = <dataDir>/users/<userId> — вне дерева исходников,
  // Claude CLI не подхватывает CLAUDE.md с техническими деталями архитектуры
  const userDir = resolve(process.env.LYRA_DATA_DIR || __dirname, 'users', session.userId || 'anonymous');
  mkdirSync(userDir, { recursive: true });

  const proc = spawn(claudePath, args, {
    stdio: ['pipe', 'pipe', 'pipe'],
    cwd: userDir,
    env,
  });

  session.claudeProcess = proc;
  session.streaming = false;
  session._spawnTime = Date.now();
  session._turnToolCount = 0;
  session._turnResearchTools = false;
  log.info(TAG, `Claude PID=${proc.pid}`);

  let ready = false;
  let firstTokenTime = 0;

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
      writeClaude(session, line);

      // Detect init event and MCP tool usage
      try {
        const raw = JSON.parse(line);
        if (raw.type === 'system' && raw.subtype === 'init' && !ready) {
          ready = true;
          const initMs = Date.now() - session._spawnTime;
          log.info(TAG, `Claude ready for session ${session.sessionId} (init: ${initMs}ms)`);
          if (onReady) onReady();
        }
        // Log MCP tool calls (Vega, mcp-1c-docs — go through CLI directly)
        if (raw.type === 'assistant' && raw.message?.content) {
          for (const block of raw.message.content) {
            if (block.type === 'tool_use') {
              const inputStr = JSON.stringify(block.input || {}).slice(0, 200);
              log.info(TAG, `⏱ MCP tool_use: ${block.name} | ${inputStr}`);
              // Track tool usage for memory hints
              session._turnToolCount++;
              if (/^mcp__vega__|^mcp__mcp-1c-docs__/.test(block.name)) {
                session._turnResearchTools = true;
              }
              // Emit tool_status for client UI (progress indicator)
              onEvent({
                type: 'tool_status',
                tool: block.name,
                description: getToolDescription(block.name, profile.toolLabels),
              });
            }
            if (block.type === 'tool_result') {
              const resultStr = typeof block.content === 'string' ? block.content.slice(0, 100) : JSON.stringify(block.content).slice(0, 100);
              log.info(TAG, `⏱ MCP tool_result: ${block.name || block.tool_use_id} | ${resultStr}`);
            }
          }
        }
      } catch {}

      const event = parser.transform(line);
      if (event) {
        // Timing: first token
        if (!firstTokenTime && (event.type === 'text_delta' || event.type === 'thinking_start')) {
          firstTokenTime = Date.now();
          const ttft = session._chatSentTime ? firstTokenTime - session._chatSentTime : firstTokenTime - session._spawnTime;
          log.info(TAG, `⏱ TTFT: ${ttft}ms (session ${session.sessionId})`);
        }

        // Track streaming state
        if (event.type === 'text_delta' || event.type === 'thinking_start') {
          session.streaming = true;
        }
        if (event.type === 'assistant_end') {
          session.streaming = false;
          const totalMs = session._chatSentTime ? Date.now() - session._chatSentTime : Date.now() - session._spawnTime;
          log.info(TAG, `⏱ Total response: ${totalMs}ms, tools=${session._turnToolCount}, research=${session._turnResearchTools} (session ${session.sessionId})`);
          // Attach turn metrics to event for server.mjs memory hint logic
          event._turnMs = totalMs;
          event._turnToolCount = session._turnToolCount;
          event._turnResearchTools = session._turnResearchTools;
          // Reset for next turn
          firstTokenTime = 0;
          session._turnToolCount = 0;
          session._turnResearchTools = false;
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
      // Wrap user text with system reminder if configured
      let content = text;
      const reminder = renderReminder(profile.systemReminderTemplate, session);
      if (reminder) {
        content = `<system>\n${reminder}\n</system>\n\n${text}`;
      }
      const msg = JSON.stringify({
        type: 'user',
        message: { role: 'user', content },
      });
      session._chatSentTime = Date.now();
      proc.stdin.write(msg + '\n');
      writeClaude(session, msg);
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
