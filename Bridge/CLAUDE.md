# 1C-Claude Bridge v2

Общайся с пользователем на русском языке.

## Что это

Мост между 1С:Предприятие 8 и Claude Code через WebSocket. Пользователь в 1С пишет вопрос — Claude отвечает по буквам (стриминг). Claude может запрашивать данные из базы 1С через MCP-инструменты.

## Архитектура

```
Claude Code  <── stdin/stdout (stream-json) ──>  Bridge (:3003)  <── WebSocket ──>  1С
     │                                             ^  ^
     │  stdio MCP                                  │  │
     └───> bridge.js --mcp --session X ───────────┘  └─── 1С (WebSocket-клиент)
```

- Один скрипт `bridge.js`, два режима: основной (`node bridge.js`) и MCP (`node bridge.js --mcp --session <id>`)
- Claude Code запускается как дочерний процесс bridge
- MCP-режим запускается Claude Code как его MCP-сервер, подключается обратно к bridge через WebSocket
- 1С НЕ реализует протокол MCP — работает с простыми JSON (mcp_request/mcp_response)

## Файлы проекта

| Файл | Назначение |
|---|---|
| `bridge.js` | Основной мост — 380 строк, 11 функций |
| `package.json` | Зависимости: ws, @modelcontextprotocol/sdk |
| `PLAN-1C-CLAUDE-BRIDGE.md` | Полный план: спецификации, протокол, тесты, замеры |
| `test-bridge-full.js` | Полный тест 8/8 (чат + MCP + reconnect) |
| `test-bridge-multi.js` | Тест множественных сессий 4/4 |
| `test-bridge-speed.js` | Замер скорости старта |
| `test-bridge.js`, `test-bridge2.js` | Ранние тесты (исторические) |
| `test-stream*.js` | Эксперименты с форматом stream-json (1-5) |
| `logs/*.log` | Логи сессий bridge |

## Запуск и тестирование

```bash
# Установка зависимостей (уже есть node_modules)
npm install

# Запуск bridge
node bridge.js

# Тесты (bridge должен работать)
node test-bridge-full.js     # 8/8: чат, MCP, reconnect
node test-bridge-multi.js    # 4/4: две сессии одновременно
node test-bridge-speed.js    # замер скорости старта
```

Порт по умолчанию: 3003. Можно изменить: `node bridge.js --port 3005`.

## Формат stream-json

**Вход Claude (stdin):**
```json
{"type":"user","message":{"role":"user","content":"текст"}}
```

Content может быть строкой или массивом блоков (Anthropic Messages API):
```json
{"type":"user","message":{"role":"user","content":[
  {"type":"text","text":"Посмотри:"},
  {"type":"image","source":{"type":"base64","media_type":"image/png","data":"..."}}
]}}
```

**Выход Claude (stdout) — NDJSON, каждая строка отдельный JSON:**
- `{"type":"system","subtype":"init",...}` — готовность Claude
- `{"type":"stream_event","event":{"type":"content_block_delta","delta":{"text":"фрагмент"}}}` — стриминг по буквам
- `{"type":"assistant","message":{"content":[{"type":"text","text":"полный ответ"}]}}` — полное сообщение
- `{"type":"result","result":"текст","duration_ms":...,"total_cost_usd":...}` — финал

## WebSocket-протокол (1С <-> Bridge)

**Bridge → 1С:**
- `{"type":"session","sessionId":"uuid"}` — при подключении
- raw NDJSON от Claude (стриминг, результаты, системные события)
- `{"type":"mcp_request","requestId":"uuid","tool":"v8_eval","params":{...}}` — запрос инструмента
- `{"type":"claude_exit","code":0}` — Claude завершился

**1С → Bridge (заголовки при подключении):**
- *(без заголовков)* — новая сессия, случайный UUID
- `claude-session-id: <uuid>` — новая сессия с заданным ID (`--session-id`)
- `claude-resume: <uuid>` — возобновление существующей сессии Claude (`--resume`), bridge автоматически ищет папку проекта в `~/.claude/projects/`

**1С → Bridge (сообщения):**
- `{"type":"chat","content":"текст"}` — сообщение пользователя
- `{"type":"mcp_response","requestId":"uuid","result":"..."}` — ответ на инструмент
- `{"type":"mcp_response","requestId":"uuid","error":"..."}` — ошибка инструмента

## MCP-серверы

### 1c (stdio, через bridge)

