# Centrifugo — транспортный слой Lyra

Общайся с пользователем на русском языке.

## Что это

Centrifugo v6 — сервер реального времени (WebSocket/SSE). Единый транспорт для всех компонентов Lyra. Клиенты (Чат 1С, мобильное приложение, сайт) и Роутер подключаются к Centrifugo по WebSocket. Роутер также использует Server API (HTTP) для публикации сообщений в каналы.

## Расположение

```
centrifugo/
├── centrifugo.exe         — бинарник Centrifugo v6.6.2 (Windows)
├── config.json            — конфигурация сервера
├── CLAUDE.md              — этот файл
├── test-two-clients.mjs   — тест: полный hello-флоу (Роутер + Чат, Node 22+)
└── docs/                  — документация с сайта centrifugal.dev
    ├── Centrifugo introduction.md
    ├── Quickstart tutorial.md
    ├── Frequently Asked Questions.md
    ├── Server API walkthrough.md
    ├── Channels and namespaces.md
    ├── Design overview.md
    ├── Proxy events to the backend.md
    └── Centrifugo v6 + FastAPI (Хабр).md
```

## Запуск

```bash
cd centrifugo
./centrifugo.exe --config=config.json
```

- Порт: **11000** (настраивается через `http_server.port` в config.json)
- Admin UI: http://localhost:11000 (пароль в config.json → admin.password)

**Важно:** В Centrifugo v6 порт задаётся через `http_server.port` (строка!), **не** через `port` (будет предупреждение "unknown key"). CLI-флаг: `--http_server.port`.

## Роль в архитектуре

```
Чат 1С ─────────┐
Мобильное ───────┤  WebSocket    ┌──────────┐   WebSocket    ┌──────────────────┐
Сайт ────────────┼──────────────►│Centrifugo├◄─────────────►│ЕХТ_Лира_Роутер   │
                 │               │  :11000  │   Server API   │(серверная база 1С)│
                 └───────────────┤          ├◄──────────────►│                  │
                   ◄─────────────│          │  publish       │Адаптер (Claude)  │
                   стриминг      │          │                │                  │
                                 │          │   WebSocket    ├──────────────────┤
                                 │          ├◄─────────────►│Биллинг           │
                                 └──────────┘                └──────────────────┘
```

- **Клиенты** подключаются по WebSocket с JWT, подписываются на каналы
- **Все серверные компоненты** (Роутер, Биллинг) — **WebSocket-клиенты** Centrifugo (могут быть разнесены на разные машины)
- **Роутер** подключается по **WebSocket** (подписан на lobby, получает все hello) **и** использует **Server API** (HTTP) для публикации и подписки. При создании сессии подписывается на канал сессии через **Server API subscribe** (не WebSocket subscribe — namespace `session:` запрещает клиентскую подписку)
- **Биллинг** — WebSocket-клиент Centrifugo, подключается к каналам сессий после auth (для учёта запросов и тарификации)
- **Адаптер** стримит ответы Claude через Centrifugo обратно клиентам

## Аутентификация

Используются два типа JWT-токенов (оба подписаны одним `hmac_secret_key` из config.json, HMAC SHA-256):

### Общий JWT

- Долгоживущий, зашит в EPF Чата
- Один `sub` для всех обработок (например `lobby-user`)
- Используется **только** для первого подключения к Centrifugo и отправки hello в lobby
- После hello клиент переподключается с персональным JWT

### Персональные JWT (генерирует Роутер)

Роутер генерирует два токена при обработке hello:

| Токен | sub | Назначение | Время жизни |
|-------|-----|-----------|-------------|
| `chat_jwt` | `chat-<session_uuid>` | Для Чата после hello | 1 год |
| `mobile_jwt` | `mobile-<session_uuid>` | Для мобильного, кодируется в QR-код | 1 год |

Оба подписаны тем же `hmac_secret_key` из config.json. Оба содержат claim `channels: ["session:<session_id>"]` — клиент может подписаться только на свой канал сессии (безопасность: знание session_id без JWT не даёт доступа).

### Генерация тестовых токенов

```bash
./centrifugo.exe gentoken --user <user-id>
```

## Каналы

Три namespace — `session:`, `mobile:` и `service:` — настроены в config.json.

