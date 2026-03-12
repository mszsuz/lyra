# План: профили, системный промпт, MCP-инструменты

Статус: обсуждение

## Контекст

Цепочка Чат → Centrifugo → Роутер → centrifugo_stdio → Claude работает (подтверждено 2026-03-11).
Нужно добавить системный промпт, настройки модели и инструменты.

## Целевая архитектура

```
                                     Профили/Основной/
                                     ┌─────────────────────┐
                                     │ system-prompt.md    │
                                     │ model.json          │
                                     │ tools.json          │
                                     │ mcp-config.json     │
                                     └────────┬────────────┘
                                              │ читает при
                                              │ создании сессии
                                              ▼
┌─────────┐   {chat,text}   ┌───────────────────────┐  {user,message}   ┌─────────────────┐
│         │ ──────────────► │                       │ ────────────────► │                 │
│  Чат    │   session:      │      Роутер           │    pipe:          │centrifugo_stdio │
│  (1С)   │ ◄────────────── │      (1С)             │ ◄──────────────── │                 │
│         │  text_delta,    │                       │  stream-json      │   stdin/stdout  │
│         │  assistant_end  │  - шаблонизация       │                   │        │        │
│         │                 │    промпта            │                   └────────┼────────┘
│         │                 │  - трансформация      │                            │
│         │                 │    stream-json ↔      │                            │
│         │                 │    универсальный      │                  ┌─────────┼───────┐
│         │                 │  - запуск процессов   │                  │   Claude CLI    │
│         │                 │                       │                  │                 │
│         │                 └───────────────────────┘                  │  --system-prompt│
│         │                                                            │  --model        │
│         │                                                            │  --mcp-config   │
│         │                                                            │  --allowedTools │
│         │                 ┌───────────────────────────────────┐      │                 │
│         │  tool_call      │       1c-mcp-relay                │ stdin│MCP stdio        │
│         │ ◄───────────────│                                   │◄─────┤                 │
│         │   session:      │  - initialize    → ответ сам      │      │                 │
│         │                 │  - tools/list    → из tools.json  │stdout│                 │
│         │  tool_result    │  - tools/call    → tool_call      │─────►│                 │
│         │ ────────────────│    в session:    ← tool_result    │      │                 │
│         │   session:      │                                   │      │                 │
│         │                 │  Подключён к session:<id>         │      │                 │
└─────────┘                 │  через Centrifugo WebSocket       │      └─────────────────┘
                            └───────────────────────────────────┘
                                                                       ┌─────────────────┐
                                                                       │  MCP-серверы    │
                            Все каналы через Centrifugo (:11000)       │  (серверные)    │
                            ┌──────────────────────────────────┐       │                 │
                            │  session:<id>  — Чат, мобильное, │       │  vega-Trade     │
                            │                 Роутер, Биллинг, │       │  vega-HRM       │
                            │                 1c-mcp-relay     │       │  mcp-1c-docs    │
                            │  pipe:<id>     — Роутер ↔        │       │  ...            │
                            │                 centrifugo_stdio │       │                 │
                            │  session:lobby — hello           │       │  (запускаются   │
                            └──────────────────────────────────┘       │   Claude CLI    │
                                                                       │   напрямую)     │
                                                                       └─────────────────┘

Потоки данных:

  Сообщение пользователя:
  Чат → {type:"chat"} → session: → Роутер → {type:"user"} → pipe: → centrifugo_stdio → Claude

  Ответ модели (стриминг):
  Claude → stdout → centrifugo_stdio → pipe: → Роутер → {type:"text_delta"} → session: → Чат

  Вызов инструмента 1С (v8_query и др.):
  Claude → stdio MCP → 1c-mcp-relay → {type:"tool_call"} → session: → Чат
  Чат выполняет → {type:"tool_result"} → session: → 1c-mcp-relay → stdio MCP → Claude

  Вызов серверного инструмента (vega, docs):
  Claude → stdio MCP → vega-Trade/mcp-1c-docs → ответ → Claude
  (напрямую, без Centrifugo)
```

