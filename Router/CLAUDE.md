# Lyra-Router — Node.js роутер

Общайся с пользователем на русском языке.

## Что это

Центральный транспортный слой комплекса Lyra. Один Node.js процесс — заменяет ЕХТ_Лира_Роутер (BSL), centrifugo_stdio (Rust) и 1c-mcp-relay (Node.js).

## Стратегия

Фаза CLI → Фаза API:
1. **Сейчас (CLI):** Claude CLI как child process, ноль npm-зависимостей
2. **Потом (API):** `@anthropic-ai/sdk`, прямые вызовы, tool calls в процессе

## Стек

- **Node.js 22+** — встроенный WebSocket, fetch, crypto
- **Centrifugo v6** — realtime транспорт (WebSocket/SSE)
- **Claude CLI** — child process, stream-json
- **Ноль npm-зависимостей** (фаза CLI)

## Статус

**Фазы 1–3 реализованы и протестированы на реальном Чате (1С EPF).**

1. **Hello flow** ✅ — connect → hello → hello_ack (auto_auth MVP) → spawn Claude CLI
2. **Claude streaming** ✅ — chat → Claude CLI → text_delta/thinking_delta → канал сессии
3. **Tool calls** ✅ — Claude → MCP → HTTP → Centrifugo → Chat EPF → tool_result → Claude
4. **Polish** ✅ — disconnect, reconnect, abort, TTL cleanup

## Архитектура

```
Chat (1C EPF) ──► Centrifugo ──► Node.js Router ──► Claude CLI (child process)
Mobile app ─────►    :11000     │    │                 ↕ MCP
                                │    │            tools-mcp.mjs ──► Router HTTP ──► Centrifugo ──► Chat EPF
                                │    └── Vega (HTTP MCP, напрямую через CLI)
                                └── users/billing (in-memory MVP)
```

### Как работают 1C-инструменты

1. Claude CLI спавнит `tools-mcp.mjs` (MCP server, stdio) через `--mcp-config`
2. Claude вызывает `lyra_data_query` → `tools-mcp.mjs` получает MCP request
3. `tools-mcp.mjs` отправляет HTTP POST на Router `localhost:<port>/tool-call`
4. Router публикует `tool_call` в Centrifugo → Chat EPF выполняет → `tool_result` приходит обратно
5. Router отвечает на HTTP → `tools-mcp.mjs` возвращает MCP response → Claude продолжает

## Файлы

```
Router/
├── server.mjs          — точка входа, диспетчер, push dispatcher
├── config.mjs          — загрузка config.json + centrifugo/config.json
├── config.json         — конфигурация роутера
├── centrifugo.mjs      — WS-клиент (built-in) + Server API (fetch)
├── sessions.mjs        — Map сессий, индекс по form_id, TTL cleanup
├── jwt.mjs             — HMAC SHA-256 (node:crypto)
├── claude.mjs          — spawn Claude CLI, stream-json → protocol.mjs
├── tools-mcp.mjs       — MCP server (stdio), спавнится Claude CLI для lyra_* tools + память (fs)
├── tools.mjs           — HTTP endpoint для tool_call/tool_result
├── protocol.mjs        — stream-json → универсальный протокол
├── history.mjs         — JSONL-лог сессии, сохранение вложений
├── profiles.mjs        — загрузка профилей, шаблонизация промптов, MCP config
├── users.mjs           — in-memory пользователи (MVP)
├── log.mjs             — структурированный лог в stderr + router.log
├── test-hello.mjs      — тест hello flow
├── test-resume.mjs     — тест resume (kill Claude → respawn → память сохраняется)
├── package.json        — type: module, без зависимостей
├── profiles/default/
│   ├── model.json          — модель, mode (роль), allowedTools
│   ├── system-prompt.md    — шаблон промпта ({{ }} переменные)
│   ├── tools.json          — описания lyra_* инструментов (input_schema)
│   ├── tool-labels.json    — человекочитаемые описания инструментов для UI клиента
│   └── vega.json           — маппинг конфигураций → Vega порты
├── .lobby/<session_id>/ — данные неавторизованных сессий (в .gitignore)
│   ├── system-prompt.md   — отрендеренный промпт
│   ├── mcp-config.json    — MCP config для Claude CLI
│   ├── history.jsonl      — JSONL-лог всех событий (in/out)
│   └── attach/            — вложения (если есть)
├── .users/<user_id>/   — данные авторизованных сессий (в .gitignore)
├── memory/<config>/   — память модели по конфигурациям
│   ├── registry.md        — реестр знаний (загружается в системный промпт)
│   └── skills/<name>.md   — файлы знаний (загружаются по запросу через lyra_memory_read)
├── CLAUDE.md           — этот файл
├── ЕХТ_Лира_Роутер/    — симлинк на расширение 1С (историческое)
└── ЕХТ_СтдИО/          — симлинк на расширение 1С (историческое)
```

