import 'dart:async';

import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/centrifugo/centrifugo_client.dart';
import '../../core/centrifugo/message_types.dart';
import '../../core/storage/secure_storage.dart';
import '../../models/session_info.dart';

class SessionNotifier extends StateNotifier<SessionInfo?> {
  final CentrifugoClient _centrifugo;
  final SecureStorage _storage;
  final String sessionId;
  StreamSubscription<IncomingMessage>? _messagesSub;

  SessionNotifier(this._centrifugo, this._storage, this.sessionId)
      : super(null) {
    _init();
  }

  Future<void> _init() async {
    // Загружаем сессию из хранилища
    final sessions = await _storage.getSessions();
    final session = sessions.where((s) => s.sessionId == sessionId).firstOrNull;
    if (session != null) {
      state = session;
      // Подключаемся к каналу сессии
      if (session.mobileJwt != null && session.mobileJwt!.isNotEmpty) {
        await _centrifugo.connectToSession(session.mobileJwt!);
        _messagesSub = _centrifugo.messages.listen(_onMessage);
      }
    }
  }

  void _onMessage(IncomingMessage message) {
    if (state == null) return;

    switch (message) {
      case BalanceUpdateMessage(
          :final sessionId,
          :final balance,
          :final currency,
        ):
        if (sessionId == this.sessionId) {
          final updated = state!.copyWith(
            balance: balance,
            currency: currency,
          );
          state = updated;
          _storage.saveSession(updated);
          _storage.saveBalance(balance);
        }

      case AuthAckMessage(:final sessionId, :final status):
        if (sessionId == this.sessionId) {
          state = state!.copyWith(status: status);
          _storage.saveSession(state!);
        }

      default:
        break;
    }
  }

  Future<void> sendVoiceText(String text) async {
    if (state == null) return;
    await _centrifugo.publish(
      state!.channel,
      MobileMessage.text(text),
    );
  }

  Future<void> disconnect() async {
    await _centrifugo.disconnect();
    if (state != null) {
      await _storage.removeSession(state!.sessionId);
    }
    state = null;
  }

  @override
  void dispose() {
    _messagesSub?.cancel();
    super.dispose();
  }
}

final sessionProvider = StateNotifierProvider.autoDispose
    .family<SessionNotifier, SessionInfo?, String>((ref, sessionId) {
  final centrifugo = ref.watch(centrifugoClientProvider);
  final storage = ref.watch(secureStorageProvider);
  return SessionNotifier(centrifugo, storage, sessionId);
});