## Что есть сейчас

### Рабочая цепочка (без инструментов)
```
Чат → {type:"chat", text} → session: → Роутер → pipe: → centrifugo_stdio → stdin Claude
Claude stdout → centrifugo_stdio → pipe: → Роутер → трансформация → session: → Чат
```

### Код Роутера (ЗапуститьМодельДляСессии)
- Генерирует JSON-конфиг для centrifugo_stdio (program, args)
- Args: `-p --verbose --input-format stream-json --output-format stream-json --include-partial-messages --disable-slash-commands --session-id <uuid> --model sonnet`
- Нет системного промпта
- Нет MCP-серверов
- Нет описания инструментов

### МодульMCP в Чате (текущий, ~577 строк)
- Полная реализация MCP JSON-RPC: initialize, tools/list, tools/call
- 4 серверных обработчика: v8_query, v8_metadata, v8_eval, v8_exec
- Использовался с Bridge (JSON-RPC от Claude → Bridge → 1С → Bridge → Claude)

### Bridge (референс, bridge.js)
- Запускал себя как MCP-сервер: `bridge.js --mcp --session <id>`
- MCP relay = 25 строк, тупая труба: stdin ↔ WebSocket
- **1С сама обрабатывала JSON-RPC** (initialize, tools/list, tools/call в МодульMCP)
- Bridge только пересылал JSON-RPC между Claude и 1С

---

## Задача 1: Профили (файлы настроек)

### Расположение
```
C:\1ext.ru\projects\github.com\ЕХТ_Лира_Роутер\Профили\Основной\
├── system-prompt.md    — шаблон системного промпта
├── model.json          — модель, allowedTools
├── tools.json          — описания v8_* инструментов (inputSchema)
└── mcp-config.json     — статические MCP-серверы (vega-*, mcp-1c-docs)
```

### system-prompt.md
Шаблон с переменными ЕХТ_Шаблонизатор (`{{ }}`):
```markdown
Ты Лира — AI-ассистент для 1С:Предприятие.

Ты подключена к базе: {{ ИмяКонфигурации }} версии {{ ВерсияКонфигурации }}.
Компьютер: {{ Компьютер }}.
{# Идентификатор конфигурации для определения типовая/доработанная #}
{% Если ИдентификаторКонфигурации <> "" Тогда %}
Идентификатор конфигурации: {{ ИдентификаторКонфигурации }}
{% КонецЕсли; %}

Отвечай на русском языке.
Язык запросов 1С — это НЕ SQL. Используй ВЫБРАТЬ, ИЗ, ГДЕ (не SELECT, FROM, WHERE).
Даты в запросах: ДАТАВРЕМЯ(2025,1,1).
```

Роутер при запуске сессии:
1. Читает шаблон из профиля
2. Подставляет данные из hello через ЕХТ_Шаблонизатор
3. Записывает во временный файл
4. Передаёт Claude через `--system-prompt-file <путь>`

### model.json
```json
{
  "model": "sonnet",
  "allowedTools": [
    "mcp__1c__v8_query",
    "mcp__1c__v8_eval",
    "mcp__1c__v8_exec",
    "mcp__1c__v8_metadata",
    "mcp__vega-Trade__search_metadata",
    "mcp__vega-Trade__search_code",
    "mcp__vega-Trade__search_metadata_by_description",
    "mcp__vega-Accounting__*",
    "mcp__vega-HRM__*",
    "mcp__vega-Enterprise20__*",
    "mcp__vega-Retail23__*",
    "mcp__vega-Demo__*",
    "mcp__mcp-1c-docs__*"
  ]
}
```

Вопрос: поддерживает ли Claude CLI wildcards в `--allowedTools`? Если нет — перечислять все.

