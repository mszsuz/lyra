# Lyra — бэклог

Источник: [глубокий аудит 2026-03-09](Аудит/2026-03-09-глубокий-аудит.md)

## Баги (исправить при прохождении шагов)

- [ ] **content vs text** — Chat отправляет `"content"`, Router ожидает `"text"`. Сообщения теряются молча. Унифицировать на `text` (как в документации). **Шаг 8**
- [ ] **Chat без проверки auth** — `ОбработатьСообщениеЧата` не проверяет статус сессии в регистре. Добавить проверку `Status = "active"` перед вызовом Claude. **Шаг 8**

## TODO по шагам

- [ ] **QR-код в Chat** — `mobile_jwt` получен, но QR не рендерится (TODO в коде). Реализовать генерацию и показ QR. **Шаги 5-6**
- [x] **Мобильное приложение: убрать лишний subscribe** — убран `newSubscription('mobile:lobby')` и ручные подписки. publish через `client.publish()`. ~~Шаги 6-7~~
- [x] **Мобильное приложение: fail-fast при пустом JWT** — `connectToLobby()` бросает `StateError`, регистрация показывает ошибку. ~~Шаги 6-7~~
- [x] **Мобильное: publish без подписки** — `publish()` переписан на `client.publish(channel, data)` вместо создания подписки
- [x] **Мобильное: race condition в scanner** — `_sendAuth()` мог вызываться дважды, добавлен guard `authSent`
- [ ] **Claude: системный промпт, MCP, модель** — добавить `--system-prompt`, `--mcp-config`, `--model`, `--permission-mode` в запуск stdio-bridge. **Шаг 11**
- [ ] **Глобальный LyraActiveChannel** — singleton-канал, межсессионная утечка при параллельных сессиях. Сделать маппинг `process_id -> channel`. **Фаза 2**

## Перед внешним деплоем

- [ ] **Ротация секретов** — убрать hmac_secret_key, http_api.key, admin password/secret из git. Вынести в env/secret store. Пересобрать EPF с новым lobby JWT
- [ ] **Localhost -> конфигурация** — вынести wsUrl из кода Chat и mobile в настройки
- [ ] **Блокировка production-flow** — если MDM/Биллинг не готовы, явно отклонять внешние подключения
- [ ] **Legacy Bridge** — добавить DEPRECATED.md или архивировать
