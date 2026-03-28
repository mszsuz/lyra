# Аудит плана `ACCOUNT-RECOVERY-PLAN.md`

Дата: 2026-03-28

Основание аудита:
- `docs/ACCOUNT-RECOVERY-PLAN.md`
- текущая реализация роутера и мобильного приложения в workspace
- текущие данные в `TEST-LYRA/users`

## Краткий вывод

План движется в правильную сторону, но в текущем виде он **ещё не implementation-ready**. Основная проблема не в email-отправке, а в том, что recovery затрагивает сразу четыре слоя:

1. навигацию мобильного приложения,
2. протокол `mobile:lobby`,
3. модель владения `device_id -> user_id`,
4. источник истины для профиля.

Если реализовать план "как есть", высок риск получить:
- некорректный recovery на новом устройстве,
- временные или навсегда "осиротевшие" аккаунты,
- утечки/перемешивание lobby-ответов между мобильными клиентами,
- ложное ощущение, что "настройки вернулись", хотя часть из них сейчас device-local.

Итоговая оценка: **идея здравая, но план нужно доработать до уровня контрактов, миграции и UX-точки входа**.

Отдельная практическая рекомендация: **сначала реализовать только привязку и подтверждение email к уже существующему аккаунту**, а recovery запускать вторым шагом. Это даст возможность:
- проверить server-side модель email без риска поломать вход на новом устройстве,
- накопить реальные данные по bind/confirm UX,
- подготовить `email_verified` как надёжную опору для последующего recovery.

## Критические замечания

### 1. Точка входа recovery выбрана неверно

В плане сказано, что `router.dart` менять не нужно, потому что восстановление будет "внутри профиля" (`ACCOUNT-RECOVERY-PLAN.md:145`). Это не бьётся с текущим приложением.

Что есть сейчас:
- splash при отсутствии `user_id` автоматически запускает регистрацию через `register()` и уводит пользователя дальше, без выбора режима: `mobile/lyra_mobile/lib/app/router.dart:43-71`
- профиль доступен только после входа в приложение: `mobile/lyra_mobile/lib/app/router.dart:17-25`
- в архитектурной документации recovery уже описан как сценарий со splash: `mobile/CLAUDE.md:311-313`

Почему это критично:
- на новом устройстве пользователь **не может** попасть в профиль до появления нового `user_id`
- если recovery оставить "внутри профиля", то fresh install сначала создаст временный новый аккаунт, и только потом пользователь попытается переключиться на старый
- это автоматически порождает задачу "account switch / cleanup temporary account", которой в плане нет

Рекомендация:
- recovery должен стартовать **до авто-регистрации**, то есть со splash/onboarding
- если хочется оставить кнопку и в профиле, это должен быть вторичный сценарий "переключить аккаунт", а не основной recovery-flow

### 2. Протокол `mobile:lobby` сейчас широковещательный, а план добавляет туда чувствительные ответы

План вешает `bind_email`, `confirm_email`, `recover`, `recover_confirm` на общий канал `mobile:lobby`: `ACCOUNT-RECOVERY-PLAN.md:35-59`.

Что есть сейчас:
- мобильное подключается к общему lobby через shared JWT: `mobile/lyra_mobile/lib/core/centrifugo/centrifugo_client.dart:32-69`
- роутер публикует ответы на `register` обратно в `mobile:lobby`: `TEST-LYRA/router/server.mjs:502-527`
- текущий `register_ack` вообще не коррелируется по request id или client id на клиенте: `mobile/lyra_mobile/lib/features/registration/registration_provider.dart:81-104`

Почему это критично:
- ответы из lobby видят все клиенты, сидящие в lobby
- для recovery это уже не просто баг UX, а риск утечки:
  - факта запроса восстановления,
  - маски email,
  - `user_id`,
  - статуса recovery
- без `request_id`/`nonce`/private reply channel несколько параллельных устройств могут обрабатывать чужие ack

Рекомендация:
- не вводить recovery-команды в lobby без изоляции ответов
- минимум:
  - добавить `request_id` во все lobby-команды и ack,
  - echo `request_id` в ответах,
  - фильтровать ack на клиенте по `request_id`
