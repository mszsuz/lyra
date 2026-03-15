# Lyra — архитектура и схема взаимодействия

## Концепция

ИИ-ассистент для 1С:Предприятие на базе Claude. Пользователи задают вопросы через чат прямо в интерфейсе 1С, Claude отвечает в реальном времени с доступом к данным базы.

Часть экосистемы Lyra + 1ext.com

## Текущий статус

**Подключение (hello → hello_ack → JWT → переподключение) — работает, подтверждено тестами.**

**Архитектура стриминга переходит на автономную схему:**

```
Чат → Centrifugo (канал сессии) → Модератор (stdio-bridge) → Ассистент (stdio-bridge) → Claude → Centrifugo → Чат
```

- stdio-bridge подключается к Centrifugo напрямую (WebSocket-клиент), без посредничества 1С
- Модератор — отдельная модель (Haiku), отдельный stdio-bridge на канале сессии
- Роутер запускает bridge-процессы и управляет жизненным циклом, но не участвует в стриминге

Bridge (Node.js) — устаревший прототип, сохранён как референс.

## Архитектура

```
                         Сервер Lyra
  База пользователя      +-----------------------------------------------------+
  +--------------+        |                                                     |
  | 1С           |        |  Centrifugo (:11000)                                |
  |              |  WS    |  +-----------------+                                |
  | Lyra-Chat.epf+------->|  | Каналы:         |     Мобильное                  |
  |              |<-------|  |  lobby (общий)   |<-- приложение                 |
  |  exec-       |        |  |  канал сессии    |     (авторизация,             |
  |  команды     |        |  +---------+--------+      голос, камера)            |
  +--------------+        |       ^   |   ^                                     |
                          |       |   |   |                                     |
                          |       |   v   |                                     |
                          |  stdio-bridge (Модератор)   stdio-bridge (Ассистент)|
                          |  +-------------------+      +-------------------+   |
                          |  | Haiku             |      | Claude            |   |
                          |  | проверка          |      | (Sonnet/Opus)     |   |
                          |  | user_message      | ---->| assistant_input   |   |
                          |  | -> assistant_input |      | -> assistant_output|  |
                          |  +-------------------+      +--------+----------+   |
                          |                                      |              |
                          |                              +-------+--------+     |
                          |                              | MCP-серверы    |     |
                          |                              |  Vega          |     |
                          |                              |  mcp-1c-docs   |     |
                          |                              +----------------+     |
                          |                                                     |
                          |  ЕХТ_Лира_Роутер (расширение 1С, серверная база)    |
                          |  +----------------------------------------------+   |
                          |  |  1. hello/auth (lobby)                        |   |
                          |  |  2. QR-авторизация (через мобильное)          |   |
                          |  |  3. Проверка баланса (Биллинг)                |   |
                          |  |  4. Выбор Vega-инстанса по конфигурации       |   |
                          |  |  5. Запуск stdio-bridge (Модератор+Ассистент) |   |
                          |  |  6. Управление жизненным циклом               |   |
                          |  +----------------------------------------------+   |
                          +-----------------------------------------------------+
```

Все серверные компоненты (Роутер, Биллинг) — WebSocket-клиенты Centrifugo. Могут быть разнесены на разные машины.

### Компоненты

| Компонент | Роль | Где живёт |
|-----------|------|-----------|
| **Lyra-Chat.epf** | UI чата, WebSocket-клиент Centrifugo, exec-команды | База пользователя |
| **Мобильное приложение** | Flutter (iOS + Android). Единственный способ авторизации (QR), баланс, список баз | Телефон пользователя |
| **Centrifugo** | WebSocket-транспорт, каналы (session:lobby, mobile:lobby, session:\<id\>), переподключение | Сервер Lyra |
| **ЕХТ_Лира_Роутер** | Бизнес-логика: авторизация, генерация JWT, запуск stdio-bridge (Модератор + Ассистент), управление жизненным циклом сессий | Серверная база 1С |
| **MDM** | НСИ: Пользователи (привязка к телефону) + подчинённый Базы (список баз пользователя) | Серверная база 1С |
| **Биллинг** | WebSocket-клиент Centrifugo, подключается к каналам сессий после auth. Баланс, тарификация, balance_update в реальном времени | Серверная база 1С |
| **stdio-bridge** | Rust-бинарник (~600 КБ). WebSocket-клиент Centrifugo, запуск Claude CLI, автономный стриминг. Два экземпляра на сессию: Модератор + Ассистент | Сервер Lyra |
| **ЕХТ_Центрифуга** | Общее расширение: Server API, JWT, WebSocket-клиент Centrifugo | Серверная база 1С |
| **Vega** | Метаданные конфигураций 1С, MCP-сервер | Сервер Lyra |
| **mcp-1c-docs** | Документация 1С, примеры, справочник языка | Сервер Lyra |

## Транспорт: Centrifugo

Centrifugo v6.6.2 — сервер реального времени (WebSocket/SSE). Единый транспорт для всех компонентов. Порт: **11000**.

### Каналы

Три namespace — `session:`, `mobile:` и `service:` — настроены в config.json.

| Канал | JWT | Кто подключён | Назначение |
|-------|-----|---------------|------------|
| `session:lobby` | Общий JWT для Чатов, зашит в EPF | Чаты 1С + Роутер (WS) | hello-рукопожатие от Чатов |
| `mobile:lobby` | Общий JWT для мобильных, зашит в приложение | Мобильные + Роутер (WS) | Регистрация мобильных (SMS) |
| Канал сессии `session:<id>` | Персональные JWT: chat_jwt, mobile_jwt (channels claim = авто-подписка) | Чат + мобильное + Роутер (Server API subscribe) + Биллинг (WS) | Пользовательский: user_message, assistant_output, billing_block, moderator_block, balance_update, exec |
| Конвейер `session:<id>:pipe` | JWT bridge-процессов (channels claim) | Биллинг (WS) + Модератор (centrifugo-stdio) + Ассистент (centrifugo-stdio) | Внутренний: billing_ok, assistant_input. Клиенты не видят |
| `service:events` | Серверный JWT | Роутер, Биллинг и другие серверные компоненты | Шина событий: event_router_auth_completed, event_billing_balance_checked и т.д. |

Два отдельных lobby: `session:lobby` для Чатов 1С, `mobile:lobby` для мобильных. Разные общие JWT -- если один скомпрометирован, другой не затронут. Роутер сразу понимает тип клиента по каналу.

Служебный канал `service:events` -- шина событий между серверными компонентами. Каждый компонент публикует свои события, остальные подписываются на нужные.

**Безопасность подписки:** для namespace `session` и `mobile` установлен `allow_subscribe_for_client: false`. Клиент может подписаться на канал только через `channels` claim в JWT (авто-подписка при connect) или Server API subscribe. Ручной subscribe клиентом запрещён. `allow_publish_for_client: true` сохранён -- клиенты могут publish в lobby без подписки.

### JWT-схема

Используются три типа JWT-токенов (HMAC SHA-256):

