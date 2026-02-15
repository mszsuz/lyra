# План: Связь 1С с Claude Code через WebSocket Bridge

**Дата начала проектирования:** 2026-02-06
**Статус:** Реализация (bridge.js написан и протестирован)

---

## 1. Архитектура

```
                    stdin/stdout                    WebSocket
                     (чат, NDJSON)                   (:3003)
Claude Code  ◄─────────────────────►  Bridge  ◄───────────────►  1С
     │                                  ▲  ▲                      │
     │  stdio MCP                       │  │                      │
     └──────────► bridge.js --mcp ─────┘  └──────────────────────┘
                  (WebSocket-клиент)          (WebSocket-клиент)
```

### Два канала, один WebSocket-порт

| Канал | Транспорт | Назначение |
|---|---|---|
| **Чат** | stdin/stdout (stream-json) | Текст пользователя ↔ ответы Claude (стриминг) |
| **Инструменты** | MCP через bridge.js --mcp → WebSocket | tool_use запросы Claude → выполнение в 1С |

### Компоненты

| Компонент | Роль |
|---|---|
| **Claude Code** | AI-агент, дочерний процесс bridge, пишет текст + вызывает MCP-инструменты |
| **Bridge** (основной режим) | WebSocket-сервер (:3003), relay чата (stdin/stdout ↔ WebSocket), управление процессами |
| **Bridge** (MCP-режим) | `node bridge.js --mcp --session X` — stdio MCP-сервер для Claude, подключается к основному bridge через WebSocket |
| **1С** | WebSocket-клиент с чат-интерфейсом, выполняет команды от Claude |

### Один скрипт, два режима

```bash
node bridge.js                              # Основной: WebSocket-сервер, запускает Claude
node bridge.js --mcp --session session_1    # MCP-режим: stdio MCP ↔ WebSocket-клиент
```

Позже, когда всё отработаем — компилируем в бинарник (`bun build --compile`).

Claude Code сам порождает MCP-процесс через `--mcp-config`:
```json
{"1c": {"command": "node", "args": ["bridge.js", "--mcp", "--session", "session_1"]}}
```

---

## 2. Принципы

### Bridge — маршрутизатор
- Не интерпретирует содержимое сообщений
- Маршрутизация по session ID: MCP-запрос → нужный WebSocket 1С
- Управление жизненным циклом процессов Claude Code

### Чат и инструменты разделены
- **Текст** — идёт через stdout Claude, стримится естественно (NDJSON)
- **Инструменты** — идут через MCP, отдельно от текста
- Claude использует нативные tool_use, не нужен кастомный протокол в тексте
- Нет JSON-контейнеров, нет парсинга markdown для извлечения команд

### 1С сама формирует JSON
- 1С оборачивает свои сообщения в JSON самостоятельно
- Bridge не трансформирует форматы

---

## 3. Потоки данных

### Чат: 1С → Claude (сообщение пользователя)
```
1С формирует JSON → WebSocket → Bridge → stdin Claude
```

### Чат: Claude → 1С (ответ, стриминг)
```
Claude stdout (NDJSON) → Bridge → WebSocket → 1С (показывает "по буквам")
```

### Инструменты: Claude → 1С (запрос данных)
```
Claude tool_use → stdio MCP → bridge.js --mcp → WebSocket → Bridge → WebSocket → 1С
1С выполняет → WebSocket → Bridge → WebSocket → bridge.js --mcp → stdio MCP → Claude
```

### Стриминг
- Claude Code запускается с `--output-format stream-json --include-partial-messages --verbose`
- Каждая строка stdout — **законченный JSON** (NDJSON), парсится сразу
- `partial: true` — 1С показывает текст "по буквам" (эффект печатания)
- `partial: false` — финальное сообщение
- Инструменты не мешают стримингу — это отдельный канал

### Формат stream-json (проверено 2026-02-06)

