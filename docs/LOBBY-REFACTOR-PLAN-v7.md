# Рефакторинг lobby — v7 (final implementation spec)

Основано на:

- `LOBBY-REFACTOR-PLAN-v6.md`
- `LOBBY-REFACTOR-PLAN-v6-AUDIT.md`
- текущем коде роутера, mobile и transport-обёрток

## Цель

Сделать `lobby` чистой transport-точкой входа без бизнес-данных:

- Chat входит через `session:lobby`, получает персональный bootstrap-канал и уходит в `room:<sessionId>`;
- Mobile входит через `mobile:lobby`, получает персональный bootstrap-канал и уходит в `user:<userId>`;
- session/QR-поток работает через `room:<sessionId>`;
- account-операции работают только через `user:<userId>`.

## Главные инварианты

### 1. В lobby нет payload-данных

В `session:lobby` и `mobile:lobby` допустимы только:

- connect
- disconnect
- join
- leave

Ни `hello`, ни `register`, ни `get_sessions` туда не публикуются.

### 2. Роутер подписывается раньше клиента

- `handleHello()` сначала подписывает роутер на `room:<sessionId>`, потом отправляет `hello_ack`;
- `handleRegister()` сначала подписывает роутер на `user:<userId>`, потом отправляет `register_ack`.

### 3. Один `clientUUID` = один bootstrap

- duplicate `join` не создаёт вторую запись в `pendingBootstraps`;
- duplicate `hello` после первого принятого сообщения игнорируется;
- duplicate `register` после первого принятого сообщения игнорируется.

### 4. `device_id` переживает auth fallback

`device_id` не удаляется:

- при unauthorized;
- при ротации секрета;
- при bootstrap/re-bootstrap;
- при `clearAuth()`.

Удаляется только при полном logout.

### 5. На `user:` `userId` всегда берётся из имени канала

На `user:<userId>` payload не содержит `user_id`.  
Во всех запросах обязателен `device_id`.

### 6. `session:lobby` остаётся `session:lobby`

После рефакторинга:

- `session:lobby` = entry point;
- `session:<clientUUID>` = bootstrap;
- старый рабочий `session:<sessionId>` уходит в `room:<sessionId>`.

### 7. `pipe:<sessionId>` не меняется

Переименование `session:<sessionId>` -> `room:<sessionId>` не влияет на `pipe:<sessionId>`.  
Adapter/sidecar продолжает получать `pipe:<sessionId>` отдельным параметром.

---

## Каналы

| Канал | Тип | Кто | Назначение |
|-------|-----|-----|------------|
| `session:lobby` | entry | Chat + Router | вход Chat |
| `mobile:lobby` | entry | Mobile + Router | вход Mobile |
| `session:<clientUUID>` | bootstrap | Chat + Router | `hello`, `hello_ack`, `hello_error` |
| `mobile:<clientUUID>` | bootstrap | Mobile + Router | `register`, `register_ack`, `register_error` |
| `room:<sessionId>` | work | Chat + Mobile + Router | auth, chat, balance, Claude |
| `user:<userId>` | work | Mobile + Router | sessions, profile, email |
| `pipe:<sessionId>` | internal | Router + sidecar | без изменений |
| `service:events` | internal | server events | без изменений |

---

## Centrifugo namespace policy

```json
{
  "channel": {
    "namespaces": [
      {
        "name": "session",
        "allow_subscribe_for_client": false,
        "allow_publish_for_client": true,
        "presence": true,
        "join_leave": true
      },
      {
        "name": "mobile",
        "allow_subscribe_for_client": false,
        "allow_publish_for_client": true,
        "presence": true,
        "join_leave": true
      },
      {
        "name": "room",
        "allow_subscribe_for_client": false,
        "allow_publish_for_client": true,
        "presence": true,
        "join_leave": true
      },
      {
        "name": "user",
        "allow_subscribe_for_client": false,
        "allow_publish_for_client": true
      },
      {
        "name": "pipe",
        "allow_subscribe_for_client": false,
        "allow_publish_for_client": true
      },
      {
        "name": "service",
        "allow_subscribe_for_client": true,
        "allow_publish_for_client": true
      }
    ]
  }
}
```

### Policy для `room:` leave/join

- Chat реагирует только на `leave.info.user == "router-1"`;
- alert показывается через grace period 5 секунд;
- если за 5 секунд приходит `join` того же `router-1`, alert отменяется.