| Токен | Кто генерирует | sub | Доступ | Время жизни |
|-------|---------------|-----|--------|-------------|
| **Общий JWT (Чат)** | Зашит в EPF | общий (lobby) | Только `session:lobby` | Долгоживущий |
| **Общий JWT (мобильное)** | Зашит в приложение | общий (mobile) | Только `mobile:lobby` | Долгоживущий |
| **chat_jwt** | Роутер | chat-uuid | Канал сессии `session:<session_id>` | 1 год |
| **mobile_jwt** | Роутер | mobile-uuid | Канал сессии `session:<session_id>` | 1 год |

- Два **общих JWT** — отдельные для Чата и мобильного, дают доступ только к своим lobby
- Персональные JWT (chat_jwt и mobile_jwt) генерируются Роутером при создании сессии, оба дают доступ к одному каналу сессии, но имеют разные sub
- Оба персональных JWT со сроком жизни 1 год. mobile_jwt кодируется в QR-код. Риск минимален — auth требует валидный user_id + device_id
- Персональные JWT содержат claim `channels: ["session:<session_id>"]` — авто-подписка при connect (отдельный subscribe не нужен). Безопасность: знание session_id без JWT не даёт доступа

#### Модель безопасности lobby-токенов

Общие lobby JWT — **не секреты авторизации**, а bootstrap-токены для входа в публичный pre-auth транспортный контур. Centrifugo требует токен для любого WebSocket-соединения, но lobby — общедоступная точка входа до начала авторизации.

**Что даёт lobby-токен:**
- Открыть WebSocket-соединение с Centrifugo
- Попасть в общий канал (session:lobby или mobile:lobby)
- Опубликовать hello/register — после чего Роутер создаёт персональный канал и начинает авторизацию

**Чего lobby-токен НЕ даёт:**
- Доступа к каналам сессий (namespace `session:` / `mobile:` — `allow_subscribe_for_client: false`)
- Доступа к Server API (требует отдельный `http_api.key`)
- Доступа к Admin UI (отдельные admin credentials)
- Выполнения привилегированных действий — до завершения auth через персональный канал нельзя задавать вопросы Claude, получать данные базы и т.д.

**Граница доверия:** подключился к lobby ≠ аутентифицирован. Получил персональный канал ≠ подтвердил личность. Lobby-токен — публичный пропуск в тамбур, не ключ от квартиры.

**Условия безопасности:**
- Lobby-токен не даёт доступа ни к чему, кроме bootstrap-флоу
- Персональный канал создаётся сервером (Роутер), непредсказуем (UUID) и живёт ограниченное время (TTL 30 минут без клиента)
- SMS rate limit (15 минут на номер), ограничение попыток кода (3 на reg_id), TTL кода (5 минут)
- Статус сессии `awaiting_auth` — до завершения auth запросы к Claude блокируются

### Роутер: WebSocket + Server API

Роутер использует **два способа** взаимодействия с Centrifugo:

1. **WebSocket-клиент** — подключается как обычный клиент, подписывается на `session:lobby` и `mobile:lobby` (через JWT `channels` claim). Получает все hello и регистрации автоматически
2. **Server API (HTTP)** — для управления каналами: `subscribe` (подписать клиента или себя на канал), `publish` (отправить сообщение), `disconnect` и другие административные операции. При создании сессии Роутер подписывается на канал сессии через **Server API subscribe** (не WebSocket subscribe — namespace `session:` запрещает клиентскую подписку)

Общий JWT (один `sub` для всех обработок) используется только для lobby. При publish в lobby Centrifugo включает в push `pub.info.client` — UUID конкретного соединения, что позволяет Роутеру адресно отправить hello_ack. После получения hello_ack Чат переподключается с персональным chat_jwt — авто-подписка на канал сессии через `channels` claim (отдельный subscribe не нужен).

### Мини-клиент Centrifugo на BSL

Чат (1С) реализует клиентский протокол Centrifugo (connect, subscribe, publish, ping/pong) непосредственно в коде BSL, используя встроенный WebSocket-клиент платформы 8.3.27+. Без внешних компонент или SDK.

**Важно:** Centrifugo может отправлять **несколько JSON-объектов в одном WebSocket-фрейме**, разделённых `\n`. Мини-клиент BSL должен разбивать входящее сообщение по `\n` и парсить каждую строку отдельно.

### stdio-bridge: автономный адаптер

stdio-bridge — Rust-бинарник (~600 КБ), универсальный адаптер между Centrifugo и CLI-программами (Claude, модератор и др.).

**Режим работы (Centrifugo):**

```
stdio-bridge
  ├── WebSocket-клиент Centrifugo (мини-клиент на tungstenite, ~200-300 строк)
  │     ├── connect (JWT)
  │     ├── subscribe (канал сессии)
  │     ├── publish (результаты)
  │     └── ping/pong (keepalive)
  │
  ├── Фильтр входящих: слушает только --listen-type (user_message или assistant_input)
  │
  ├── CLI-процесс: Claude / Haiku (stdin/stdout)
  │     └── NDJSON-стриминг
  │
  └── Конфигурация: --config <path.json>
        ├── program, args
        ├── system_prompt_file
        ├── mcp_config
        └── permission_mode
```

**Ключевые свойства:**
- **Автономность** — после запуска не зависит от 1С. Перезапуск сервера 1С не убивает Claude-сессию
- **Два экземпляра на сессию** — Модератор (Haiku) + Ассистент (Sonnet/Opus)
- **Фильтрация** — каждый bridge слушает только свой тип сообщений, игнорирует остальные
- **Жизненный цикл** — Роутер завершает bridge через Centrifugo Server API `disconnect` (по user из JWT sub). При disconnect bridge убивает CLI-процесс и завершается

**Завершение сессии:**

```
Роутер (регулярное задание, TTL истёк)
  │
  ├── Centrifugo Server API: disconnect user "bridge-moderator-<session_id>"
  ├── Centrifugo Server API: disconnect user "bridge-assistant-<session_id>"
  │
  ├── stdio-bridge получает disconnect → убивает Claude CLI → exit
  │
  ├── Удаляет временные файлы конфигурации
  └── Обновляет регистр сессий (status = expired)
```