**Запуск Claude Code:**
```bash
claude -p --output-format stream-json --input-format stream-json --include-partial-messages --verbose --disable-slash-commands
```

**Формат ВВОДА (stdin):**
```json
{"type":"user","message":{"role":"user","content":"текст сообщения"}}
```

Content — строка или массив блоков (стандартный Anthropic Messages API):
```json
{"type":"user","message":{"role":"user","content":[
  {"type":"image","source":{"type":"base64","media_type":"image/png","data":"iVBOR..."}},
  {"type":"text","text":"Что на картинке?"}
]}}
```

Поддерживаемые блоки контента:
| Тип | Назначение |
|---|---|
| `{"type":"text","text":"..."}` | Текст |
| `{"type":"image","source":{"type":"base64","media_type":"...","data":"..."}}` | Картинка (base64) |
| `{"type":"image","source":{"type":"url","url":"..."}}` | Картинка (URL) |
| `{"type":"document","source":{"type":"base64","media_type":"application/pdf","data":"..."}}` | PDF-документ |

**Формат ВЫВОДА (stdout) — последовательность NDJSON-строк:**

| Тип | Описание |
|---|---|
| `{"type":"system","subtype":"init",...}` | Инициализация, список tools |
| `{"type":"stream_event","event":{"type":"message_start",...}}` | Начало ответа |
| `{"type":"stream_event","event":{"type":"content_block_start",...}}` | Начало блока контента |
| `{"type":"stream_event","event":{"type":"content_block_delta","delta":{"text":"..."}}}` | **Дельта текста** — стриминг по буквам |
| `{"type":"stream_event","event":{"type":"content_block_stop"}}` | Конец блока |
| `{"type":"assistant","message":{"content":[{"type":"text","text":"полный текст"}]}}` | Полное сообщение |
| `{"type":"stream_event","event":{"type":"message_delta",...}}` | Метаданные завершения |
| `{"type":"stream_event","event":{"type":"message_stop"}}` | Конец сообщения |
| `{"type":"result","result":"полный текст"}` | Финальный результат |

### Лог bridge — полная картина
В отличие от v1, bridge видит ВСЁ:
- Текст Claude для пользователя (stdout)
- Вызовы инструментов (MCP)
- Ответы 1С (WebSocket)
- Сообщения пользователя (WebSocket → stdin)

---

## 4. Управление сессиями

### Подход A: Долгоживущий процесс (основной)
```
claude -p --input-format stream-json --output-format stream-json
         --include-partial-messages --session-id <uuid>
         --mcp-config '{"1c": {"command": "bridge.exe", "args": ["--mcp", "--session", "<session_id>"]}}'
```
- Bridge порождает процесс Claude при подключении 1С
- Процесс живёт, пока открыто WebSocket-соединение
- stdin/stdout — pipe (не detached, не ignore)

### Подход B: Per-message с --resume (fallback)
```
claude -p --resume <uuid> --output-format stream-json "текст сообщения"
```
- Если процесс упал — bridge пересоздаёт через --resume
- Claude Code хранит историю сессии на диске
- 1С-клиент может не заметить обрыва

### Session ID
- Генерирует **bridge** (UUID) при первом подключении 1С
- Передаёт Claude Code через `--session-id`
- Используется для маршрутизации MCP-запросов к нужной 1С
- Отправляет 1С-клиенту для возможности переподключения

### Несколько баз одновременно
Каждая 1С получает свой процесс Claude — полная изоляция:
```
1С (Карташов) ──WS──► Bridge ──stdin/stdout──► Claude A ──MCP──► bridge.js --mcp --session s1 ──WS──► Bridge
1С (Комарова) ──WS──► Bridge ──stdin/stdout──► Claude B ──MCP──► bridge.js --mcp --session s2 ──WS──► Bridge
```
Bridge маршрутизирует по session ID (подтверждено логом v1: две базы работали параллельно).

---

## 5. Начальный промпт