---

## JWT

| Токен | sub | channels | Срок |
|-------|-----|----------|------|
| `lobbyJwt` chat | `lobby-chat` | `["session:lobby"]` | 1 год |
| `lobbyJwt` mobile | `lobby-mobile` | `["mobile:lobby"]` | 1 год |
| `room_jwt` | `chat-<sessionId>` | `["room:<sessionId>"]` | 1 год |
| `mobile_jwt` | `mobile-<sessionId>` | `["room:<sessionId>"]` | 1 год |
| `user_jwt` | `user-<userId>` | `["user:<userId>"]` | 1 год |
| `routerJwt` | `router-1` | `["session:lobby", "mobile:lobby"]` | 1 год |

При ротации секрета:

- старые `room_jwt`, `mobile_jwt`, `user_jwt` становятся невалидны;
- Mobile делает `clearAuth()` и проходит bootstrap через lobby;
- Chat проходит bootstrap заново;
- `device_id` сохраняется.

---

## Контракт bootstrap-каналов

## Chat bootstrap

Запрос:

```json
{
  "type": "hello",
  "form_id": "<form_id>",
  "config_name": "...",
  "config_version": "...",
  "computer": "...",
  "connection_string": "...",
  "base_ids": {}
}
```

Успешный ответ:

```json
{
  "type": "hello_ack",
  "session_id": "<session_id>",
  "status": "awaiting_auth" | "reconnected",
  "room_jwt": "<jwt>",
  "mobile_jwt": "<jwt|null>"
}
```

Ошибка:

```json
{
  "type": "hello_error",
  "reason": "subscribe_failed" | "internal_error"
}
```

Правила:

- `mobile_jwt` не возвращается при `status: "reconnected"`;
- duplicate `hello` игнорируется после первого принятого сообщения;
- timeout ожидания `push.subscribe`: 10 сек;
- timeout ожидания `hello_ack` или `hello_error`: 15 сек;
- retry: до 3 раз.

### Когда отправляется `hello_error`

- не удалось подписать роутер на `room:<sessionId>`;
- не удалось создать session/reconnect target;
- любое внутреннее исключение в `handleHello()`.

Правило для MVP: любая ошибка создания session, кроме явной ошибки подписки, сводится к:

```json
{ "type": "hello_error", "reason": "internal_error" }
```

## Mobile bootstrap

Запрос:

```json
{
  "type": "register",
  "device_id": "<device_id>"
}
```

Успешный ответ:

```json
{
  "type": "register_ack",
  "status": "ok",
  "user_id": "<user_id>",
  "user_jwt": "<jwt>",
  "balance": 0,
  "currency": "руб"
}
```

Ошибка:

```json
{
  "type": "register_error",
  "reason": "missing_device_id" | "subscribe_failed" | "internal_error"
}
```

Правила:

- duplicate `register` игнорируется после первого принятого сообщения;
- timeout ожидания `push.subscribe`: 10 сек;
- timeout ожидания `register_ack` или `register_error`: 15 сек;
- retry: до 3 раз только для retriable-ошибок.

### Retry policy для `register_error`

Retriable:

- `subscribe_failed`
- `internal_error`

Non-retriable:

- `missing_device_id`

---

## Контракт `user:<userId>`

Во всех запросах обязателен `device_id`.

### get_sessions

```json
{
  "type": "get_sessions",
  "device_id": "<device_id>"
}
```

### get_profile

```json
{
  "type": "get_profile",
  "device_id": "<device_id>"
}
```

### bind_email

```json
{
  "type": "bind_email",
  "device_id": "<device_id>",
  "email": "User@Mail.ru"
}
```

### confirm_email

```json
{
  "type": "confirm_email",
  "device_id": "<device_id>",
  "email": "User@Mail.ru",
  "code": "481729"
}
```

Все ответы публикуются в тот же `user:<userId>`.

---

## Storage-модель Mobile

| Слой | Ключи | Очистка |
|------|-------|---------|
| device identity | `lyra_device_id` | только logout |
| account identity | `lyra_user_id`, `lyra_user_jwt` | unauthorized, logout |
| session cache | `lyra_sessions`, `lyra_auto_scanner` | logout или явный cache reset |

Обязательные методы:

```dart
Future<void> clearAuth() async {
  await _storage.delete(key: _keyUserId);
  await _storage.delete(key: _keyUserJwt);
}

Future<void> clearSessionCache() async {
  await _storage.delete(key: _keySessions);
  await _storage.delete(key: _keyAutoScanner);
}

Future<void> clearAll() async {
  await _storage.deleteAll();
}
```

`clearAuth()` не трогает:

- `device_id`
- session cache
- local preferences

---

## Router: точный алгоритм

## 1. `onJoin`

### `session:lobby`

```js
function bootstrapChat(clientUUID) {
  if (pendingBootstraps.has(clientUUID)) return; // duplicate join
  const channel = `session:${clientUUID}`;
  // subscribe router
  // subscribe client
  // start timer 30s
  pendingBootstraps.set(clientUUID, {
    kind: 'chat',
    channel,
    state: 'waiting_message',
    timer,
  });
}
```

### `mobile:lobby`

```js
function bootstrapMobile(clientUUID) {
  if (pendingBootstraps.has(clientUUID)) return; // duplicate join
  const channel = `mobile:${clientUUID}`;
  // subscribe router
  // subscribe client
  // start timer 30s
  pendingBootstraps.set(clientUUID, {
    kind: 'mobile',
    channel,
    state: 'waiting_message',
    timer,
  });
}
```

## 2. `handleHello(channel, data)`

Алгоритм:

1. извлечь `clientUUID`;
2. найти bootstrap entry;
3. если записи нет -> ignore;
4. если `state !== "waiting_message"` -> ignore duplicate;
5. отметить `state = "acked"`;
6. попытаться найти reconnect или создать новую session;
7. определить `room:<sessionId>`;
8. подписать роутер на `room:<sessionId>`;
9. выпустить `room_jwt` и `mobile_jwt`;
10. отправить `hello_ack`;
11. `cleanupBootstrap(clientUUID)`.

Если не удалось:

- создать session;
- вычислить reconnect target;
- подписаться на `room:<sessionId>`;

то роутер отправляет `hello_error`, делает `cleanupBootstrap(clientUUID)` и не считает bootstrap успешным.

## 3. `handleRegister(channel, data)`

Алгоритм:

1. извлечь `clientUUID`;
2. найти bootstrap entry;
3. если записи нет -> ignore;
4. если `state !== "waiting_message"` -> ignore duplicate;
5. проверить `device_id`;
6. `registerByDeviceId(device_id)` -> `userId`;
7. подписать роутер на `user:<userId>`;
8. выпустить `user_jwt`;
9. отправить `register_ack`;
10. `cleanupBootstrap(clientUUID)`.

Если не удалось:

- прочитать/провалидировать `device_id`;
- подписаться на `user:<userId>`;
- завершить регистрацию по внутренней причине;

роутер отправляет `register_error`, делает cleanup и не считает bootstrap успешным.

## 4. `cleanupBootstrap(clientUUID)`

Обязательное поведение:

1. остановить таймер;
2. вызвать `apiUnsubscribe('router-1', centrifugo.clientId, bootstrapChannel)`;
3. удалить запись из `pendingBootstraps`.

Cleanup вызывается:

- после `hello_ack`;
- после `register_ack`;
- после `hello_error`;
- после `register_error`;
- по таймеру 30 сек;
- по leave клиента из bootstrap-канала.

## 5. `onLeave`

Роутер реагирует только на leave клиента, а не на собственный unsubscribe:

```js
centrifugo.onLeave((channel, info) => {
  if (info.user === 'router-1') return;
  if (!channel.startsWith('session:') && !channel.startsWith('mobile:')) return;
  if (pendingBootstraps.has(info.client)) {
    cleanupBootstrap(info.client);
  }
});
```

### Контрольное допущение

На Этапе 0 отдельным тестом подтверждаем, что `push.leave` в Centrifugo v6 действительно содержит:

- `info.user`
- `info.client`

Если формат окажется другим, адаптируем фильтр, но семантика плана не меняется: cleanup должен реагировать только на уход клиента.

## 6. Startup / reconnect subscriptions for `user:`

Для MVP роутер подписывается на всех известных `user:<userId>`:

- при старте;
- при reconnect.

Делается с bounded parallelism, а не линейно:

```js
await subscribeKnownUsers({ concurrency: 20 });
```

Это допустимое MVP-ограничение. При росте числа пользователей выносится в отдельную lazy/on-demand стратегию.

