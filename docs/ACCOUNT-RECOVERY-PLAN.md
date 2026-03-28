# Восстановление аккаунта — план реализации

## Суть

Пользователь потерял телефон / переустановил приложение → device_id утерян → нужно привязать новый device_id к существующему user_id. Единственный способ — подтверждение через email.

## Предусловие

Пользователь **заранее** привязал email в Профиле. Без email восстановление невозможно — создаётся новый аккаунт.

## UX-сценарии

### Сценарий 1: Привязка email (подготовка к восстановлению)

```
Профиль → поле Email → [Привязать]
  → Роутер отправляет 6-значный код на email
  → Пользователь вводит код
  → Email сохраняется в profile.json на сервере
  → Статус: "Email подтверждён ✓"
```

### Сценарий 2: Восстановление аккаунта

```
Профиль → [Восстановить аккаунт]
  → Ввод email
  → Роутер: находит user_id по email, отправляет код
  → Ввод кода
  → Роутер: привязывает текущий device_id к найденному user_id
  → Мобильное: заменяет user_id в secure storage
  → Баланс, базы, настройки — возвращаются
```

## Протокол (Centrifugo, канал mobile:lobby)

### Привязка email

```
→ {type: "bind_email", user_id, device_id, email}
← {type: "bind_email_ack", status: "code_sent"}
← {type: "bind_email_ack", status: "error", reason: "..."}

→ {type: "confirm_email", user_id, device_id, email, code}
← {type: "confirm_email_ack", status: "ok"}
← {type: "confirm_email_ack", status: "error", reason: "invalid_code|expired|..."}
```

### Восстановление

```
→ {type: "recover", device_id, email}
← {type: "recover_ack", status: "code_sent"}
← {type: "recover_ack", status: "error", reason: "email_not_found|..."}

→ {type: "recover_confirm", device_id, email, code}
← {type: "recover_confirm_ack", status: "ok", user_id, balance}
← {type: "recover_confirm_ack", status: "error", reason: "invalid_code|expired|..."}
```

## Роутер (server.mjs + users.mjs)

### Новые поля в profile.json

```json
{
  "device_id": "uuid",
  "email": "user@mail.ru",
  "email_verified": true,
  "created_at": "..."
}
```

### Новые функции в users.mjs

```
bindEmail(userId, email)
  → сохранить email в profile.json (email_verified: false)
  → сгенерировать 6-значный код, сохранить в памяти (TTL 10 мин)
  → отправить email (через внешний сервис)

confirmEmail(userId, email, code)
  → проверить код
  → profile.json: email_verified = true

recoverByEmail(email)
  → найти user_id по email среди всех profile.json
  → сгенерировать код, отправить на email

confirmRecovery(email, code, newDeviceId)
  → проверить код
  → перепривязать: старый device_id отвязать, новый привязать
  → обновить profile.json: device_id = newDeviceId
  → обновить deviceToUser Map
  → вернуть {user_id, balance}
```

### Email-индекс (оптимизация)

При `loadDeviceMapping()` также строить `emailToUser: Map<string, string>` — чтобы не сканировать все profile.json при каждом recover.

### Отправка email

Варианты:
1. **Resend** (resend.com) — API для транзакционных писем, бесплатно до 100/день
2. **Nodemailer + SMTP** — свой SMTP или Gmail
3. **SendGrid** — бесплатно до 100/день

Рекомендация: **Resend** — минимальный код, бесплатный tier достаточен для начала.

```js
import { Resend } from 'resend';
const resend = new Resend('re_...');

await resend.emails.send({
  from: 'Лира <noreply@lyra.app>',
  to: email,
  subject: 'Код подтверждения',
  text: `Ваш код: ${code}`,
});
```

## Мобильное приложение (Flutter)

### Новые файлы

```
lib/features/profile/email_provider.dart      — привязка email (bind + confirm)
lib/features/profile/recovery_provider.dart    — восстановление (recover + confirm)
```

### Изменения в существующих файлах