### tools.json
Описания клиентских инструментов (v8_*) для регистрации через MCP:
```json
{
  "tools": [
    {
      "name": "v8_query",
      "description": "Выполнить запрос на языке запросов 1С (ВЫБРАТЬ ... ИЗ ...). Это НЕ SQL!",
      "inputSchema": {
        "type": "object",
        "properties": {
          "query": {"type": "string", "description": "Текст запроса 1С"},
          "params": {"type": "object", "description": "Параметры запроса (необязательно)"}
        },
        "required": ["query"]
      }
    },
    {
      "name": "v8_eval",
      "description": "Вычислить выражение 1С. Только выражения, НЕ процедуры. Пример: Строка(ТекущаяДата())",
      "inputSchema": {
        "type": "object",
        "properties": {
          "expression": {"type": "string", "description": "Выражение на языке 1С"}
        },
        "required": ["expression"]
      }
    },
    {
      "name": "v8_metadata",
      "description": "Получить дерево/ветку метаданных конфигурации 1С",
      "inputSchema": {
        "type": "object",
        "properties": {
          "path": {"type": "string", "description": "Путь в дереве метаданных (пусто = корень)"}
        }
      }
    },
    {
      "name": "v8_exec",
      "description": "Выполнить блок кода на языке 1С (процедуры, циклы, условия, присваивания)",
      "inputSchema": {
        "type": "object",
        "properties": {
          "code": {"type": "string", "description": "Код на встроенном языке 1С"}
        },
        "required": ["code"]
      }
    }
  ]
}
```

### mcp-config.json (статическая часть)
```json
{
  "mcpServers": {
    "vega-Trade": {
      "type": "http",
      "url": "http://localhost:60010/mcp",
      "headers": {"X-API-Key": "vega"}
    },
    "mcp-1c-docs": {
      "command": "...",
      "args": ["..."]
    }
  }
}
```
Роутер при запуске сессии мержит с динамическим MCP-сервером `1c` (relay).

---

## Задача 2: MCP для клиентских инструментов (v8_*) — КЛЮЧЕВОЙ ВОПРОС

Claude CLI знает об инструментах только через MCP-серверы. v8_* выполняются в базе
клиента (через Чат). Нужен MCP-сервер-посредник.

### Как было в Bridge
```
Claude CLI ←stdio MCP→ bridge.js --mcp ←WebSocket→ bridge.js ←WebSocket→ 1С (МодульMCP)
```
- MCP relay (bridge.js --mcp) = 25 строк, тупая труба stdin↔WebSocket
- 1С (МодульMCP) отвечала на initialize, tools/list, tools/call
- Bridge пересылал JSON-RPC прозрачно

### Варианты для новой архитектуры

#### ~~Вариант А: centrifugo_stdio как MCP relay (второй экземпляр)~~ — отклонён
Нужен отдельный namespace mcp:, проблема с initialize/tools/list, усложняет Роутер.

#### ~~Вариант Б: Node.js MCP relay~~ — поглощён вариантом Д

#### ~~Вариант В: centrifugo_stdio --mode mcp~~ — отклонён
Усложняет centrifugo_stdio (добавление JSON-RPC логики в Rust).

#### ~~Вариант Г: Чат обрабатывает JSON-RPC~~ — отклонён
JSON-RPC остаётся в Чате, описания инструментов приходится передавать из Роутера в Чат.

#### Вариант Д: MCP sidecar (РЕКОМЕНДУЕМЫЙ)

Источник: [IDEA-MCP-SIDECAR.md](IDEA-MCP-SIDECAR.md)

```
Claude CLI ←stdio MCP→ 1c-mcp-relay ←WS Centrifugo→ session:<id> ←→ Чат
                        (самостоятельный MCP-сервер)
```

**1c-mcp-relay** — отдельный процесс, запускается Claude CLI как MCP-сервер:
- Сам отвечает на `initialize` (capabilities, serverInfo)
- Сам отвечает на `tools/list` (из tools.json, путь в аргументах)
- На `tools/call` → публикует `{type:"tool_call", request_id, tool, params}` в session:
- Ждёт `{type:"tool_result", request_id, result/error}` из session:
- Формирует JSON-RPC ответ → stdout → Claude

