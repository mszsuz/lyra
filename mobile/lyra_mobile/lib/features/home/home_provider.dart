import 'dart:async';

import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/centrifugo/centrifugo_client.dart';
import '../../core/centrifugo/message_types.dart';
import '../../core/storage/secure_storage.dart';
import '../../models/session_info.dart';

class HomeState {
  final List<SessionInfo> sessions;
  final bool loading;
  final String? error;

  const HomeState({
    this.sessions = const [],
    this.loading = false,
    this.error,
  });

  HomeState copyWith({
    List<SessionInfo>? sessions,
    bool? loading,
    String? error,
  }) {
    return HomeState(
      sessions: sessions ?? this.sessions,
      loading: loading ?? this.loading,
      error: error,
    );
  }
}

class HomeNotifier extends StateNotifier<HomeState> {
  final CentrifugoClient _centrifugo;
  final SecureStorage _storage;
  StreamSubscription<IncomingMessage>? _sub;

  HomeNotifier(this._centrifugo, this._storage) : super(const HomeState());

  /// Загрузка сессий через user-канал (не lobby).
  /// accountClient уже подключён к user:<userId> из splash.
  Future<void> loadSessions() async {
    final userId = await _storage.getUserId();
    final deviceId = await _storage.getOrCreateDeviceId();
    if (userId == null || userId.isEmpty) return;

    state = state.copyWith(loading: true, error: null);

    // Если accountClient не подключён — подключиться через user_jwt
    if (_centrifugo.currentState != CentrifugoConnectionState.connected) {
      final userJwt = await _storage.getUserJwt();
      if (userJwt == null) {
        state = state.copyWith(loading: false, error: 'Нет авторизации');
        return;
      }
      try {
        await _centrifugo.connectToUserChannel(userJwt);
      } on TimeoutException {
        state = state.copyWith(loading: false, error: 'Нет связи с сервером');
        return;
      } catch (e) {
        state = state.copyWith(loading: false, error: 'Ошибка подключения');
        return;
      }
    }

    // Listen for sessions_list response
    final completer = Completer<List<SessionInfo>>();
    _sub = _centrifugo.messages.listen((message) {
      if (message is SessionsListMessage) {
        final sessions = message.sessions
            .map((s) => SessionInfo.fromJson(s))
            .toList();
        if (!completer.isCompleted) completer.complete(sessions);
      }
    });

    // Send request через user-канал (userId из канала, device_id в payload)
    await _centrifugo.publish(
      'user:$userId',
      GetSessionsUserMessage(deviceId: deviceId),
    );

    // Wait for response with timeout
    try {
      final sessions = await completer.future.timeout(
        const Duration(seconds: 5),
      );
      await _syncStorage(sessions);
      state = state.copyWith(sessions: sessions, loading: false);
    } on TimeoutException {
      state = state.copyWith(loading: false, error: 'Нет ответа от сервера');
    } finally {
      _sub?.cancel();
      _sub = null;
      // НЕ отключаемся — accountClient остаётся на user-канале
    }
  }

  /// Синхронизирует local storage с ответом Роутера.
  Future<void> _syncStorage(List<SessionInfo> serverSessions) async {
    final liveIds = serverSessions.map((s) => s.sessionId).toSet();
    final local = await _storage.getSessions();

    for (final s in local) {
      if (!liveIds.contains(s.sessionId)) {
        await _storage.removeSession(s.sessionId);
      }
    }

    for (final s in serverSessions) {
      await _storage.saveSession(s);
    }
  }

  @override
  void dispose() {
    _sub?.cancel();
    super.dispose();
  }
}

final homeProvider = StateNotifierProvider<HomeNotifier, HomeState>((ref) {
  final centrifugo = ref.watch(accountClientProvider);
  final storage = ref.watch(secureStorageProvider);
  return HomeNotifier(centrifugo, storage);
});
