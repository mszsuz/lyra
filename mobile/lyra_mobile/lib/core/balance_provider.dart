import 'dart:async';

import 'package:flutter_riverpod/flutter_riverpod.dart';

import 'centrifugo/centrifugo_client.dart';
import 'centrifugo/message_types.dart';
import 'storage/secure_storage.dart';

/// Единый источник баланса пользователя.
/// Глобально слушает поток сообщений Centrifugo — обновляет баланс
/// независимо от текущего экрана (home, session, scanner).
class BalanceNotifier extends StateNotifier<double> {
  final SecureStorage _storage;
  StreamSubscription<IncomingMessage>? _messageSub;

  BalanceNotifier(this._storage, Stream<IncomingMessage> messages) : super(0) {
    _load();
    _messageSub = messages.listen(_onMessage);
  }

  Future<void> _load() async {
    state = await _storage.getBalance();
  }

  void _onMessage(IncomingMessage message) {
    if (message is BalanceUpdateMessage) {
      update(message.balance);
    } else if (message is AuthAckMessage && message.balance != null) {
      update(message.balance!);
    }
  }

  void update(double balance) {
    state = balance;
    _storage.saveBalance(balance);
  }

  @override
  void dispose() {
    _messageSub?.cancel();
    super.dispose();
  }
}

final balanceProvider = StateNotifierProvider<BalanceNotifier, double>((ref) {
  final storage = ref.watch(secureStorageProvider);
  final centrifugo = ref.watch(centrifugoClientProvider);
  return BalanceNotifier(storage, centrifugo.messages);
});
