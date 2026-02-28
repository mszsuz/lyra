# Спецификация: перенос MCP из bridge.js в 1С

> Цель: убрать MCP SDK из bridge.js, сделать bridge тупым relay.
> 1С сама обрабатывает JSON-RPC от Claude Code.

---

## 1. Текущая схема (как сейчас)

```
Claude Code (stdin/stdout, JSON-RPC)
    ↕ stdio
bridge.js --mcp (MCP SDK, парсит JSON-RPC, формирует ответы)
    ↕ WebSocket (простой JSON: mcp_request/mcp_response)
bridge.js main
    ↕ WebSocket (простой JSON: mcp_request/mcp_response)
1С МодульMCP (обрабатывает простые запросы, выполняет на сервере)
```

**Что делает MCP SDK в bridge:**
- Парсит JSON-RPC из stdin
- Обрабатывает `initialize`, `tools/list`, `tools/call`
- Формирует JSON-RPC ответы в stdout
- Переводит `tools/call` в простой `{type: "mcp_request", tool, params, requestId}` для 1С

---

## 2. Новая схема (цель)

```
Claude Code (stdin/stdout, JSON-RPC)
    ↕ stdio
bridge.js --mcp (тупой relay: stdin → WebSocket, WebSocket → stdout)
    ↕ WebSocket (сырые строки JSON-RPC)
bridge.js main
    ↕ WebSocket (обёртка: {type: "mcp_jsonrpc", data: ...})
1С МодульMCP (парсит JSON-RPC, обрабатывает протокол MCP, выполняет на сервере)
```

---

## 3. Изменения в bridge.js

### 3.1 MCP-режим: relay вместо SDK

**Было (115 строк с MCP SDK):**
```javascript
async function runMcpMode(sessionId) {
  const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
  // ... создание MCP-сервера, обработчики tools/list, tools/call ...
}
```

**Стало (~25 строк, тупой relay):**
```javascript
function runMcpRelay(sessionId) {
  const ws = new WebSocket(`ws://localhost:${PORT}/?type=mcp&session=${sessionId}`);

  ws.on('open', () => {
    // stdin → WebSocket (построчно)
    let buf = '';
    process.stdin.on('data', chunk => {
      buf += chunk;
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const line of lines) {
        if (line.trim()) ws.send(line);
      }
    });
  });

  // WebSocket → stdout
  ws.on('message', raw => {
    process.stdout.write(String(raw) + '\n');
  });

  ws.on('close', () => process.exit(0));
  ws.on('error', () => process.exit(1));
}
```

### 3.2 Основной режим: пересылка JSON-RPC

В `onMcpConnect` — без изменений в логике, но формат сообщений меняется:

**Было:** MCP-клиент присылал `{type: "mcp_request", requestId, tool, params}`
**Стало:** MCP relay присылает сырые JSON-RPC строки

```javascript
// onMcpConnect — изменения:
ws.on('message', (raw) => {
  const line = String(raw);
  s.log(`MCP → ${line.slice(0, 300)}`);

  // Оборачиваем JSON-RPC в конверт и пересылаем 1С
  if (s.ws1c) {
    wsSend(s.ws1c, { type: 'mcp_jsonrpc', data: line });
  }
});

// Обработка ответов от 1С (в on1cConnect, секция msg.type):
} else if (msg.type === 'mcp_jsonrpc') {
  // Ответ 1С (JSON-RPC) → MCP relay → stdout → Claude
  if (s.wsMcp) s.wsMcp.send(msg.data);
}
```

### 3.3 Зависимость @modelcontextprotocol/sdk — можно удалить

После рефакторинга bridge.js больше не использует MCP SDK. Можно убрать из `package.json`.

---

## 4. Что нужно реализовать в 1С (МодульMCP)

### 4.1 Новый тип сообщения от bridge

Сейчас 1С получает от bridge: `{type: "mcp_request", requestId, tool, params}`
Будет получать: `{type: "mcp_jsonrpc", data: "<строка JSON-RPC>"}`

В главной форме — новый обработчик:
```
ИначеЕсли ТипСобытия = "mcp_jsonrpc" Тогда
    ОтветJSON = МодульMCP.ОбработатьJSONRPC(ДанныеОтвета["data"]);
    Если ОтветJSON <> Неопределено Тогда
        МодульBridge.ОтправитьСообщение(СобратьJSON_mcp_jsonrpc(ОтветJSON));
    КонецЕсли;