Bridge передаёт Claude Code при запуске. Содержит:
- Информацию о подключённой базе 1С (имя, конфигурация)
- Доступные MCP-инструменты (query, eval, metadata и др.)
- Правила работы с 1С (из опыта v1: Дата vs ДАТАВРЕМЯ, eval vs query, сначала метаданные)

Промпт проще, чем планировался — не нужно описывать формат JSON-контейнера, Claude использует стандартные MCP tool_use.

Точный формат промпта — **проектируется отдельно**.

---

## 6. UI на стороне 1С

### Берём из существующих проектов

| Что | Откуда |
|---|---|
| Чат-интерфейс (React) | `TEMP-CHAT/chat-app/` — Markdown, подсветка BSL, emoji, темы |
| Расширение ЕХТ_Чат | `TEMP-CHAT/ЕХТ_Чат/` — API, callback-и, шаблоны сообщений |
| WebSocket-клиент | `1c-connector/1C/ТестВебСокет.epf` — подключение к bridge |

### Нужно объединить в одну обработку
- Чат из ЕХТ_Чат (отображение, Markdown, темы)
- WebSocket-клиент (подключение к bridge, отправка/получение)
- Поле ввода сообщения + кнопка отправки
- Обработка MCP-запросов от Claude (query, eval, metadata)
- Метод `ОбновитьСообщение(ИД, Текст)` для стриминга

---

## 7. Реализация: bridge.js

**Файл:** `C:\WORKS\TEMP\bridge.js` + `package.json`
**Зависимости:** `ws`, `@modelcontextprotocol/sdk`

### Основной режим (`node bridge.js`)
- WebSocket-сервер на порту 3003 (3001 и 3002 заняты bridge v1)
- При подключении 1С: генерация session ID, spawn Claude Code
- Relay: 1С `{"type":"chat","content":"..."}` → Claude stdin
- Relay: Claude stdout (NDJSON) → 1С WebSocket (raw forwarding)
- При подключении MCP-клиента (`?type=mcp&session=X`): relay MCP-запросов ↔ 1С
- Логирование в `logs/<sessionId>.log`
- Graceful shutdown (SIGINT/SIGTERM)

### MCP-режим (`node bridge.js --mcp --session <id>`)
- stdio MCP-сервер (JSON-RPC) для Claude Code
- WebSocket-клиент к основному bridge
- Инструменты: `1c_query`, `1c_eval`, `1c_metadata`, `1c_exec`
- Таймаут запросов к 1С: 30 сек
- Request/response matching по requestId (UUID)

### Запуск Claude Code из bridge
```bash
claude -p --output-format stream-json --input-format stream-json
  --include-partial-messages --verbose --disable-slash-commands
  --session-id <uuid>
  --mcp-config '{"mcpServers":{"1c":{"command":"node","args":["bridge.js","--mcp","--session","<id>"]}}}'
  --system-prompt "Ты AI-помощник для 1С..."
  --allowedTools mcp__1c__1c_query mcp__1c__1c_eval mcp__1c__1c_metadata mcp__1c__1c_exec ToolSearch
  --strict-mcp-config
  --settings '{"disableAllHooks":true}'
```

**Важные флаги:**
- `--allowedTools` — без него Claude Code блокирует MCP-инструменты в `-p` режиме. `ToolSearch` тоже нужен для обнаружения deferred MCP-инструментов.
- `--strict-mcp-config` — загружать только наш MCP, игнорировать `.mcp.json` и managed (ускоряет старт).
- `--settings '{"disableAllHooks":true}'` — отключить хуки в bridge-сессиях (ускоряет старт).

### WebSocket-протокол (краткая таблица)

**Bridge → 1С:**
| type | Описание |
|---|---|
| `session` | ID сессии при подключении |
| `stream_event` | Стриминг от Claude (raw NDJSON) |
| `assistant` | Полное сообщение Claude |
| `result` | Финальный результат |
| `system` | Системные события (init, hooks) |
| `mcp_request` | Запрос MCP-инструмента |
| `claude_exit` | Claude завершился |

