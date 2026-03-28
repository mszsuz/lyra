import 'dart:async';

import 'package:flutter_riverpod/flutter_riverpod.dart';

import 'centrifugo/centrifugo_client.dart';
import 'centrifugo/message_types.dart';

/// Единый источник баланса пользователя.
/// Глобально слушает поток сообщений Centrifugo — обновляет баланс
/// независимо от текущего экрана (home, session, scanner).
/// Баланс только в памяти — при перезапуске приложения обновляется с сервера.
class BalanceNotifier extends StateNotifier<double> {
  StreamSubscription<IncomingMessage>? _messageSub;

  BalanceNotifier(Stream<IncomingMessage> messages) : super(0) {
    _messageSub = messages.listen(_onMessage);
  }

  void _onMessage(IncomingMessage message) {
    if (message is BalanceUpdateMessage) {
      state = message.balance;
    } else if (message is AuthAckMessage && message.balance != null) {
      state = message.balance!;
    } else if (message is RegisterAckMessage && message.balance != null) {
      state = message.balance!;
    } else if (message is SessionsListMessage && message.balance != null) {
      state = message.balance!;
    }
  }

  @override
  void dispose() {
    _messageSub?.cancel();
    super.dispose();
  }
}

final balanceProvider = StateNotifierProvider<BalanceNotifier, double>((ref) {
  final centrifugo = ref.watch(centrifugoClientProvider);
  return BalanceNotifier(centrifugo.messages);
});
