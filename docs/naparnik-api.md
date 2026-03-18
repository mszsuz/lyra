# API 1С:Напарник (code.1c.ai)

Недокументированный API. Документации нет. При изменениях — реверс-инжиниринг через JS-бандл.

## Метод реверс-инжиниринга (проверен 2026-03-18)

1. Скачать JS-бандл: `curl -s 'https://code.1c.ai/chat/index.<hash>.js' > bundle.js`
   - Hash берётся из HTML: `curl -s 'https://code.1c.ai/chat/' | grep -oE 'src="[^"]*\.js[^"]*"'`
2. Ключевые модули в бандле:
   - `chat-client` (ID `AYSpO`) — основной клиент, формат запросов/ответов
   - `ai-transport` (ID `63R4r`) — HTTP-транспорт, fetch-вызовы
3. Поиск формата: `grep -oE 'sendMessage.{0,300}' bundle.js`
4. Поиск URL: `grep -oE 'getBaseUrl.{0,200}' bundle.js`

## Актуальный формат (2026-03-18)

**Base URL:** `https://code.1c.ai/chat_api/v1`

**Заголовки (КРИТИЧНО):**
```
Content-Type: application/json        ← БЕЗ charset=utf-8 !
Authorization: <token>
```

**Необязательные заголовки** (JS-бандл чата передаёт, но API работает и без них):
```
Session-Id:                           ← пустая строка, можно не передавать
Accept: text/event-stream             ← можно не передавать
Origin: https://code.1c.ai           ← можно не передавать
```

**ВАЖНО:** `Content-Type: application/json; charset=utf-8` вызывает HTTP 400 "error parsing the body". Это сломало Напарник в марте 2026 — все вызовы таймаутились 300 сек.

### 1. Создание conversation

```
POST /chat_api/v1/conversations/
Body: {"skill_name":"custom","is_chat":true,"ui_language":"russian","programming_language":"1c"}
Response: {"uuid":"..."}
```

### 2. Отправка сообщения (user)

```
POST /chat_api/v1/conversations/<uuid>/messages
Body: {
  "parent_uuid": null,           // или uuid предыдущего сообщения
  "role": "user",
  "content": {
    "content": {"instruction": "текст вопроса"},
    "tools": []
  }
}
Response: SSE stream (data: {...}\n)
```

### 3. Отправка tool response

```
POST /chat_api/v1/conversations/<uuid>/messages
Body: {
  "parent_uuid": "<msg_uuid>",
  "role": "tool",
  "content": [{"status":"accepted","tool_call_id":"<id>","content":null}]
}
Response: SSE stream
```

## Формат SSE-ответа

Каждая строка: `data: {json}\n`

Ключевые поля в JSON:
- `uuid` — ID сообщения
- `parent_uuid` — родительское сообщение
- `role` — "user" | "assistant" | "tool"
- `finished` — true = финальный чанк
- `content.content` — полный текст (в финальном чанке)
- `content.reasoning_content` — reasoning/thinking
- `content.tool_calls` — массив tool_calls (в финальном чанке с finished=true)
- `content_delta.content` — дельта текста (стриминг)
- `details.finish_reason` — "stop" | "tool_calls"

## Цикл tool_calls

Напарник может вызывать инструменты (Search_ITS, Search_Documentation, validate и др.). Клиент должен:
1. Получить tool_calls из finished-чанка
2. Отправить role=tool с status="accepted" для каждого tool_call_id
3. Повторять до получения finish_reason="stop"

Типичный сложный вопрос: 4-8 раундов, 30-80 секунд (подтверждено тестами 2026-03-18).

## Реализация клиента (МодульНапарник)

### Транспорт: XMLHttpRequest (не fetch!)

**`fetch` не работает в тонком клиенте 1С** (движок IE, ES5). Ломается молча — никаких ошибок, никаких таймаутов. Использовать **только XMLHttpRequest**.

```javascript
function post(url, hdrs, body, fn) {
  var x = new XMLHttpRequest();
  x.open('POST', url, true);
  x.timeout = 90000;  // 90 сек на один запрос (SSE может быть долгим)
  for (var k in hdrs) { x.setRequestHeader(k, hdrs[k]); }
  x.onload = function() { fn(null, x.status, x.responseText); };
  x.onerror = function() { fn('network'); };
  x.ontimeout = function() { fn('timeout'); };
  x.send(body);
}
```

### Callback: input.click() + value (не a.href/innerText!)

В тонком клиенте `a.innerText` и `dataset` не читаются из BSL. Рабочая схема:

```javascript
// JS: скрытый input для возврата данных в BSL
var fwd = document.createElement('input');
fwd.id = 'NaparnikForwarder';
fwd.style.display = 'none';
document.body.appendChild(fwd);
function cb(d) { if (done) return; done = true; fwd.value = d; fwd.click(); }
```

```bsl
// BSL: ПриНажатии — читаем value по id элемента
ВнешнийОбъект = ДанныеСобытия["Element"];
ИДЭлемента = ВнешнийОбъект["id"];  // "NaparnikForwarder"
Значение = ВнешнийОбъект["value"];  // "result|conv_id|msg_uuid|текст"
```

**Формат value:** `команда|данные`
- `result|conv_id|msg_uuid|текст_ответа` — успешный ответ
- `error|сообщение_об_ошибке` — ошибка
- `status|ok` / `status|error` — проверка доступности

### Генерация JS: конкатенация строк (не BSL `|`!)

BSL строки с `|` (продолжение строки) ломают JS — экранирование непредсказуемо. Генерировать JS **только через конкатенацию `+`**:

```bsl
// ПРАВИЛЬНО:
JS = "var x=new XMLHttpRequest();"
+ "x.open('POST',url,true);"
+ "x.timeout=90000;";

// НЕПРАВИЛЬНО (ломает JS):
JS = "var x=new XMLHttpRequest();
|x.open('POST',url,true);
|x.timeout=90000;";
```

### JS regex в BSL-строках — ЗАПРЕЩЕНЫ

BSL удваивает обратные слэши `\` в строках. Regex литералы `/<\/?thinking>/g` превращаются в невалидный `/<\\/?thinking>/g` → SyntaxError → скрипт не выполняется (молча!).

**Использовать split/join:**
```javascript
// ПРАВИЛЬНО:
r.split('<thinking>').join('').split('</thinking>').join('')

// НЕПРАВИЛЬНО (SyntaxError в тонком клиенте):
r.replace(/<\/?thinking>/g, '')
```

### Таймауты

| Таймаут | Значение | Назначение |
|---------|----------|------------|
| XHR timeout | 90 сек | Один HTTP-запрос (SSE ответ с tool_calls может быть долгим) |
| Global setTimeout | 270 сек | Весь цикл (conv + msg + tool_calls). Запас до 5-мин toolCallTimeout Роутера |
| ПроверитьДоступность XHR | 10 сек | Быстрая проверка при открытии |
| ПроверитьДоступность global | 15 сек | Fallback если XHR завис |

### Парсинг SSE в XHR

XHR получает весь SSE-ответ целиком в `responseText` (не стриминг). Парсинг:

```javascript
var lines = responseText.split(String.fromCharCode(10));  // split по \n
for (var i = 0; i < lines.length; i++) {
  if (lines[i].indexOf('data:') !== 0) continue;
  var ds = lines[i].substring(5);
  if (ds === '[DONE]') break;
  var d = JSON.parse(ds);
  // ... обработка чанков
}
```

### Цикл tool_calls (рекурсивный ask)

```javascript
function ask(body) {
  rounds++;
  if (rounds > 15) { cb('error|Превышен лимит раундов'); return; }
  post(msgUrl, headers, JSON.stringify(body), function(e, s, t) {
    var sse = parseSSE(t);
    if (sse.tc.length > 0) {
      // Есть tool_calls → отправляем accepted, рекурсия
      var tr = [];
      for (var j = 0; j < sse.tc.length; j++)
        tr.push({ status: 'accepted', tool_call_id: sse.tc[j].id, content: null });
      ask({ role: 'tool', content: tr, parent_uuid: sse.uid });
      return;
    }
    // Финальный ответ
    cb('result|' + convId + '|' + sse.uid + '|' + sse.text);
  });
}
```

### Производительность (подтверждено 2026-03-18)

| Клиент | Вопрос | Время | Раунды |
|--------|--------|-------|--------|
| Веб-клиент | «тест напарника» → закрытый месяц | 46 сек | 1 tool_call |
| Тонкий клиент | закрытый месяц в Бухгалтерии 3 | 79 сек | 1 tool_call |
| Тестовая EPF (веб) | что такое СКД | ~24 сек | 2 tool_calls |

## Особенности HTML-поля 1С

JS в HTML-поле 1С (веб-клиент и тонкий клиент) имеет ограничения:
- **`fetch`** — НЕ работает в тонком клиенте (`Can't find variable: fetch`). Использовать XMLHttpRequest
- **`async/await`** — НЕ работает в тонком клиенте (ES5). Использовать callbacks
- **`dataset`** — НЕ читается в BSL тонкого клиента
- **`a.innerText`** — НЕ читается в BSL тонкого клиента
- **`input.value`** — читается через `ВнешнийОбъект["value"]` ✅
- **`input.click()`** — вызывает `ПриНажатии` ✅
- **`setTimeout`** — работает в обоих клиентах ✅
- **JS regex в BSL-строках** — ломается (BSL удваивает `\`). Использовать split/join
- **BSL строки с `|`** — ломают JS. Генерировать через конкатенацию `+`
- **`AbortSignal.timeout()`** — может не поддерживаться. Оборачивать в `try/catch`
- **Кастомные заголовки** — минимизировать. `Session-Id` с пустым значением не нужен
- Если JS падает до callback — молчаливый таймаут без ошибки на стороне Роутера

## Инцидент: март 2026

**Симптом:** все вызовы lyra_ask_naparnik таймаутятся (300 сек), tool_result никогда не приходит.
**Причина:** сервер code.1c.ai стал возвращать 400 на `Content-Type: application/json; charset=utf-8` (между 11:17 и 13:46 17 марта 2026).
**Диагностика:**
1. Логи роутера: все `tool_call START` без `tool_call END`, только `TIMEOUT`
2. curl с тем же токеном и `charset=utf-8` → 400. Без charset → 200
3. Реверс-инжиниринг JS-бандла `code.1c.ai/chat/index.*.js` — подтвердил формат `application/json` без charset
4. Тест Node.js — полный цикл с tool_calls работает
5. Тест в веб-клиенте 1С — консоль браузера подтвердила выполнение JS и получение ответа

**Фикс (v26.03.18.3):**
- `Content-Type: application/json` без `; charset=utf-8`
- Убран `Session-Id: ''` из заголовков (не нужен API, лишний кастомный заголовок)
- `AbortSignal.timeout()` обёрнут в `try/catch`
- Возвращены `Origin`, `Referer`, `User-Agent` (были в рабочей версии)

**Результат:** сложный вопрос — 51 сек, 6 раундов tool_calls, полный ответ с кодом BSL.