**1С → Bridge:**
| type | Описание |
|---|---|
| `chat` | Сообщение пользователя |
| `mcp_response` | Ответ на MCP-запрос |

Детальная спецификация — в разделе "Контейнеры сообщений" ниже.

---

## 7.1. Контейнеры сообщений (спецификация)

### Принцип: MCP инкапсулирован в bridge

1С **НЕ реализует протокол MCP** (JSON-RPC, capabilities, handshake). Весь MCP скрыт внутри bridge:

```
Claude ←── JSON-RPC (MCP) ──→ bridge.js --mcp ←── WebSocket ──→ bridge main ←── WebSocket ──→ 1С
           ^^^^^^^^^^^^                                                         ^^^^^^^^^^^^^^^
           MCP-протокол                                                         простой JSON
           (1С не видит)                                                        (request/response)
```

1С работает только с простыми JSON-контейнерами:
- Получает `mcp_request` → выполняет → отвечает `mcp_response`
- Никакого JSON-RPC, capabilities negotiation и т.д.

### 1С → Bridge

#### `chat` — сообщение пользователя
```json
{
  "type": "chat",
  "content": "текст сообщения"
}
```

Content — строка или массив блоков (для картинок, файлов):
```json
{
  "type": "chat",
  "content": [
    {"type": "text", "text": "Посмотри на эту форму:"},
    {"type": "image", "source": {
      "type": "base64",
      "media_type": "image/png",
      "data": "iVBORw0KGgo..."
    }},
    {"type": "document", "source": {
      "type": "base64",
      "media_type": "application/pdf",
      "data": "JVBERi0..."
    }}
  ]
}
```

#### `mcp_response` — ответ на запрос инструмента
```json
{
  "type": "mcp_response",
  "requestId": "uuid-от-mcp_request",
  "result": "значение или объект"
}
```

Ошибка выполнения:
```json
{
  "type": "mcp_response",
  "requestId": "uuid",
  "error": "Справочник 'Сотрудники' не найден"
}
```

---

### Bridge → 1С

#### `session` — назначение сессии (первое сообщение)
```json
{
  "type": "session",
  "sessionId": "550e8400-e29b-41d4-a716-446655440000"
}
```
1С сохраняет sessionId для возможности переподключения (`ws://bridge:3003/?session=<id>`).

#### `mcp_request` — запрос на выполнение инструмента в 1С
```json
{
  "type": "mcp_request",
  "requestId": "uuid",
  "tool": "1c_eval",
  "params": {"expression": "Строка(ТекущаяДата())"}
}
```

Инструменты и их params:

| tool | params | Описание |
|---|---|---|
| `1c_query` | `{query: "ВЫБРАТЬ...", params?: {}}` | Запрос на языке 1С |
| `1c_eval` | `{expression: "..."}` | Вычислить выражение |
| `1c_metadata` | `{path?: "..."}` | Дерево метаданных |
| `1c_exec` | `{code: "..."}` | Выполнить блок кода |

1С выполняет и отвечает `mcp_response` с тем же `requestId`.

#### `claude_exit` — процесс Claude завершился
```json
{
  "type": "claude_exit",
  "code": 0
}
```

---

### Bridge → 1С: события Claude (raw NDJSON)

Bridge пересылает stdout Claude как есть. Каждое WebSocket-сообщение — одна JSON-строка. Ниже — события, которые 1С должна обрабатывать:

#### Системные (можно игнорировать)
```json
{"type": "system", "subtype": "init", "session_id": "...", "tools": [...]}
{"type": "system", "subtype": "hook_started", ...}
{"type": "system", "subtype": "hook_response", ...}
```
1С может использовать `init` как сигнал готовности Claude.