## Запуск

```bash
# Centrifugo должен быть запущен
cd centrifugo && ./centrifugo.exe --config=config.json

# Router
cd Router && node server.mjs

# Тест hello flow
node test-hello.mjs
```

## Взаимодействие с Centrifugo

### WebSocket-клиент (приём)

Роутер подключается с JWT, содержащим `channels: ["session:lobby", "mobile:lobby"]` — авто-подписка при connect (namespace `session:` имеет `allow_subscribe_for_client: false`).

Для каналов сессий — Server API subscribe (`apiSubscribe(user, client, channel)`).

Push dispatcher в server.mjs маршрутизирует по каналу и типу:

| Канал | type | Действие |
|-------|------|----------|
| session:lobby | hello | create session, JWT, apiSubscribe, hello_ack, spawn Claude |
| session:* | chat | claude.sendChat(text) → stdout → protocol → apiPublish |
| session:* | tool_result | resolve pending promise |
| session:* | auth | verify, auth_ack |
| session:* | abort | kill streaming, send assistant_end(aborted) |
| session:* | disconnect | kill Claude process, пометить сессию disconnected |
| mobile:lobby | register/confirm | MVP обработка |

### Server API (управление + отправка)

- `apiSubscribe(user, client, channel)` — подписать клиента на канал (hello_ack delivery, router self-subscribe)
- `apiPublish(channel, data)` — hello_ack, стриминг text_delta, auth_ack, tool_call

## JWT

Роутер генерирует 2 персональных JWT при hello:

| Токен | sub | channels | TTL |
|-------|-----|----------|-----|
| chat_jwt | `chat-<session_id>` | `[session:<session_id>]` | 1 год |
| mobile_jwt | `mobile-<session_id>` | `[session:<session_id>]` | 1 год |

Авто-подписка через channels claim — клиент получает `subs` в connect response.

## Универсальный протокол (protocol.mjs)

Claude stream-json → model-agnostic events:

| Claude stream-json | → | Универсальный протокол |
|---|---|---|
| `content_block_delta` → `text_delta` | → | `{type: "text_delta", text}` |
| `content_block_start` (thinking) | → | `{type: "thinking_start"}` |
| `content_block_delta` → `thinking_delta` | → | `{type: "thinking_delta", text}` |
| `content_block_stop` (after thinking) | → | `{type: "thinking_end"}` |
| `result` | → | `{type: "assistant_end", text}` |

## Профили

`profiles/default/` — набор файлов для конфигурации Claude сессии:

- **model.json** — модель (`sonnet`), `mode` (роль пользователя), `allowedTools` (MCP tool names)
- **system-prompt.md** — шаблон с `{{ ИмяКонфигурации }}`, `{{ ТекущаяДата }}`, `{% Если %}` блоками
- **tools.json** — описания lyra_* инструментов для MCP server (input_schema, hints)
- **tool-labels.json** — человекочитаемые описания инструментов для UI клиента (например `"mcp__1c__lyra_data_query": "Получаю данные из базы..."`)
- **vega.json** — маппинг config_name → Vega MCP port

**Hot reload:** профиль перечитывается при каждом спавне Claude (`loadProfile()` в `spawnClaudeForSession`). Можно менять tools.json, model.json, system-prompt.md, tool-labels.json без перезапуска роутера — изменения подхватятся при следующей сессии или респавне.

## MCP Config (генерируется для каждой сессии)

