
// МодульНапарник — интеграция с 1С:Напарник (code.1c.ai).
// Служебная форма-модуль с HTML-полем для HTTP-запросов к API Напарника.
// 1С клиент не имеет HTTP-клиента — запросы через fetch() в HTML-поле.
//
// Поддерживает диалог: хранит conversation_id и last_message_uuid
// между вызовами, Напарник видит историю и отвечает в контексте.
//
// Поток: МодульЧат → ЗадатьВопрос(Токен, Вопрос, ИДЗапроса)
//        → HTML/JS fetch к code.1c.ai (SSE)
//        → JS callback через location.href
//        → ПриНажатии → tool_result через Транспорт

#Область ПеременныеМодуля

&НаКлиенте
Перем Владелец;          // главная форма (Форма)
&НаКлиенте
Перем МодульТранспорт;         // МодульТранспорт (для отправки tool_result)
&НаКлиенте
Перем ИДДиалога;         // conversation uuid — сохраняется между вызовами
&НаКлиенте
Перем ПоследнийИДСообщения; // uuid последнего сообщения (parent_uuid для следующего)
&НаКлиенте
Перем ТекущийНавык;      // skill_name текущего диалога (custom/explain/review/modify)
&НаКлиенте
Перем ПоследнийСтатус;   // последний цвет индикатора ("серый"/"красный"/"зелёный")

#КонецОбласти

#Область ПрограммныйИнтерфейс

// Инициализация модуля.
//
// Параметры:
//  ФормаВладелец   - УправляемаяФорма - главная форма
//  МодульТранспорт - УправляемаяФорма - модуль транспорта
//
&НаКлиенте
Процедура Инициализация(ФормаВладелец, ФормаТранспорт) Экспорт

	Владелец = ФормаВладелец;
	МодульТранспорт = ФормаТранспорт;
	ИДДиалога = "";
	ПоследнийИДСообщения = "";
	ТекущийНавык = "";
	ПоследнийСтатус = "серый";

КонецПроцедуры

// Отправляет вопрос к 1С:Напарник через HTML/JS fetch.
// Результат придёт асинхронно через callback в ПриНажатии.
// Если диалог уже существует — продолжает его (передаёт parent_uuid).
//
// Параметры:
//  Токен            - Строка - токен авторизации Напарника (ONEC_AI_TOKEN)
//  Вопрос           - Строка - текст вопроса или код
//  ИДЗапроса        - Строка - request_id для tool_result
//  Навык            - Строка - skill_name: "custom", "explain", "review", "modify"
//  Режим            - Строка - "standard" или "direct"
//  ПрямойИнструмент - Строка - имя инструмента для direct mode
//
&НаКлиенте
Процедура ЗадатьВопрос(Знач Токен, Знач Вопрос, Знач ИДЗапроса, Знач Навык = "custom", Знач Режим = "standard", Знач ПрямойИнструмент = "") Экспорт

	Если НЕ ЗначениеЗаполнено(Токен) Тогда
		ОтправитьОшибку(ИДЗапроса, "Токен 1С:Напарник не настроен");
		Возврат;
	КонецЕсли;

	Если НЕ ЗначениеЗаполнено(Вопрос) Тогда
		ОтправитьОшибку(ИДЗапроса, "Не указан вопрос");
		Возврат;
	КонецЕсли;

	// Сохраняем ИД запроса для callback
	ЭтотОбъект.ИДЗапроса = ИДЗапроса;

	ТекущийНавык = Навык;

	// Загружаем HTML с JS-кодом для fetch к API Напарника
	Владелец.Интеграция1СНапарник = СобратьHTML(Токен, Вопрос, ИДДиалога, ПоследнийИДСообщения, Навык, Режим, ПрямойИнструмент);

КонецПроцедуры

// Сбрасывает диалог — следующий вопрос начнёт новую conversation.
//
&НаКлиенте
Процедура СброситьДиалог() Экспорт
	ИДДиалога = "";
	ПоследнийИДСообщения = "";
КонецПроцедуры