#### Стриминг текста — главное для отображения "по буквам"
```json
{"type": "stream_event", "event": {"type": "content_block_delta", "delta": {"type": "text_delta", "text": "фрагмент"}}}
```
**Алгоритм для 1С:** при получении `text_delta` — дописывать `.text` к текущему сообщению в чате.

#### Начало/конец блоков (опционально)
```json
{"type": "stream_event", "event": {"type": "message_start", ...}}
{"type": "stream_event", "event": {"type": "content_block_start", "content_block": {"type": "text"|"tool_use", ...}}}
{"type": "stream_event", "event": {"type": "content_block_stop"}}
{"type": "stream_event", "event": {"type": "message_stop"}}
```
`content_block_start` с `"type": "tool_use"` — Claude начинает вызов инструмента (можно показать индикатор).

#### Полное сообщение
```json
{"type": "assistant", "message": {"content": [{"type": "text", "text": "полный ответ"}]}}
```
Содержит весь текст. Можно использовать вместо склейки дельт.

#### Финальный результат
```json
{"type": "result", "result": "текст", "duration_ms": 3400, "total_cost_usd": 0.05}
```
Последнее событие для каждого ответа. Содержит полный текст + метаданные.

---

### Пример полного диалога (WebSocket)

```
→ 1С подключается к ws://bridge:3003
← {"type":"session","sessionId":"abc-123"}

... 10 сек инициализация ...

← {"type":"system","subtype":"init","tools":[...]}

→ {"type":"chat","content":"Какая дата в базе?"}

← {"type":"stream_event","event":{"type":"content_block_delta","delta":{"text":"Сейчас "}}}
← {"type":"stream_event","event":{"type":"content_block_delta","delta":{"text":"проверю"}}}
← {"type":"stream_event","event":{"type":"content_block_start","content_block":{"type":"tool_use","name":"mcp__1c__1c_eval"}}}

← {"type":"mcp_request","requestId":"req-1","tool":"1c_eval","params":{"expression":"Строка(ТекущаяДата())"}}
→ {"type":"mcp_response","requestId":"req-1","result":"08.02.2026"}

← {"type":"stream_event","event":{"type":"content_block_delta","delta":{"text":"Текущая дата: **08.02.2026**"}}}
← {"type":"result","result":"Сейчас проверю...\n\nТекущая дата: **08.02.2026**"}
```

### Псевдокод обработки на стороне 1С

```bsl
// Обработка входящего WebSocket-сообщения
Процедура ПриПолученииСообщения(Сообщение)
    Данные = РазобратьJSON(Сообщение);
    Тип = Данные.type;

    Если Тип = "session" Тогда
        // Сохранить для переподключения
        ИДСессии = Данные.sessionId;

    ИначеЕсли Тип = "stream_event" Тогда
        Событие = Данные.event;
        Если Событие.type = "content_block_delta"
           И Событие.delta.type = "text_delta" Тогда
            // Дописать текст к текущему сообщению (эффект печатания)
            ДобавитьТекст(Событие.delta.text);
        КонецЕсли;

    ИначеЕсли Тип = "result" Тогда
        // Финальный ответ — можно заменить накопленный текст
        ЗавершитьСообщение(Данные.result);

    ИначеЕсли Тип = "mcp_request" Тогда
        // Claude хочет выполнить команду в 1С
        Попытка
            Результат = ВыполнитьИнструмент(Данные.tool, Данные.params);
            Ответ = Новый Структура("type,requestId,result",
                "mcp_response", Данные.requestId, Результат);
        Исключение
            Ответ = Новый Структура("type,requestId,error",
                "mcp_response", Данные.requestId, ОписаниеОшибки());
        КонецПопытки;
        ОтправитьJSON(Ответ);

    ИначеЕсли Тип = "claude_exit" Тогда
        // Claude завершился — показать статус
    КонецЕсли;
КонецПроцедуры

Функция ВыполнитьИнструмент(Инструмент, Параметры)
    Если Инструмент = "1c_query" Тогда
        Возврат ВыполнитьЗапрос(Параметры.query, Параметры.params);
    ИначеЕсли Инструмент = "1c_eval" Тогда
        Возврат Вычислить(Параметры.expression);
    ИначеЕсли Инструмент = "1c_metadata" Тогда
        Возврат ПолучитьМетаданные(Параметры.path);
    ИначеЕсли Инструмент = "1c_exec" Тогда
        Возврат ВыполнитьКод(Параметры.code);
    КонецЕсли;
КонецФункции
```