Инструменты для работы с базой 1С. Bridge выступает адаптером: Claude говорит по MCP/JSON-RPC, 1С работает с простыми JSON (mcp_request/mcp_response).

| tool | params | Описание |
|---|---|---|
| `v8_query` | `{query, params?}` | Запрос на языке 1С (ВЫБРАТЬ...ИЗ..., НЕ SQL!) |
| `v8_eval` | `{expression}` | Вычислить выражение (Строка(ТекущаяДата())) |
| `v8_metadata` | `{path?}` | Дерево метаданных конфигурации |
| `v8_exec` | `{code}` | Выполнить блок кода 1С |

### vega (HTTP)

MCP-сервер Vega, подключается напрямую по HTTP (не через bridge).

- URL: `http://localhost:60010/mcp`
- Заголовок: `X-API-Key: vega`

## Запуск Claude из bridge (ключевые флаги)

```javascript
const claudeArgs = [
  '-p',
  '--output-format', 'stream-json',
  '--input-format', 'stream-json',
  '--include-partial-messages',
  '--verbose',
  '--disable-slash-commands',
  // --resume <id> для возобновления, --session-id <id> для новой сессии
  s.resume && projectDir ? '--resume' : '--session-id', s.id,
  '--mcp-config', mcpConfig,
  '--system-prompt', systemPrompt,
  '--strict-mcp-config',
  '--settings', JSON.stringify({ disableAllHooks: true }),
];
// При resume — cwd в папку проекта, найденную по session ID
spawn('claude', claudeArgs, { cwd: projectDir || undefined, ... });
```

**Критичные флаги:**
- `--resume` vs `--session-id` — `--resume` загружает историю существующей сессии, `--session-id` создаёт новую с заданным ID
- `--allowedTools` — убран, инструменты не ограничиваются (ранее без него Claude блокировал MCP в -p режиме, сейчас работает без ограничений)
- `--strict-mcp-config` — загружать только наш MCP, не тянуть всё из .mcp.json (ускоряет старт)
- `--settings '{"disableAllHooks":true}'` — отключить хуки (ускоряет старт)

**Resume-логика:** при заголовке `claude-resume`, bridge ищет файл `<sessionId>.jsonl` в `~/.claude/projects/*/`, декодирует имя папки проекта обратно в путь и запускает Claude с `--resume` и `cwd` в эту папку.

## Результаты тестирования (12/12 passed)

| Тест | Результат |
|---|---|
| Session ID получен | ✅ |
| Стриминг дельт текста | ✅ |
| Result получен | ✅ |
| MCP: Claude вызвал v8_eval | ✅ |
| MCP: Claude использовал данные от 1С | ✅ |
| Переподключение: session сохранился | ✅ |
| Переподключение: Claude ответил | ✅ |
| Две сессии: разные session ID | ✅ |
| Две сессии: оба получили ответы | ✅ |
| Две сессии: ответы не перепутались | ✅ |

## Скорость старта (после оптимизации)

| Метрика | До | После |
|---|---|---|
| init received | ~22 сек | **2.6 сек** |
| Первая дельта | ~26 сек | **6.2 сек** |
| Полный ответ | ~27 сек | **6.3 сек** |

Из 6.3 сек ~4 сек — API Anthropic. Старт самого Claude Code ~2.5 сек.

## Найденные и решённые проблемы

1. **MCP permissions** — без `--allowedTools` Claude блокирует инструменты в -p режиме
2. **Init задержка** — не ждать init, отправлять сообщение сразу, Claude буферизует stdin
3. **Deferred tools** — MCP-инструменты deferred, Claude сначала вызывает ToolSearch чтобы их найти
4. **Медленный старт** — решено: `--strict-mcp-config` + `--settings disableAllHooks` + удаление плагина superpowers

## Открытые вопросы

- [ ] Аутентификация / безопасность WebSocket через интернет
- [ ] Обработка ошибок (обрывы связи, ошибки 1С, рестарт Claude)
- [ ] Обработка 1С (WebSocket-клиент + чат-интерфейс)
- [ ] Компиляция bridge в бинарник (`bun build --compile`) для ещё более быстрого старта MCP-режима

## Windows + Git Bash подводные камни

- `taskkill` из Git Bash: использовать `//PID` `//T` `//F` (двойной слэш)
- `node` с путями: использовать прямые слэши `C:/WORKS/...` или кавычки, не `C:\\WORKS\\`
- `cmd` из Git Bash: `cmd //c "C:\\путь\\script.bat"`