- лучше:
  - уйти на per-client reply channel / temporary recovery channel
  - либо делать reply через адресацию по `clientUUID`, а не broadcast в общий lobby

### 3. План не описывает, что делать с текущим владельцем `newDeviceId`

В плане recovery предполагается простой `confirmRecovery(email, code, newDeviceId)` с перепривязкой устройства к целевому пользователю: `ACCOUNT-RECOVERY-PLAN.md:90-95`.

Проблема:
- в текущем UX на fresh install устройство почти наверняка уже успеет получить новый `user_id` через auto-register: `mobile/lyra_mobile/lib/app/router.dart:57-71`
- значит `newDeviceId` уже может принадлежать временному аккаунту

Почему это критично:
- если просто переписать `device_id` у целевого пользователя, нужно ещё:
  - снять `device_id` с временного аккаунта,
  - решить, удаляем ли временный аккаунт или оставляем без `device_id`,
  - не допустить двойной записи одного и того же `device_id` в двух `profile.json`
- иначе после рестарта `loadDeviceMapping()` может собрать не тот маппинг

Что особенно настораживает:
- в `users.mjs` регистрация сейчас реально создаёт нового пользователя по неизвестному `device_id`: `TEST-LYRA/router/users.mjs:45-63`
- `loadDeviceMapping()` строит карту только по `profile.device_id`: `TEST-LYRA/router/users.mjs:23-38`

Рекомендация:
- лучший способ убрать этот класс проблем: перенести recovery **до** auto-register
- если recovery допускается после auto-register, в план нужно явно добавить:
  - "detach current owner of `newDeviceId`",
  - "cleanup or quarantine temporary user",
  - "remove stale `device_id` from previous profile and all in-memory maps"

### 4. Заявление "баланс, базы, настройки возвращаются" сейчас неверно по модели данных

Фраза из плана: "Баланс, базы, настройки — возвращаются" (`ACCOUNT-RECOVERY-PLAN.md:32`).

Что реально есть сейчас:
- баланс хранится на сервере и восстановится: `TEST-LYRA/router/users.mjs:109-113`
- список живых сессий можно пересобрать с сервера: `TEST-LYRA/router/server.mjs:532-563`, `mobile/lyra_mobile/lib/features/home/home_provider.dart:41-87`
- но профильные настройки на мобильном сейчас local-only:
  - имя сохраняется только в secure storage: `mobile/lyra_mobile/lib/features/profile/profile_screen.dart:45-53`
  - роль сохраняется только в secure storage: `mobile/lyra_mobile/lib/features/profile/profile_screen.dart:45-53`
  - server sync из `profile_screen.dart` отсутствует

Следствие:
- после recovery на новом устройстве баланс и серверные сущности действительно можно вернуть
- но `user_name`, `role`, локальные флаги и кэши сейчас **не возвращаются автоматически**

Рекомендация:
- либо изменить обещание в плане на "возвращаются серверные данные: баланс, базы, привязки"
- либо сначала определить сервер как источник истины для account profile

## Существенные замечания

### 5. В документе есть прямое противоречие по email enumeration

В протоколе recovery указано:
- `recover_ack -> status: "error", reason: "email_not_found|..."`: `ACCOUNT-RECOVERY-PLAN.md:52-58`

В секции безопасности указано обратное:
- даже для несуществующего email должен возвращаться одинаковый `code_sent`: `ACCOUNT-RECOVERY-PLAN.md:206-212`

Это нужно привести к одному контракту. С точки зрения безопасности правильнее второй вариант.

### 6. `lyra_email` в secure storage не решает задачу статуса email

В плане предлагается хранить `lyra_email` локально: `ACCOUNT-RECOVERY-PLAN.md:142-144`.

Проблема:
- email для recovery является серверной сущностью
- после reinstall / recovery / смены устройства локальный `lyra_email` будет пуст, даже если на сервере email уже подтверждён
- значит UI профиля не сможет показать истинный статус без server fetch

Рекомендация:
- нужен отдельный серверный контракт вроде `get_profile` / `account_status`
- минимум данных:
  - `email`
  - `email_verified`
  - `masked_email`
  - возможно `can_recover`