---

## 8. Результаты тестирования

### Полный тест (8/8 passed, 2026-02-08)

| # | Тест | Результат |
|---|---|---|
| 1.1 | Session ID получен | ✅ |
| 1.2 | Стриминг (дельты текста) | ✅ "Москва" |
| 1.3 | Result получен | ✅ |
| 2.1 | MCP: Claude вызвал `1c_eval` | ✅ tool=1c_eval, expression="Строка(ТекущаяДата())" |
| 2.2 | MCP: Result после tool call | ✅ Claude ответил "08.02.2026" |
| 2.3 | MCP: Claude использовал данные от "1С" | ✅ дата из ответа в тексте |
| 3.1 | Переподключение: session ID совпал | ✅ |
| 3.2 | Переподключение: ответ от существующего Claude | ✅ "Работает" |

### Тест множественных сессий (4/4 passed, 2026-02-08)

| # | Тест | Результат |
|---|---|---|
| 4.1 | Разные session ID | ✅ (95c11daa vs 445eb57d) |
| 4.2 | 1С-А получила ответ | ✅ "4" |
| 4.3 | 1С-Б получила ответ | ✅ "Париж." |
| 4.4 | Ответы не перепутались | ✅ А="4" Б="Париж." |

Два клиента подключены одновременно, отправили разные вопросы ("2+2=?" и "столица Франции?"), получили правильные ответы без смешивания.

### Полный путь MCP-вызова (подтверждён)
```
Claude → ToolSearch (нашёл mcp__1c__1c_eval)
  → tool_use(mcp__1c__1c_eval, {expression: "Строка(ТекущаяДата())"})
  → bridge.js --mcp (stdio MCP) → WebSocket → main bridge → WebSocket → "1С"
  → "1С" отвечает "08.02.2026"
  → обратный путь → Claude показывает результат
```

### Найденные и исправленные проблемы

1. **Permissions** — без `--allowedTools` Claude блокирует MCP-инструменты в `-p` режиме. Исправлено: добавлен `--allowedTools` с перечислением MCP-инструментов и `ToolSearch`.

2. **Init задержка** — `system:init` приходит через ~10-15 сек (инициализация MCP + хуки). Клиент не должен ждать init перед отправкой — bridge буферизует в stdin Claude.

3. **Deferred tools** — MCP-инструменты 1С являются "deferred" — Claude сначала вызывает `ToolSearch` чтобы их обнаружить, потом уже вызывает сам инструмент. Это штатное поведение.

4. **Медленный старт (расследовано и оптимизировано, 2026-02-08)** — исходная задержка ~22 сек до init состояла из трёх фаз:
   - Node.js + MCP handshake (~9 сек) — загрузка ВСЕХ MCP-серверов из `.mcp.json`
   - SessionStart хук от плагина superpowers (~2 сек)
   - Загрузка лишних MCP из managed конфигов

   **Применённые оптимизации:**
   - `--strict-mcp-config` — загружать только MCP из `--mcp-config`, игнорировать `.mcp.json` и managed
   - `--settings '{"disableAllHooks":true}'` — отключить все хуки в bridge-сессиях
   - Удалён плагин superpowers (`claude plugin uninstall`) — убрал SessionStart хук
   - Сообщение отправляется немедленно (не ждём init)

### Замеры скорости старта (2026-02-08)

