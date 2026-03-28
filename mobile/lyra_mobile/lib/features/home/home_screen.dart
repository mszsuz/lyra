import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../app/theme.dart';
import '../../core/balance_provider.dart';
import '../../core/storage/secure_storage.dart';
import '../../models/session_info.dart';
import 'home_provider.dart';

// Provider for auto-scanner setting
final autoScannerProvider = FutureProvider<bool>((ref) async {
  final storage = ref.watch(secureStorageProvider);
  return storage.getAutoScanner();
});

class HomeScreen extends ConsumerStatefulWidget {
  const HomeScreen({super.key});

  @override
  ConsumerState<HomeScreen> createState() => _HomeScreenState();
}

class _HomeScreenState extends ConsumerState<HomeScreen> {
  bool _autoScanChecked = false;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) {
      // Load sessions from Router
      ref.read(homeProvider.notifier).loadSessions();

      // Auto-open scanner if enabled and balance > 0
      ref.read(autoScannerProvider.future).then((auto) {
        if (!auto || !mounted) return;
        final balance = ref.read(balanceProvider);
        if (balance > 0 && mounted) {
          context.go('/scanner');
        }
      });
    });
  }

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    // Refresh sessions when returning to this screen
    ref.read(homeProvider.notifier).loadSessions();
  }

  @override
  Widget build(BuildContext context) {
    final homeState = ref.watch(homeProvider);
    final balance = ref.watch(balanceProvider);

    return Scaffold(
      body: SafeArea(
        child: Padding(
          padding: const EdgeInsets.all(20),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              _buildAppBar(context),
              const SizedBox(height: 20),
              _buildBalanceCardSimple(context, balance),
              const SizedBox(height: 20),
              _buildScanButton(context),
              const SizedBox(height: 24),
              _buildSectionTitle('АКТИВНЫЕ ПОДКЛЮЧЕНИЯ'),
              const SizedBox(height: 12),
              Expanded(
                child: homeState.loading
                    ? const Center(child: CircularProgressIndicator())
                    : homeState.sessions.isEmpty
                        ? _buildEmptyState()
                        : _buildSessionsList(context, homeState.sessions),
              ),
              Center(
                child: Text(
                  'v0.4.25',
                  style: TextStyle(
                    color: LyraTheme.textSecondary.withValues(alpha: 0.5),
                    fontSize: 11,
                  ),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }

  Widget _buildAppBar(BuildContext context) {
    return Row(
      children: [
        const Text(
          'ЛИРА',
          style: TextStyle(
            color: LyraTheme.accent,
            fontSize: 28,
            fontWeight: FontWeight.w900,
            letterSpacing: 2,
          ),
        ),
        const Spacer(),
        _buildIconButton(
          icon: Icons.person_outline,
          onTap: () => context.go('/profile'),
        ),
      ],
    );
  }

  Widget _buildIconButton({
    required IconData icon,
    required VoidCallback onTap,
  }) {
    return GestureDetector(
      onTap: onTap,
      child: Container(
        width: 40,
        height: 40,
        decoration: BoxDecoration(
          color: LyraTheme.bgAlt,
          border: Border.all(color: LyraTheme.divider),
          borderRadius: BorderRadius.circular(LyraTheme.radiusSm),
        ),
        child: Icon(icon, size: 20, color: LyraTheme.textSecondary),
      ),
    );
  }

  Widget _buildBalanceCardSimple(BuildContext context, double balance) {
    final balanceStr = _formatBalance(balance);

    return Container(
      width: double.infinity,
      padding: const EdgeInsets.all(24),
      decoration: BoxDecoration(
        gradient: const LinearGradient(
          colors: [LyraTheme.accent, LyraTheme.accentDark],
          begin: Alignment.topLeft,
          end: Alignment.bottomRight,
        ),
        borderRadius: BorderRadius.circular(LyraTheme.radius),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            'БАЛАНС',
            style: TextStyle(
              color: Colors.white.withValues(alpha: 0.7),
              fontSize: 12,
              fontWeight: FontWeight.w700,
              letterSpacing: 2,
            ),
          ),
          const SizedBox(height: 8),
          Row(
            crossAxisAlignment: CrossAxisAlignment.end,
            children: [
              Expanded(
                child: FittedBox(
                  fit: BoxFit.scaleDown,
                  alignment: Alignment.centerLeft,
                  child: Text(
                    '$balanceStr \u20BD',
                    style: const TextStyle(
                      color: Colors.white,
                      fontSize: 40,
                      fontWeight: FontWeight.w900,
                    ),
                  ),
                ),
              ),
              const SizedBox(width: 16),
              GestureDetector(
                onTap: () {
                  ScaffoldMessenger.of(context).showSnackBar(
                    const SnackBar(content: Text('В разработке')),
                  );
                },
                child: Container(
                  padding:
                      const EdgeInsets.symmetric(horizontal: 20, vertical: 10),
                  decoration: BoxDecoration(
                    color: Colors.white,
                    borderRadius: BorderRadius.circular(LyraTheme.radiusSm),
                  ),
                  child: const Text(
                    'ПОПОЛНИТЬ',
                    style: TextStyle(
                      color: LyraTheme.accent,
                      fontSize: 13,
                      fontWeight: FontWeight.w700,
                      letterSpacing: 1,
                    ),
                  ),
                ),
              ),
            ],
          ),
        ],
      ),
    );
  }

  String _formatBalance(double balance) {
    // Format as "1 250,00"
    final parts = balance.toStringAsFixed(2).split('.');
    final intPart = parts[0];
    final decPart = parts[1];

    // Add spaces as thousand separators
    final buffer = StringBuffer();
    final digits = intPart.replaceFirst('-', '');
    if (intPart.startsWith('-')) buffer.write('-');
    for (var i = 0; i < digits.length; i++) {
      if (i > 0 && (digits.length - i) % 3 == 0) {
        buffer.write('\u00A0'); // non-breaking space
      }
      buffer.write(digits[i]);
    }
    buffer.write(',');
    buffer.write(decPart);
    return buffer.toString();
  }

  Widget _buildScanButton(BuildContext context) {
    final balance = ref.watch(balanceProvider);
    final enabled = balance > 0;

    return GestureDetector(
      onTap: enabled
          ? () => context.go('/scanner')
          : () {
              ScaffoldMessenger.of(context).showSnackBar(
                const SnackBar(content: Text('Пополните баланс для подключения')),
              );
            },
      child: Opacity(
        opacity: enabled ? 1.0 : 0.4,
        child: Container(
          width: double.infinity,
          height: 60,
          decoration: BoxDecoration(
            color: LyraTheme.accent,
            borderRadius: BorderRadius.circular(LyraTheme.radius),
          ),
          child: const Row(
            mainAxisAlignment: MainAxisAlignment.center,
            children: [
              Icon(Icons.camera_alt, color: Colors.white, size: 22),
              SizedBox(width: 10),
              Text(
                'ПОДКЛЮЧИТЬСЯ К 1С',
                style: TextStyle(
                  color: Colors.white,
                  fontSize: 16,
                  fontWeight: FontWeight.w700,
                  letterSpacing: 1,
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }

  Widget _buildAutoScanCheckbox(AsyncValue<bool> autoScanAsync) {
    final isOn = autoScanAsync.valueOrNull ?? false;
    return GestureDetector(
      onTap: () {
        final storage = ref.read(secureStorageProvider);
        storage.setAutoScanner(!isOn);
        ref.invalidate(autoScannerProvider);
      },
      child: Padding(
        padding: const EdgeInsets.only(top: 8),
        child: Row(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            Icon(
              isOn ? Icons.check_box : Icons.check_box_outline_blank,
              size: 18,
              color: isOn ? LyraTheme.accent : LyraTheme.textSecondary,
            ),
            const SizedBox(width: 6),
            Text(
              'Открывать при запуске',
              style: TextStyle(
                fontSize: 12,
                color: LyraTheme.textSecondary,
              ),
            ),
          ],
        ),
      ),
    );
  }

  Widget _buildSectionTitle(String title) {
    return Text(
      title,
      style: const TextStyle(
        color: LyraTheme.textSecondary,
        fontSize: 12,
        fontWeight: FontWeight.w800,
        letterSpacing: 2,
      ),
    );
  }

  Widget _buildEmptyState() {
    return Center(
      child: Container(
        width: double.infinity,
        padding: const EdgeInsets.symmetric(vertical: 40, horizontal: 20),
        decoration: BoxDecoration(
          color: LyraTheme.bgAlt,
          borderRadius: BorderRadius.circular(LyraTheme.radius),
        ),
        child: const Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(Icons.sensors, size: 48, color: LyraTheme.textMuted),
            SizedBox(height: 16),
            Text(
              'Нет активных сессий',
              style: TextStyle(
                fontSize: 16,
                fontWeight: FontWeight.w700,
                color: LyraTheme.textPrimary,
              ),
            ),
            SizedBox(height: 4),
            Text(
              'Отсканируйте QR-код в 1С\nдля подключения',
              textAlign: TextAlign.center,
              style: TextStyle(
                fontSize: 14,
                color: LyraTheme.textSecondary,
              ),
            ),
          ],
        ),
      ),
    );
  }

  Widget _buildSessionsList(BuildContext context, List<SessionInfo> sessions) {
    return ListView.separated(
      itemCount: sessions.length,
      separatorBuilder: (_, __) => const SizedBox(height: 8),
      itemBuilder: (context, index) {
        final session = sessions[index];
        return _SessionCard(session: session);
      },
    );
  }

  Future<void> _showLogoutDialog(BuildContext context) async {
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
        context.go('/');
      }
    }
  }
}

String _formatSessionTime(String? isoDate) {
  if (isoDate == null) return '';
  final dt = DateTime.tryParse(isoDate)?.toLocal();
  if (dt == null) return '';
  final now = DateTime.now();
  final today = DateTime(now.year, now.month, now.day);
  final sessionDay = DateTime(dt.year, dt.month, dt.day);
  final time = '${dt.hour}:${dt.minute.toString().padLeft(2, '0')}';
  if (sessionDay == today) return 'Сегодня, $time';
  if (sessionDay == today.subtract(const Duration(days: 1))) return 'Вчера, $time';
  return '${dt.day}.${dt.month.toString().padLeft(2, '0')}.${dt.year}, $time';
}

class _SessionCard extends StatelessWidget {
  final SessionInfo session;

  const _SessionCard({required this.session});

  @override
  Widget build(BuildContext context) {
    final borderColor = _borderColor(session.status);
    final iconData = _statusIcon(session.status);
    final iconColor = _iconColor(session.status);
    final iconBgColor = _iconBgColor(session.status);
    final statusText = _statusText(session.status);
    final displayName = session.configName.isNotEmpty
        ? session.configName
        : 'Сессия ${session.sessionId.substring(0, 8)}...';

    return GestureDetector(
      onTap: () => context.go('/session/${session.sessionId}'),
      child: Container(
        decoration: BoxDecoration(
          color: Colors.white,
          border: Border.all(color: LyraTheme.divider),
          borderRadius: BorderRadius.circular(LyraTheme.radiusSm),
        ),
        child: IntrinsicHeight(
          child: Row(
            children: [
              // Left color border
              Container(
                width: 4,
                decoration: BoxDecoration(
                  color: borderColor,
                  borderRadius: const BorderRadius.only(
                    topLeft: Radius.circular(LyraTheme.radiusSm),
                    bottomLeft: Radius.circular(LyraTheme.radiusSm),
                  ),
                ),
              ),
              const SizedBox(width: 12),
              // Status icon
              Container(
                width: 36,
                height: 36,
                decoration: BoxDecoration(
                  color: iconBgColor,
                  borderRadius: BorderRadius.circular(LyraTheme.radiusSm),
                ),
                child: Icon(iconData, size: 18, color: iconColor),
              ),
              const SizedBox(width: 12),
              // Text content
              Expanded(
                child: Padding(
                  padding: const EdgeInsets.symmetric(vertical: 14),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        displayName,
                        style: const TextStyle(
                          fontSize: 15,
                          fontWeight: FontWeight.w700,
                          color: LyraTheme.textPrimary,
                        ),
                      ),
                      const SizedBox(height: 2),
                      Text(
                        _formatSessionTime(session.created),
                        style: const TextStyle(
                          fontSize: 13,
                          color: LyraTheme.textSecondary,
                        ),
                      ),
                      if (statusText != null) ...[
                        Text(
                          statusText,
                          style: TextStyle(
                            fontSize: 12,
                            color: iconColor,
                          ),
                        ),
                      ],
                    ],
                  ),
                ),
              ),
              // Arrow
              const Padding(
                padding: EdgeInsets.only(right: 12),
                child: Text(
                  '\u203A',
                  style: TextStyle(
                    fontSize: 24,
                    color: LyraTheme.textMuted,
                  ),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }

  Color _borderColor(String status) {
    return switch (status) {
      'active' || 'ok' || 'connected' => LyraTheme.green,
      'insufficient_balance' => LyraTheme.yellow,
      _ => LyraTheme.textMuted,
    };
  }

  IconData _statusIcon(String status) {
    return switch (status) {
      'active' || 'ok' || 'connected' => Icons.check_circle,
      'insufficient_balance' => Icons.warning_amber_rounded,
      _ => Icons.circle_outlined,
    };
  }

  Color _iconColor(String status) {
    return switch (status) {
      'active' || 'ok' || 'connected' => LyraTheme.green,
      'insufficient_balance' => LyraTheme.yellow,
      _ => LyraTheme.textMuted,
    };
  }

  Color _iconBgColor(String status) {
    return switch (status) {
      'active' || 'ok' || 'connected' => LyraTheme.greenBg,
      'insufficient_balance' => LyraTheme.yellowBg,
      _ => LyraTheme.bgAlt,
    };
  }

  String? _statusText(String status) {
    return switch (status) {
      'active' || 'ok' || 'connected' => 'Подключено',
      'insufficient_balance' => 'Пополните баланс',
      'disconnected' => 'Чат отключён',
      _ => null,
    };
  }
}
