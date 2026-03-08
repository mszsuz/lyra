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
    return Card(
      child: ListTile(
        leading: Icon(
          session.status == 'connected' || session.status == 'ok'
              ? Icons.cloud_done
              : Icons.cloud_off,
          color: session.status == 'connected' || session.status == 'ok'
              ? Colors.green
              : Colors.grey,
        ),
        title: Text(session.baseName ?? 'Сессия ${session.sessionId.substring(0, 8)}...'),
        subtitle: Text(
          '${session.balance.toStringAsFixed(2)} ${session.currency}',
        ),
        trailing: const Icon(Icons.chevron_right),
        onTap: () => context.go('/session/${session.sessionId}'),
      ),
    );
  }
}

final _sessionsProvider = FutureProvider<List<SessionInfo>>((ref) async {
  final storage = ref.watch(secureStorageProvider);
  return storage.getSessions();
});
