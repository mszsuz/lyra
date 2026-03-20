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

  Future<void> loadSessions() async {
    final userId = await _storage.getUserId();
    if (userId == null || userId.isEmpty) return;

    state = state.copyWith(loading: true, error: null);

    try {
      await _centrifugo.connectToLobby();
    } on TimeoutException {
      state = state.copyWith(loading: false, error: 'Нет связи с сервером');
      return;
    } catch (e) {
      state = state.copyWith(loading: false, error: 'Ошибка подключения');
      return;
    }

    // Listen for sessions_list response
    final completer = Completer<List<SessionInfo>>();
    _sub = _centrifugo.messages.listen((message) {
      if (message is SessionsListMessage && message.userId == userId) {
        final sessions = message.sessions
            .map((s) => SessionInfo.fromJson(s))
            .toList();
        if (!completer.isCompleted) completer.complete(sessions);
      }
    });

    // Send request
    await _centrifugo.publish(
      'mobile:lobby',
      GetSessionsMessage(userId: userId),
    );

    // Wait for response with timeout
    try {
      final sessions = await completer.future.timeout(
        const Duration(seconds: 5),
      );
      state = state.copyWith(sessions: sessions, loading: false);
    } on TimeoutException {
      state = state.copyWith(loading: false, error: 'Нет ответа от сервера');
    } finally {
      _sub?.cancel();
      _sub = null;
      await _centrifugo.disconnect();
    }
  }

  @override
  void dispose() {
    _sub?.cancel();
    super.dispose();
  }
}

final homeProvider = StateNotifierProvider<HomeNotifier, HomeState>((ref) {
  final centrifugo = ref.watch(centrifugoClientProvider);
  final storage = ref.watch(secureStorageProvider);
  return HomeNotifier(centrifugo, storage);
});