Что это даёт:
- **Роутер не трогаем** — никакого JSON-RPC, никакого mcp: namespace
- **Чат не трогаем** — tool_call/tool_result уже работает в главной форме
- **centrifugo_stdio не трогаем** — остаётся тупой трубой pipe:↔stdio
- **МодульMCP упрощаем** — убираем JSON-RPC, оставляем только ВыполнитьИнструмент + обработчики
- Описания инструментов хранятся в tools.json профиля, читает relay

Один минус: дополнительный процесс на сессию. Но это легковесный процесс
(~80 строк Node.js или ~300 строк Rust), дешевле чем усложнять Router+Chat+centrifugo_stdio.

### Рекомендация

**Вариант Д (MCP sidecar)** — самый чистый. Каждый компонент делает одно:
- centrifugo_stdio = транспорт pipe:↔stdio (не меняется)
- 1c-mcp-relay = MCP-протокол + Centrifugo клиент (новый, изолированный)
- Роутер = маршрутизация, трансформация, запуск процессов (не трогает JSON-RPC)
- Чат = выполнение инструментов, UI (tool_call/tool_result уже есть)

**Вариант В** — если хотим всё без Node.js, в одном Rust-бинарнике. Больше работы.

---

## Задача 3: centrifugo_stdio

### Изменения
1. Убрать `--listen` фильтрацию — передавать ВСЁ из канала в stdin
2. Удалять `CLAUDECODE` из env перед spawn дочернего процесса

Каналы: только `pipe:<id>` (как сейчас). Namespace `mcp:` не нужен —
1c-mcp-relay подключается напрямую к `session:<id>` через Centrifugo WebSocket.

---

## Задача 4: Роутер

### Чтение профиля
- При старте (или при первом запросе) читает файлы из `Профили/Основной/`
- Кэширует в памяти (не перечитывает на каждую сессию)

### Запуск сессии (ЗапуститьМодельДляСессии)
1. Прочитать system-prompt.md → ЕХТ_Шаблонизатор с данными из hello → временный файл
2. Прочитать model.json → модель, allowedTools
3. Прочитать mcp-config.json → статические MCP-серверы
4. Сгенерировать mcp-config с динамическим 1c relay:
   - JWT для mcp:<session_id> канала
   - Путь к centrifugo_stdio.exe, URL Centrifugo, token, channel
5. Записать итоговый mcp-config → временный файл
6. Собрать аргументы Claude CLI:
   - `-p --verbose --input-format stream-json --output-format stream-json`
   - `--include-partial-messages --disable-slash-commands`
   - `--session-id <uuid> --model <из model.json>`
   - `--system-prompt-file <путь>`
   - `--mcp-config <путь>`
   - `--allowedTools <список из model.json>`
   - `--strict-mcp-config`
   - `--settings {"disableAllHooks": true}`
7. Собрать config.json для centrifugo_stdio (program=claude, args, env={CLAUDECODE:""})
8. Запустить centrifugo_stdio на pipe:<session_id>

### Трансформация сообщений
- chat → stream-json: `{type:"chat", text}` → `{type:"user", message:{role:"user", content:text}}`
- stream-json → универсальный: stream_event → text_delta/thinking_*/assistant_end (уже сделано)
- JSON-RPC прокси (если вариант Г): mcp: → session: и обратно (прозрачный проброс)

### Подписка на каналы
При создании сессии Роутер подписывается на:
- session:<id> (уже есть)
- pipe:<id> (уже есть)
- mcp:<id> (новое — для проксирования JSON-RPC)

---

## Задача 5: Чат (МодульMCP)