// Устанавливает индикатор состояния Напарника (цветной кружок в HTML-поле).
//
// Параметры:
//  Цвет - Строка - "серый", "красный", "зелёный"
//
&НаКлиенте
Процедура УстановитьИндикатор(Знач Цвет) Экспорт

	ПоследнийСтатус = Цвет;

	Если Цвет = "серый" Тогда
		КодЦвета = "#999";
		Подсказка = "1С:Напарник — токен не настроен";
	ИначеЕсли Цвет = "красный" Тогда
		КодЦвета = "#e53935";
		Подсказка = "1С:Напарник — нет связи или неверный токен";
	ИначеЕсли Цвет = "зелёный" Тогда
		КодЦвета = "#43a047";
		Подсказка = "1С:Напарник — подключён";
	Иначе
		КодЦвета = "#999";
		Подсказка = "1С:Напарник";
	КонецЕсли;

	Владелец.Интеграция1СНапарник = "<!DOCTYPE html>
	|<html><head><meta charset=""utf-8"">
	|<style>body{margin:0;display:flex;align-items:center;justify-content:center;height:100%;}
	|.dot{width:10px;height:10px;border-radius:50%;background:" + КодЦвета + ";cursor:pointer;}</style>
	|</head><body><div class=""dot"" title=""" + Подсказка + """ onclick=""var a=document.createElement('a');a.href='v8:naparnik/settings/open';document.body.appendChild(a);a.click();""></div></body></html>";

КонецПроцедуры

