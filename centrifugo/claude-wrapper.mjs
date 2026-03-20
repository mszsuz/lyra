// claude-wrapper.mjs — обёртка для centrifugo_stdio
//
// Читает JSON-строки из stdin, извлекает текст, вызывает `claude -p`,
// возвращает ответ как JSON в stdout.
//
// stdin:  {"type":"chat","text":"вопрос"}
// stdout: {"type":"assistant_output","text":"ответ Claude"}

import { createInterface } from 'node:readline';
import { spawn } from 'node:child_process';

const rl = createInterface({ input: process.stdin });

rl.on('line', (line) => {
  let data;
  try { data = JSON.parse(line); } catch { return; }

  const text = data.text;
  if (!text) return;

  process.stderr.write(`[claude-wrapper] Получен вопрос: "${text.slice(0, 80)}"\n`);

  // Убираем CLAUDECODE чтобы можно было запустить вложенный Claude Code
  const env = { ...process.env };
  delete env.CLAUDECODE;

  // Full path — needed when launched from 1C server service (no user PATH)
  const claudePath = process.env.CLAUDE_PATH || 'C:/Users/Andre/.local/bin/claude';
  const claude = spawn(claudePath, ['-p', '--model', 'sonnet'], {
    stdio: ['pipe', 'pipe', 'inherit'],
    env,
  });

  claude.stdin.write(text);
  claude.stdin.end();

  let response = '';
  claude.stdout.on('data', chunk => {
    response += chunk.toString();
  });

  claude.on('close', (code) => {
    process.stderr.write(`[claude-wrapper] Claude завершился (code=${code}), ответ ${response.length} символов\n`);
    if (response.trim()) {
      const output = JSON.stringify({
        type: 'assistant_output',
        text: response.trim(),
      });
      console.log(output);
    }
  });

  claude.on('error', (err) => {
    process.stderr.write(`[claude-wrapper] Ошибка запуска Claude: ${err.message}\n`);
  });
});