Локальный storage здесь допустим только как cache, но не как source of truth.

### 7. Не описана нормализация, уникальность и lifecycle email

Сейчас в плане отсутствуют правила:
- нормализуем ли email в lowercase/trim
- индексируем ли только `email_verified=true`
- что делать, если email уже привязан к другому user
- можно ли менять email
- можно ли отвязать email
- резервируется ли email на стадии `bindEmail()` до подтверждения

Без этого легко получить:
- дубли `User@Mail.ru` и `user@mail.ru`
- recovery в не тот аккаунт
- споры вокруг переиспользования email

Минимум, что стоит зафиксировать:
- canonical form = `trim().toLowerCase()`
- recovery разрешён только по `email_verified=true`
- bind на уже занятый verified email запрещён
- смена email = новый bind + confirm + removal old email from index

### 8. Реальные данные уже содержат legacy-структуры, которые план не учитывает

В рабочем каталоге есть не только canonical `TEST-LYRA/users/<userId>/profile.json`, но и вложенные профили, например:
- `TEST-LYRA/users/Новая папка/7b9b7601-f024-48a6-b193-25f1a49d5480/profile.json`
- `TEST-LYRA/users/Новая папка/mvp-user/profile.json`

При этом `loadDeviceMapping()` сканирует только первый уровень директорий: `TEST-LYRA/router/users.mjs:23-38`

Риски:
- часть реальных аккаунтов не попадёт в `deviceToUser`
- будущий `emailToUser` на той же логике тоже будет неполным
- миграционные профили без `device_id` уже существуют

Рекомендация:
- добавить в план отдельный шаг "sanity check / migration of users directory"
- хотя бы разово:
  - найти все `profile.json` рекурсивно,
  - проверить дубликаты `device_id`,
  - проверить дубликаты email,
  - выровнять layout до одного канонического формата

### 9. Обещание "старое устройство теряет доступ" не обеспечено текущим session-механизмом

Сейчас `device_id` проверяется в момент `auth`: `TEST-LYRA/router/server.mjs:363-436`, `TEST-LYRA/router/users.mjs:70-102`.

Что не покрыто:
- уже авторизованная мобильная сессия на старом устройстве может продолжать жить до disconnect/TTL
- старые `mobile_jwt`/локальные session записи не инвалидируются автоматически самим фактом смены `device_id`

Если продуктово важно "моментально выбить старое устройство", плану нужен отдельный пункт:
- найти активные session для пользователя,
- опубликовать forced logout / session revoked,
- очистить или инвалидировать старые mobile-сессии

### 10. Security-раздел обещает rate limit и блокировки, но под это нет даже каркаса

План обещает:
- TTL 10 минут,
- 3 попытки,
- блокировку на 30 минут: `ACCOUNT-RECOVERY-PLAN.md:206-212`

В текущем роутере нет похожего механизма для account recovery:
- нет pending-code store,
- нет per-email/per-device cooldown,
- нет persisted throttle state,
- нет audit trail по recovery events

Это не аргумент "не делать", но аргумент "не называть это мелкой доработкой".

### 11. Хранить коды только в памяти можно для dev, но не для production без явной оговорки

План несколько раз предлагает хранить коды "в памяти": `ACCOUNT-RECOVERY-PLAN.md:79, 88`.

Последствия:
- рестарт роутера обнуляет все pending codes
- rollout/deploy/restart во время recovery будет выглядеть как "код внезапно протух"

Для MVP это допустимо, но тогда нужно прямо написать:
- dev/MVP: in-memory
- production: persistent store или хотя бы осознанная деградация

### 12. В плане нет тестового контура, хотя изменение кросс-срезовое

Фактически меняются:
- роутер,
- transport contract,
- secure storage,
- splash/navigation,
- profile UX,
- potentially logout behavior.

При этом:
- в `TEST-LYRA/router/package.json` нет test scripts
- в mobile есть `flutter_test` в зависимостях, но тестов на recovery не видно

Рекомендация:
- сразу заложить не только ручной чек-лист, но и минимум smoke-сценариев