```

### 4.2 Протокол JSON-RPC (3 типа сообщений от Claude)

Claude присылает JSON-RPC строки. Каждая строка — один JSON объект.
Есть 3 типа: **запрос** (есть `id` + `method`), **уведомление** (есть `method`, нет `id`), **ответ** (есть `result`/`error`).

1С нужно обрабатывать только **запросы** и **уведомления**.

### 4.3 Сообщение 1: `initialize` (запрос)

**Приходит от Claude (первое сообщение при старте):**
```json
{
  "jsonrpc": "2.0",
  "id": 0,
  "method": "initialize",
  "params": {
    "protocolVersion": "2024-11-05",
    "capabilities": {},
    "clientInfo": {
      "name": "claude-code",
      "version": "1.0.0"
    }
  }
}
```

**1С должна ответить:**
```json
{
  "jsonrpc": "2.0",
  "id": 0,
  "result": {
    "protocolVersion": "2024-11-05",
    "capabilities": {
      "tools": {}
    },
    "serverInfo": {
      "name": "1c-bridge",
      "version": "2.0.0"
    }
  }
}
```

**Важно:** `id` в ответе должен совпадать с `id` в запросе.

### 4.4 Сообщение 2: `notifications/initialized` (уведомление)

**Приходит от Claude (сразу после ответа на initialize):**
```json
{
  "jsonrpc": "2.0",
  "method": "notifications/initialized"
}
```

**Ответ не нужен.** Уведомления (нет поля `id`) просто игнорируются.

### 4.5 Сообщение 3: `tools/list` (запрос)

**Приходит от Claude:**
```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "tools/list",
  "params": {}
}
```

**1С должна ответить (список инструментов):**
```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "tools": [
      {
        "name": "1c_query",
        "description": "Выполнить запрос на языке запросов 1С (ВЫБРАТЬ ... ИЗ ...). Это НЕ SQL!",
        "inputSchema": {
          "type": "object",
          "properties": {
            "query": {
              "type": "string",
              "description": "Текст запроса 1С"
            },
            "params": {
              "type": "object",
              "description": "Параметры запроса (необязательно)"
            }
          },
          "required": ["query"]
        }
      },
      {
        "name": "1c_eval",
        "description": "Вычислить выражение 1С. Только выражения, НЕ процедуры. Пример: Строка(ТекущаяДата())",
        "inputSchema": {
          "type": "object",
          "properties": {
            "expression": {
              "type": "string",
              "description": "Выражение на языке 1С"
            }
          },
          "required": ["expression"]
        }
      },
      {
        "name": "1c_metadata",
        "description": "Получить дерево/ветку метаданных конфигурации 1С",
        "inputSchema": {
          "type": "object",
          "properties": {
            "path": {
              "type": "string",
              "description": "Путь в дереве метаданных (пусто = корень)"
            }
          }
        }
      },
      {
        "name": "1c_exec",
        "description": "Выполнить блок кода на языке 1С (процедуры, циклы, условия, присваивания)",
        "inputSchema": {
          "type": "object",
          "properties": {
            "code": {
              "type": "string",
              "description": "Код на встроенном языке 1С"
            }
          },
          "required": ["code"]
        }
      }
    ]
  }
}
```

### 4.6 Сообщение 4: `tools/call` (запрос)

**Приходит от Claude (вызов инструмента):**
```json
{
  "jsonrpc": "2.0",
  "id": 2,
  "method": "tools/call",
  "params": {
    "name": "1c_query",
    "arguments": {
      "query": "ВЫБРАТЬ Наименование ИЗ Справочник.Номенклатура"
    }
  }
}
```

**1С должна ответить (успех):**
```json
{
  "jsonrpc": "2.0",
  "id": 2,
  "result": {
    "content": [
      {
        "type": "text",
        "text": "Наименование\nМолоко\nХлеб\nМасло"
      }
    ]
  }
}
```

**1С должна ответить (ошибка):**
```json
{
  "jsonrpc": "2.0",
  "id": 2,
  "result": {
    "content": [
      {
        "type": "text",
        "text": "Ошибка: Таблица не найдена"
      }
    ],
    "isError": true
  }
}
```

**Важно:** ошибки инструментов — это НЕ ошибки JSON-RPC. Они возвращаются через `result` с флагом `isError: true`. JSON-RPC `error` нужен только для ошибок протокола (неизвестный метод и т.п.).

---

## 5. Алгоритм обработки JSON-RPC в 1С

```
Функция ОбработатьJSONRPC(СтрокаJSONRPC)

  1. Разобрать JSON → Соответствие
  2. Если нет поля "id" → это уведомление → вернуть Неопределено (ответ не нужен)
  3. Получить id = Данные["id"], method = Данные["method"]
  4. Выбор по method:

     "initialize"  → вернуть ответ с capabilities и serverInfo
     "tools/list"  → вернуть ответ со списком инструментов
     "tools/call"  → извлечь name и arguments из params,
                     выполнить обработчик (существующая логика),
                     вернуть ответ с content

     иначе → вернуть JSON-RPC error: method not found

  5. Вернуть строку JSON-ответа