| Канал | Кто подключён | JWT | Назначение |
|-------|---------------|-----|-----------|
| `session:lobby` | Чаты (1С) + Роутер (по WebSocket) | Общий JWT (Чат) | hello-рукопожатие для чатов 1С |
| `mobile:lobby` | Мобильные приложения + Роутер (по WebSocket) | Общий JWT (мобильное) | Регистрация мобильных приложений (отдельный общий JWT) |
| Канал сессии | Чат + мобильное + Роутер + Биллинг | Персональные JWT (`chat_jwt`, `mobile_jwt`) | Сообщения, стриминг Claude, exec-команды, медиа от мобильного |
| `service:events` | Роутер, Биллинг и другие серверные компоненты | Серверный JWT | Служебный канал: компоненты публикуют события (event_router_session_created, event_router_auth_completed и т.д.), подписчики реагируют |

Служебный канал `service:events` — шина событий между серверными компонентами. Каждый компонент публикует свои события, остальные подписываются на нужные. Например: Роутер публикует `event_router_session_created` после auth → Биллинг подписан и автоматически подключается к каналу сессии.

Канал сессии создается Роутером при обработке hello. Роутер подписывается на канал сессии через WebSocket subscribe при создании. Чат и мобильное подключаются к нему самостоятельно, используя персональные JWT. Биллинг подключается к каналам сессий после auth (см. ниже).

### Подтвержденный флоу (тестами)

1. Роутер подключается к Centrifugo по WebSocket, подписывается на `session:lobby`
2. Чат подключается по WebSocket (общий JWT), публикует `hello` в `session:lobby` (subscribe на lobby не нужен — `allow_publish_for_client: true`)
3. Роутер получает hello через WebSocket (как подписчик lobby). `pub.info.client` содержит UUID отправителя
4. Роутер генерирует `chat_jwt` (sub=`chat-<session_uuid>`) и `mobile_jwt` (sub=`mobile-<session_uuid>`)
5. Роутер подписывается на `session:<session_id>` через **Server API subscribe** (WebSocket subscribe запрещён — `allow_subscribe_for_client: false`)
6. Роутер через **Server API `subscribe`** подписывает клиента на `session:<session_id>` (параметр `client` = UUID из `pub.info` — адресует конкретное соединение)
7. Роутер через **Server API `publish`** отправляет `hello_ack` в `session:<session_id>` — только этот Чат получает ответ
8. Чат переподключается с `chat_jwt` — авто-подписка на канал сессии через `channels` claim (отдельный subscribe не нужен)
9. Мобильное приложение подключается с `mobile_jwt` (получен из QR-кода) — авто-подписка на канал сессии через `channels` claim

Подтверждено тестами: `test-full-flow.mjs` (полный сценарий шаги 1-9: hello, JWT, авто-подписка, auth, auth_ack), `test-no-subscribe-lobby.mjs` (publish без subscribe на lobby), `test-two-clients.mjs` (hello-флоу), `test-client-id.mjs` (адресация по client ID).

## Адресация конкретного клиента

- **На этапе hello (lobby):** `pub.info.client` — Роутер знает UUID отправителя hello. Через Server API `subscribe({user, client, channel})` подписывает именно это соединение на `session:<session_id>`, затем публикует hello_ack туда. Остальные клиенты на lobby не видят hello_ack.
- **После hello (канал сессии):** адресация через персональные JWT — каждый клиент подключается с собственным токеном на канал сессии, дополнительной адресации не требуется

## Протокол Centrifugo (клиентский, JSON поверх WebSocket)

### Формат команд

Каждая команда — JSON-объект с полем `id` (номер запроса) и одним методом:

```json
{"id": 1, "connect": {"token": "JWT..."}}
{"id": 2, "subscribe": {"channel": "session:lobby"}}
{"id": 3, "publish": {"channel": "session:lobby", "data": {...}}}
```

Ответ содержит тот же `id` и результат:

```json
{"id": 1, "connect": {"client": "uuid", "version": "6.6.2 OSS", "ping": 25, "pong": true}}
{"id": 2, "subscribe": {}}
{"id": 3, "publish": {}}
```

Push-сообщения (без `id`):

```json
{"push": {"channel": "session:lobby", "pub": {"data": {"type": "hello", ...}}}}
{"push": {"channel": "session:abc", "subscribe": {}}}
```

### Мульти-JSON в одном фрейме

**Важно для мини-клиента BSL:** Centrifugo может отправить **несколько JSON-объектов в одном WebSocket-фрейме**, разделённых символом `\n`. При парсинге необходимо разбивать входящее сообщение по `\n` и парсить каждую строку отдельно.

### Необходимые команды

