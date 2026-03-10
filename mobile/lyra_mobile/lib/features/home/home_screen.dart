import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../core/storage/secure_storage.dart';
import '../../models/session_info.dart';

class HomeScreen extends ConsumerWidget {
  const HomeScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final sessionsAsync = ref.watch(_sessionsProvider);

    return Scaffold(
      appBar: AppBar(
        title: const Text('Лира'),
        actions: [
          IconButton(
            icon: const Icon(Icons.logout),
            onPressed: () async {
              final confirmed = await showDialog<bool>(
                context: context,
                builder: (ctx) => AlertDialog(
                  title: const Text('Выйти?'),
                  content: const Text(
                    'Данные авторизации будут удалены. '
                    'Потребуется повторная регистрация.',
                  ),
                  actions: [
                    TextButton(
                      onPressed: () => Navigator.pop(ctx, false),
                      child: const Text('Отмена'),
                    ),
                    TextButton(
                      onPressed: () => Navigator.pop(ctx, true),
                      child: const Text('Выйти'),
                    ),
                  ],
                ),
              );
              if (confirmed == true) {
                await ref.read(secureStorageProvider).clearAll();
                if (context.mounted) {
                  context.go('/registration');
                }
              }
            },
          ),
        ],
      ),
      body: Padding(
        padding: const EdgeInsets.all(16.0),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            // Кнопка сканирования QR
            SizedBox(
              height: 120,
              child: FilledButton.icon(
                onPressed: () => context.go('/scanner'),
                icon: const Icon(Icons.qr_code_scanner, size: 40),
                label: const Text(
                  'Сканировать QR',
                  style: TextStyle(fontSize: 20),
                ),
              ),
            ),
            const SizedBox(height: 24),

            // Список активных сессий
            const Text(
              'Активные сессии',
              style: TextStyle(fontSize: 18, fontWeight: FontWeight.bold),
            ),
            const SizedBox(height: 8),
            Expanded(
              child: sessionsAsync.when(
                data: (sessions) {
                  if (sessions.isEmpty) {
                    return const Center(
                      child: Text(
                        'Нет активных сессий.\n'
                        'Отсканируйте QR-код в 1С для подключения.',
                        textAlign: TextAlign.center,
                        style: TextStyle(color: Colors.grey),
                      ),
                    );
                  }
                  return ListView.builder(
                    itemCount: sessions.length,
                    itemBuilder: (context, index) {
                      final session = sessions[index];
                      return _SessionCard(session: session);
                    },
                  );
                },
                loading: () =>
                    const Center(child: CircularProgressIndicator()),
                error: (error, _) => Center(
                  child: Text('Ошибка: $error'),
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _SessionCard extends StatelessWidget {
  final SessionInfo session;

  const _SessionCard({required this.session});

  @override
  Widget build(BuildContext context) {
    final iconData = _statusIcon(session.status);
    final iconColor = _statusColor(session.status);
    final statusText = _statusText(session.status);

    return Card(
      child: ListTile(
        leading: Icon(iconData, color: iconColor),
        title: Text(session.baseName ?? 'Сессия ${session.sessionId.substring(0, 8)}...'),
        subtitle: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              '${session.balance.toStringAsFixed(2)} ${session.currency}',
            ),
            if (statusText != null)
              Text(
                statusText,
                style: TextStyle(color: iconColor, fontSize: 12),
              ),
          ],
        ),
        trailing: const Icon(Icons.chevron_right),
        onTap: () => context.go('/session/${session.sessionId}'),
      ),
    );
  }

  IconData _statusIcon(String status) {
    return switch (status) {
      'active' || 'ok' || 'connected' => Icons.cloud_done,
      'insufficient_balance' => Icons.warning_amber_rounded,
      'disconnected' => Icons.cloud_off,
      _ => Icons.cloud_off,
    };
  }

  Color _statusColor(String status) {
    return switch (status) {
      'active' || 'ok' || 'connected' => Colors.green,
      'insufficient_balance' => Colors.orange,
      'disconnected' => Colors.grey,
      _ => Colors.grey,
    };
  }

  String? _statusText(String status) {
    return switch (status) {
      'insufficient_balance' => 'Пополните баланс',
      'disconnected' => 'Чат отключён',
      _ => null,
    };
  }
}

final _sessionsProvider = FutureProvider<List<SessionInfo>>((ref) async {
  final storage = ref.watch(secureStorageProvider);
  return storage.getSessions();
});