Полностью убрать JSON-RPC из Чата (вариант Д — MCP sidecar):
- Убрать: initialize, tools/list, tools/call обёртки, JSON-RPC каркас, inputSchema, descriptions
- Убрать: Инициализация, ЗарегистрироватьОбработчик, ПолучитьИменаИнструментов, РеестрОбработчиков
- Убрать: СобратьОтветJSONRPC, СобратьОтветToolsCall, ОтветОшибкаПротокола, ОписаниеИнструмента, СвойствоСхемы
- Оставить: ВыполнитьИнструмент(Имя, Параметры) — простой switch по имени
- Оставить: 4 серверных обработчика (v8_query, v8_metadata, v8_eval, v8_exec)
- Оставить: утилиты (ПолучитьПараметр, ЗначениеДляJSON, серверные JSON обёртки)

Главная форма (tool_call/tool_result) — уже работает, без изменений.

---

## Задача 6: 1c-mcp-relay (новый компонент)

Самостоятельный MCP-сервер для клиентских инструментов 1С.
Запускается Claude CLI как stdio MCP-сервер через `--mcp-config`.

### Аргументы
```
1c-mcp-relay --url <ws_url> --token <jwt> --channel <session:id> --tools <tools.json>
```

### Логика
1. Подключиться к Centrifugo (WebSocket, JWT авто-подписка на session:<id>)
2. stdin: JSON-RPC от Claude
   - `initialize` → ответить capabilities + serverInfo
   - `tools/list` → ответить из tools.json
   - `tools/call` → publish `{type:"tool_call", request_id:<uuid>, tool:<name>, params:{...}}` в канал
     → ждать push `{type:"tool_result", request_id:<тот же uuid>}` из канала
     → сформировать JSON-RPC result → stdout
3. stdout: JSON-RPC ответы для Claude

### Реализация
- **Node.js** (~80 строк) — быстрее написать, зависимость от Node.js
- **Rust** (~300 строк) — один бинарник, можно собрать рядом с centrifugo_stdio
- Рекомендация: начать с Node.js для MVP, при необходимости переписать на Rust

### Таймаут
tools/call ожидает tool_result из канала. Таймаут — 30 секунд (v8_query может быть долгим).
При таймауте — JSON-RPC error.

---

## Порядок реализации

### Этап 1: Системный промпт (без инструментов)
1. ✅ Создать `Профили/Основной/system-prompt.md` и `model.json`
2. ✅ Роутер: чтение профиля, шаблонизация промпта, `--system-prompt-file`, `--model`
3. ✅ centrifugo_stdio: --listen опционален, удалять CLAUDECODE из env. **Сборка** — exe заблокирован работающим процессом, пересобрать после рестарта
4. Тест: Claude отвечает на русском с правильной ролью

### Этап 2: MCP-серверы (vega, docs) — серверные инструменты
5. Создать `Профили/Основной/mcp-config.json` (статические серверы) — **отложено, добавим позже**
6. Роутер: мержить mcp-config в аргументы Claude CLI — **отложено**
7. Тест: Claude использует vega/docs инструменты

### Этап 3: 1c-mcp-relay — клиентские инструменты
8. ✅ Создать `Профили/Основной/tools.json` (описания v8_*)
9. ✅ Написать 1c-mcp-relay (Node.js, ~140 строк, zero dependencies кроме Node 22+)
10. ✅ Роутер: добавить 1c-mcp-relay в mcp-config при запуске сессии (JWT для session: канала)
11. ✅ Чат (МодульMCP): упрощён до ВыполнитьИнструмент + обработчики (577→193 строки)
12. Тест: Claude вызывает v8_query → Чат выполняет → результат возвращается

---

## Статус реализации (2026-03-12) ✅ ЗАВЕРШЕНО

### Подтверждённая цепочка

