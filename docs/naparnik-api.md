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
Session-Id:                           ← пустая строка
Accept: text/event-stream
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

Типичный сложный вопрос: 4-6 раундов, 30-50 секунд.

## Инцидент: март 2026

**Симптом:** все вызовы lyra_ask_naparnik таймаутятся (300 сек), tool_result никогда не приходит.
**Причина:** сервер code.1c.ai стал возвращать 400 на `Content-Type: application/json; charset=utf-8`.
**Диагностика:** curl с тем же токеном → 400. Без charset → 200.
**Фикс:** `Chat/.../МодульНапарник/Module.bsl` — убрать `; charset=utf-8` из Content-Type, добавить `Session-Id: ''`.
**Почему тихо:** JS в HTML-поле 1С получал 400, callback error через `a.click()` видимо не доходил до BSL ПриНажатии — молчаливый таймаут без ошибки.