## Что в плане уже хорошо

- правильно выбран business key: recovery через заранее подтверждённый email
- правильно замечен `emailToUser` index как ускоритель lookup
- правильно отмечено, что старый `device_id` нужно отвязать
- верно, что bind email и recovery лучше разводить по этапам
- верно, что на старте можно использовать лог вместо реального email-провайдера

## Отдельная рекомендация по порядку внедрения

Наиболее безопасный и прагматичный порядок для этой задачи:
- сначала реализовать **только привязку email к текущему аккаунту**
- затем убедиться, что email хранится на сервере, подтверждается, уникален и корректно читается обратно в UI
- и только после этого добавлять recovery на новом устройстве

Почему это хороший first step:
- bind email не ломает текущую модель splash/auto-register
- bind email не требует немедленно решать проблему temporary account на новом устройстве
- bind email позволяет раньше проверить формат данных, индексацию, отправку кодов, TTL, retry и ошибки
- после этого recovery становится не "первым касанием" email-модели, а вторым, гораздо более предсказуемым этапом

## Рекомендуемая переработка плана

### Этап 0. Зафиксировать контракты и источник истины

Нужно сначала принять 4 решения:
- recovery начинается со splash или это account-switch после входа
- как адресуются ответы в `mobile:lobby`
- что является source of truth для account profile
- как обрабатываются duplicate email и temporary account after auto-register

Без этого начинать кодить `bind_email` рискованно.

### Этап 1. Подготовить серверную модель

Добавить в план отдельные server задачи:
- canonical email normalization
- `email_verified` index only
- pending verification store
- pending recovery store
- detach old/new device ownership safely
- migration / audit job for existing `users/`

### Этап 2. Добавить read-contract для профиля

До UI recovery нужен хотя бы один способ получить серверный статус аккаунта:
- `get_profile`
- или расширенный `register_ack`
- или отдельный `account_status`

Иначе UI не знает:
- привязан ли email,
- подтверждён ли он,
- что показывать после reinstall.

### Этап 3. Реализовать bind email в профиле

Это стоит рассматривать как **первую обязательную продуктовую поставку** в этой теме, даже если recovery будет отложен.

Этот этап выглядит реалистично, если:
- bind доступен только для уже валидно привязанного `user_id/device_id`
- bind/confirm имеют `request_id`
- UI показывает server-derived status, а не только local cache

### Этап 4. Реализовать recovery со splash

Рекомендуемый целевой UX:
- splash не создаёт новый аккаунт мгновенно
- пользователь видит:
  - "Продолжить" / авто-регистрация
  - "Восстановить доступ"
- успешный recovery:
  - привязывает `device_id`,
  - записывает новый `user_id`,
  - очищает stale local sessions,
  - перезагружает account state

### Этап 5. Подключить реальную email-доставку

Отдельно от кода надо учесть инфраструктуру:
- верифицированный sender domain
- SPF/DKIM/DMARC
- секреты в env/config, а не в коде
- наблюдаемость: лог send result, retry policy, alert on failures

## Минимальный DoD для production-ready recovery

- fresh install на новом устройстве может запустить recovery **без** создания лишнего аккаунта
- два клиента одновременно в `mobile:lobby` не могут перепутать или перехватить recovery ack
- verified email уникален и нормализован
- старое устройство теряет доступ не только "на будущее", но и для уже активных мобильных сессий
- после recovery корректно восстанавливаются:
  - `user_id`
  - баланс
  - список серверных сессий
  - server-side account profile
- профиль после reinstall показывает реальный server status email
- recovery переживает повторный запрос, неверный код, истечение TTL и рестарт роутера хотя бы предсказуемо

## Резюме одним абзацем

План хороший по продуктовой идее, но недооценивает глубину затрагиваемой архитектуры. Главный скрытый объём работ не в `Resend`, а в том, что recovery ломает текущую модель "нет `user_id` -> авто-регистрация", требует изоляции ответов в общем `mobile:lobby`, требует явной стратегии cleanup для временного аккаунта и требует перевода email-статуса из local cache в server authority. После исправления этих мест план станет значительно ближе к безопасной реализации.
