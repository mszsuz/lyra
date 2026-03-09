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

  Stream<IncomingMessage> get messages => _messagesController.stream;
  Stream<CentrifugoConnectionState> get connectionState =>
      _connectionStateController.stream;

  CentrifugoConnectionState _currentState =
      CentrifugoConnectionState.disconnected;
  CentrifugoConnectionState get currentState => _currentState;

  /// Подключение к mobile:lobby с общим JWT.
  /// Throws [StateError] если JWT не настроен.
  Future<void> connectToLobby() async {
    await disconnect();

    const jwt = CentrifugoConfig.mobileLobbyJwt;
    if (jwt.isEmpty) {
      throw StateError(
        'mobileLobbyJwt не настроен — подключение к lobby невозможно',
      );
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

    // Для mobile:lobby подписка не нужна (allow_subscribe_for_client: false).
    // Мобильное только публикует в lobby, ответы приходят на персональный
    // канал mobile:reg-<reg_id> через server-side subscription.
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