```json
{
  "mcpServers": {
    "1c": {
      "command": "node",
      "args": ["tools-mcp.mjs"],
      "env": { "LYRA_TOOLS_URL": "http://localhost:<port>/tool-call", "LYRA_SESSION_ID": "<id>" }
    },
    "mcp-1c-docs": {
      "type": "http",
      "url": "http://localhost:6280/mcp"
    },
    "vega": {
      "type": "http",
      "url": "http://localhost:<vega_port>/mcp",
      "headers": {"X-API-Key": "vega"}
    }
  }
}
```

## Переподключение

По `form_id` (UUID формы). Известный form_id + живая сессия → hello_ack status `reconnected`, новый chat_jwt, Claude продолжает.

## Resume (восстановление Claude после краша)

При падении/убийстве Claude CLI процесса сессия сохраняется. При следующем сообщении пользователя:

1. Router видит `claudeProcess === null` → respawn с `--resume <sessionId>` (не `--session-id`)
2. `--resume` восстанавливает историю диалога — Claude помнит контекст
3. Сообщение отправляется в stdin **сразу** после spawn (не дожидаясь `init`)

**Важно:** Claude CLI 2.1.74 не эмитит `init` до получения первого сообщения в stdin. В режиме resume `initialMessage` отправляется немедленно, иначе — дедлок.

Сценарии resume:
- **reconnect** (hello с известным form_id, Claude мёртв) → `spawnClaudeForSession(session, null, { resume: true })`
- **handleChat** (Claude мёртв, пришло сообщение) → `spawnClaudeForSession(session, text, { resume: true })`
- **onExit + pendingMessage** (Claude упал при pending) → `spawnClaudeForSession(session, text, { resume: true })`

## Шаблонизация промптов

Поддержка кириллицы в переменных через Unicode regex `[\p{L}\w]+` с флагом `/u`:
- `{{ ИмяКонфигурации }}` → подстановка переменной
- `{% Если Режим = "founder" Тогда %}...{% КонецЕсли; %}` — условные блоки

Переменная `Режим` берётся из `mode` в `model.json` профиля (по умолчанию `"user"`). Допустимые значения:

| mode | Описание |
|------|----------|
| `founder` | Основатель продукта. Полный доступ, можно обсуждать архитектуру, промпты, модели |
| `advanced_user` | Продвинутый пользователь 1С (программист, аналитик, администратор). Код и технические термины разрешены, архитектура Лиры скрыта |
| `user` | Обычный пользователь (бухгалтер, кадровик, менеджер). Простой язык, код скрыт, архитектура скрыта |

## Логирование и хронометраж

`log.mjs` пишет в stderr + файл `router.log` (через `appendFileSync`, обходит буферизацию Node.js при перенаправлении stderr).

Тайминги (метки `⏱` в логах):
- `chat RECEIVED` — момент получения сообщения от пользователя
- `TTFT` (Time To First Token) — от отправки в Claude до первого токена
- `MCP tool_use` — вызов MCP-инструмента (Vega, mcp-1c-docs) через Claude CLI
- `tool_call START/END` — вызов lyra_* инструмента через Centrifugo → Chat EPF (с длительностью в мс)
- `Total response` — полное время ответа Claude
- `SUMMARY` — total от chat received до assistant_end

## Фильтрация событий

- `thinking_delta` — **не передаётся** клиенту. Чат показывает "Анализирую...", текст размышлений не нужен. Фильтрация предотвращает disconnect 3012 (no pong) — клиент не успевал обрабатывать поток thinking при длинных ответах.
- `tool_status` — уведомление о вызове MCP-инструмента (`{type: "tool_status", tool, description}`). Описание берётся из `tool-labels.json`. Клиент показывает статусы с группировкой и дедупликацией.

## История сессий (history.mjs)

Каждая сессия пишет JSONL-лог всех событий, проходящих через роутер. Файл `history.jsonl` в папке сессии (`.lobby/<session_id>/` до авторизации, `.users/<user_id>/<session_id>/` после).

Формат записи: `{"ts":"ISO","dir":"in|out","type":"...","...":"..."}`

