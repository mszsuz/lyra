import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../core/centrifugo/centrifugo_client.dart';
import 'session_provider.dart';

class SessionScreen extends ConsumerWidget {
  final String sessionId;

  const SessionScreen({super.key, required this.sessionId});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final session = ref.watch(sessionProvider(sessionId));
    final connectionAsync = ref.watch(_connectionStateProvider);
    final connectionState = connectionAsync.valueOrNull ??
        CentrifugoConnectionState.disconnected;

    if (session == null) {
      return Scaffold(
        appBar: AppBar(title: const Text('Сессия')),
        body: const Center(child: CircularProgressIndicator()),
      );
    }

    return Scaffold(
      appBar: AppBar(
        title: Text(session.baseName ?? 'Сессия'),
        leading: IconButton(
          icon: const Icon(Icons.arrow_back),
          onPressed: () => context.go('/home'),
        ),
        actions: [
          IconButton(
            icon: const Icon(Icons.close),
            onPressed: () async {
              final confirmed = await showDialog<bool>(
                context: context,
                builder: (ctx) => AlertDialog(
                  title: const Text('Отключиться?'),
                  content: const Text('Сессия будет завершена.'),
                  actions: [
                    TextButton(
                      onPressed: () => Navigator.pop(ctx, false),
                      child: const Text('Отмена'),
                    ),
                    TextButton(
                      onPressed: () => Navigator.pop(ctx, true),
                      child: const Text('Отключить'),
                    ),
                  ],
                ),
              );
              if (confirmed == true) {
                ref
                    .read(sessionProvider(sessionId).notifier)
                    .disconnect();
                if (context.mounted) {
                  context.go('/home');
                }
              }
            },
          ),
        ],
      ),
      body: Padding(
        padding: const EdgeInsets.all(24.0),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            // Статус подключения
            Card(
              child: ListTile(
                leading: Icon(
                  connectionState == CentrifugoConnectionState.connected
                      ? Icons.cloud_done
                      : Icons.cloud_off,
                  color:
                      connectionState == CentrifugoConnectionState.connected
                          ? Colors.green
                          : Colors.grey,
                ),
                title: const Text('Подключение'),
                subtitle: Text(_connectionText(connectionState)),
              ),
            ),
            const SizedBox(height: 8),

            // Баланс
            Card(
              child: ListTile(
                leading: const Icon(Icons.account_balance_wallet),
                title: const Text('Баланс'),
                subtitle: Text(
                  '${session.balance.toStringAsFixed(2)} ${session.currency}',
                  style: TextStyle(
                    fontSize: 20,
                    fontWeight: FontWeight.bold,
                    color: session.balance > 0 ? Colors.green : Colors.red,
                  ),
                ),
              ),
            ),
            const SizedBox(height: 8),

            // Статус сессии
            Card(
              child: ListTile(
                leading: const Icon(Icons.info_outline),
                title: const Text('Статус'),
                subtitle: Text(_sessionStatusText(session.status)),
              ),
            ),
            const SizedBox(height: 8),

            // ID сессии
            Card(
              child: ListTile(
                leading: const Icon(Icons.tag),
                title: const Text('ID сессии'),
                subtitle: Text(
                  session.sessionId,
                  style: const TextStyle(fontSize: 12),
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }

  String _connectionText(CentrifugoConnectionState state) {
    return switch (state) {
      CentrifugoConnectionState.connected => 'Подключено',
      CentrifugoConnectionState.connecting => 'Подключение...',
      CentrifugoConnectionState.disconnected => 'Отключено',
    };
  }

  String _sessionStatusText(String status) {
    return switch (status) {
      'ok' || 'connected' => 'Активна',
      'insufficient_balance' => 'Недостаточно средств',
      'auth_failed' => 'Ошибка авторизации',
      'service_unavailable' => 'Сервис недоступен',
      _ => status,
    };
  }
}

final _connectionStateProvider =
    StreamProvider<CentrifugoConnectionState>((ref) {
  final client = ref.watch(centrifugoClientProvider);
  return client.connectionState;
});
