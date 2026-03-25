# Коды ошибок Lyra

Ошибки отображаются в чате в формате: `Ошибка: описание (код XX). Действие.`

## Коды

| Код | Сообщение | Причина | Что делать |
|-----|-----------|---------|------------|
| 01 | Сервер не ответил вовремя | API-провайдер не ответил в течение `chunkTimeout`. Роутер сделал повторную попытку — тоже без ответа. | Повторить вопрос. Если повторяется — проверить статус провайдера. Лог: `Adapter timeout [chunk/connect]` |
| 02 | Сервис временно недоступен | API-провайдер вернул ошибку (HTTP 4xx/5xx): rate limit, перегрузка, невалидный запрос. | Повторить через минуту. Если 429 — подождать. Если 401 — проверить API-ключ. Лог: `Adapter error: API error {status}` |
| 03 | Превышен лимит обращений к данным | Модель сделала `maxToolTurns` tool calls подряд и не дала финальный ответ. Роутер отправил запрос без tools — модель всё равно попыталась вызвать инструмент. | Упростить вопрос, спросить конкретнее. Лог: `Model returned tool_use after tool limit` |
| 04 | Непредвиденная ситуация | Необработанное исключение в `runAdapterChatManaged()`. | Повторить вопрос. Если повторяется — смотреть stack trace в логе: `Adapter error: {message} {stack}` |
| 05 | Сервер не ответил вовремя | То же что код 01, но для passthrough-адаптеров (claude-cli, codex-cli). Retry не выполняется. | Повторить вопрос. Лог: `Passthrough adapter timeout` |
| 06 | Непредвиденная ситуация | Необработанное исключение в `runAdapterChatPassthrough()`. | Повторить вопрос. Лог: `Adapter error: {message} {stack}` |

## Где искать в логе

Лог роутера: `var/router.log`.

Каждая ошибка логируется **до** отправки сообщения пользователю:
- `[WARN]` — retry (код 01/05, первая попытка)
- `[ERROR]` — финальная ошибка (все коды)

Пример:
```
[WARN]  Adapter timeout [chunk] attempt 1/2, session abc123
[ERROR] Adapter timeout [chunk] after 2 attempts, session abc123
→ пользователь видит: "Ошибка: сервер не ответил вовремя (код 01). Попробуйте повторить."
```

## Настройки

`config.json`:

| Параметр | Описание |
|----------|----------|
| `adapterTimeout.chunkTimeout` | Макс. тишина между SSE-чанками (мс) |
| `adapterTimeout.connectTimeout` | Таймаут на соединение с API (мс) |
| `adapterTimeout.maxRetries` | Количество повторных попыток |
| `maxToolTurns` | Макс. количество tool-turn'ов на один вопрос. При исчерпании — финальный запрос без tools |
| `billingMultiplier` | Множитель стоимости для пользователя (1 = без наценки) |
| `exchangeRate` | Курс USD → RUB |
| `adapter` | Тип адаптера (`openai`, `claude-api`, `claude-cli`) |
| `adapterConfig.base_url` | URL API-провайдера |
| `adapterConfig.api_key` | API-ключ (`env:OPENROUTER_API_KEY` для чтения из .env) |
| `adapterConfig.model` | Имя модели |
| `rag.model` | Модель для RAG-агента |
| `rag.timeout` | Таймаут RAG (мс) |
