---
created: 2026-03-06T13:48:37 (UTC +07:00)
tags: [centrifugo,centrifugo v6,fastapi,sqlite,python,sqlalchemy 2.0,sqlalchemy sqlite,javascript,веб-разработа,websocket]
source: https://habr.com/ru/companies/amvera/articles/885714/
author: Алексей Яковенко
---

# Centrifugo v6 + FastAPI + Python: разрабатываем веб-опросник с обновлениями в реальном времени / Хабр

> ## Excerpt
> Друзья, приветствую!Если вы следите за моими публикациями на Хабре, то знаете, что прошлую свою статью я посвятил теме разработки мини-чата с комнатами. Там я ис...

---
Друзья, приветствую!

Если вы следите за моими публикациями на Хабре, то знаете, что [прошлую свою статью](https://habr.com/ru/companies/amvera/articles/884816/) я посвятил теме разработки мини-чата с комнатами. Там я использовал такую технологию, как веб-сокеты. Реализовал я все через FastApi + Websockets, но это был лишь один из примеров возможной реализации Real-time приложений.

Сегодня же на теоретико-практическом примере я рассмотрю ещё один подход к реализации Real-time приложений, но уже при помощи такой технологии как Centrifugo.

### План на сегодня

Статью, условно, мы разделим на два больших блока — теория и практика. В рамках теоретического блока мы разберемся с тем, что такое Centrifugo, где он используется и рассмотрим прочие теоретические аспекты.

Далее, для того чтобы закрепить теорию практикой — мы с нуля разработаем простое FullStack-приложение с наглядной демонстрацией реализации Real-time функционала.

### Какое приложение будем сегодня разрабатывать?

Сегодня мы реализуем веб-приложение-опросник. Логика будет такой:

1.  Пользователь, попадая на главную страницу приложения, сможет выбрать интересующий его вопрос
    
2.  На странице вопроса он выбирает интересующий его вариант и нажимает на «Ответить»
    
3.  После этого его перебрасывает на страницу с результатами ответов
    

При запросе страницы с результатами ответов будет отправляться запрос к базе данных, и будет возвращаться текущая актуальная статистика по ответам (это же будет происходить и при обновлении страницы). То есть стандартная поллинг-логика, но, как вы понимаете, собрались мы тут не для этого.

Основная фишка страницы с результатами по конкретному вопросу будет заключаться в том, что актуальная статистика будет подгружаться в формате Real-time. То есть, вы сможете видеть динамику ответов без необходимости перезагрузки страницы. Это, как вы догадались, мы реализуем через Centrifugo.

### Технический стек для веб-приложения

При разработке веб-приложения-опросника мы сегодня будем использовать:

-   **Centrifugo** – технология, которой посвящена статья
    
-   **Tailwind** – библиотека для стилизации HTML
    
-   **FastApi** – веб-сервер
    
-   **HTTPX** – библиотека для отправки асинхронных запросов (будем использовать ее для публикации сообщений в каналы Centrifugo)
    
-   **SQLAlchemy** – ORM для удобной работы с базой данных
    
-   **SQLite** – база данных проекта
    

Поскольку мы разрабатываем real-time приложение, финальным этапом нашей практической части станет его деплой на платформу [Amvera Cloud](https://amvera.ru/?utm_source=habr&utm_medium=article&utm_campaign=yakvenalex_fast_api_centrifugo). Я выбрал этот сервис за его удобство и простоту развертывания: достаточно просто перетащить файлы в интерфейсе или выполнить git push — все остальное Amvera Cloud сделает автоматически.

Приятно то, что Amvera позволит не только развернуть наше веб-приложение, но и там мы сможем поднять Centrifugo (забегая вперед скажу, что Centrifugo – это отдельный сервис, сравнимый с RabbitMQ, который я подробно рассматривал в статье [«Телеграм-бот для бронирования столов на вебхуках: FastAPI, Aiogram Dialog, FastStream и RabbitMQ в единой экосистеме»](https://habr.com/ru/companies/amvera/articles/882878/)).

Но, прежде чем мы приступим к практической части, давайте разберемся с тем, что же такое Centrifugo и как использовать его в своих проектах.

### Что такое Centrifugo и для чего он используется?

[Centrifugo](https://centrifugal.dev/) — это сервер для отправки событий реального времени клиентам через WebSocket, HTTP-streaming, SSE и другие механизмы. Он помогает разработчикам **легко** добавлять push-уведомления, чаты, обновления данных в реальном времени и другие динамические функции в приложения.

#### Где он используется?

-   **Чаты и мессенджеры** (например, уведомления о новых сообщениях)
    
-   **Обновления в реальном времени** (например, биржевые котировки, результаты матчей)
    
-   **Push-уведомления** (например, уведомления о новых заказах в приложении доставки)
    
-   **Системы мониторинга** (например, обновления статуса серверов или устройств)
    
-   **Совместная работа** (например, редактирование документов в реальном времени в стиле Google Docs)
    

#### Почему Centrifugo — это круто?

**Поддержка множества клиентов**

-   Работает с браузерами, мобильными приложениями, IoT-устройствами
    
-   Можно подключаться через WebSocket, HTTP/2, SSE, gRPC
    

**Горизонтальное масштабирование**

-   Использует Redis, Tarantool или NATS для синхронизации между нодами
    
-   Легко масштабируется без изменения логики приложения
    

**Простая интеграция**

-   Работает как внешний сервис, не требует сложных изменений бэкенда
    
-   Имеет **HTTP API** и SDK для разных языков (JS, Python, Go и др.)
    

**Безопасность**

-   JWT-аутентификация, контроль подписок, доступ на основе токенов
    

**Механизм восстановления сообщений**

-   Позволяет клиентам восстанавливать потерянные сообщения (например, если отключился интернет)
    

**WebSocket + HTTP fallback**

-   Если WebSocket не поддерживается, автоматически переключается на другие протоколы
    

**Легкий деплой в Docker**

-   Можно быстро развернуть с помощью Docker, чем мы сегодня и займемся
    

#### Как это работает?

1.  Клиент подписывается на канал (channel), например: news-updates
    
2.  Бэкенд отправляет сообщение в Centrifugo через HTTP API
    
3.  Centrifugo пушит (рассылает) это сообщение всем подписчикам в реальном времени
    

#### Чем лучше, чем другие?

| **Платформа**  | **Поддержка WebSocket** |      **JWT-аутентификация**       |         **Скалируемость**          | **Поддержка истории сообщений** |
|------------|---------------------|-------------------------------|--------------------------------|-----------------------------|
| **Centrifugo** |        ✅ Да         |             ✅ Да              |  ✅ Да (через Redis/Tarantool)  |            ✅ Да             |
| **Socket.IO**  |        ✅ Да         | ❌ Нет (только свои механизмы) |         🔸 Ограниченно         |            ❌ Нет            |
|   **Pusher**   |        ✅ Да         |             ✅ Да              |  ✅ Да (но облачный, платный)   |            ✅ Да             |
|  **Firebase**  |        ✅ Да         |             ✅ Да              | ✅ Да (но требует Google Cloud) |            ❌ Нет            |

Centrifugo — мощное и удобное решение для работы с реальным временем. Оно идеально подходит для проектов, где важно **быстрое обновление данных** и **масштабируемость**.

В следующем разделе мы рассмотрим данную технологию на реальном примере и начнем с разворачивания системы Centrifugo.

### Поднимаем Centrifugo

Для этой задачи мы будем использовать технологию Docker, а устанавливать мы будем Centrifugo V6.

Развернуть Centrifugo можно как на своей локальной машине, так и на облачном сервисе [Amvera Cloud](https://amvera.ru/?utm_source=habr&utm_medium=article&utm_campaign=yakvenalex_fast_api_centrifugo). Далее я покажу оба способа, так как они особо не будут отличаться друг от друга.

#### Поднимаем Centrifugo на локальной машине

Если вы будете ставить эту технологию на локальной машине, то необходимо начать с установки Docker. Новичкам подойдет Docker Desktop, который поддерживается всеми PC операционными системами.

После установки не забудьте его запустить!

Теперь создаем папку и в эту папку помещаем 2 файла:

-   **config.json**: файл с описанием настроек Centrifugo
    
-   **Dockerfile**: файл с описанием сборки образа
    

Начнем мы с файла config.json. В нем мы опишем необходимые для запуска системы настройки.

Пример:

```json
{  "client": {    "token": {      "hmac_secret_key": "super_client_key"    },    "allowed_origins": ["*"]  },  "http_api": {    "key": "super_api_key"  },  "channel": {    "without_namespace": {      "allow_subscribe_for_client": true    }  },  "admin": {    "enabled": true,    "password": "super_admin_password",    "secret": "super_admin_secret_key"  }}
```

На настройках остановимся подробнее.

#### Как работает Centrifugo: краткий обзор

Для понимания данных настроек нужно разобраться с тем, как вообще работает Centrifugo.

Centrifugo реализована посредством наличия каналов. К каждому каналу можно подключиться (подписаться на обновления) и в каналы можно публиковать сообщения (определенные данные).

Для подписки на определенные каналы в Centrifugo используется JWT авторизация. То есть, необходимо подготовить специальный JWT токен и при подключении к определенному каналу передавать этот токен.

Для того чтобы сгенерировать этот токен, в файл настроек мы внедрили параметр hmac\_secret\_key. Далее, в практической части, мы напишем простой Python-скрипт, который позволит генерировать такой токен на основании значения ключа hmac\_secret\_key.

Для публикации сообщений используются простые API-запросы. Основным параметром этого запроса будет X-API-Key, который берется из переменной http\_api.key. Дополнительных преобразований не требует.

"allowed\_origins": \["\*"\] - указывает на то, что подключаться можно с любого доменного имени или IP-адреса. В боевых проектах нужно указывать реальные доверенные источники.

```json
"without_namespace": {    "allow_subscribe_for_client": true}
```

Позволяет подписываться на любой канал любому пользователю.

Кроме того, в Centrifugo есть возможность поднять простую админ-панель. Если она необходима, то в настройки добавляется блок:

```json
"admin": {    "enabled": true,    "password": "super_admin_password",    "secret": "super_admin_secret_key"}
```

Тут вы активируете панель флагом true и создаете пароль и секретный ключ.

Больше параметров и вариаций настроек вы можете найти в [официальной документации](https://centrifugal.dev/docs/server/configuration), где подробно описан раздел про конфигурационный файл.

Теперь подготовим сам Dockerfile в одной папке с файлом настроек. Вот содержимое:

```bash
FROM centrifugo/centrifugo:v6# Устанавливаем рабочую директориюWORKDIR /centrifugo# Копируем конфигурационный файлCOPY config.json ./config.json# Открываем порт 8000EXPOSE 8000# Запускаем Centrifugo с указанной конфигурациейCMD ["centrifugo", "--config", "config.json"]
```

Соберем образ:

```perl
docker build -t my-centrifugo .
```

И после запустим контейнер:

```css
docker run -d -p 8000:8000 --name centrifugo my-centrifugo
```

Если все было выполнено корректно, то перейдя по адресу: [http://localhost:8000/](http://localhost:8000/) у вас откроется админ-панель. Для входа используйте пароль, который вы указали в настройках.

![](https://habrastorage.org/r/w1560/getpro/habr/upload_files/034/0ce/2e8/0340ce2e8bf62a576a79af8f5c528a86.png)

При локальной разработке:

-   Ссылка для отправки API-запросов: [http://localhost:8000/api](http://localhost:8000/api)
    
-   Ссылка для подписки на каналы: ws://localhost:8000/connection/websocket
    

### Поднимаем Centrifugo на Amvera Cloud

Для подъема Centrifugo на облачном сервисе Amvera у нас уже все готово. Далее мы будем использовать тот же конфигурационный файл и тот же Dockerfile. Пошагово:

-   Регистрируемся на [Amvera Cloud](https://amvera.ru/?utm_source=habr&utm_medium=article&utm_campaign=yakvenalex_fast_api_centrifugo) (если ещё не было регистрации)
    
-   Кликаем на «Создать проект»
    
-   Выбираем «Приложение»
    
-   Даем имя приложению и выбираем тарифный план (советую брать не ниже «Начальный»)
    

![](https://habrastorage.org/r/w1560/getpro/habr/upload_files/476/ed7/446/476ed74464a611d526ef9376901d2ced.png)

-   Перемещаемся на вкладку загрузки данных. Можно использовать как команды Git, так и загрузить через интерфейс. Я беру интерфейс, так как у нас всего 2 файла
    
-   На странице с конфигурацией выбираем Docker в качестве типа приложения. В containerPort укажите 8000
    

![](https://habrastorage.org/r/w1560/getpro/habr/upload_files/ff9/eff/814/ff9eff814356864343eb6a56be99cf9d.png)

-   После создания проекта входим в него и перемещаемся на вкладку «Домены». Там выбираем «Добавить домен – https — бесплатный домен Amvera»
    

![](https://habrastorage.org/r/w1560/getpro/habr/upload_files/f29/dde/13f/f29dde13fd06bb121d01a61c9bbc4550.png)

Если все было выполнено корректно, то через пару минут вы увидите, что проект успешно развернут и проверить это сможете через переход по выделенной ссылке (в моем случае: [https://mycentrifugo-yakvenalex.amvera.io/](https://mycentrifugo-yakvenalex.amvera.io/))

Если вы будете использовать облачную версию Centrifugo, то ссылки будут иметь следующий вид:

-   Ссылка для отправки API-запросов: [https://amvera\_url/api](https://amvera_url/api)
    
-   Ссылка для подписок: wss://amvera\_url/connection/websocket
    

В моем случае:

-   [https://mycentrifugo-yakvenalex.amvera.io/api](https://mycentrifugo-yakvenalex.amvera.io/api)
    
-   wss://[mycentrifugo-yakvenalex.amvera.io/connection/websocket](http://mycentrifugo-yakvenalex.amvera.io/connection/websocket)
    

Обратите внимание, не ws, а wss, так как мы используем https протокол.

Далее, для удобства, я буду использовать облачную версию Centrifugo.

Теперь, когда мы подняли Centrifugo – можем приступать к написанию кода, что мы и сделаем в следующем разделе.

### Подготовим проект

Начнем с подготовки проекта. Для этого открываем любимый IDE, создаем проект и активируем виртуальное окружение.

### Устанавливаем зависимости

Теперь создадим файл requirements.txt и заполним его следующим образом:

```ini
pyjwt==2.10.1fastapi==0.115.8httpx==0.28.1jinja2==3.1.5pydantic==2.10.6pydantic-settings==2.8.0sqlalchemy==2.0.38aiosqlite==0.21.0loguru==0.7.3uvicorn==0.34.0
```

Установим зависимости:

```css
pip install -r requirements.txt
```

### Настройки окружения

Теперь подготовим файл с переменными окружения (.env):

```bash
BASE_URL=https://mycentrifugo-yakvenalex.amvera.io/apiSOCKET_URL=wss://mycentrifugo-yakvenalex.amvera.io/connection/websocketCENTRIFUGO_API_KEY=api_keySECRET_KEY=client_token_key
```

Там же, в корне проекта, создадим папку data. В ней будет сгенерирован файл базы данных SQLite.

### Создаем конфигурационный файл

В корне проекта создаем папку app и внутри нее файл [config.py](http://config.py/). Заполняем:

```lua
import osfrom pydantic_settings import BaseSettings, SettingsConfigDictclass Settings(BaseSettings):    DB_URL: str = 'sqlite+aiosqlite:///data/db.sqlite3'    DB_PATH: str = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "data", "db.sqlite3")    BASE_URL: str    CENTRIFUGO_API_KEY: str    SECRET_KEY: str    SOCKET_URL: str    model_config = SettingsConfigDict(        env_file=os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", ".env")    )# Получаем параметры для загрузки переменных средыsettings = Settings()
```

Тут мы, используя библиотеку pydantic\_settings, удобным образом загрузили переменные окружения в наш проект. Такой подход позволяет нам получить типизированный доступ к настройкам, что делает код более безопасным и читаемым.

На этом блок с настройками завершен, и уже в следующем разделе на простом примере я продемонстрирую вам связку FastAPI + Centrifugo.

## Простой пример

Сейчас мы реализуем чисто учебный пример связки, который просто и наглядно продемонстрирует, как связывается бэкенд, фронтенд и Centrifugo в единой экосистеме.

В папке app создаем папку pages и внутри нее сделаем файл [utils.py](http://utils.py/). Сейчас нам предстоит реализовать простую утилиту по генерации валидного JWT токена для Centrifugo. Вот код:

```lua
import timeimport jwtdef generate_client_token(user_id, secret_key):    # Устанавливаем время жизни токена (например, 60 минут)    exp = int(time.time()) + 60 * 60  # Время истечения в секундах    # Создаем полезную нагрузку токена    payload = {        "sub": str(user_id),  # Идентификатор пользователя        "exp": exp  # Время истечения    }    # Генерируем токен с использованием HMAC SHA-256    return jwt.encode(payload, secret_key, algorithm="HS256")
```

Обязательным параметром для токена тут выступает некая загружаемая дата, например это может быть айди пользователя или любая другая информация и время жизни токена. Информация передается строкой.

Далее этот токен будет использоваться для того, чтоб пользователь мог выполнить подписку на тот или иной канал. Генерировать его будет бэкенд.

У нас логика будет такой:

1.  Пользователь переходит на страницу где требуется подписка
    
2.  Мы генерируем JWT токен
    
3.  Передаем этот токен на фронтенд
    

Для учебных целей айди пользователя будем генерировать случайно.

Теперь создаем файл [router.py](http://router.py/) и в нем опишем следующую логику:

```kotlin
import randomfrom fastapi import APIRouterfrom app.pages.utils import generate_client_tokenfrom fastapi.requests import Requestfrom fastapi.responses import HTMLResponsefrom fastapi.templating import Jinja2Templatesfrom app.config import settingsrouter = APIRouter()templates = Jinja2Templates(directory='app/templates')@router.get("/example", response_class=HTMLResponse)async def show_results(request: Request):    # Генерируем токен    token = generate_client_token(random.randint(100, 100000), settings.SECRET_KEY)    # Подготавливаем данные для шаблона    context = {        "request": request,        "centrifugo_url": settings.SOCKET_URL,        "centrifugo_token": token    }    return templates.TemplateResponse("example.html", context)
```

Тут использовал стандартный синтаксис FastApi в связке с Jinja2 для рендеринга HTML страницы.

То есть, по запросу /example мы вернем пользователю некий HTML шаблон с ссылкой на подключение к Centrifugo и сгенерированным токеном.

Подготовим шаблон. Для этого в папке app создаем папку templates и помещаем внутрь файл example.html. Заполним:

```php-template
<!DOCTYPE html><html lang="en"><head>    <meta charset="UTF-8">    <meta name="viewport" content="width=device-width, initial-scale=1.0">    <title>Centrifugo Quick Start</title>    <script src="https://unpkg.com/centrifuge@5.2.2/dist/centrifuge.js"></script>    <script src="https://cdn.tailwindcss.com"></script></head><body class="bg-gray-100 h-screen flex items-center justify-center">    <div id="question"         data-question-id="{{ question_id }}"         data-centrifugo-url="{{ centrifugo_url }}"         data-centrifugo-token="{{ centrifugo_token }}">    </div><div id="counter"     class="text-4xl font-bold text-gray-800 bg-white p-8 rounded-lg shadow-md transition-all duration-300 hover:scale-105">    -</div><script src="/static/example.js"></script></body></html>
```

К данной странице мы подключаем библиотеку Tailwind для стилизации страницы и библиотеку Centrifugo.

В тело html, используя синтаксис Jinja2, мы передаем:

```kotlin
<div data-centrifugo-token="{{ centrifugo_token }}" data-centrifugo-url="{{ centrifugo_url }}" data-question-id="{{ question_id }}" id="question"></div>
```

Это необходимо для удобного и безопасного извлечения серверных данных на стороне JavaScript.

Больше всего нас будет интересовать блок:

```bash
<div class="text-4xl font-bold text-gray-800 bg-white p-8 rounded-lg shadow-md transition-all duration-300 hover:scale-105" id="counter">  -</div>
```

Смысл этого блока в том, чтоб отобразить опубликованное сообщение в указанный канал. Просто и наглядно:

1.  Мы открываем страницу /example, тем самым подписываясь на канал example\_channel
    
2.  Если кто-то опубликует сообщение в этот канал, то мы его мгновенно увидим без необходимости перезагрузки страницы (Real time).
    

Далее мы видим строку:

```php-template
<script src="/static/example.js"></script>
```

Она намекает на то, что мы будем выполнять импорт файла example.js с папки static. Создадим папку static в корне app и поместим в нее файл example.js:

```lua
/* jshint esversion: 6 */// Получаем элемент с данными для подключенияconst qstEl = document.getElementById("question");// Получаем данные для подключения из HTML-элементаconst centrifugoUrl = qstEl.dataset.centrifugoUrl;  // Адрес сервера Centrifugoconst centrifugoToken = qstEl.dataset.centrifugoToken;  // Токен авторизацииconst container = document.getElementById('counter');  // Элемент на странице, где будем показывать значение// Создаём соединение с сервером Centrifugoconst centrifuge = new Centrifuge(centrifugoUrl, {token: centrifugoToken});// Настраиваем обработчики событий соединенияcentrifuge.on('connecting', function (ctx) {    // Когда происходит попытка подключения к серверу    console.log(`connecting: ${ctx.code}, ${ctx.reason}`);}).on('connected', function (ctx) {    // Когда успешно подключились к серверу    console.log(`connected over ${ctx.transport}`);}).on('disconnected', function (ctx) {    // Когда соединение с сервером было прервано    console.log(`disconnected: ${ctx.code}, ${ctx.reason}`);}).connect();  // Запускаем соединение// Создаём подписку на канал "example_channel"const sub = centrifuge.newSubscription("example_channel");// Настраиваем обработчики событий для каналаsub.on('publication', function (ctx) {    // Когда приходит новое сообщение в канал    container.innerHTML = ctx.data.value;  // Обновляем содержимое элемента на странице    document.title = ctx.data.value;  // Обновляем заголовок вкладки/окна браузера}).on('subscribing', function (ctx) {    // Когда идёт процесс подписки на канал    console.log(`subscribing: ${ctx.code}, ${ctx.reason}`);}).on('subscribed', function (ctx) {    // Когда успешно подписались на канал    console.log('subscribed', ctx);}).on('unsubscribed', function (ctx) {    // Когда отписались от канала    console.log(`unsubscribed: ${ctx.code}, ${ctx.reason}`);}).subscribe();  // Выполняем подписку на канал
```

В коде я дал подробные комментарии того, что делает каждая строка. Сейчас просто коротко подытожим.

Начинается все с извлечения переменных с блока с айди question.

Далее, для манипулирования DOM-деревом мы извлекли блок container.

Затем происходит подключение к вебсокету Centrifugo. На входе для подключения мы передаем 2 обязательных параметра: ссылку на подключение и сгенерированный токен.

Затем я продемонстрировал как работают обработчики событий. Код можно было бы не описывать, но для общего понимания логи лишними не будут.

Далее происходит сама подписка на канал:

```perl
const sub = centrifuge.newSubscription("example_channel");
```

Канал будет создан автоматически, как только к нему подключится пользователь. Это на себя берет Centrifugo.

Далее я продемонстрировал всевозможные обработчики событий, но больше всего нас интересует событие, которое происходит при публикации нового сообщения в канал:

```javascript
sub.on('publication', function (ctx) {    // Когда приходит новое сообщение в канал    container.innerHTML = ctx.data.value;  // Обновляем содержимое элемента на странице    document.title = ctx.data.value;  // Обновляем заголовок вкладки/окна браузера
```

Во время этого события мы изменяем DOM-дерево, отображая новое сообщение.

Осталось запустить FastApi приложение и сделать тесты.

В корне папки app создаем файл [main.py](http://main.py/) и заполним его следующим образом:

```python
from contextlib import asynccontextmanagerfrom fastapi.staticfiles import StaticFilesfrom fastapi import FastAPIfrom loguru import loggerfrom app.pages.router import router as page_router@asynccontextmanagerasync def lifespan(app: FastAPI):    app.include_router(page_router)    logger.info("Приложение запущено!")    yield    logger.info("Приложение остановлено!")app = FastAPI(lifespan=lifespan)app.mount('/static', StaticFiles(directory='app/static'), name='static')
```

Этим кодом мы примонтировали обработчик статических файлов на стороне FastApi, указав путь к файлам, инициировали само приложение и подключили наш роутер.

Запустим приложение:

```
uvicorn app.main:app
```

Теперь для теста сделаем следующее.

Открываем приложение по пути /example и входим в админку Centrifugo. В админке перемещаемся на вкладку action и делаем публикацию.

![](https://habrastorage.org/r/w1560/getpro/habr/upload_files/da0/6a9/6f7/da06a96f772ba1d94c9c553015712a01.png)

Видим что все работает, а это значит, что мы можем приступить к разработке логики нашего опросника. Этим мы займемся в следующем разделе.

## Подготавливаем базу данных

Для полноценной работы нашего опросника необходимо подготовить базу данных и методы взаимодействия с ней. В этом нам поможет **SQLAlchemy**.

### Настройка SQLAlchemy

В папке app создаем директорию dao и добавляем в нее файл [database.py](http://database.py/). В нем опишем базовые настройки **SQLAlchemy**:

```python
from sqlalchemy import Integerfrom sqlalchemy.ext.asyncio import AsyncAttrs, create_async_engine, async_sessionmaker, AsyncSessionfrom sqlalchemy.orm import DeclarativeBase, Mapped, mapped_columnfrom app.config import settingsengine = create_async_engine(url=settings.DB_URL)async_session_maker = async_sessionmaker(engine, class_=AsyncSession)class Base(AsyncAttrs, DeclarativeBase):    __abstract__ = True    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)    @classmethod    @property    def __tablename__(cls) -> str:        return cls.__name__.lower() + 's'
```

Здесь мы реализуем:

-   **Движок** (engine) для работы с базой данных;
    
-   **Фабрику асинхронных сессий** (async\_session\_maker);
    
-   **Базовый класс** (Base), от которого будут наследоваться все модели.
    

Более детальное объяснение этой структуры можно найти в моих публикациях, [посвященных **SQLAlchemy**](https://yakvenalex.ru/ru/sqlalchemy).

### Описание моделей таблиц

Теперь создадим файл dao/[models.py](http://models.py/) и опишем структуру таблиц:

```vbnet
from sqlalchemy import Integer, String, ForeignKeyfrom sqlalchemy.orm import Mapped, mapped_column, relationshipfrom app.dao.database import Baseclass Question(Base):    text: Mapped[str] = mapped_column(String, nullable=False)    answers: Mapped[list["Answer"]] = relationship(        back_populates="question",        cascade="all, delete-orphan"    )class Answer(Base):    question_id: Mapped[int] = mapped_column(ForeignKey("questions.id", ondelete="CASCADE"), nullable=False)    text: Mapped[str] = mapped_column(String, nullable=False)    votes: Mapped[int] = mapped_column(Integer, default=0)    question: Mapped["Question"] = relationship(back_populates="answers")
```

Мы определили две таблицы:

-   **Question** (вопросы);
    
-   **Answer** (варианты ответов), привязанные к вопросам через внешний ключ.
    

### Создание и заполнение базы данных

Чтобы не тянуть в проект **Alembic**, создадим скрипт инициализации базы app/dao/create\_[db.py](http://db.py/):

```python
import aiosqlitefrom loguru import loggerfrom app.config import settingsasync def create_and_fill_database():    async with aiosqlite.connect(settings.DB_PATH) as db:        await db.execute('''        CREATE TABLE IF NOT EXISTS questions (            id INTEGER PRIMARY KEY AUTOINCREMENT,            text TEXT NOT NULL        )        ''')        await db.execute('''        CREATE TABLE IF NOT EXISTS answers (            id INTEGER PRIMARY KEY AUTOINCREMENT,            question_id INTEGER NOT NULL,            text TEXT NOT NULL,            votes INTEGER DEFAULT 0,            FOREIGN KEY (question_id) REFERENCES questions (id)        )        ''')        questions_and_answers = {            "Какой ваш любимый фреймворк для веб-разработки на Python?": ["Django", "Flask", "FastAPI", "Pyramid"],        }        for question_text, answers in questions_and_answers.items():            cursor = await db.execute('INSERT INTO questions (text) VALUES (?)', (question_text,))            question_id = cursor.lastrowid            for answer_text in answers:                await db.execute('INSERT INTO answers (question_id, text, votes) VALUES (?, ?, 0)', (question_id, answer_text))        await db.commit()async def check_database():    async with aiosqlite.connect(settings.DB_PATH) as db:        logger.info("Вопросы и ответы в базе данных:")        async with db.execute('''            SELECT q.id, q.text, a.text, a.votes            FROM questions q            JOIN answers a ON q.id = a.question_id            ORDER BY q.id, a.id        ''') as cursor:            current_question_id = None            async for row in cursor:                if current_question_id != row[0]:                    logger.info(f"\nВопрос {row[0]}: {row[1]}")                    current_question_id = row[0]                logger.info(f"  - {row[2]} (Голосов: {row[3]})")async def main_create_db():    try:        await create_and_fill_database()        logger.success("База данных успешно создана и заполнена!")        await check_database()    except aiosqlite.Error as e:        logger.error(f"Произошла ошибка SQLite: {e}")
```

Полный исходный код можно найти в моем Telegram-канале **«**[**Легкий путь в Python**](https://t.me/PythonPathMaster)**»**.

### Методы работы с базой данных

Создадим файл dao/[dao.py](http://dao.py/), в котором реализуем **DAO-классы** для работы с вопросами и ответами:

```python
from sqlalchemy import select, updatefrom sqlalchemy.ext.asyncio import AsyncSessionfrom sqlalchemy.orm import selectinloadfrom app.dao.models import Question, Answerclass QuestionDAO:    def __init__(self, session: AsyncSession):        self.session = session    async def get_all_questions(self):        """Получить все вопросы с их вариантами ответов"""        query = select(Question).options(selectinload(Question.answers))        result = await self.session.execute(query)        return result.scalars().all()    async def get_question_by_id(self, question_id: int):        """Получить конкретный вопрос с вариантами ответов по id"""        query = select(Question).options(            selectinload(Question.answers)        ).where(Question.id == question_id)        result = await self.session.execute(query)        return result.scalar_one_or_none()    async def increment_answer_votes(self, answer_id: int):        """Увеличить количество голосов для конкретного варианта ответа"""        query = update(Answer).where(            Answer.id == answer_id        ).values(            votes=Answer.votes + 1        ).returning(Answer)        result = await self.session.execute(query)        return result.scalar_one_or_none()    async def get_answers_for_question(self, question_id: int):        """Получить все варианты ответов для конкретного вопроса"""        query = select(Answer).where(Answer.question_id == question_id)        result = await self.session.execute(query)        return result.scalars().all()    async def get_question_results(self, question_id: int):        """Получить результаты голосования для вопроса"""        question = await self.get_question_by_id(question_id)        if not question:            return None        total_votes = sum(answer.votes for answer in question.answers)        results = []        for answer in question.answers:            percentage = (answer.votes / total_votes * 100) if total_votes > 0 else 0            results.append({                'answer_text': answer.text,                'votes': answer.votes,                'percentage': round(percentage, 2)            })        return {            'question': question.text,            'total_votes': total_votes,            'results': results        }
```

### Зависимости для FastAPI

Создадим файл app/dao/fast\_api\_[dep.py](http://dep.py/), в котором определим зависимости для работы с сессиями:

```python
from typing import AsyncGeneratorfrom sqlalchemy.ext.asyncio import AsyncSessionfrom app.dao.database import async_session_makerasync def get_session_with_commit() -> AsyncGenerator[AsyncSession, None]:    """Асинхронная сессия с автоматическим коммитом."""    async with async_session_maker() as session:        try:            yield session            await session.commit()        except Exception:            await session.rollback()            raise        finally:            await session.close()async def get_session_without_commit() -> AsyncGenerator[AsyncSession, None]:    """Асинхронная сессия без автоматического коммита."""    async with async_session_maker() as session:        try:            yield session        except Exception:            await session.rollback()            raise        finally:            await session.close()
```

Теперь, когда база данных настроена, мы можем перейти к разработке API на **FastAPI**!

#### API метод для публикации в каналы

Публиковать сообщения через админ-панель Centrifugo, конечно, интересно, но в реальной практике используются специальные API-методы на бэкенде.

Сейчас мы реализуем такой метод. Для этого создадим папку app/api и внутри файл [utils.py](http://utils.py/). Заполним его следующим кодом:

```kotlin
import jsonimport httpxasync def send_msg(data: dict, api_url: str, secret_key: str, channel_name: str) -> bool:    # Трансформируем данные в нужный формат    transformed_data = {        "results": data['results'],        "total_votes": data['total_votes']    }    # Округляем процентные значения до двух знаков после запятой    for result in transformed_data['results']:        result['percentage'] = round(result['percentage'], 2)    # Сериализуем данные в JSON    json_data = json.dumps(transformed_data)    payload = {        "method": "publish",        "params": {"channel": channel_name, "data": json_data}    }    headers = {"X-API-Key": secret_key}    async with httpx.AsyncClient() as client:        response = await client.post(api_url,                                   json=payload,                                   headers=headers)        return response.status_code == 200
```

На входе этот метод принимает: ссылку для отправки API-запросов, API-ключ, название канала и данные для отправки.

При отправке запроса в заголовок обязательно передается ключ "X-API-Key" со значением API-ключа.

В отправляемых данных обязательными ключами будут: "method" (для публикации используется publish) и ключ с параметрами. В параметрах обязательными значениями будут имя канала и загружаемые данные.

Чтобы Centrifugo корректно принимал загружаемые данные, лучше выполнить трансформацию питоновского словаря (или списка словарей) в JSON, как показано в примере выше.

Теперь опишем сам API-метод в файле app/api/[router.py](http://router.py/). Начнем с импортов:

```javascript
from fastapi import APIRouter, Dependsfrom sqlalchemy.ext.asyncio import AsyncSessionfrom app.api.utils import send_msgfrom app.config import settingsfrom app.dao.dao import QuestionDAOfrom app.dao.fast_api_dep import get_session_with_commit
```

Теперь инициализируем роутер:

```ini
router = APIRouter(prefix="/api")
```

Теперь нам предстоит реализовать единственный API-метод, который будет выполнять две задачи:

1.  Увеличивать счетчик для конкретного варианта ответа на +1 (метод increment\_answer\_votes).
    
2.  Публиковать актуальный результат голосования в конкретный канал Centrifugo.
    

Опишем полный код, а затем разберем его логику:

```kotlin
@router.post("/vote/{answer_id}")async def vote(answer_id: int, session: AsyncSession = Depends(get_session_with_commit)):    try:        db_client = QuestionDAO(session)        result = await db_client.increment_answer_votes(answer_id)        data = await db_client.get_question_results(result.question_id)        channel = f"question_{result.question_id}"        is_sent = await send_msg(            data=data,            api_url=settings.BASE_URL,            secret_key=settings.CENTRIFUGO_API_KEY,            channel_name=channel        )        if is_sent:            return {                "status": "success",                "message": "Ваш голос учтен, и результаты обновлены"            }        else:            return {                "status": "partial_success",                "message": "Ваш голос учтен, но не удалось обновить результаты в реальном времени"            }    except Exception as e:        return {            "status": "error",            "message": f"Не удалось обработать ваш голос: {str(e)}"        }
```

Метод на вход принимает: ID вопроса и зависимость с генератором асинхронной сессии для подключения к базе данных.

Далее мы вызываем метод увеличения счетчика для конкретного варианта ответа. В результате мы извлекаем ID вопроса (не варианта ответа).

Затем мы генерируем имя канала. Логика простая:

```ini
channel = f"question_{result.question_id}"
```

После этого мы вызываем ранее подготовленный метод для публикации сообщений. Логика здесь выполнится примерно так же, как при публикации сообщения из админ-панели Centrifugo, но теперь мы вызываем метод самостоятельно.

В целом это все, что требуется от API FastAPI, так как остальную логику берет на себя Centrifugo. Напоминаю, что в статье «[Вебсокеты на FastAPI: Реализация простого чата с комнатами за 20 минут](https://habr.com/ru/companies/amvera/articles/884816/)» мы самостоятельно реализовали менеджер для управления вебсокетами.

Теперь остается реализовать фронтенд, чем мы займемся далее.

#### Реализация серверной части фронтенда

Мы уже описывали эндпоинт для рендеринга демонстрационной страницы в файле app/pages/[router.py](http://router.py/). Возвращаемся к этому файлу. Там нам предстоит реализовать три эндпоинта для рендеринга следующих страниц:

-   Главная страница со списком всех вопросов.
    
-   Страница вопроса с вариантами ответов.
    
-   Страница с результатами по конкретному вопросу.
    

### Эндпоинт для главной страницы:

```less
@router.get("/", response_class=HTMLResponse)async def read_root(request: Request, session: AsyncSession = Depends(get_session_without_commit)):    data = await QuestionDAO(session).get_all_questions()    return templates.TemplateResponse("home.html", {"request": request, "questions": data})
```

После обращения к главной странице отправится запрос к базе данных для извлечения всех существующих вопросов. Затем пользователь получит HTML-страницу home.html с информацией о вопросах.

### Эндпоинт страницы с вопросом:

```less
@router.get("/question/{qst_id}", response_class=HTMLResponse)async def read_root(qst_id: int, request: Request, session: AsyncSession = Depends(get_session_without_commit)):    data = await QuestionDAO(session).get_question_by_id(qst_id)    return templates.TemplateResponse("answer.html", {"request": request, "question": data})
```

Здесь логика похожая, только теперь мы вернем страницу answer.html с полной информацией по вопросу (сам вопрос и варианты ответа на него).

### Эндпоинт с результатами по вопросу:

```cpp
@router.get("/results/{question_id}", response_class=HTMLResponse)async def show_results(question_id: int, request: Request, session: AsyncSession = Depends(get_session_without_commit)):    # Получаем данные о результатах голосования    results_data = await QuestionDAO(session).get_question_results(question_id)    token = generate_client_token(random.randint(100, 100000), settings.SECRET_KEY)    # Подготавливаем данные для шаблона    context = {        "request": request,        "question_id": question_id,        "question": results_data["question"],        "total_votes": results_data["total_votes"],        "results": results_data["results"],        "centrifugo_url": settings.SOCKET_URL,        "centrifugo_token": token    }    return templates.TemplateResponse("results.html", context)
```

При вызове этого эндпоинта мы отправляем запрос на получение информации по вопросу с актуальными результатами голосования. При обновлении страницы каждый раз запрашивается актуальная информация из базы данных, которая затем отображается. Если бы мы не внедрили в систему Centrifugo, это был бы единственный способ получения актуальных данных.

Также при вызове генерируется специальный токен. Логика здесь такая же, как в демонстрационном примере.

Далее мы удобным образом группируем все необходимые для корректной работы страницы с результатами параметры и возвращаем их вместе со страницей results.html.

Теперь, чтобы все заработало, нам необходимо будет создать три HTML-страницы: home.html, answer.html и results.html, подключив к ним необходимую JavaScript-логику там, где это нужно (не волнуйтесь, разобраться будет несложно). Этим мы займемся в следующем разделе.

#### Реализация HTML-страниц

Начнем с реализации страницы home.html. Она самая простая и не требует написания JavaScript-кода.

### Реализация главной страницы (templates/home.html):

```php-template
<!DOCTYPE html><html lang="ru"><head>    <meta charset="UTF-8">    <meta name="viewport" content="width=device-width, initial-scale=1.0">    <title>Каталог вопросов</title>    <script src="https://cdn.tailwindcss.com"></script></head><body class="bg-gray-100 min-h-screen py-8"><div class="container mx-auto px-4">    <h1 class="text-3xl font-bold mb-8 text-center text-blue-600">Каталог вопросов</h1>    <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">        {% for question in questions %}        <div class="bg-white rounded-lg shadow-md p-6">            <h2 class="text-lg font-semibold mb-4">{{ question.text }}</h2>            <a href="/question/{{ question.id }}"               class="bg-blue-500 hover:bg-blue-600 text-white font-bold py-2 px-4 rounded">                Ответить            </a>        </div>        {% endfor %}    </div></div></body></html>
```

Здесь я снова использовал библиотеку TailwindCSS для стилизации и стандартный синтаксис Jinja2 для передачи параметров на страницу.

![Привмер готовой главной страницы](https://habrastorage.org/r/w1560/getpro/habr/upload_files/31b/655/6d6/31b6556d6b3db181fc98ab084b0ae5b4.png "Привмер готовой главной страницы")

Привмер готовой главной страницы

### Реализация страницы с вопросом (templates/answer.html):

```php-template
<!DOCTYPE html><html lang="ru"><head>    <meta charset="UTF-8">    <meta name="viewport" content="width=device-width, initial-scale=1.0">    <title>Вопрос</title>    <script src="https://cdn.tailwindcss.com"></script></head><body class="bg-gray-100 min-h-screen py-8"><div class="container mx-auto px-4">    <h1 class="text-3xl font-bold mb-8 text-center text-blue-600">Вопрос</h1>    <div id="question" data-question-id="{{ question.id }}"></div>    <div class="bg-white rounded-lg shadow-md p-6 max-w-2xl mx-auto">        <h2 class="text-xl font-semibold mb-4">{{ question.text }}</h2>        <form id="voteForm">            {% for answer in question.answers %}            <div class="mb-2">                <label class="inline-flex items-center">                    <input type="radio" class="form-radio text-blue-600" name="answer" value="{{ answer.id }}" required>                    <span class="ml-2">{{ answer.text }}</span>                </label>            </div>            {% endfor %}            <div class="mt-4 flex gap-2">                <button type="submit" class="bg-blue-500 hover:bg-blue-600 text-white font-bold py-2 px-4 rounded">                    Проголосовать                </button>                <a href="/" class="bg-gray-500 hover:bg-gray-600 text-white font-bold py-2 px-4 rounded">                    Вернуться к списку                </a>            </div>        </form>    </div></div><script src="/static/answer.js"></script></body></html>
```

Здесь нам предстоит задействовать JavaScript. Основная задача этого кода — отправить результат голосования пользователя на наш API-метод, который мы реализовали ранее.

![Пример страницы с вопросом и вариантами ответов](https://habrastorage.org/r/w1560/getpro/habr/upload_files/0fb/e24/e62/0fbe24e626a19b094cfae4fec20ec2e4.png "Пример страницы с вопросом и вариантами ответов")

Пример страницы с вопросом и вариантами ответов

### Описание кода в файле app/static/answer.js:

```javascript
/* jshint esversion: 6 */const questionId = document.getElementById("question").dataset.questionId;document.getElementById('voteForm').addEventListener('submit', e => {    e.preventDefault();    const formData = new FormData(e.target);    const answerId = formData.get('answer');    if (!answerId) {        alert('Пожалуйста, выберите вариант ответа');        return;    }    fetch(`/api/vote/${answerId}`, {        method: 'POST'    })    .then(response => response.json())    .then(data => {        if (data.status === 'success' || data.status === 'partial_success') {            window.location.href = `/results/${questionId}`;        } else {            throw new Error(data.message || 'Неизвестная ошибка');        }    })    .catch(error => {        console.error('Ошибка:', error);        alert(`Произошла ошибка: ${error.message}`);    });});
```

Здесь я снова воспользовался уже знакомым приемом с извлечением важных серверных данных, а затем выполнил стандартный POST-запрос с помощью встроенной в JavaScript библиотеки fetch.

Если запрос выполнится корректно, то мы увеличим счетчик голосов для конкретного варианта ответа и отправим сообщение с актуальными данными в конкретный канал Centrifugo.

### Реализация страницы с результатами (templates/results.html):

```php-template
<!DOCTYPE html><html lang="ru"><head>    <meta charset="UTF-8">    <meta name="viewport" content="width=device-width, initial-scale=1.0">    <title>Результаты голосования</title>    <script src="https://cdn.tailwindcss.com"></script>    <script src="https://unpkg.com/centrifuge@5.2.2/dist/centrifuge.js"></script></head><body class="bg-gray-100 min-h-screen py-8"><div class="container mx-auto px-4">    <h1 class="text-3xl font-bold mb-8 text-center text-blue-600">Результаты голосования</h1>    <div id="question"         data-question-id="{{ question_id }}"         data-centrifugo-url="{{ centrifugo_url }}"         data-centrifugo-token="{{ centrifugo_token }}">    </div>    <div id="results" class="bg-white rounded-lg shadow-md p-6 max-w-2xl mx-auto">        <h2 id="question-text" class="text-xl font-semibold mb-4">{{ question }}</h2>        <div id="answers">            {% for result in results %}            <div class="mb-4">                <div class="flex justify-between items-center mb-1">                    <span>{{ result.answer_text }}</span>                    <span class="font-semibold">{{ result.votes }} голосов</span>                </div>                <div class="w-full bg-gray-200 rounded-full h-2.5">                    <div class="bg-blue-600 h-2.5 rounded-full" style="width: {{ result.percentage }}%"></div>                </div>            </div>            {% endfor %}        </div>        <p id="total-votes" class="mt-4 text-gray-600">Всего голосов: {{ total_votes }}</p>        <a href="/" class="mt-4 inline-block bg-blue-500 hover:bg-blue-600 text-white font-bold py-2 px-4 rounded">            Вернуться к списку вопросов        </a>    </div></div><script src="/static/result.js"></script></body></html>
```

Здесь стало немного больше стилей TailwindCSS, но сама логика особо не изменилась. Есть ряд серверных переменных, которые мы устанавливаем на HTML-страницу через Jinja2, и есть блоки с отображением результатов, которыми нам предстоит манипулировать через JavaScript.

![Пример страницы с результатами](https://habrastorage.org/r/w1560/getpro/habr/upload_files/72e/946/c5b/72e946c5bbb56ea75c88b1c96c05e400.png "Пример страницы с результатами")

Пример страницы с результатами

### Написание кода (static/results.js):

```javascript
/* jshint esversion: 6 */const qstEl = document.getElementById("question");    const questionId = qstEl.dataset.questionId;    const centrifugoUrl = qstEl.dataset.centrifugoUrl;    const centrifugoToken = qstEl.dataset.centrifugoToken;    const centrifuge = new Centrifuge(centrifugoUrl, { token: centrifugoToken });    centrifuge.connect();    const sub = centrifuge.newSubscription(`question_${questionId}`);    sub.on('publication', ctx => updateResults(ctx.data)).subscribe();    function updateResults(data) {        try {            const jsonData = JSON.parse(data);            if (!jsonData || !jsonData.results) return;            const answersContainer = document.getElementById('answers');            answersContainer.innerHTML = '';            jsonData.results.forEach(result => {                const answerDiv = document.createElement('div');                answerDiv.className = 'mb-4';                answerDiv.innerHTML = `                    <div class="flex justify-between items-center mb-1">                        <span>${result.answer_text}</span>                        <span class="font-semibold">${result.votes} голосов</span>                    </div>                    <div class="w-full bg-gray-200 rounded-full h-2.5">                        <div class="bg-blue-600 h-2.5 rounded-full" style="width: ${result.percentage}%"></div>                    </div>                `;                answersContainer.appendChild(answerDiv);            });            document.getElementById('total-votes').textContent = `Всего голосов: ${jsonData.total_votes}`;        } catch (err) {            console.error('Ошибка обработки данных:', err);        }    }
```

Извлекаем нужные данные из HTML, подписываем пользователя на конкретный канал и ждем обновлений. Как только обновления поступают, они автоматически отрисовываются в DOM-дереве.

Остается донастроить главный файл ([main.py](http://main.py/)), и проект будет готов. Этим мы займемся в следующем разделе.

#### Дописываем main-файл и тестируем приложение

Main-файл практически готов. Нам осталось только включить в него наш API-эндпоинт и метод для генерации базы данных с таблицами и внутренней информацией по вопросам. Финальная версия [main.py](http://main.py/) выглядит так:

```python
from contextlib import asynccontextmanagerfrom fastapi.staticfiles import StaticFilesfrom fastapi import FastAPIfrom loguru import loggerfrom app.api.router import router as api_routerfrom app.pages.router import router as page_routerfrom app.dao.create_db import main_create_db@asynccontextmanagerasync def lifespan(app: FastAPI):    await main_create_db()    app.include_router(api_router)    app.include_router(page_router)    logger.info("Приложение запущено!")    yield    logger.info("Приложение остановлено!")app = FastAPI(lifespan=lifespan)app.mount('/static', StaticFiles(directory='app/static'), 'static')
```

Запускаем приложение следующей командой.

```
uvicorn app.main:app
```

![](https://habrastorage.org/getpro/habr/upload_files/496/7a5/a17/4967a5a17910c8143bf4fe2113d30222.gif)

Проект достаточно функционален, но сейчас использовать его можно только на вашем локальном компьютере. Давайте это исправим, выполнив деплой проекта на сервис Amvera Cloud.

### Деплой веб-приложения

Процесс развертывания веб-опросника на платформе [Amvera Cloud](https://amvera.ru/?utm_source=habr&utm_medium=article&utm_campaign=yakvenalex_fast_api_centrifugo) не будет сильно отличаться от аналогичной процедуры для Centrifugo. Однако на этот раз потребуется доставить больше файлов, и мы обойдёмся без Dockerfile.

Приступим:

-   Регистрируемся и авторизуемсяя на сайте Amvera
    
-   Кликаем на "Создать проект"
    
-   Даем имя и выбираем тарифный план. Кликаем на "Далее"
    
-   На новой вкладке выбираем способ доставки файлов. Можно снова воспользоваться загрузкой через интерфейс на сайте. Кликаем на "Далее"
    
-   На новом экране вам необходимо заполнить конфигурации по проекту. Просто повторите за мной:
    

![Команда для запуска: uvicorn app.main:app --host 0.0.0.0 --port 8000](https://habrastorage.org/r/w1560/getpro/habr/upload_files/e0c/4c5/227/e0c4c522755940a8233677cded8bd143.png "Команда для запуска: uvicorn app.main:app --host 0.0.0.0 --port 8000")

Команда для запуска: uvicorn app.main:app --host 0.0.0.0 --port 8000

-   После сохранения не забудьте зайти в проект и активировать бесплатное доменное имя.
    

После завершения этих простых шагов и небольшого ожидания ваш проект станет доступен по специальной ссылке. В моём случае это: [ссылка на работающий проект](https://centrifugoapp-yakvenalex.amvera.io/).

Хочу напомнить вам, что полный исходный код этого проекта, а также эксклюзивный контент, который я не публикую на Хабре, вы сможете найти в моём бесплатном телеграм-канале «[Лёгкий путь в Python](https://t.me/PythonPathMaster)».

### Заключение

Вот и подошло к концу наше, надеюсь, увлекательное путешествие в мир Centrifugo. Если вам удалось разобраться в изложенном материале, то теперь разработка Real-time приложений больше не станет для вас вызовом.

Чтобы закрепить полученные знания, я предлагаю вам реализовать проект из статьи [«Вебсокеты на FastAPI: Реализация простого чата с комнатами за 20 минут»](https://habr.com/ru/companies/amvera/articles/884816/), но уже с использованием Centrifugo. В той статье я рассказывал, как создать чат с комнатами, используя Python WebSocket. Теперь же у вас есть возможность сравнить оба подхода и оценить преимущества Centrifugo перед классическими WebSocket и другими технологиями.

Надеюсь, этот материал оказался для вас полезным. Если так, не забудьте поддержать статью лайком или оставить приятный комментарий — это всегда мотивирует делиться новыми знаниями!

На этом пока все, но уверен, что Centrifugo еще не раз станет темой моих будущих статей, ведь это действительно мощный инструмент.

До скорого!

Только зарегистрированные пользователи могут участвовать в опросе. [Войдите](https://habr.com/kek/v1/auth/habrahabr/?back=&hl=ru), пожалуйста.

82.35%Конечно!14

5.88%Возможно…1

11.76%Нет!2

Проголосовали 17 пользователей. Воздержался 1 пользователь.
