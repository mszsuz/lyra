import 'dart:async';
import 'dart:convert';

import 'package:centrifuge/centrifuge.dart' as centrifuge;
import 'package:flutter_riverpod/flutter_riverpod.dart';

import 'centrifugo_config.dart';
import 'message_types.dart';

enum CentrifugoConnectionState {
  disconnected,
  connecting,
  connected,
}

class CentrifugoClient {
  centrifuge.Client? _client;
  centrifuge.ClientSubscription? _subscription;

  final _messagesController =
      StreamController<IncomingMessage>.broadcast();
  final _connectionStateController =
      StreamController<CentrifugoConnectionState>.broadcast();

  Stream<IncomingMessage> get messages => _messagesController.stream;
  Stream<CentrifugoConnectionState> get connectionState =>
      _connectionStateController.stream;

  CentrifugoConnectionState _currentState =
      CentrifugoConnectionState.disconnected;
  CentrifugoConnectionState get currentState => _currentState;

  /// Подключение к mobile:lobby с общим JWT.
  Future<void> connectToLobby() async {
    await disconnect();

    final jwt = CentrifugoConfig.mobileLobbyJwt;
    if (jwt.isEmpty) {
      print('[CentrifugoClient] mobileLobbyJwt пуст — подключение невозможно');
      return;
    }

    _client = centrifuge.createClient(
      CentrifugoConfig.wsUrl,
      centrifuge.ClientConfig(
        token: jwt,
      ),
    );

    _setupClientHandlers();

    _updateState(CentrifugoConnectionState.connecting);
    _client!.connect();

    // Подписка на mobile:lobby
    _subscription = _client!.newSubscription('mobile:lobby');
    _setupSubscriptionHandlers(_subscription!);
    _subscription!.subscribe();
  }

  /// Подключение с персональным JWT (авто-подписка через channels claim).
  Future<void> connectToSession(String mobileJwt) async {
    await disconnect();

    _client = centrifuge.createClient(
      CentrifugoConfig.wsUrl,
      centrifuge.ClientConfig(
        token: mobileJwt,
      ),
    );

    _setupClientHandlers();

    _updateState(CentrifugoConnectionState.connecting);
    _client!.connect();

    // Авто-подписка через channels claim в JWT — подписка не нужна.
    // Сообщения приходят через server-side subscriptions.
  }

  /// Публикация JSON в канал.
  Future<void> publish(String channel, OutgoingMessage message) async {
    if (_client == null) {
      print('[CentrifugoClient] Нет подключения для publish');
      return;
    }

    final data = utf8.encode(jsonEncode(message.toJson()));

    // Если есть подписка на этот канал — публикуем через неё
    if (_subscription != null) {
      await _subscription!.publish(data);
    } else {
      // Для server-side subscription публикуем через клиент
      // centrifuge-dart не поддерживает publish без подписки —
      // используем подписку
      final sub = _client!.newSubscription(channel);
      _setupSubscriptionHandlers(sub);
      sub.subscribe();
      await sub.publish(data);
      _subscription = sub;
    }
  }

  /// Отключение.
  Future<void> disconnect() async {
    _subscription?.unsubscribe();
    _subscription = null;
    _client?.disconnect();
    _client = null;
    _updateState(CentrifugoConnectionState.disconnected);
  }

  void _setupClientHandlers() {
    final client = _client!;

    client.connected.listen((event) {
      print('[CentrifugoClient] Connected: ${event.client}');
      _updateState(CentrifugoConnectionState.connected);
    });

    client.disconnected.listen((event) {
      print('[CentrifugoClient] Disconnected: ${event.reason}');
      _updateState(CentrifugoConnectionState.disconnected);
    });

    client.connecting.listen((event) {
      print('[CentrifugoClient] Connecting: ${event.reason}');
      _updateState(CentrifugoConnectionState.connecting);
    });

    client.error.listen((event) {
      print('[CentrifugoClient] Error: ${event.error}');
    });

    // Server-side subscriptions (авто-подписка через channels claim)
    client.publication.listen((event) {
      _handlePublication(event.data);
    });
  }

  void _setupSubscriptionHandlers(centrifuge.ClientSubscription sub) {
    sub.publication.listen((event) {
      _handlePublication(event.data);
    });

    sub.subscribed.listen((event) {
      print('[CentrifugoClient] Subscribed to channel');
    });

    sub.error.listen((event) {
      print('[CentrifugoClient] Subscription error: ${event.error}');
    });
  }

  void _handlePublication(List<int> data) {
    try {
      final jsonStr = utf8.decode(data);
      // Centrifugo может слать несколько JSON в одном фрейме через \n
      for (final line in jsonStr.split('\n')) {
        if (line.trim().isEmpty) continue;
        final json = jsonDecode(line) as Map<String, dynamic>;
        final message = IncomingMessage.fromJson(json);
        _messagesController.add(message);
      }
    } catch (e) {
      print('[CentrifugoClient] Ошибка парсинга: $e');
    }
  }

  void _updateState(CentrifugoConnectionState state) {
    _currentState = state;
    _connectionStateController.add(state);
  }

  void dispose() {
    disconnect();
    _messagesController.close();
    _connectionStateController.close();
  }
}

final centrifugoClientProvider = Provider<CentrifugoClient>((ref) {
  final client = CentrifugoClient();
  ref.onDispose(() => client.dispose());
  return client;
});