- `connect` — подключение с JWT-токеном
- `subscribe` — подписка на канал (lobby или канал сессии)
- `publish` — отправка сообщения в канал
- `ping/pong` — keepalive (интервал задаётся сервером в connect response, поле `ping`)

## Server API

HTTP API для серверного взаимодействия с Centrifugo. Используется Роутером.

### Аутентификация Server API

Заголовок `X-API-Key` с ключом из `http_api.key` в config.json.

### Методы

**publish** — отправить сообщение в канал. Используется Роутером для:

- `hello_ack` в lobby (до переподключения клиента)
- Стриминг ответов Claude в канал сессии
- exec-команды в канал сессии

```bash
curl -X POST http://localhost:11000/api/publish \
  -H "Content-Type: application/json" \
  -H "X-API-Key: <key>" \
  -d '{"channel": "session:lobby", "data": {"type": "hello_ack", "session_id": "...", "chat_jwt": "...", "mobile_jwt": "...", "qr": "..."}}'
```

**subscribe** — подписать конкретного пользователя на канал (по `user` + `client`). Используется для доставки hello_ack: подписать конкретное соединение на `session:<session_id>` до переподключения с персональным JWT.

```bash
curl -X POST http://localhost:11000/api/subscribe \
  -H "Content-Type: application/json" \
  -H "X-API-Key: <key>" \
  -d '{"user": "lobby-user", "client": "<UUID из pub.info>", "channel": "session:<session_id>"}'
```

**unsubscribe** — отписать пользователя от канала.

## Конфигурация (config.json)

- `http_server.port` — порт HTTP-сервера (строка, по умолчанию `"8000"`)
- `client.token.hmac_secret_key` — секрет для JWT (HMAC SHA-256)
- `client.allowed_origins` — разрешённые origins (CORS)
- `admin.enabled` — включение Admin UI
- `admin.password` — пароль для Admin UI
- `admin.secret` — секрет для Admin API
- `http_api.key` — ключ для Server API
- `channel.namespaces` — настройки каналов по неймспейсам:
  - `allow_subscribe_for_client` — разрешить клиентскую подписку. `false` для `session` и `mobile` (подписка только через `channels` claim в JWT или Server API). `true` для `service` (серверные компоненты подписываются сами)
  - `allow_publish_for_client` — разрешить клиентский publish (нужно для hello в lobby)

## Авто-подписка через channels claim

JWT с `channels: ["session:<id>"]` — Centrifugo автоматически подписывает клиента на указанные каналы при connect. В connect response приходит `subs: {"session:<id>": {}}`. Отдельная команда subscribe не нужна. Подтверждено тестом `test-full-flow.mjs`.

Это значит: Чату и Мобильному после переподключения с персональным JWT не нужно вызывать subscribe — они уже подписаны.

## Тесты

### test-full-flow.mjs
Полный сценарий подключения (шаги 1-9): Роутер на lobby → Чат connect + publish hello (без subscribe) → Роутер получает с pub.info.client → генерирует 2 JWT с channels claim → Server API subscribe + publish hello_ack → Чат переподключается с chat_jwt (авто-подписка) → Мобильное подключается с mobile_jwt (авто-подписка) → auth → auth_ack → оба получают сообщения на канале.

### test-no-subscribe-lobby.mjs
Чат публикует hello без subscribe на lobby. Подтверждает: `allow_publish_for_client: true` разрешает publish любому подключённому клиенту.

### test-two-clients.mjs
Hello-флоу: Роутер на lobby → Чат подключается → Чат публикует hello → Роутер получает → Server API subscribe + publish hello_ack → Чат получает.

### test-client-id.mjs
Два клиента с одним JWT (одинаковый `sub`). Один публикует в lobby → push содержит `pub.info.client` UUID. Server API subscribe с параметром `client` адресует только одно соединение — второй клиент не получает подписку.

### test-router-flow.mjs
Полный флоу через реальный Роутер 1С (ЕХТ_Лира_Роутер). 7 шагов: Чат connect → publish hello → hello_ack (JWT, session_id) → переподключение с chat_jwt → мобильное с mobile_jwt → auth → auth_ack + balance_update. Все 7 шагов проходят. Требует запущенный Centrifugo + серверную базу 1С с расширениями.

Запуск: `node <тест>.mjs` (требует Node.js 22+ с встроенным WebSocket).

## Документация

- `docs/` — сохраненные статьи с centrifugal.dev и Хабра
- Официальная документация: https://centrifugal.dev