**message_types.dart** — новые типы сообщений:
- Исходящие: `BindEmailMessage`, `ConfirmEmailMessage`, `RecoverMessage`, `RecoverConfirmMessage`
- Входящие: `BindEmailAckMessage`, `ConfirmEmailAckMessage`, `RecoverAckMessage`, `RecoverConfirmAckMessage`

**profile_screen.dart** — новые секции:
- Секция «Email» — поле ввода + кнопка «Привязать» / статус «Подтверждён ✓»
- Кнопка «Восстановить аккаунт» внизу экрана

**secure_storage.dart** — новые ключи:
- `lyra_email` — сохранённый email (для отображения статуса)

**router.dart** — не меняется (восстановление происходит внутри профиля, не на splash)

### UI профиля (после изменений)

```
┌─────────────────────────────┐
│  ← Назад          ПРОФИЛЬ  │
│                             │
│  ИМЯ                       │
│  ┌─────────────────────┐   │
│  │ Андрей              │   │
│  └─────────────────────┘   │
│                             │
│  КАК ОБЩАТЬСЯ              │
│  ○ Просто и понятно        │
│  ● Детально (аналитик)     │
│  ○ Технически (разработчик)│
│                             │
│  EMAIL                     │
│  ┌─────────────────────┐   │
│  │ user@mail.ru    [✓] │   │  ← подтверждён
│  └─────────────────────┘   │
│  или                       │
│  ┌─────────────────────┐   │
│  │ email         [>>>] │   │  ← не привязан, кнопка "Привязать"
│  └─────────────────────┘   │
│                             │
│  ─────────────────────────  │
│                             │
│  ┌─────────────────────┐   │
│  │ ВОССТАНОВИТЬ АККАУНТ│   │  ← переход к флоу восстановления
│  └─────────────────────┘   │
│                             │
│  ┌─────────────────────┐   │
│  │      СОХРАНИТЬ      │   │
│  └─────────────────────┘   │
│                             │
│  device: 3fa8c...  v0.4.7  │
└─────────────────────────────┘
```

### Диалог ввода кода (общий для привязки и восстановления)

```
┌─────────────────────────────┐
│                             │
│   Код отправлен на          │
│   us**@mail.ru              │
│                             │
│   ┌─┐ ┌─┐ ┌─┐ ┌─┐ ┌─┐ ┌─┐│
│   │4│ │8│ │1│ │7│ │2│ │9││
│   └─┘ └─┘ └─┘ └─┘ └─┘ └─┘│
│                             │
│   ┌─────────────────────┐  │
│   │    ПОДТВЕРДИТЬ      │  │
│   └─────────────────────┘  │
│                             │
│   Повторно через 58 сек    │
└─────────────────────────────┘
```

## Безопасность

- Код 6 цифр, TTL 10 минут, максимум 3 попытки
- После 3 неверных кодов — блокировка на 30 минут
- Email маскируется в ответах: `us**@mail.ru`
- `recover` не раскрывает, существует ли email (одинаковый ответ «код отправлен» / «email не найден» — оба возвращают `code_sent` для защиты от перебора)
- При восстановлении старый device_id **отвязывается** — старое устройство теряет доступ

## Порядок реализации

### Этап 1: Привязка email (без отправки писем — для тестов)

1. `users.mjs`: `bindEmail()`, `confirmEmail()`, email-индекс
2. `server.mjs`: обработчики `bind_email`, `confirm_email` на mobile:lobby
3. `message_types.dart`: новые типы
4. `email_provider.dart`: провайдер привязки
5. `profile_screen.dart`: секция Email
6. Тест: код выводится в лог роутера (без реальной отправки)

### Этап 2: Восстановление аккаунта

1. `users.mjs`: `recoverByEmail()`, `confirmRecovery()`
2. `server.mjs`: обработчики `recover`, `recover_confirm`
3. `recovery_provider.dart`: провайдер восстановления
4. `profile_screen.dart`: кнопка + UI восстановления
5. Тест: полный цикл с кодом из лога

### Этап 3: Реальная отправка email

1. Выбрать провайдера (Resend / Nodemailer)
2. Интеграция в роутер
3. Шаблон письма
4. Тест с реальным email
