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

  final _messagesController =
      StreamController<IncomingMessage>.broadcast();
  final _connectionStateController =
      StreamController<CentrifugoConnectionState>.broadcast();
  final _serverSubscriptionsController =
      StreamController<String>.broadcast();

  Stream<IncomingMessage> get messages => _messagesController.stream;
  Stream<CentrifugoConnectionState> get connectionState =>
      _connectionStateController.stream;
  Stream<String> get serverSubscriptions =>
      _serverSubscriptionsController.stream;

  CentrifugoConnectionState _currentState =
      CentrifugoConnectionState.disconnected;
  CentrifugoConnectionState get currentState => _currentState;

  /// Client ID текущего соединения (от Centrifugo, доступен после connect).
  String? _clientId;
  String? get clientId => _clientId;

  /// Подключение к mobile:lobby с общим JWT.
  /// Throws [StateError] если JWT не настроен.
  /// Throws [TimeoutException] если не удалось подключиться за 10 секунд.
  Future<void> connectToLobby() async {
    await disconnect();

    const jwt = CentrifugoConfig.mobileLobbyJwt;
    if (jwt.isEmpty) {
      throw StateError(
        'mobileLobbyJwt не настроен — подключение к lobby невозможно',
      );
    }

    final wsUrl = await CentrifugoConfig.getWsUrl();
    _client = centrifuge.createClient(
      wsUrl,
      centrifuge.ClientConfig(
        token: jwt,
      ),
    );

    _setupClientHandlers();

    _updateState(CentrifugoConnectionState.connecting);
    _client!.connect();

    // Ждём подключения с таймаутом
    try {
      await connectionState
          .firstWhere((s) => s == CentrifugoConnectionState.connected)
          .timeout(const Duration(seconds: 15));
    } on TimeoutException {
      await disconnect();
      throw TimeoutException(
        'Не удалось подключиться к серверу. Проверьте сеть.',
      );
    }
  }

  /// Подключение к user:<userId> с персональным user_jwt.
  Future<void> connectToUserChannel(String userJwt) async {
    await disconnect();

    final wsUrl = await CentrifugoConfig.getWsUrl();
    _client = centrifuge.createClient(
      wsUrl,
      centrifuge.ClientConfig(token: userJwt),
    );

    _setupClientHandlers();

    _updateState(CentrifugoConnectionState.connecting);
    _client!.connect();

    try {
      await connectionState
          .firstWhere((s) => s == CentrifugoConnectionState.connected)
          .timeout(const Duration(seconds: 15));
    } on TimeoutException {
      await disconnect();
      throw TimeoutException(
        'Не удалось подключиться к каналу пользователя.',
      );
    }
  }

  /// Подключение с персональным JWT (авто-подписка через channels claim).
  /// Throws [TimeoutException] если не удалось подключиться за 15 секунд.
  Future<void> connectToSession(String mobileJwt) async {
    await disconnect();

    final wsUrl = await CentrifugoConfig.getWsUrl();
    _client = centrifuge.createClient(
      wsUrl,
      centrifuge.ClientConfig(
        token: mobileJwt,
      ),
    );

    _setupClientHandlers();

    _updateState(CentrifugoConnectionState.connecting);
    _client!.connect();

    try {
      await connectionState
          .firstWhere((s) => s == CentrifugoConnectionState.connected)
          .timeout(const Duration(seconds: 15));
    } on TimeoutException {
      await disconnect();
      throw TimeoutException(
        'Не удалось подключиться к серверу. Проверьте сеть.',
      );
    }
  }

  /// Публикация JSON в канал.
  /// Использует client.publish() — не требует подписки на канал.
  Future<void> publish(String channel, OutgoingMessage message) async {
    if (_client == null) {
      throw StateError('Нет подключения для publish');
    }

    final data = utf8.encode(jsonEncode(message.toJson()));
    await _client!.publish(channel, data);
  }

  /// Отключение.
  Future<void> disconnect() async {
    _client?.disconnect();
    _client = null;
    _updateState(CentrifugoConnectionState.disconnected);
  }

  void _setupClientHandlers() {
    final client = _client!;

    client.connected.listen((event) {
      _clientId = event.client;
      _updateState(CentrifugoConnectionState.connected);
    });

    client.disconnected.listen((event) {
      _updateState(CentrifugoConnectionState.disconnected);
    });

    client.connecting.listen((event) {
      _updateState(CentrifugoConnectionState.connecting);
    });

    client.error.listen((event) {});

    // Server-side subscriptions (авто-подписка через channels claim + Server API subscribe)
    client.publication.listen((event) {
      _handlePublication(event.data);
    });

    // Server-side subscription events (bootstrap-канал от роутера)
    client.subscribed.listen((event) {
      _serverSubscriptionsController.add(event.channel);
      if (event.data.isNotEmpty) {
        _handlePublication(event.data);
      }
    });
  }

  void _handlePublication(List<int> data) {
    final jsonStr = utf8.decode(data);
    try {
      // centrifuge-dart отдаёт data одной publication — парсим целиком
      final json = jsonDecode(jsonStr) as Map<String, dynamic>;
      final message = IncomingMessage.fromJson(json);
      _messagesController.add(message);
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
    _serverSubscriptionsController.close();
  }
}

/// Account client: user:<userId> канал для account-операций (profile, sessions, email).
/// Живёт всё время работы приложения.
final accountClientProvider = Provider<CentrifugoClient>((ref) {
  final client = CentrifugoClient();
  ref.onDispose(() => client.dispose());
  return client;
});

/// Session client: room:<sessionId> канал для активной сессии.
/// Создаётся при сканировании QR, может быть null.
final sessionClientProvider = StateProvider<CentrifugoClient?>((ref) => null);

// Legacy alias — убрать после полной миграции
final centrifugoClientProvider = accountClientProvider;