```

### Шаблон кода 1С

```1c
&НаКлиенте
Функция ОбработатьJSONRPC(СтрокаJSONRPC) Экспорт
    Данные = МодульПарсер.РазобратьJSON(СтрокаJSONRPC);

    // Уведомления (нет id) — игнорируем
    ИДЗапроса = Неопределено;
    Если Данные.Свойство("id") Тогда  // для Структуры
        ИДЗапроса = Данные.id;
    ИначеЕсли ТипЗнч(Данные) = Тип("Соответствие") Тогда
        ИДЗапроса = Данные["id"];
    КонецЕсли;

    Если ИДЗапроса = Неопределено Тогда
        Возврат Неопределено; // уведомление, ответ не нужен
    КонецЕсли;

    Метод = Данные["method"];
    Параметры = Данные["params"];

    Если Метод = "initialize" Тогда
        Возврат ОтветInitialize(ИДЗапроса);

    ИначеЕсли Метод = "tools/list" Тогда
        Возврат ОтветToolsList(ИДЗапроса);

    ИначеЕсли Метод = "tools/call" Тогда
        Возврат ОтветToolsCall(ИДЗапроса, Параметры);

    Иначе
        Возврат ОтветОшибкаПротокола(ИДЗапроса, -32601, "Method not found: " + Метод);
    КонецЕсли;
КонецФункции
```

---

## 6. Формат обёртки WebSocket (bridge ↔ 1С)

### Bridge → 1С

```json
{"type": "mcp_jsonrpc", "data": "{\"jsonrpc\":\"2.0\",\"id\":0,\"method\":\"initialize\",...}"}
```

Поле `data` — **строка** (сырой JSON-RPC). 1С парсит её отдельно.

### 1С → Bridge

```json
{"type": "mcp_jsonrpc", "data": "{\"jsonrpc\":\"2.0\",\"id\":0,\"result\":{...}}"}
```

Тот же формат. Bridge извлекает `data` и отправляет как есть в stdout MCP relay.

**Почему строка, а не объект?** Bridge не должен парсить/модифицировать JSON-RPC. Он просто пересылает. Меньше точек отказа.

---

## 7. Последовательность при запуске

```
1. 1С подключается к bridge по WebSocket
2. Bridge запускает Claude Code
3. Claude запускает MCP relay (bridge.js --mcp)
4. MCP relay подключается к bridge по WebSocket (?type=mcp&session=X)
5. Claude шлёт initialize → relay → bridge → 1С
6. 1С отвечает → bridge → relay → Claude
7. Claude шлёт notifications/initialized → relay → bridge → 1С → (игнорируется)
8. Claude шлёт tools/list → relay → bridge → 1С
9. 1С отвечает списком инструментов → bridge → relay → Claude
10. Claude при необходимости шлёт tools/call → ... → 1С выполняет → ...
```

---

## 8. Что остаётся без изменений

- **Запуск Claude Code** из bridge — без изменений (те же аргументы)
- **WebSocket 1С ↔ bridge** — тот же канал, добавляется тип `mcp_jsonrpc`
- **Сообщения chat, session, claude_exit** — без изменений
- **Стриминг Claude → 1С** — без изменений (raw NDJSON)
- **Обработчики инструментов в МодульMCP** (серверная логика: запросы, метаданные, eval, exec) — без изменений, только вызываются из нового диспетчера

---

## 9. Что можно удалить

### Из bridge.js:
- Весь `async function runMcpMode()` (~100 строк)
- Функция `mcpTool()` (хелпер для описания инструментов)
- `require('@modelcontextprotocol/sdk/...')` — все импорты MCP SDK

### Из package.json:
- Зависимость `@modelcontextprotocol/sdk`

### Из node_modules:
- `@modelcontextprotocol/` — вся папка

---

## 10. Итого: объём изменений

| Компонент | Что делать | Строк |
|---|---|---|
| bridge.js MCP режим | Заменить SDK на relay | ~25 (вместо ~115) |
| bridge.js основной режим | Добавить тип `mcp_jsonrpc` в пересылку | ~10 |
| 1С МодульMCP | Добавить `ОбработатьJSONRPC` + 3 обработчика протокола | ~80-100 |
| 1С Форма | Заменить `mcp_request` на `mcp_jsonrpc` | ~5 |
| 1С МодульMCP (существующие обработчики) | Без изменений | 0 |