Полный флоу с MCP-инструментами работает (подтверждено 2026-03-12):
```
Чат → {type:"chat"} → session: → Роутер → pipe: → centrifugo_stdio → Claude CLI
  → MCP tools/call → relay.mjs → {type:"tool_call"} → session: → Чат (v8_metadata)
  → {type:"tool_result"} → session: → relay.mjs → Claude CLI → ответ
  → centrifugo_stdio → pipe: → Роутер → {type:"text_delta"} → session: → Чат
```

### Что сделано

- **1c-mcp-relay** (`centrifugo/1c-mcp-relay/relay.mjs`) — Node.js MCP sidecar, ~140 строк, zero dependencies (Node 22+ built-in WebSocket). Подключается к Centrifugo, отвечает на initialize/tools/list, проксирует tools/call → tool_call/tool_result через Centrifugo. Таймаут 60 сек.

- **Профили** (`ЕХТ_Лира_Роутер/Профили/Основной/`):
  - `system-prompt.md` — шаблон промпта с подстановками `{{ }}`
  - `model.json` — модель sonnet, allowedTools для v8_* инструментов
  - `tools.json` — описания 4 инструментов в формате Anthropic API (input_schema)

- **Роутер** (`ЗапуститьМодельДляСессии`) — переписан:
  - Читает model.json → модель, allowedTools
  - Шаблонизирует system-prompt.md через `СтрЗаменить` → `ДвоичныеДанные.Записать` (обход бага `ЗаписьТекста`)
  - Генерирует JWT для relay (авто-подписка на session: канал)
  - Генерирует mcp-config.json с 1c relay → временный файл (ручная сборка JSON)
  - Передаёт Claude CLI: --system-prompt-file, --mcp-config, --allowedTools, --model, --dangerously-skip-permissions, --strict-mcp-config

- **centrifugo_stdio** — обновлён и пересобран:
  - --listen теперь опциональный (пустой = пропускать всё)
  - Удаляет CLAUDECODE из env перед spawn

- **Чат МодульMCP** — упрощён с 577 до ~193 строк:
  - Убран весь JSON-RPC (initialize, tools/list, tools/call, реестр обработчиков)
  - Оставлен единственный API: `ВыполнитьИнструмент(Имя, Параметры) → Строка`
  - 4 серверных обработчика и утилиты без изменений

### Исправленные баги

1. **ЗаписатьJSON с Соответствие** — вставляет `Нет` между элементами. Обход: ручная конкатенация строк
2. **ЕХТ_Шаблонизатор ломает переносы строк** — заменяет `\n` на `Нет`. Обход: `СтрЗаменить` для подстановок
3. **ЗаписьТекста.Записать(многострочный текст)** — ломает переносы. Обход: `ДвоичныеДанные.Записать()`
4. **`"node"` в MCP config** — служба 1С не имеет PATH. Фикс: полный 8.3 путь `C:/PROGRA~1/nodejs/node.exe`
5. **Относительный путь к relay** (`../../../`) — разрешался неверно. Фикс: абсолютный 8.3 путь

### Что дальше

1. **Серверные MCP** (этап 2) — добавить vega, mcp-1c-docs в mcp-config
2. **Отображение tool_call** — показывать в Чате какой инструмент вызывается
3. **Очистка temp-файлов** — удалять lyra-bridge/mcp/prompt при завершении сессии

---

## Принятые решения

1. **Node.js для relay** — zero dependencies (Node 22+ built-in WebSocket), ~140 строк
2. **tools.json в формате Anthropic API** (`input_schema`) — при переходе на API файл используется напрямую. Relay конвертирует в MCP формат (`inputSchema`)
3. **--dangerously-skip-permissions** — используется (pipe-режим, нет терминала)
4. **Путь к профилю** — hardcode в Роутере (`ПутьКПрофилю("Основной")`)
5. **Кэширование** — нет, перечитывается при каждой сессии (удобно для разработки)
6. **Relay фильтрует сообщения канала** — ждёт только `{type:"tool_result", request_id:<id>}`, остальное игнорирует
7. **Несколько tool_call** — поддержано (Map по request_id с таймаутами)
