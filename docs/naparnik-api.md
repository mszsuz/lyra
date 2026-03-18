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

## Особенности HTML-поля 1С

JS в HTML-поле 1С (веб-клиент и тонкий клиент) имеет ограничения:
- **`AbortSignal.timeout()`** — может не поддерживаться в некоторых движках. Оборачивать в `try/catch`
- **Кастомные заголовки** — минимизировать. `Session-Id` с пустым значением не нужен API и может вызывать проблемы с CORS в движке HTML-поля
- **Callback через `a.click()`** — единственный способ вернуть данные из JS в BSL (через `ПриНажатии`). Если JS падает до callback — молчаливый таймаут без ошибки на стороне Роутера

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
