import 'package:flutter_riverpod/flutter_riverpod.dart';

import 'storage/secure_storage.dart';

/// Единый источник баланса пользователя.
/// Обновляется из scanner (auth_ack), session (balance_update) и любых
/// других источников. Синхронизируется с SecureStorage.
class BalanceNotifier extends StateNotifier<double> {
  final SecureStorage _storage;

  BalanceNotifier(this._storage) : super(0) {
    _load();
  }

  Future<void> _load() async {
    state = await _storage.getBalance();
  }

  void update(double balance) {
    state = balance;
    _storage.saveBalance(balance);
  }
}

final balanceProvider = StateNotifierProvider<BalanceNotifier, double>((ref) {
  final storage = ref.watch(secureStorageProvider);
  return BalanceNotifier(storage);
});