**Расположение исходников:** `Router/ЕХТ_СтдИО/stdio-bridge/` (симв. ссылка на `C:\1ext.ru\projects\github.com\ЕХТ_СтдИО\stdio-bridge\`)

---

## Пошаговый флоу

### Регистрация пользователя (мобильное приложение)

Происходит при первом запуске (user_id отсутствует на устройстве). SMS отправляется **всегда** -- device_id не заменяет подтверждение номера. Номер телефона -- единственный способ восстановить аккаунт на новом устройстве.

```
Мобильное приложение:
  1. connect к Centrifugo (общий mobile JWT)
  2. publish register в mobile:lobby:
     {type: "register", phone: "+79001234567", device_id: "uuid-устройства"}

Роутер (подписан на mobile:lobby):
  3. Получает register (pub.info.client = UUID соединения мобильного)
  4. Проверяет rate limit (15 мин на номер):
     -> Превышен: генерирует reg_id, подписывает на mobile:reg-<reg_id>, отправляет register_error:
        {type: "register_error", reason: "rate_limited", message: "SMS уже отправлено. Повторная отправка через 12 мин", retry_after: 720}
  5. Генерирует reg_id, отправляет SMS с кодом подтверждения
  6. Server API subscribe: подписать конкретное соединение мобильного на mobile:reg-<reg_id>
     subscribe({user: "mobile-lobby-user", client: "<UUID из pub.info>", channel: "mobile:reg-<reg_id>"})
  7. Server API publish в mobile:reg-<reg_id>:
     {type: "sms_sent", reg_id: "..."}
     -> только это мобильное получает (как hello_ack в чате)

Мобильное приложение:
  8. publish confirm в mobile:lobby (Роутер видит как подписчик lobby):
     {type: "confirm", reg_id: "...", code: "1234"}

Роутер:
  9. Проверяет код:
     -> Неверный код: publish в mobile:reg-<reg_id>:
        {type: "confirm_error", reason: "invalid_code", message: "Неверный код", attempts_left: 2}
     -> 3 неудачные попытки: reg_id сгорает, publish:
        {type: "confirm_error", reason: "max_attempts", message: "Превышено число попыток. Запросите новый код", attempts_left: 0}
     -> Код истёк (5 мин): publish:
        {type: "confirm_error", reason: "code_expired", message: "Код устарел. Запросите новый", attempts_left: 0}
  10. MDM: найти или создать пользователя по номеру телефона
      -> Справочник Пользователи (владелец) + подчинённый справочник Базы
  11. Server API publish в mobile:reg-<reg_id>:
      {type: "register_ack", user_id: "uuid", status: "ok"}

Мобильное приложение:
  12. Сохраняет user_id в secure storage (Keychain / Keystore)
  13. Отключается от mobile:lobby -- готово к сканированию QR
```

Адресация аналогична чату: `pub.info.client` из register = UUID соединения мобильного. Server API subscribe подписывает именно это соединение на персональный канал `mobile:reg-<reg_id>`. Мобильное продолжает publish confirm в `mobile:lobby` (Роутер видит как подписчик). Ответы (sms_sent, register_ack) идут в персональный канал -- другие мобильные не видят.

**MDM: справочники**
- **Пользователи** -- владелец, привязан к номеру телефона
- **Базы** -- подчинён Пользователям. Каждый пользователь видит свой список баз (даже если физически одна и та же база, у разных пользователей это разные записи)

device_id хранится в MDM для аудита (разбор инцидентов, отслеживание устройств).

**Ограничения регистрации:**

- 3 попытки ввода кода на один reg_id
- Код живёт 5 минут
- Rate limit на SMS: не чаще 1 раз в 15 минут на один номер телефона

### 1. Пользователь открывает Lyra-Chat.epf в своей базе 1С ✅

Обработка собирает информацию о базе:

| Поле | Пример | Описание |
|------|--------|----------|
| `config_name` | `БухгалтерияПредприятия` | Имя конфигурации (Метаданные.Имя) |
| `config_version` | `3.0.191.41` | Версия конфигурации (Метаданные.Версия) |
| `config_id` | `2xxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx` | Идентификатор конфигурации. MD5 от платформенного `ПолучитьИдентификаторКонфигурации()` без последней строки (она уникальна для каждой базы). У типовых на поддержке одной версии совпадает, у доработанных/снятых с поддержки — свой. Вычисляется в обработке без зависимостей |
| `computer` | `BUHPC-01` | Имя компьютера пользователя |
| `connection_string` | `Srvr="srv1c";Ref="buh_prod";` | Строка подключения к базе 1С |

### 2. Чат подключается к Centrifugo (общий канал session:lobby) ✅

```
Lyra-Chat.epf --> WebSocket --> Centrifugo (:11000) --> канал session:lobby
```

Общий JWT зашит в обработку. Протокол Centrifugo:

```json
// 1. connect с общим JWT
{"id": 1, "connect": {"token": "JWT..."}}
// 2. publish hello в lobby (subscribe не нужен -- allow_publish_for_client: true)
{"id": 2, "publish": {"channel": "session:lobby", "data": {...}}}
```

Данные hello:

```json
{
  "type": "hello",
  "form_id": "uuid-формы",
  "config_name": "БухгалтерияПредприятия",
  "config_version": "3.0.191.41",
  "config_id": "DEADBEEF-0000-0000-0000-00000000F00D",
  "computer": "BUHPC-01",
  "connection_string": "Srvr=\"srv1c\";Ref=\"buh_prod\";"
}
```

### 3. Роутер обрабатывает hello ✅

Роутер подключен к Centrifugo по WebSocket и подписан на `session:lobby` -- получает все hello автоматически.

```
hello (получен через WebSocket)
  |   push содержит pub.info.client = UUID соединения отправителя
  |
  +-> Создать сессию в регистре сведений (session_id + данные базы)
  |         -> session_id (генерирует Роутер)
  |         -> РегистрСведений.ЕХТ_Лира_Роутер_Сессии
  |
  +-> Сгенерировать 2 JWT:
  |         chat_jwt   (sub = chat-uuid)   -- для Чата 1С
  |         mobile_jwt (sub = mobile-uuid) -- для мобильного приложения
  |
  +-> Роутер подписывается на session:<session_id> (Server API subscribe)
  |         -> чтобы получать auth от мобильного и сообщения от Чата
  |         -> WebSocket subscribe запрещён (allow_subscribe_for_client: false для session:)
  |
  +-> Server API subscribe: подписать клиента на session:<session_id>
  |         subscribe({user: "lobby-user", client: "<UUID из pub.info>", channel: "session:<session_id>"})
  |         -> адресует конкретное соединение, а не всех с этим user
  |
  +-> Server API publish: hello_ack в session:<session_id>
          -> только этот клиент получает ответ (остальные на lobby не видят)
```

**Регистр сведений `ЕХТ_Лира_Роутер_Сессии`:**

| Поле | Тип | Назначение |
|------|-----|------------|
| ИДСессии (измерение) | Строка 36 | UUID сессии |
| ИДФормы | Строка 36 | UUID формы обработки (для переподключения) |
| ИмяКонфигурации | Строка 256 | Имя конфигурации клиента |
| ВерсияКонфигурации | Строка 50 | Версия конфигурации |
| ИДКонфигурации | Строка 36 | Идентификатор конфигурации |
| Компьютер | Строка 256 | Имя компьютера |
| СтрокаПодключения | Строка 1024 | Строка подключения |
| Канал | Строка 100 | Канал сессии (session:\<id\>) |
| ИДКлиента | Строка 36 | UUID соединения Centrifugo |
| Статус | Строка 50 | Статус (awaiting_auth, active, closed) |
| ИДПользователя | Строка 36 | ID пользователя (после auth) |
| Создана | ДатаВремя | Время создания |
| ПоследняяАктивность | ДатаВремя | Последняя активность |

**Проверено:** сессия записывается в регистр при обработке hello (все поля заполнены корректно).

**Адресация конкретного клиента на этапе hello:** JWT общий (один `sub` для всех обработок). Centrifugo при publish в push включает `pub.info.client` -- UUID соединения отправителя. Роутер через Server API `subscribe` подписывает именно это соединение (по параметру `client`) на персональный канал `session:<session_id>`, затем публикует hello_ack туда. Подтверждено тестами: `test-two-clients.mjs` (полный hello-флоу), `test-client-id.mjs` (два клиента с одним JWT, subscribe по client ID адресует только одного).

### 4. Клиент получает hello_ack

```json
{
  "type": "hello_ack",
  "session_id": "uuid-сессии",
  "status": "awaiting_auth",
  "chat_jwt": "eyJ...",
  "mobile_jwt": "eyJ..."
}
```

Баланс на этом этапе НЕ проверяется -- пользователь ещё неизвестен. Проверка баланса происходит после авторизации (шаг 7).

### 5. Чат переподключается и отображает QR

Чат переподключается к Centrifugo с `chat_jwt` (отключается от lobby). JWT содержит `channels` claim -- Centrifugo автоматически подписывает на канал сессии при connect (отдельный subscribe не нужен). QR-код = `mobile_jwt`. Оба JWT со сроком жизни 1 год.

```
Lyra-Chat.epf:
  1. Отключиться от lobby
  2. Подключиться к Centrifugo с chat_jwt (авто-подписка на канал сессии)
  3. Отобразить QR-код на форме (QR = mobile_jwt)
```

### 6. Мобильное приложение сканирует QR

Мобильное приложение сканирует QR-код, получает `mobile_jwt`. Подключается к Centrifugo с этим JWT -- авто-подписка на канал сессии через `channels` claim. При авторизации (сканировании QR) мобильное не подключается к lobby — сразу на канал сессии. К `mobile:lobby` мобильное подключается только при регистрации (первый запуск).

```
Мобильное приложение:
  1. Сканировать QR -> получить mobile_jwt
  2. Подключиться к Centrifugo с mobile_jwt (авто-подписка на канал сессии)
  3. Отправить auth на канале:
     {type: "auth", user_id: "uuid-пользователя", device_id: "uuid-устройства"}
```

### 7. Роутер завершает авторизацию

```
auth (на канале сессии)
  |
  +-> MDM: найти пользователя по user_id + проверить device_id
  |         -> ОК (пара user_id + device_id совпадает) → продолжить
  |         -> Не найден / device_id не совпадает → auth_ack с status: "auth_failed"
  |            (причина не раскрывается клиенту — логируется на сервере для аудита)
  |
  +-> MDM: создать запись в справочнике Базы (подчинён Пользователям)
  |         -> привязать данные базы из hello к пользователю
  |
  +-> Роутер публикует event_router_auth_completed в service:events
  |         {type: "event_router_auth_completed", session_id, user_id, channel: "session:<id>"}
  |
  +-> Биллинг (подписан на service:events) получает event_router_auth_completed:
  |         -> проверяет баланс пользователя
  |         -> подключается к каналу сессии (WebSocket subscribe)
  |         -> публикует event_billing_balance_checked в service:events:
  |            {type: "event_billing_balance_checked", session_id, status: "ok"|"insufficient_balance", balance: 1250.00}
  |
  +-> Роутер получает event_billing_balance_checked:
  |         -> отправляет auth_ack в канал сессии (status из ответа Биллинга)
  |         -> если Биллинг не ответил за 10 секунд -- auth_ack с status: "service_unavailable"
  |
  +-> Биллинг обновляет баланс в реальном времени (balance_update при каждом изменении)
  |         -> при пополнении до достаточного уровня -- публикует event_billing_balance_checked ok
  |         -> Роутер отправляет auth_ack ok в канал сессии
```

Роутер -- единственный отправитель auth_ack. Биллинг обязателен: без ответа Биллинга пользователь не допускается к работе.

### 8. Пользователь пишет вопрос

Сообщение отправляется в канал сессии:

```json
{
  "type": "user_message",
  "form_id": "uuid-формы",
  "session_id": "uuid-сессии",
  "text": "Почему у контрагента Ромашка не заполнен КПП?"
}
```

### 9. Медиа от мобильного

Мобильное приложение публикует фото/голос в канал сессии. Модератор подхватывает (как и текстовые `user_message`). Чат видит (подписан на тот же канал) и отображает.

```
Мобильное --> канал сессии --> Модератор (stdio-bridge) --> канал --> Ассистент (stdio-bridge) --> Claude
                  |
                  +----------> Чат (отображает фото/голос)
```

### 10. Биллинг и Модератор проверяют сообщение

Последовательная цепочка: Биллинг → Модератор → Ассистент.

```
Канал сессии
    │
    ├── user_message (от Чата / Мобильного)
    │       │
    │       ▼
    │   Биллинг (подписан на канал, слушает user_message)
    │       │
    │       ├── Баланс ≤ 0 → publish {type: "billing_block", message: "Недостаточно средств"}
    │       │                 → цепочка прерывается, Чат показывает сообщение
    │       │
    │       └── Баланс > 0 → publish {type: "billing_ok", text: "<текст из user_message>", ...}
    │                         → передаёт сообщение дальше по цепочке
    │
    ├── billing_ok
    │       │
    │       ▼
    │   stdio-bridge (Модератор, Haiku) — слушает billing_ok
    │       │
    │       ├── Блокировка → publish {type: "moderator_block", message: "..."}
    │       │                 → цепочка прерывается, Чат показывает предупреждение
    │       │
    │       └── ОК → publish {type: "assistant_input", text: "...", reminder?: "..."}
    │                 → Модератор добавляет примечание если нужно
    │
    ├── assistant_input (от Модератора)
    │       │
    │       ▼
    │   stdio-bridge (Ассистент, Sonnet/Opus) — слушает assistant_input
    │       │
    │       └── publish {type: "assistant_output", ...} (стриминг ответа)
    │
    └── assistant_output (от Ассистента) → Чат + Мобильное отображают
```

Биллинг — гейткипер (первый в цепочке). Модератор — координатор (формирует `assistant_input`). Промежуточных типов не нужно — каждый участник слушает результат предыдущего.

Три результата модерации:

- **Блокировка** (`moderator_block`) -- prompt injection, вопросы об устройстве -- пользователь получает предупреждение, Ассистент не видит сообщение
- **Напоминание** (`assistant_input` + `reminder`) -- рискованный вопрос ("расскажи о себе", "какая ты модель?") -- модератор добавляет приписку
- **ОК** (`assistant_input`) -- обычный вопрос, проходит без изменений

Соблюдение легенды ("Лира -- AI-ассистент") обеспечивается двумя уровнями:

1. **Системный промпт** Claude (основная линия)
2. **Модератор** -- контекстные напоминания на входе при рискованных вопросах

### 11. Роутер запускает stdio-bridge (два экземпляра)

При создании сессии Роутер запускает **два** процесса stdio-bridge — Модератор и Ассистент. Каждый подключается к Centrifugo как WebSocket-клиент и подписывается на канал сессии. После запуска работают **автономно** — не зависят от соединения с 1С.

```
ЕХТ_Лира_Роутер запускает:

1. stdio-bridge (Модератор):
      --centrifugo-url "ws://localhost:11000/connection/websocket"
      --centrifugo-token "<JWT канала сессии>"
      --channel "session:<session_id>"
      --listen-type "billing_ok"
      --publish-type "assistant_input"
      --config "/tmp/lyra-moderator-<session_id>.json"

2. stdio-bridge (Ассистент):
      --centrifugo-url "ws://localhost:11000/connection/websocket"
      --centrifugo-token "<JWT канала сессии>"
      --channel "session:<session_id>"
      --listen-type "assistant_input"
      --publish-type "assistant_output"
      --config "/tmp/lyra-assistant-<session_id>.json"
```

**Файл конфигурации** (JSON) содержит параметры модели:

```json
{
  "program": "claude",
  "args": ["--model", "sonnet", "--output-format", "stream-json"],
  "system_prompt_file": "/tmp/lyra-prompt-<session_id>.md",
  "mcp_config": "/tmp/lyra-mcp-<session_id>.json",
  "permission_mode": "plan"
}
```

Роутер генерирует файл при создании сессии, включая динамический системный промпт с контекстом базы (конфигурация, версия, config_id).

**Протокол Centrifugo в stdio-bridge** (мини-клиент на `tungstenite`, ~200-300 строк):

```json
// Connect с JWT
{"id":1, "connect":{"token":"<JWT>","name":"bridge-moderator-<session_id>"}}

// Subscribe на канал сессии
{"id":2, "subscribe":{"channel":"session:<session_id>"}}

// Publish (результат модерации / ответ Claude)
{"id":3, "publish":{"channel":"session:<session_id>","data":{...}}}
```

**Фильтрация**: каждый bridge реагирует только на свой `--listen-type`, игнорирует остальные сообщения в канале.

### 12. stdio-bridge (Ассистент) получает assistant_input, стримит ответ

```
assistant_input (в канале) --> stdio-bridge --> stdin --> Claude
                                                          |
                                                          +-- thinking (размышления)
                                                          +-- text (ответ по буквам)
                                                          +-- tool_use (MCP-вызов)
                                                          |     +-- Vega: search_metadata, search_code
                                                          |     +-- exec: v8_query, v8_eval -> через Centrifugo -> 1С клиента -> результат
                                                          +-- result (финальный ответ)
```

### 13. Стриминг ответа клиенту

```
Claude --> stdout --> stdio-bridge (Ассистент) --> Centrifugo publish --> канал сессии
                                                                           |
                                                                           +--> Lyra-Chat.epf (основной UI)
                                                                           +--> Мобильное приложение
                                                                                (видит ответ, но UI чата -- в 1С)
```

**Ключевое отличие от предыдущей схемы:** stdio-bridge публикует в Centrifugo **напрямую** через WebSocket, без посредничества Роутера и HTTP callback. Роутер не участвует в стриминге — только запускает процессы и управляет жизненным циклом.

Проверка исходящих не нужна -- легенда обеспечивается системным промптом + напоминаниями модератора на входе (шаг 10).

### 13а. Биллинг: проверка + списание

Биллинг участвует **дважды** в каждом цикле запрос-ответ:

1. **Перед Claude (шаг 10):** слушает `user_message` → проверяет баланс → `billing_ok` (цепочка продолжается) или `billing_block` (цепочка прерывается)
2. **После ответа:** слушает `assistant_output` event=result → списывает стоимость → `balance_update` в канал → если баланс ≤ 0, публикует `event_billing_balance_checked insufficient_balance` в `service:events` → Роутер переводит ВСЕ сессии пользователя в `insufficient_balance`

### 14. exec-команды (MCP -> 1С клиента)

Когда Claude нужны данные из базы пользователя. stdio-bridge (Ассистент) публикует exec-запрос в канал, Чат выполняет и отвечает:

```
Claude: tool_use v8_query("ВЫБРАТЬ КПП ИЗ Справочник.Контрагенты WHERE ...")
    |
    v
stdio-bridge (Ассистент) --> publish в канал сессии:
    {type: "exec_request", request_id: "uuid", tool: "v8_query", params: {...}}
                                |
                                v
Lyra-Chat.epf (подписан на канал) --> выполнить запрос на сервере 1С
                                |
                                v
Lyra-Chat.epf --> publish в канал сессии:
    {type: "exec_response", request_id: "uuid", result: [{КПП: "", ЮрФизЛицо: "ФизЛицо"}]}
                                |
                                v
stdio-bridge (Ассистент, слушает exec_response) --> stdin --> Claude
```

**Роутер не участвует в exec-обмене** — Ассистент и Чат общаются напрямую через канал.

---

## Переподключение

Переподключение определяется по `form_id` — UUID формы обработки (`ЭтотОбъект.УникальныйИдентификатор`). Генерируется при открытии формы, живёт в оперативной памяти 1С. `form_id` включается во все сообщения от Чата (hello, user_message).

**Логика Роутера при получении hello:**

- `form_id` **неизвестен** → новая сессия (полный цикл: шаги 3–7)
- `form_id` **известен**, сессия жива → переподключение:
  - Генерирует новый `chat_jwt` (старое WS-соединение мёртво)
  - Отправляет `hello_ack` со статусом `reconnected` (без `mobile_jwt` — QR не нужен)
  - Адаптер и Claude продолжают работать, контекст сохранён
- `form_id` **известен**, сессия истекла (TTL) → новая сессия

**TTL сессии без клиента:** 30 минут. Если Чат не переподключился за 30 минут — сессия закрывается, адаптер останавливается. При следующем hello с тем же form_id — новая сессия.

**Закрытие формы** — form_id исчезает (жил только в RAM). Следующее открытие формы генерирует новый form_id → всегда новая сессия.

## Идентификация базы в НСИ (MDM)

Из hello формируется уникальный идентификатор базы:

```
config_name + connection_string + computer
     |                 |                |
     v                 v                v
"БухгалтерияПредприятия" + "Srvr=srv1c;Ref=buh_prod;" + "BUHPC-01"
                    |
                    v
            Хеш -> идентификатор базы в НСИ
```

Это позволяет:

- Различать одну и ту же конфигурацию на разных серверах
- Различать тестовую и рабочую базу на одном сервере
- Привязывать базу к тарифу, балансу, истории запросов
- Выбирать правильный Vega-инстанс (по конфигурации + версии)

---

## Контракты сообщений

Все сообщения -- JSON. Обязательные правила:

- Каждое сообщение содержит `type`
- Ошибки содержат `reason` (machine-readable) + `message` (human-readable)
- `session_id` присутствует во всех сообщениях в контексте сессии

### Регистрация (mobile:lobby ↔ mobile:reg-\<reg_id\>)

```json
// Мобильное → mobile:lobby
{"type": "register", "phone": "+79001234567", "device_id": "uuid-устройства"}

// Роутер → mobile:reg-<reg_id>
{"type": "sms_sent", "reg_id": "uuid-регистрации"}

// Мобильное → mobile:lobby
{"type": "confirm", "reg_id": "uuid-регистрации", "code": "1234"}

// Роутер → mobile:reg-<reg_id> (успех)
{"type": "register_ack", "status": "ok", "user_id": "uuid-пользователя"}

// Роутер → mobile:reg-<reg_id> (ошибка)
{"type": "confirm_error", "reason": "invalid_code", "message": "Неверный код", "attempts_left": 2}
{"type": "confirm_error", "reason": "max_attempts", "message": "Превышено число попыток. Запросите новый код", "attempts_left": 0}
{"type": "confirm_error", "reason": "code_expired", "message": "Код устарел. Запросите новый", "attempts_left": 0}

// Роутер → mobile:reg-<reg_id> (rate limit)
{"type": "register_error", "reason": "rate_limited", "message": "SMS уже отправлено. Повторная отправка через 12 мин", "retry_after": 720}
```

### Список сессий (mobile:lobby)

```json
// Мобильное → mobile:lobby (запрос списка сессий пользователя)
{"type": "get_sessions", "user_id": "uuid-пользователя"}

// Роутер → mobile:sessions-<uuid> (персональный канал, через Server API subscribe + publish)
{"type": "sessions_list", "sessions": [
  {"session_id": "uuid", "channel": "session:uuid", "config_name": "БухгалтерияПредприятия", "status": "active", "created": "2026-03-09T12:00:00", "last_activity": "2026-03-09T14:30:00"},
  {"session_id": "uuid2", "channel": "session:uuid2", "config_name": "ЗарплатаИКадры", "status": "disconnected", "created": "2026-03-08T09:00:00", "last_activity": "2026-03-08T18:00:00"}
]}
```

Роутер возвращает только сессии со статусами `active`, `insufficient_balance`, `disconnected`. Сессии `created`, `awaiting_auth`, `expired` не возвращаются.

### Сессия (session:lobby ↔ session:\<id\>)

```json
// Чат → session:lobby
{"type": "hello", "form_id": "uuid-формы", "config_name": "БухгалтерияПредприятия", "config_version": "3.0.191.41", "config_id": "DEADBEEF-0000-0000-0000-00000000F00D", "computer": "BUHPC-01", "connection_string": "Srvr=\"srv1c\";Ref=\"buh_prod\";", "base_ids": {"ssl_id": "uuid", "user_id": "uuid", "storage_id": "uuid", "connect_id": "md5-hash"}}

// Роутер → session:<id> (новая сессия)
{"type": "hello_ack", "session_id": "uuid-сессии", "status": "awaiting_auth", "chat_jwt": "eyJ...", "mobile_jwt": "eyJ..."}

// Роутер → session:<id> (переподключение — form_id известен, сессия жива)
{"type": "hello_ack", "session_id": "uuid-сессии", "status": "reconnected", "chat_jwt": "eyJ..."}

// Мобильное → session:<id>
{"type": "auth", "user_id": "uuid-пользователя", "device_id": "uuid-устройства"}

// Роутер → session:<id>
{"type": "auth_ack", "session_id": "uuid-сессии", "status": "ok"}
{"type": "auth_ack", "session_id": "uuid-сессии", "status": "insufficient_balance", "message": "К сожалению, на вашем счёте недостаточно средств. Пополните баланс в мобильном приложении, и мы сразу продолжим!"}
{"type": "auth_ack", "session_id": "uuid-сессии", "status": "service_unavailable", "message": "Сервис временно недоступен. Попробуйте позже."}
{"type": "auth_ack", "session_id": "uuid-сессии", "status": "auth_failed", "message": "Ошибка авторизации. Попробуйте заново."}

// Биллинг → session:<id>
{"type": "balance_update", "session_id": "uuid-сессии", "balance": 1250.00, "currency": "RUB"}
```

### Чат: сообщения и стриминг (session:\<id\>)

```json
// Чат → session:<id> (вопрос пользователя)
{"type": "user_message", "form_id": "uuid-формы", "session_id": "uuid-сессии", "text": "Почему у контрагента Ромашка не заполнен КПП?"}

// Биллинг → session:<id> (проверка баланса, слушает user_message)
{"type": "billing_ok", "session_id": "uuid-сессии", "text": "Почему у контрагента Ромашка не заполнен КПП?", "form_id": "uuid-формы"}
{"type": "billing_block", "session_id": "uuid-сессии", "message": "Недостаточно средств. Пополните баланс."}

// Модератор (stdio-bridge) → session:<id> (слушает billing_ok, формирует assistant_input)
{"type": "assistant_input", "session_id": "uuid-сессии", "text": "Почему у контрагента Ромашка не заполнен КПП?"}
{"type": "assistant_input", "session_id": "uuid-сессии", "text": "Расскажи о себе", "reminder": "При ответе придерживайся легенды"}
{"type": "moderator_block", "session_id": "uuid-сессии", "message": "Я не могу отвечать на вопросы о внутреннем устройстве системы."}

// Ассистент (stdio-bridge) → session:<id> (стриминг — события Claude)
{"type": "assistant_output", "event": "content_block_start", "index": 0, "content_block": {"type": "text", "text": ""}}
{"type": "assistant_output", "event": "content_block_delta", "index": 0, "delta": {"type": "text_delta", "text": "КПП не заполнен"}}
{"type": "assistant_output", "event": "content_block_stop", "index": 0}
{"type": "assistant_output", "event": "message_start"}
{"type": "assistant_output", "event": "message_delta"}
{"type": "assistant_output", "event": "message_stop"}

// Ассистент (stdio-bridge) → session:<id> (финальный результат)
{"type": "assistant_output", "event": "result", "result": "Полный текст ответа Claude"}

// Ассистент (stdio-bridge) → session:<id> (ошибка)
{"type": "assistant_output", "event": "error", "message": "Описание ошибки"}
```

**Механизм стриминга — последовательная цепочка:**
1. `user_message` → **Биллинг** (проверка баланса) → `billing_ok` / `billing_block`
2. `billing_ok` → **Модератор** (stdio-bridge, Haiku) → `assistant_input` / `moderator_block`
3. `assistant_input` → **Ассистент** (stdio-bridge, Sonnet/Opus) → stdin Claude CLI → NDJSON из stdout → `assistant_output` в канал

Чат (Lyra-Chat.epf) парсит `assistant_output` и отображает ответ. **Роутер не участвует в стриминге ответов.**

**Жизненный цикл bridge:** Claude CLI запускается в режиме `-p --output-format stream-json`. stdio-bridge управляет перезапуском самостоятельно (без участия Роутера).

### exec-команды (session:\<id\>)

```json
// Ассистент (stdio-bridge) → session:<id> (запрос данных из базы)
{"type": "exec_request", "session_id": "uuid-сессии", "request_id": "uuid-запроса", "tool": "v8_query", "params": {"query": "ВЫБРАТЬ КПП ИЗ Справочник.Контрагенты WHERE ..."}}

// Чат (Lyra-Chat.epf) → session:<id> (ответ с данными)
{"type": "exec_response", "session_id": "uuid-сессии", "request_id": "uuid-запроса", "result": [{"КПП": "", "ЮрФизЛицо": "ФизЛицо"}]}
{"type": "exec_response", "session_id": "uuid-сессии", "request_id": "uuid-запроса", "error": "Описание ошибки"}
```

### Служебные события (service:events)

```json
// Роутер → service:events
{"type": "event_router_auth_completed", "session_id": "uuid-сессии", "user_id": "uuid-пользователя", "channel": "session:<id>"}

// Биллинг → service:events
{"type": "event_billing_balance_checked", "session_id": "uuid-сессии", "status": "ok", "balance": 1250.00}
{"type": "event_billing_balance_checked", "session_id": "uuid-сессии", "status": "insufficient_balance", "balance": 0.00}
```

### Жизненный цикл сессии (статусы в регистре ЕХТ_Лира_Роутер_Сессии)

```text
                                                    баланс ≤ 0
                                               ┌──────────────────────┐
                                               │                      ▼
 ┌─────────┐       ┌──────────────┐       ┌────┴────┐       ┌────────────────────┐
 │ created │──────►│awaiting_auth │──────►│ active  │──────►│insufficient_balance│
 └─────────┘       └──────┬───────┘       └────┬────┘       └─────────┬──────────┘
  hello              QR показан           auth ok  │  баланс > 0      │
                      │                        │   └──────────────────┘
                      │                        │
                      │    ┌───────────────┐   │
                      │    │ disconnected  │◄──┘ Чат закрыл форму
                      │    └───────┬───────┘
                      │         ▲  │
                      │ reconnect  │ TTL 30 мин
                      │    │  ┌────┘
                      │    │  │
                      │    │  ▼
                      │    ┌───────────┐
                      └───►│  expired  │
                 TTL       └───────────┘
                 без auth       │
                                удаление записи
```

#### Статусы

| Статус | Когда устанавливается | Описание | Мобильное видит |
| --- | --- | --- | --- |
| `created` | Роутер принял hello, генерирует JWT | Сессия создаётся, переход в awaiting_auth мгновенный | Нет |
| `awaiting_auth` | Роутер отправил hello_ack (chat_jwt + mobile_jwt) | Чат показывает QR, ждём сканирования с телефона | Нет |
| `active` | auth_ack ok (MDM + Биллинг подтвердили, баланс > 0) | Сессия работает, Claude доступен, голос и камера разрешены | Зелёная иконка |
| `insufficient_balance` | Биллинг: баланс ≤ 0 (при auth или во время работы) | Ввод заблокирован, пополните баланс для продолжения | Жёлтая иконка, «Пополните баланс» |
| `disconnected` | Чат закрыл форму (disconnect Centrifugo) | Чат отключился, сессия ждёт reconnect | Серая иконка, «Чат отключён» |
| `expired` | TTL истёк (регулярное задание Роутера) | Сессия просрочена, подлежит удалению | Пропадает из списка |

#### Все переходы

| Из → В | Триггер | Кто меняет | Что происходит |
| --- | --- | --- | --- |
| `created` → `awaiting_auth` | hello обработан, JWT сгенерированы | Роутер | hello_ack отправлен в канал сессии. Мгновенный переход в рамках одной обработки hello |
| `awaiting_auth` → `active` | Мобильное: auth → MDM ok → Биллинг ok (баланс > 0) | Роутер | auth_ack ok в канал сессии. Мобильное сохраняет сессию. Claude доступен |
| `awaiting_auth` → `insufficient_balance` | Мобильное: auth → MDM ok → Биллинг: баланс ≤ 0 | Роутер | auth_ack insufficient_balance. Сессия создана, но ввод заблокирован до пополнения |
| `awaiting_auth` → `expired` | TTL без auth (никто не отсканировал QR за 30 мин) | Регулярное задание | Запись удаляется из регистра |
| `active` → `insufficient_balance` | Биллинг: баланс пользователя упал до ≤ 0 после списания | Роутер (по event от Биллинга) | **Каскадно для ВСЕХ active-сессий пользователя.** balance_update в каждый канал. Роутер блокирует новые запросы к Claude. Мобильное показывает «Пополните баланс» |
| `active` → `disconnected` | Чат закрыл форму → отправляет `{type: "disconnect"}` в канал сессии | Роутер | session_status в канал сессии. Мобильное видит «Чат отключён», ввод заблокирован |
| `active` → `expired` | TTL без активности (LastActivity устарел на 30 мин) | Регулярное задание | Запись удаляется. Сессия пропадает из списка мобильного |
| `insufficient_balance` → `active` | Биллинг: баланс пользователя пополнен > 0 | Роутер (по event от Биллинга) | **Каскадно для ВСЕХ insufficient_balance-сессий пользователя.** event_billing_balance_checked ok → auth_ack ok в каждый канал. Ввод разблокирован |
| `insufficient_balance` → `disconnected` | Чат закрыл форму → `{type: "disconnect"}` | Роутер | Аналогично active → disconnected |
| `insufficient_balance` → `expired` | TTL истёк | Регулярное задание | Запись удаляется |
| `disconnected` → `active` | Чат переоткрыл форму с тем же form_id (reconnect) | Роутер | hello_ack reconnected (новый chat_jwt, без mobile_jwt). Мобильное снова видит зелёную иконку |
| `disconnected` → `expired` | TTL 30 мин без reconnect | Регулярное задание | Запись удаляется. Сессия пропадает из списка мобильного |

#### Баланс — один на пользователя, не на сессию

Баланс привязан к `user_id` (пользователь в MDM). Один пользователь может иметь несколько активных сессий одновременно (разные базы 1С).

**При исчерпании баланса (≤ 0):**
- Роутер находит **все** сессии пользователя со статусом `active`
- Переводит каждую в `insufficient_balance`
- Отправляет `balance_update` в **каждый** канал сессии
- Все Чаты блокируют ввод, мобильное видит жёлтые иконки

**При пополнении баланса (> 0):**
- Роутер находит **все** сессии пользователя со статусом `insufficient_balance`
- Переводит каждую обратно в `active`
- Отправляет `auth_ack ok` + `balance_update` в **каждый** канал
- Все Чаты разблокируют ввод

#### Запрещённые переходы

- `expired` → любой: просроченная сессия не восстанавливается. Чат должен создать новую (hello)
- `awaiting_auth` → `disconnected`: Чат отключился до auth — сессия сразу в expired (нет пользователя, некому показывать)
- `created` → любой кроме `awaiting_auth`: created — транзитный статус

#### Что видит мобильное в списке сессий

- Запрашивает `get_sessions {user_id}` через mobile:lobby
- Роутер возвращает сессии со статусами `active`, `insufficient_balance` и `disconnected`
- НЕ возвращает `created`, `awaiting_auth`, `expired`
- `active` — зелёная иконка, можно работать (голос, камера)
- `insufficient_balance` — жёлтая иконка, «Пополните баланс», ввод заблокирован
- `disconnected` — серая иконка, «Чат отключён», ввод заблокирован

### Статусы сообщений

| Поле status | Где используется | Значение |
| --- | --- | --- |
| `ok` | register_ack, auth_ack, event_billing_balance_checked | Успех |
| `awaiting_auth` | hello_ack | Ожидание QR-авторизации |
| `reconnected` | hello_ack | Переподключение (form_id) |
| `insufficient_balance` | auth_ack, event_billing_balance_checked | Недостаточно средств |
| `service_unavailable` | auth_ack | Биллинг не ответил (таймаут) |
| `auth_failed` | auth_ack | MDM: user_id/device_id не прошёл проверку |

### Коды ошибок (reason)

| reason           | Где используется | Значение                           |
|------------------|------------------|------------------------------------|
| `invalid_code`   | confirm_error    | Неверный SMS-код                   |
| `max_attempts`   | confirm_error    | Исчерпаны попытки (reg_id сгорел)  |
| `code_expired`   | confirm_error    | Код истёк (5 мин)                  |
| `rate_limited`   | register_error   | SMS rate limit (15 мин на номер)   |

---

## Три слоя знаний Claude

1. **Как устроено** (Vega) — структура конфигурации, код модулей, связи между объектами
2. **Как должно быть** (mcp-1c-docs) — документация, best practices, справочник языка
3. **Как есть сейчас** (exec-команды через Centrifugo) — реальные данные в базе пользователя

## Связь с Vega

- Vega и Lyra живут на одном хосте
- Vega обновляется при выходе новых релизов 1С (`vega import --release ...`)
- Инкрементальные embeddings (v4) обеспечивают быстрое обновление (~20 сек)
- Роутер знает конфигурацию и версию пользователя → выбирает правильный Vega-инстанс

### Конфигурация Vega MCP

Маппинг конфигураций 1С → Vega MCP-серверы задаётся в файле `Профили/Основной/vega.json`:

```json
{
  "type": "http",
  "headers": {"X-API-Key": "vega"},
  "allowedTools": ["mcp__vega__search_metadata", "mcp__vega__search_metadata_by_description", "mcp__vega__search_code"],
  "configs": {
    "БухгалтерияПредприятия":        {"port": 60010},
    "ЗарплатаИУправлениеПерсоналом": {"port": 60030},
    "УправлениеТорговлей":           {"port": 60050},
    "УправлениеПредприятием":        {"port": 60060},
    "РозничнаяТорговля":             {"port": 60040},
    "Демонстрационная":              {"port": 60020}
  }
}
```

При hello Роутер получает `config_name` (Метаданные.Имя), ищет его в `configs`. Если найден — добавляет Vega MCP-сервер в `--mcp-config` Claude CLI и vega-инструменты в `--allowedTools`. Тип, заголовки и список инструментов берутся из того же файла — код расширения не содержит хардкода.

## Мультитенантность и сессии

- При подключении клиент передаёт через hello: config_name, config_version, config_id, строка подключения, компьютер
- Роутер по этим данным выбирает нужный Vega-инстанс (БП/УТ/ERP + версия релиза)
- Контекст диалога сохраняется в рамках сессии (follow-up вопросы работают)
- Сессия переживает переподключение клиента (stdio-bridge + Claude-процесс живут автономно, подключены к Centrifugo напрямую)
- Один пользователь может иметь несколько активных сессий (несколько баз одновременно) — каждая сессия имеет свой канал и свою пару JWT

## Мобильное приложение

Платформа: **Flutter** (iOS + Android). Единственный способ авторизации пользователя в системе — альтернатив нет.

### MVP

- Регистрация (телефон + SMS)
- Сканер QR-кода (авторизация сессии)
- Баланс
- Статус подключения
- Список баз (активные сессии)

### Будущее

- Микрофон — голосовой ввод: речь → текст → канал сессии → Роутер → Claude
- Камера — фото → канал сессии → Роутер → Claude
- Статистика использования
- Пополнение баланса (внешний эквайринг)
- Push-уведомления

### Несколько сессий

Один пользователь может работать с несколькими базами одновременно. Каждое сканирование QR создаёт отдельную сессию. Мобильное отображает список активных баз.

### Что видит мобильное

Баланс (в реальном времени от Биллинга через `balance_update` на канале сессии), статус подключения, список баз. Стриминг ответов Claude отображается только в Чате (1С) — мобильное не дублирует чат.

## Lyra-Chat.epf — клиент 1С

Внешняя обработка (EPF) с чат-интерфейсом на базе фреймворка ЕХТ_Чат.

### Требования к платформе

- **1С:Предприятие 8.3.27+** — требуется встроенный WebSocket-клиент
- Тонкий клиент, управляемое приложение

### Возможности

- HTML-чат с Markdown-рендерингом, подсветкой BSL-кода, темами (светлая/тёмная)
- Мини-клиент протокола Centrifugo на BSL (connect, subscribe, publish, ping/pong)
- Стриминг ответов Claude в реальном времени (thinking + text дельты)
- Выполнение exec-команд на сервере 1С (v8_query, v8_eval, v8_metadata, v8_exec)
- Переподключение к существующей сессии по session_id
- Busy-блокировка: пока Claude обрабатывает запрос, повторная отправка запрещена
- Модульная архитектура: главная форма + формы-модули (Bridge, Парсер, MCP)

### Распространение

Обработка распространяется любым способом (файл EPF). Общий JWT зашит в обработку — даёт доступ только к lobby. Персональные JWT (chat_jwt, mobile_jwt) генерируются Роутером при создании сессии. Авторизация — через мобильное приложение (QR).

## Безопасность

- 1С-запросы безопасны: в языке запросов 1С нет UPDATE/DELETE — только SELECT
- v8_eval — вычисление выражений (Вычислить()), не процедуры
- Деструктивных операций через exec-канал нет

## Монетизация

- Каждый запрос уменьшает баланс клиента
- Пока баланс > 0 — всё работает
- Стоимость зависит от модели и количества MCP round-trips

### Стоимость моделей Claude API (за 1M токенов)

| Модель | Input | Output |
|--------|-------|--------|
| Haiku 4.5 | $0.80 | $4 |
| Sonnet 4.5 | $3 | $15 |
| Opus 4.6 | $15 | $75 |

### Примерные сценарии

- Простой (Haiku) — ~0.05 руб
- Сложный (Sonnet + 5 MCP) — ~7 руб
- Максимальный (Opus) — ~36 руб

## Стиль общения (критично!)

- **Язык пользователя**, НЕ программиста: "звёздочка", "пункт меню", "галочка"
- **НИКОГДА** не говорить: "регламентное задание", "регистр сведений", "функциональная опция", "план обмена"
- **Уточняй размытые вопросы** — сначала спроси, потом действуй
- **Думай о простом** — "пропала синхронизация" может означать удалённую звёздочку в Избранном
- Направляй по интерфейсу: "Администрирование → Синхронизация данных"

## Примеры циклов

### Простой (с уточнением)

```
Пользователь: "У меня пропала синхронизация, что делать?"
  → Claude: вопрос размытый → уточняет
  → "Подскажите: пропала ссылка из меню? Данные не приходят? Ошибка?"
  → Пользователь: "Пропала звёздочка"
  → Claude: это просто! Отвечает сам
  → "Откройте Администрирование → Синхронизация данных, нажмите звёздочку."
```

### Сложный (с exec-командами)

```
Пользователь: "Почему у контрагента Ромашка не заполнен КПП?"
  → Claude: нужны данные → использует exec
  → Vega: search_metadata → Справочники.Контрагенты, атрибут КПП
  → exec: v8_query → SELECT КПП, ЮрФизЛицо WHERE Наименование LIKE "Ромашка%"
  → Claude: видит ЮрФизЛицо = ФизЛицо → понимает причину
  → "КПП не заполнен, потому что Ромашка — физлицо. У физлиц КПП не бывает."
```

## Прототип Bridge (устаревшее)

Bridge (Node.js) — прототип, использовался для отладки MVP. Заменяется Роутером.

- `bridge.js v2` — WebSocket-сервер (:3003), spawn Claude Code CLI
- Протокол v2: session, chat, stream_event, result, error, mcp_request/mcp_response
- exec-маршрутизация: Bridge знал пару "Claude-процесс ↔ WebSocket 1С"
- Все функции Bridge переходят к Роутеру + Centrifugo
