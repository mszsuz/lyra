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

    final isActive = session.status == 'active' ||
        session.status == 'ok' ||
        session.status == 'connected';

    return Scaffold(
      appBar: AppBar(
        title: Text(session.baseName ?? 'Сессия'),
        leading: IconButton(
          icon: const Icon(Icons.arrow_back),
          onPressed: () => context.go('/home'),
        ),
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
                leading: Icon(
                  _sessionStatusIcon(session.status),
                  color: _sessionStatusColor(session.status),
                ),
                title: const Text('Статус'),
                subtitle: Text(_sessionStatusText(session.status)),
              ),
            ),

            const Spacer(),

            // Панель ввода: микрофон + камера
            Padding(
              padding: const EdgeInsets.only(bottom: 16.0),
              child: Row(
                mainAxisAlignment: MainAxisAlignment.center,
                children: [
                  // Кнопка микрофона
                  FloatingActionButton(
                    heroTag: 'mic',
                    onPressed: isActive
                        ? () {
                            ScaffoldMessenger.of(context).showSnackBar(
                              const SnackBar(
                                content: Text('Голосовой ввод -- в разработке'),
                              ),
                            );
                          }
                        : null,
                    backgroundColor: isActive ? null : Colors.grey.shade300,
                    child: Icon(
                      Icons.mic,
                      color: isActive ? Colors.white : Colors.grey,
                    ),
                  ),
                  const SizedBox(width: 24),
                  // Кнопка камеры
                  FloatingActionButton(
                    heroTag: 'camera',
                    onPressed: isActive
                        ? () {
                            ScaffoldMessenger.of(context).showSnackBar(
                              const SnackBar(
                                content: Text('Камера -- в разработке'),
                              ),
                            );
                          }
                        : null,
                    backgroundColor: isActive ? null : Colors.grey.shade300,
                    child: Icon(
                      Icons.camera_alt,
                      color: isActive ? Colors.white : Colors.grey,
                    ),
                  ),
                ],
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

  IconData _sessionStatusIcon(String status) {
    return switch (status) {
      'active' || 'ok' || 'connected' => Icons.check_circle,
      'insufficient_balance' => Icons.warning_amber_rounded,
      'disconnected' => Icons.cancel,
      _ => Icons.info_outline,
    };
  }

  Color _sessionStatusColor(String status) {
    return switch (status) {
      'active' || 'ok' || 'connected' => Colors.green,
      'insufficient_balance' => Colors.orange,
      'disconnected' => Colors.grey,
      _ => Colors.blue,
    };
  }

  String _sessionStatusText(String status) {
    return switch (status) {
      'active' || 'ok' || 'connected' => 'Активна',
      'insufficient_balance' => 'Пополните баланс',
      'disconnected' => 'Чат отключён',
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