// Проверяет доступность API Напарника и устанавливает индикатор.
// Без токена — серый, с токеном — проверяет GET /chat_api/v1/skills/.
// Результат придёт асинхронно через callback в ПриНажатии.
//
// Параметры:
//  Токен - Строка - токен авторизации Напарника
//
&НаКлиенте
Процедура ПроверитьДоступность(Знач Токен) Экспорт

	Если НЕ ЗначениеЗаполнено(Токен) Тогда
		УстановитьИндикатор("серый");
		Возврат;
	КонецЕсли;

	ТокенJS = СтрЗаменить(Токен, "\", "\\");
	ТокенJS = СтрЗаменить(ТокенJS, """", "\""");

	Владелец.Интеграция1СНапарник = "<!DOCTYPE html>
	|<html><head><meta charset=""utf-8""></head>
	|<body><script>
	|(async function() {
	|  var TOKEN = """ + ТокенJS + """;
	|  try {
	|    var res = await fetch('https://code.1c.ai/chat_api/v1/conversations/', {
	|      method: 'POST',
	|      headers: {
	|        'Content-Type': 'application/json; charset=utf-8',
	|        'Authorization': TOKEN,
	|        'Origin': 'https://code.1c.ai',
	|        'Referer': 'https://code.1c.ai/chat/',
	|        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
	|      },
	|      body: JSON.stringify({ skill_name: 'custom', is_chat: true, ui_language: 'russian', programming_language: '1c' })
	|    });
	|    var a = document.createElement('a');
	|    a.href = 'v8:naparnik/status/' + (res.ok ? 'ok' : 'error');
	|    document.body.appendChild(a);
	|    a.click();
	|  } catch(e) {
	|    var a = document.createElement('a');
	|    a.href = 'v8:naparnik/status/error';
	|    document.body.appendChild(a);
	|    a.click();
	|  }
	|})();
	|</script></body></html>";

КонецПроцедуры

#КонецОбласти

#Область ОбработчикиСобытийФормы

&НаСервере
Процедура ПриСозданииНаСервере(Отказ, СтандартнаяОбработка)
	// Форма-модуль, не отображается
КонецПроцедуры

&НаКлиенте
Процедура ПриОткрытии(Отказ)
	// Форма-модуль, не отображается
КонецПроцедуры

#КонецОбласти

#Область ОбработчикиСобытийЭлементовФормы

&НаКлиенте
Процедура Интеграция1СНапарникПриНажатии(Элемент, ДанныеСобытия, СтандартнаяОбработка) Экспорт

	// Перехватываем callback от JS через location.href
	ВнешнийОбъект = ДанныеСобытия["Element"];
	Если ВнешнийОбъект = Неопределено Тогда
		Возврат;
	КонецЕсли;

	Попытка
		Ссылка = ВнешнийОбъект["href"];
	Исключение
		Возврат;
	КонецПопытки;

	Если Ссылка = Неопределено Тогда
		Возврат;
	КонецЕсли;

	СтандартнаяОбработка = Ложь;

	Префикс = "v8:naparnik/";
	Если НЕ СтрНачинаетсяС(Ссылка, Префикс) Тогда
		Возврат;
	КонецЕсли;

	Данные = Сред(Ссылка, СтрДлина(Префикс) + 1);
	РазделительПозиция = СтрНайти(Данные, "/");

	Если РазделительПозиция = 0 Тогда
		Возврат;
	КонецЕсли;

	Команда = Лев(Данные, РазделительПозиция - 1);
	Содержимое = Сред(Данные, РазделительПозиция + 1);

	Если Команда = "settings" Тогда
		ОткрытьФорму("ВнешняяОбработка.ЛираЧат.Форма.Настройки", , Владелец);
		Возврат;

	ИначеЕсли Команда = "status" Тогда
		Если Содержимое = "ok" Тогда
			УстановитьИндикатор("зелёный");
		Иначе
			УстановитьИндикатор("красный");
		КонецЕсли;
		Возврат;

	ИначеЕсли Команда = "result" Тогда
		// Формат: conv_id|msg_uuid|текст_ответа (без URL-кодирования)
		// Разбираем: conv_id|msg_uuid|ответ
		Части = СтрРазделить(Содержимое, "|");
		Если Части.Количество() >= 3 Тогда
			НовыйИДДиалога = Части[0];
			НовыйИДСообщения = Части[1];
			ТекстОтвета = "";
			// Ответ может содержать "|" — склеиваем остальные части
			Для Индекс = 2 По Части.ВГраница() Цикл
				Если Индекс > 2 Тогда
					ТекстОтвета = ТекстОтвета + "|";
				КонецЕсли;
				ТекстОтвета = ТекстОтвета + Части[Индекс];
			КонецЦикла;

			// Сохраняем для продолжения диалога
			Если ЗначениеЗаполнено(НовыйИДДиалога) Тогда
				ИДДиалога = НовыйИДДиалога;
			КонецЕсли;
			Если ЗначениеЗаполнено(НовыйИДСообщения) Тогда
				ПоследнийИДСообщения = НовыйИДСообщения;
			КонецЕсли;
		Иначе
			ТекстОтвета = Содержимое;
		КонецЕсли;

		ОтправитьРезультат(ЭтотОбъект.ИДЗапроса, ТекстОтвета);
		УстановитьИндикатор(ПоследнийСтатус);

	ИначеЕсли Команда = "error" Тогда
		ТекстОшибки = Содержимое;
		// При ошибке сбрасываем диалог — следующий начнёт заново
		СброситьДиалог();
		ОтправитьОшибку(ЭтотОбъект.ИДЗапроса, ТекстОшибки);
		УстановитьИндикатор(ПоследнийСтатус);

	КонецЕсли;

КонецПроцедуры

#КонецОбласти

#Область СлужебныеПроцедуры

// Отправляет tool_result (успех) через Транспорт.
&НаКлиенте
Процедура ОтправитьРезультат(ИДЗапроса, ТекстОтвета)

	Если НЕ ЗначениеЗаполнено(ИДЗапроса) Тогда
		Возврат;
	КонецЕсли;

	Ответ = Новый Структура;
	Ответ.Вставить("type", "tool_result");
	Ответ.Вставить("request_id", ИДЗапроса);
	Ответ.Вставить("result", ТекстОтвета);
	МодульТранспорт.ОтправитьСообщение(Ответ);

	ЭтотОбъект.ИДЗапроса = "";

КонецПроцедуры

// Отправляет tool_result (ошибка) через Транспорт.
&НаКлиенте
Процедура ОтправитьОшибку(ИДЗапроса, ТекстОшибки)

	Если НЕ ЗначениеЗаполнено(ИДЗапроса) Тогда
		Возврат;
	КонецЕсли;

	Ответ = Новый Структура;
	Ответ.Вставить("type", "tool_result");
	Ответ.Вставить("request_id", ИДЗапроса);
	Ответ.Вставить("error", ТекстОшибки);
	МодульТранспорт.ОтправитьСообщение(Ответ);

	ЭтотОбъект.ИДЗапроса = "";

КонецПроцедуры

// Собирает HTML-страницу с JS-кодом для запроса к API Напарника.
// Если conv_id пустой — создаёт новую conversation.
// Если заполнен — продолжает существующую (передаёт parent_uuid).
// JS возвращает conv_id|msg_uuid|текст через callback.
&НаКлиенте
Функция СобратьHTML(Знач Токен, Знач Вопрос, Знач ТекущийИДДиалога, Знач ТекущийИДСообщения, Знач Навык = "custom", Знач Режим = "standard", Знач ПрямойИнструмент = "")

	// Экранируем для вставки в JS-строку
	ВопросJS = СтрЗаменить(Вопрос, "\", "\\");
	ВопросJS = СтрЗаменить(ВопросJS, """", "\""");
	ВопросJS = СтрЗаменить(ВопросJS, Символы.ПС, "\n");
	ВопросJS = СтрЗаменить(ВопросJS, Символы.ВК, "");

	ТокенJS = СтрЗаменить(Токен, "\", "\\");
	ТокенJS = СтрЗаменить(ТокенJS, """", "\""");

	// conv_id для продолжения диалога (пустая строка = создать новый)
	ИДДиалогаJS = ?(ЗначениеЗаполнено(ТекущийИДДиалога), ТекущийИДДиалога, "");
	ИДСообщенияJS = ?(ЗначениеЗаполнено(ТекущийИДСообщения), ТекущийИДСообщения, "");
	НавыкJS = ?(ЗначениеЗаполнено(Навык), Навык, "custom");
	РежимJS = ?(ЗначениеЗаполнено(Режим), Режим, "standard");
	ПрямойИнструментJS = ?(ЗначениеЗаполнено(ПрямойИнструмент), ПрямойИнструмент, "");

	HTML = "<!DOCTYPE html>
	|<html><head><meta charset=""utf-8""></head>
	|<body><script>
	|(async function() {
	|  console.log('[NAPARNIK] JS started');
	|  var BASE = 'https://code.1c.ai';
	|  var TOKEN = """ + ТокенJS + """;
	|  var QUESTION = """ + ВопросJS + """;
	|  var CONV_ID = '" + ИДДиалогаJS + "';
	|  var PARENT_UUID = '" + ИДСообщенияJS + "';
	|  var SKILL = '" + НавыкJS + "';
	|  var MODE = '" + РежимJS + "';
	|  var DIRECT_TOOL = '" + ПрямойИнструментJS + "';
	|
	|  var headers = {
	|    'Content-Type': 'application/json; charset=utf-8',
	|    'Authorization': TOKEN,
	|    'Origin': 'https://code.1c.ai',
	|    'Referer': 'https://code.1c.ai/chat/',
	|    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
	|  };
	|
	|  function callback(type, data) {
	|    var a = document.createElement('a');
	|    a.href = 'v8:naparnik/' + type + '/' + data;
	|    document.body.appendChild(a);
	|    a.click();
	|  }
	|
	|  try {
	|    console.log('[NAPARNIK] Starting fetch, CONV_ID=' + CONV_ID);
	|    // 1. Создать conversation если нет существующей
	|    if (!CONV_ID) {
	|      var convRes = await fetch(BASE + '/chat_api/v1/conversations/', {
	|        method: 'POST',
	|        headers: Object.assign({}, headers, { 'Session-Id': '' }),
	|        body: JSON.stringify({ skill_name: 'custom', is_chat: true, ui_language: 'russian', programming_language: '1c' })
	|      });
	|      if (!convRes.ok) {
	|        callback('error', 'Ошибка создания сессии Напарника: HTTP ' + convRes.status);
	|        return;
	|      }
	|      var conv = await convRes.json();
	|      CONV_ID = conv.uuid;
	|      console.log('[NAPARNIK] Conv created: ' + CONV_ID);
	|    }
	|
	|    // Функция парсинга SSE-ответа
	|    function parseSSE(text) {
	|      var r = { chunks: [], msgUuid: '', fullText: '', toolCalls: [] };
	|      var lines = text.split('\n');
	|      for (var i = 0; i < lines.length; i++) {
	|        var line = lines[i].trim();
	|        if (line.indexOf('data:') !== 0) continue;
	|        var dataStr = line.substring(5).trim();
	|        if (dataStr === '[DONE]') break;
	|        try {
	|          var d = JSON.parse(dataStr);
	|          if (d.uuid && d.role === 'assistant') {
	|            r.msgUuid = d.uuid;
	|            // tool_calls из финального чанка (finished + role=assistant)
	|            if (d.finished && d.content && d.content.tool_calls && d.content.tool_calls.length > 0) {
	|              r.toolCalls = d.content.tool_calls;
	|            }
	|          }
	|          if (d.content && typeof d.content === 'object' && d.content.content != null && d.content.content !== '') {
	|            r.fullText = d.content.content;
	|          }
	|          if (d.content_delta && d.content_delta.content != null && d.content_delta.content !== '') {
	|            r.chunks.push(d.content_delta.content);
	|          }
	|        } catch(e) {}
	|      }
	|      r.text = r.fullText || r.chunks.join('');
	|      return r;
	|    }
	|
	|    // 2. Отправить вопрос и обработать tool_calls (цикл как в 1c-buddy)
	|    var msgUrl = BASE + '/chat_api/v1/conversations/' + CONV_ID + '/messages';
	|    var instruction = QUESTION;
	|    if (MODE === 'direct' && DIRECT_TOOL) {
	|      instruction = 'Нужно вернуть ровно один tool call для ' + DIRECT_TOOL + '. Входные данные: ' + QUESTION;
	|    } else if (SKILL === 'review') {
	|      instruction = 'Проведи code review следующего кода 1С. Укажи ошибки, проблемы производительности, нарушения best practices:\n\n' + QUESTION;
	|    } else if (SKILL === 'explain') {
	|      instruction = 'Объясни следующий код 1С. Что он делает, как работает, какие объекты и методы использует:\n\n' + QUESTION;
	|    } else if (SKILL === 'modify') {
	|      instruction = 'Выполни рефакторинг следующего кода 1С. Улучши читаемость, производительность, соответствие best practices. Верни улучшенный код с комментариями к изменениям:\n\n' + QUESTION;
	|    }
	|    var payload = {
	|      role: 'user',
	|      content: { content: { instruction: instruction }, tools: [] },
	|      parent_uuid: PARENT_UUID || null
	|    };
	|    var result = '';
	|    var msgUuid = '';
	|    var MAX_ROUNDS = 15;
	|
	|    for (var round = 0; round < MAX_ROUNDS; round++) {
	|      var msgRes = await fetch(msgUrl, {
	|        method: 'POST',
	|        headers: Object.assign({}, headers, { 'Accept': 'text/event-stream' }),
	|        body: JSON.stringify(payload)
	|      });
	|      if (!msgRes.ok) {
	|        callback('error', 'Ошибка отправки вопроса Напарнику: HTTP ' + msgRes.status);
	|        return;
	|      }
	|
	|      var text = await msgRes.text();
	|      var sse = parseSSE(text);
	|      msgUuid = sse.msgUuid || msgUuid;
	|      if (sse.text) {
	|        result = sse.text;
	|      }
	|
	|      if (sse.toolCalls.length === 0) {
	|        break;
	|      }
	|
	|      // Есть tool_calls — отправляем role=tool с результатами (проброс как в 1c-buddy)
	|      console.log('[NAPARNIK] tool_calls: ' + sse.toolCalls.map(function(tc) { return (tc.function||{}).name; }).join(', '));
	|      var toolContent = sse.toolCalls.map(function(tc) {
	|        return {
	|          content: JSON.stringify({ id: tc.id, type: tc.type || 'function', function: tc.function }),
	|          name: (tc.function || {}).name || '',
	|          tool_call_id: tc.id
	|        };
	|      });
	|      payload = {
	|        role: 'tool',
	|        content: toolContent,
	|        parent_uuid: msgUuid
	|      };
	|    }
	|
	|    // Убрать thinking-теги
	|    result = result.replace(/<\/?thinking>/g, '').replace(/<\/?think>/g, '').trim();
	|
	|    if (!result) {
	|      callback('error', 'Напарник вернул пустой ответ');
	|      return;
	|    }
	|
	|    // Возвращаем conv_id|msg_uuid|текст — BSL сохранит для продолжения диалога
	|    callback('result', CONV_ID + '|' + (msgUuid || '') + '|' + result);
	|
	|  } catch(e) {
	|    console.log('[NAPARNIK] ERROR: ' + e.message);
	|    callback('error', 'Ошибка запроса к Напарнику: ' + e.message);
	|  }
	|})();
	|</script></body></html>";

	Возврат HTML;

КонецФункции

#КонецОбласти