---

## Router: изменения по файлам

### `centrifugo.mjs`

Добавить:

1. проверку `body.error` в `_apiCall()`;
2. `apiSubscribe()`;
3. `apiUnsubscribe()`;
4. `onJoin(callback)`;
5. `onLeave(callback)`;
6. `_handleMessage()` для:
   - `msg.push.pub`
   - `msg.push.join`
   - `msg.push.leave`

Минимальная логика:

```js
if (msg.push) {
  if (msg.push.pub) this.pushHandler?.(msg.push);
  if (msg.push.join) this.joinHandler?.(msg.push.channel, msg.push.join.info);
  if (msg.push.leave) this.leaveHandler?.(msg.push.channel, msg.push.leave.info);
}
```

### `jwt.mjs`

- `makeRoomJWTs(sessionId, secret)`
- `makeUserJWT(userId, secret)`

### `sessions.mjs`

- `channel: room:<sessionId>`
- `getByChannel()` работает с `room:`

### `users.mjs`

Вынести и стабилизировать API:

- `loadUserIndex()`
- `listKnownUserIds()`
- `registerByDeviceId()`
- `verifyAuth()`
- email API

### `history.mjs`

Расширить redaction:

```js
const SENSITIVE_KEYS = [
  'naparnik_token',
  'chat_jwt',
  'room_jwt',
  'mobile_jwt',
  'user_jwt',
  'token',
  'api_key',
  'secret'
];
```

### `server.mjs`

Dispatch:

```js
if (channel === 'session:lobby' || channel === 'mobile:lobby') return;
if (channel.startsWith('session:')) { /* bootstrap chat */ }
if (channel.startsWith('mobile:'))  { /* bootstrap mobile */ }
if (channel.startsWith('room:'))    { /* session work */ }
if (channel.startsWith('user:'))    { /* account work */ }
```

---

## Mobile приложение

## 1. Два клиента

```dart
final accountClientProvider = Provider<CentrifugoClient>(...);
final sessionClientProvider = StateProvider<CentrifugoClient?>(...);
```

- `accountClient` слушает `user:<userId>`;
- `sessionClient` слушает `room:<sessionId>`.

## 2. `centrifugo_client.dart`

Используем штатные server-side subscription события `centrifuge-dart`:

```dart
client.subscribed.listen((event) {
  _serverSubscriptionsController.add(event.channel);
});
```

Нужные методы:

```dart
Stream<String> get serverSubscriptions;
Future<void> connectToUserChannel(String userJwt);
Future<void> connectToRoom(String jwt);
```

## 3. Splash state machine

1. читаем `user_id`, `user_jwt`;
2. если оба есть:
   - `connectToUserChannel(userJwt)`;
   - при success -> `/home`;
   - при unauthorized -> `clearAuth()` и bootstrap через lobby;
3. если пары нет:
   - connect `mobile:lobby`;
   - ждать `push.subscribe` на `mobile:<clientUUID>`;
   - отправить `register`;
   - ждать `register_ack` или `register_error`;
   - сохранить `user_id`, `user_jwt`;
   - reconnect в `user:<userId>`.

### Retry policy

- до 3 попыток только для временных ошибок;
- для `missing_device_id` сразу ошибка без retry.

## 4. Обработка bootstrap errors

Mobile понимает:

- `register_error { reason: "missing_device_id" }` -> fatal client error;
- `register_error { reason: "subscribe_failed" }` -> retriable;
- `register_error { reason: "internal_error" }` -> retriable.

Chat понимает:

- `hello_error { reason: "subscribe_failed" }`
- `hello_error { reason: "internal_error" }`

---

## Chat (EPF / BSL)

## 1. Bootstrap state machine

```text
Отключено
  -> ПодключениеLobby
  -> ОжиданиеBootstrapSubscribe
  -> ОжиданиеHelloAck
  -> ПереподключениеВRoom
  -> Подключено
```

Таймауты:

- `push.subscribe`: 10 сек;
- `hello_ack` или `hello_error`: 15 сек.

## 2. Правила

При `push.subscribe`:

- если это `session:<clientUUID>` и состояние `ОжиданиеBootstrapSubscribe`,
  - сохранить `bootstrapChannel`;
  - отправить `hello` один раз;
  - перейти в `ОжиданиеHelloAck`.

Повторный `push.subscribe` на тот же bootstrap-канал игнорировать.