- `dir: "in"` — входящие (от клиента: hello, chat, tool_result, auth, abort, disconnect)
- `dir: "out"` — исходящие (к клиенту: hello_ack, thinking_start/end, assistant_end, tool_call, auth_ack)
- Вложения из массива `attach` сохраняются в подпапку `attach/`, в JSONL пишутся относительные пути
- При успешной авторизации (`handleAuth`) папка сессии переносится из `.lobby/` в `.users/<userId>/`

## Память модели (memory)

Персистентная память Claude, привязанная к конфигурации 1С. Лира накапливает знания (запросы, структуры, особенности) — они доступны во всех будущих сессиях всех пользователей этой конфигурации.

### Архитектура

```
Router/memory/
├── Accounting/           — знания по Бухгалтерии
│   ├── registry.md       — краткий реестр (загружается в системный промпт)
│   └── skills/
│       ├── debitorka-query.md
│       └── ostatki-tovarov.md
├── Retail23/             — знания по Рознице 2.3
│   ├── registry.md
│   └── skills/...
└── ...
```

### Инструменты

| Инструмент | Обработка | Описание |
|------------|-----------|----------|
| `lyra_memory_list` | tools-mcp.mjs (локально) | Реестр знаний (registry.md) |
| `lyra_memory_read` | tools-mcp.mjs (локально) | Чтение файла знания (skills/*.md) |
| `lyra_memory_save` | tools-mcp.mjs (локально) | Сохранение знания + обновление реестра |

**Важно:** инструменты памяти обрабатываются в `tools-mcp.mjs` локально (файловый I/O), без HTTP и без Centrifugo. Ключ привязки — `LYRA_CONFIG_NAME` (env var, имя конфигурации в Vega).

### Загрузка в промпт

`registry.md` загружается в системный промпт через переменную `{{ ПамятьКонфигурации }}` в `renderSystemPrompt()`. Лира видит реестр знаний сразу при старте сессии и может загрузить нужное знание через `lyra_memory_read`.

### Memory hint (автоподсказка)

После `assistant_end` Роутер проверяет метрики ответа. Если ответ был «дорогим» — отправляет Лире системную подсказку сохранить знание:

**Критерии:** `totalMs > 30000` И `toolCount > 3` И `researchTools = true` (Vega или mcp-1c-docs)

**Поток:**
1. `claude.mjs` трекает `_turnToolCount` и `_turnResearchTools` за каждый turn
2. `server.mjs` после assistant_end проверяет метрики → отправляет hint через `sendChat()`
3. `session._memoryHintActive = true` — подавляет hint-ответ от клиента
4. `tool_status` ("Сохраняю знание...") пропускается к клиенту
5. `assistant_end` hint-ответа записывается в history с `_memory_hint: true`, но НЕ публикуется в Centrifugo

**Результат:** знание сохраняется автоматически, пользователь не видит лишних сообщений. Повторный вопрос отрабатывает в ~6 раз быстрее (25 сек vs 2.5 мин в тесте на БухгалтерияПредприятия).

## Vega MCP

Vega подключается к Claude CLI как HTTP MCP server (через `--mcp-config`). Маппинг конфигураций → порты в `profiles/default/vega.json`. Роутер добавляет Vega в MCP config по `config_name` из hello.

Инструменты Vega: `search_metadata`, `search_metadata_by_description`, `search_code` (семантический поиск по коду конфигурации).

## Фазы реализации

1. **Hello flow** ✅ — протестировано на реальном Чате
2. **Claude streaming** ✅ — протестировано, UTF-8 streaming через StringDecoder
3. **Tool calls** ✅ — протестировано, lyra_meta_list возвращает данные из базы 1С
4. **Polish** ✅ — disconnect, reconnect, abort, TTL cleanup, resume
5. **Vega + хронометраж** ✅ — Vega MCP подключён, логирование с таймингами
6. **Память модели** ✅ — lyra_memory_list/read/save + автоподсказка, протестировано на демо-базе БухгалтерияПредприятия

## Переход на API (будущее)

1. `npm install @anthropic-ai/sdk`
2. Переписать `claude.mjs`: SDK stream вместо spawn
3. Tool calls в процессе (без MCP, без HTTP endpoint)
4. Удалить `tools-mcp.mjs`