| Метрика | До оптимизации | После | Ускорение |
|---|---|---|---|
| init received | ~22 сек | **2.6 сек** | **8.5x** |
| Первая дельта текста | ~26 сек | **6.2 сек** | **4.2x** |
| Полный ответ | ~27 сек | **6.3 сек** | **4.3x** |

Из 6.3 сек ~4 сек — это API Anthropic (генерация). Собственно старт Claude Code ~2.5 сек.

**Дальнейшее ускорение:** компиляция `bridge.js` в бинарник через `bun build --compile` уберёт Node.js bootstrap из MCP-режима.

---

## 9. Открытые вопросы

- [ ] Аутентификация / безопасность WebSocket-соединения через интернет
- [ ] Обработка ошибок (обрывы связи, ошибки 1С, рестарт Claude)
- [ ] Обработка 1С (WebSocket-клиент + чат-интерфейс)
- [ ] Исходный код Claude Code — открытый (github.com/anthropics/claude-code), можно подсмотреть детали

### Снятые вопросы
- ~~Тестирование bridge.js~~ — **12/12 тестов passed** (чат + MCP + переподключение + множественные сессии, 2026-02-08)
- ~~Нужен ли 1С протокол MCP~~ — нет, MCP инкапсулирован в bridge. 1С работает с простыми JSON-контейнерами (mcp_request/mcp_response)
- ~~Формат stream-json~~ — проверено: ввод `{"type":"user","message":{"role":"user","content":"..."}}`, вывод — NDJSON с дельтами текста
- ~~Картинки и файлы~~ — стандартный Anthropic API: content = массив блоков (text, image, document)
- ~~Множественные базы~~ — **протестировано**: каждая 1С получает свой процесс Claude, ответы не смешиваются (4/4 passed)
- ~~Формат JSON-контейнера~~ — не нужен, Claude использует стандартный MCP tool_use для команд, текст идёт отдельно через stdout
- ~~Как совместить стриминг и команды~~ — это два отдельных канала (stdout для текста, MCP для инструментов)
- ~~Нужен ли MCP~~ — да, bridge выступает MCP-сервером (тот же бинарник в режиме --mcp)
- ~~HTTP для MCP~~ — не нужен, MCP-режим bridge подключается к основному bridge через тот же WebSocket
- ~~Список MCP-инструментов~~ — `1c_query`, `1c_eval`, `1c_metadata`, `1c_exec` (реализовано в bridge.js)
- ~~Формат начального промпта~~ — `--system-prompt` с кратким описанием + детали в описаниях MCP-инструментов
- ~~Медленный старт Claude~~ — **оптимизировано**: с 22 сек до 2.6 сек (init), полный ответ за 6.3 сек. Флаги: `--strict-mcp-config`, `--settings '{"disableAllHooks":true}'`, удалён плагин superpowers

---

## 10. Исходные материалы

| Файл | Что содержит |
|---|---|
| `~/.claude/skills/1c-connector/` | Первая версия (MCP + Bridge + WebSocket) |
| `C:\WORKS\2025-10-12 TEMP-CHAT\` | Чат-приложение (React + ЕХТ_Чат) |
| `docs/Системный_промпт_1C_MCP.md` | Опыт работы с 1С через MCP (промпты, паттерны) |
| `docs/Отчёт_УСН_Карташов.md` | Пример реального расследования в 1С |
| `docs/Анализ_недостающих_инструментов.md` | Что не хватало в первой версии |
| `C:\WORKS\TEMP\Лог бриджа.txt` | Лог реальной сессии v1 (Автоунивермаг + Карташов) |
| `C:\WORKS\TEMP\bridge.js` | **v2 bridge** (основной + MCP режимы) |
| `C:\WORKS\TEMP\package.json` | Зависимости (ws, @modelcontextprotocol/sdk) |
| `C:\WORKS\TEMP\test-stream*.js` | Тесты формата stream-json |
| `C:\WORKS\TEMP\test-bridge*.js` | Тесты bridge (эмуляция 1С-клиента) |