## 3. Обработка `hello_error`

При `hello_error`:

1. выйти из состояния `ОжиданиеHelloAck`;
2. перейти в `Отключено`;
3. показать пользователю ошибку;
4. не зависать в промежуточном состоянии.

## 4. Переход в room

После `hello_ack`:

1. disconnect lobby;
2. connect `room_jwt`;
3. auto-subscribe `room:<sessionId>`;
4. показать QR = `mobile_jwt`, только если это не reconnect.

## 5. Leave роутера

На `push.leave` в `room:<sessionId>`:

- если `leave.info.user != "router-1"` -> ignore;
- если `leave.info.user == "router-1"` -> таймер 5 сек;
- если за 5 сек пришёл `join` того же `router-1` -> отменить алерт;
- если нет -> показать “Сервер отключился”.

---

## Порядок реализации

## Этап 0. Transport substrate

### Router

1. `body.error` в `_apiCall()`
2. `apiUnsubscribe()`
3. `onJoin`, `onLeave`
4. `_handleMessage()` с поддержкой `join/leave/pub`
5. тест, что `leave.info` несёт `user` и `client`

### Mobile

6. `client.subscribed` -> `serverSubscriptions`
7. `connectToUserChannel()`
8. разделение `accountClient` / `sessionClient`

### Chat

9. bootstrap state machine
10. обработка `hello_error`

### Тесты

11. `apiSubscribe` / `apiUnsubscribe` roundtrip
12. `body.error` бросает exception
13. `push.subscribe` доходит до клиента

## Этап 1. `room:` + `user:` + JWT

1. `makeRoomJWTs()`
2. `makeUserJWT()`
3. `sessions.mjs` -> `room:<sessionId>`
4. `history.mjs` redaction
5. `loadUserIndex()` + `listKnownUserIds()`
6. re-subscribe known `user:` с concurrency limit
7. dispatch `room:*`
8. dispatch `user:*`
9. `handleHello()` с subscribe-before-ack
10. `handleRegister()` с subscribe-before-ack

### Тесты

11. `hello -> room -> auth` работает сразу, без reconnect
12. `register -> user -> get_sessions` не теряет первый запрос
13. `pipe:<sessionId>` не ломается после перехода на `room:<sessionId>`

## Этап 2. Personal bootstrap channels

1. `pendingBootstraps`
2. dedup join
3. dedup hello/register
4. cleanup по ack/error/leave/timer
5. `hello_error` и `register_error`
6. lobby становится silent

### Тесты

7. duplicate join не создаёт второй таймер
8. duplicate hello не создаёт вторую session
9. duplicate register не ломает bootstrap
10. leave клиента чистит bootstrap
11. leave `router-1` не вызывает ранний cleanup
12. таймер 30 сек чистит зависший bootstrap

## Этап 3. Email bind

Перед стартом синхронизировать `EMAIL-BIND-PLAN.md`:

- `room:` вместо старого `session:`
- `userId` из имени канала
- `device_id` в payload без `user_id`

После этого реализовать:

1. `get_profile`
2. `bind_email`
3. `confirm_email`

## Этап 4. Документация

Обновить:

- `mobile/CLAUDE.md`
- transport notes по mobile bootstrap
- локальные схемы, где ещё упомянуты `mobile:lobby` или `session:<sessionId>`

---

## MVP-ограничение

Подписка роутера на все известные `user:<userId>` при старте остаётся допустимой для MVP:

- пользователей мало;
- bounded parallelism не создаёт длинной линейной паузы;
- при росте инсталляции это станет отдельной задачей.

---

## Definition of Done

План считается реализованным, когда выполняются все условия:

1. В lobby нет бизнес-публикаций.
2. `session:lobby` сохранился как entry point.
3. Новый bootstrap не теряет первые сообщения в `room:` и `user:`.
4. Duplicate join не создаёт вторую запись в `pendingBootstraps`.
5. Duplicate `hello` не создаёт вторую session.
6. `device_id` переживает unauthorized fallback.
7. Bootstrap cleanup игнорирует leave от `router-1`.
8. Chat корректно обрабатывает `hello_error` и не зависает.
9. `pipe:<sessionId>` не затронут миграцией на `room:<sessionId>`.
10. `mobile/CLAUDE.md` и `EMAIL-BIND-PLAN.md` синхронизированы с новым протоколом.
