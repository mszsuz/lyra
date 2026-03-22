import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:speech_to_text/speech_to_text.dart' as stt;

import '../../app/theme.dart';
import '../../core/centrifugo/centrifugo_client.dart';
import '../../core/storage/secure_storage.dart';
import '../../models/session_info.dart';
import 'session_provider.dart';

final _balanceProvider = FutureProvider<double>((ref) async {
  final storage = ref.watch(secureStorageProvider);
  return storage.getBalance();
});

class SessionScreen extends ConsumerStatefulWidget {
  final String sessionId;
  const SessionScreen({super.key, required this.sessionId});

  @override
  ConsumerState<SessionScreen> createState() => _SessionScreenState();
}

class _SessionScreenState extends ConsumerState<SessionScreen> {
  final stt.SpeechToText _speech = stt.SpeechToText();
  bool _isListening = false;
  String _recognizedText = '';

  @override
  Widget build(BuildContext context) {
    final session = ref.watch(sessionProvider(widget.sessionId));
    final connectionAsync = ref.watch(_connectionStateProvider);
    final connectionState =
        connectionAsync.valueOrNull ?? CentrifugoConnectionState.disconnected;

    if (session == null) {
      return _buildLoading();
    }

    // Determine effective status combining session status and connection
    final effectiveStatus = _effectiveStatus(session, connectionState);
    final isActive = effectiveStatus == 'active';

    return Scaffold(
      backgroundColor: Colors.white,
      body: SafeArea(
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 20),
          child: Column(
            children: [
              const SizedBox(height: 8),
              _buildHeader(context, session),
              const SizedBox(height: 20),
              _buildConnectionStatus(effectiveStatus),
              const SizedBox(height: 12),
              _buildBalanceCard(session, effectiveStatus),
              const SizedBox(height: 16),
              _buildStatusBanner(effectiveStatus),
              const Spacer(),
              _buildInputPanel(isActive),
              const SizedBox(height: 20),
            ],
          ),
        ),
      ),
    );
  }

  String _effectiveStatus(
      SessionInfo session, CentrifugoConnectionState connState) {
    if (connState == CentrifugoConnectionState.disconnected) {
      return 'disconnected';
    }
    if (session.status == 'insufficient_balance') {
      return 'insufficient_balance';
    }
    if (session.status == 'active' ||
        session.status == 'ok' ||
        session.status == 'connected') {
      return 'active';
    }
    return session.status;
  }

  // ── Loading ───────────────────────────────────────────────────────────

  Widget _buildLoading() {
    return Scaffold(
      backgroundColor: Colors.white,
      body: SafeArea(
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 20),
          child: Column(
            children: [
              const SizedBox(height: 8),
              Row(
                children: [
                  _buildBackButton(context),
                  const SizedBox(width: 12),
                  const Text('Сессия',
                      style: TextStyle(
                        fontSize: 17,
                        fontWeight: FontWeight.w800,
                        color: LyraTheme.textPrimary,
                      )),
                ],
              ),
              const Expanded(
                child: Center(child: CircularProgressIndicator()),
              ),
            ],
          ),
        ),
      ),
    );
  }

  // ── Header ────────────────────────────────────────────────────────────

  Widget _buildHeader(BuildContext context, SessionInfo session) {
    return Container(
      padding: const EdgeInsets.only(bottom: 16),
      decoration: const BoxDecoration(
        border: Border(bottom: BorderSide(color: LyraTheme.divider, width: 2)),
      ),
      child: Row(
        children: [
          _buildBackButton(context),
          const SizedBox(width: 12),
          Expanded(
            child: Text(
              session.configName.isNotEmpty ? session.configName : 'Сессия',
              style: const TextStyle(
                fontSize: 17,
                fontWeight: FontWeight.w800,
                color: LyraTheme.textPrimary,
              ),
              overflow: TextOverflow.ellipsis,
            ),
          ),
        ],
      ),
    );
  }

  Widget _buildBackButton(BuildContext context) {
    return SizedBox(
      width: 40,
      height: 40,
      child: IconButton(
        onPressed: () => context.go('/home'),
        icon: const Icon(Icons.arrow_back, size: 18),
        style: IconButton.styleFrom(
          backgroundColor: LyraTheme.bgAlt,
          foregroundColor: LyraTheme.textSecondary,
          shape: RoundedRectangleBorder(
            borderRadius: BorderRadius.circular(LyraTheme.radiusSm),
            side: const BorderSide(color: LyraTheme.divider, width: 2),
          ),
        ),
        padding: EdgeInsets.zero,
      ),
    );
  }

  // ── Connection status card ────────────────────────────────────────────

  Widget _buildConnectionStatus(String status) {
    final Color borderColor;
    final Color dotColor;
    final String valueText;
    final Color valueColor;

    switch (status) {
      case 'active':
        borderColor = LyraTheme.green;
        dotColor = LyraTheme.green;
        valueText = 'ПОДКЛЮЧЕНО';
        valueColor = LyraTheme.green;
      case 'insufficient_balance':
        borderColor = LyraTheme.yellow;
        dotColor = LyraTheme.yellow;
        valueText = 'ПОДКЛЮЧЕНО';
        valueColor = LyraTheme.green;
      case 'disconnected':
        borderColor = LyraTheme.textMuted;
        dotColor = LyraTheme.textMuted;
        valueText = 'ОТКЛЮЧЕНО';
        valueColor = LyraTheme.red;
      default:
        borderColor = LyraTheme.textMuted;
        dotColor = LyraTheme.textMuted;
        valueText = status.toUpperCase();
        valueColor = LyraTheme.textSecondary;
    }

    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 14),
      decoration: BoxDecoration(
        borderRadius: BorderRadius.circular(LyraTheme.radius),
        border: Border.all(color: LyraTheme.divider, width: 2),
      ),
      child: Container(
        decoration: BoxDecoration(
          border: Border(left: BorderSide(color: borderColor, width: 4)),
        ),
        padding: const EdgeInsets.only(left: 12),
        child: Row(
          children: [
            Container(
              width: 10,
              height: 10,
              decoration: BoxDecoration(
                color: dotColor,
                shape: BoxShape.circle,
              ),
            ),
            const SizedBox(width: 10),
            const Text(
              'Статус:',
              style: TextStyle(
                fontSize: 13,
                color: LyraTheme.textSecondary,
                fontWeight: FontWeight.w500,
              ),
            ),
            const SizedBox(width: 6),
            Text(
              valueText,
              style: TextStyle(
                fontSize: 14,
                fontWeight: FontWeight.w800,
                color: valueColor,
              ),
            ),
          ],
        ),
      ),
    );
  }

  // ── Balance card ──────────────────────────────────────────────────────

  Widget _buildBalanceCard(SessionInfo session, String status) {
    final bool isNegative =
        status == 'insufficient_balance' || status == 'disconnected';
    final bgColor = isNegative ? LyraTheme.red : LyraTheme.accent;

    // Read user-level balance (not per-session)
    final balanceFuture = ref.watch(_balanceProvider);
    final userBalance = balanceFuture.valueOrNull ?? session.balance;

    final String balanceText;
    if (status == 'disconnected') {
      balanceText = '\u2014'; // em dash
    } else {
      balanceText =
          userBalance.toStringAsFixed(2).replaceAll('.', ',');
    }

    return Container(
      width: double.infinity,
      padding: const EdgeInsets.symmetric(vertical: 28, horizontal: 28),
      decoration: BoxDecoration(
        color: bgColor,
        borderRadius: BorderRadius.circular(LyraTheme.radius),
      ),
      child: Column(
        children: [
          Text(
            'БАЛАНС',
            style: TextStyle(
              fontSize: 12,
              color: Colors.white.withValues(alpha: 0.7),
              fontWeight: FontWeight.w700,
              letterSpacing: 2,
            ),
          ),
          const SizedBox(height: 6),
          Row(
            mainAxisAlignment: MainAxisAlignment.center,
            crossAxisAlignment: CrossAxisAlignment.baseline,
            textBaseline: TextBaseline.alphabetic,
            children: [
              Text(
                balanceText,
                style: const TextStyle(
                  fontSize: 44,
                  fontWeight: FontWeight.w900,
                  color: Colors.white,
                ),
              ),
              const SizedBox(width: 4),
              Text(
                'руб',
                style: TextStyle(
                  fontSize: 18,
                  fontWeight: FontWeight.w500,
                  color: Colors.white.withValues(alpha: 0.7),
                ),
              ),
            ],
          ),
        ],
      ),
    );
  }

  // ── Status banner ─────────────────────────────────────────────────────

  Widget _buildStatusBanner(String status) {
    final Color bgColor;
    final Color borderColor;
    final Color textColor;
    final String text;

    switch (status) {
      case 'active':
        bgColor = LyraTheme.greenBg;
        borderColor = LyraTheme.green;
        textColor = LyraTheme.green;
        text = 'СЕССИЯ АКТИВНА';
      case 'insufficient_balance':
        bgColor = LyraTheme.yellowBg;
        borderColor = LyraTheme.yellow;
        textColor = LyraTheme.yellow;
        text = 'ПОПОЛНИТЕ БАЛАНС';
      case 'disconnected':
        bgColor = LyraTheme.bgAlt;
        borderColor = LyraTheme.divider;
        textColor = LyraTheme.textMuted;
        text = 'ЧАТ ОТКЛЮЧЁН';
      default:
        bgColor = LyraTheme.bgAlt;
        borderColor = LyraTheme.divider;
        textColor = LyraTheme.textMuted;
        text = status.toUpperCase();
    }

    return Container(
      width: double.infinity,
      padding: const EdgeInsets.symmetric(vertical: 14, horizontal: 20),
      decoration: BoxDecoration(
        color: bgColor,
        borderRadius: BorderRadius.circular(LyraTheme.radiusSm),
        border: Border.all(color: borderColor, width: 2),
      ),
      child: Text(
        text,
        style: TextStyle(
          fontSize: 13,
          fontWeight: FontWeight.w800,
          color: textColor,
          letterSpacing: 1,
        ),
        textAlign: TextAlign.center,
      ),
    );
  }

  // ── Input panel ───────────────────────────────────────────────────────

  Widget _buildInputPanel(bool isActive) {
    return Column(
      children: [
        // Live recognition text
        if (_isListening && _recognizedText.isNotEmpty)
          Padding(
            padding: const EdgeInsets.only(bottom: 8),
            child: Text(
              _recognizedText,
              style: TextStyle(
                fontSize: 14,
                color: LyraTheme.accent,
                fontStyle: FontStyle.italic,
              ),
              textAlign: TextAlign.center,
            ),
          ),
        // Buttons
        Row(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            _buildMediaButton(
              icon: Icons.camera_alt,
              enabled: isActive,
              onTap: () => _showInDevelopment(context),
            ),
            const SizedBox(width: 40),
            _buildMicButton(isActive),
          ],
        ),
        if (_isListening)
          Padding(
            padding: const EdgeInsets.only(top: 6),
            child: Text(
              'Говорите...',
              style: TextStyle(fontSize: 11, color: LyraTheme.textSecondary),
            ),
          ),
      ],
    );
  }

  Widget _buildMicButton(bool isActive) {
    return GestureDetector(
      onLongPressStart: isActive ? (_) => _startListening() : null,
      onLongPressEnd: isActive ? (_) => _stopAndSend() : null,
      child: Opacity(
        opacity: isActive ? 1.0 : 0.3,
        child: Container(
          width: 120,
          height: 120,
          decoration: BoxDecoration(
            color: _isListening ? LyraTheme.accent : (isActive ? LyraTheme.accentBg : LyraTheme.bgAlt),
            borderRadius: BorderRadius.circular(LyraTheme.radius),
            border: Border.all(
              color: isActive ? LyraTheme.accent : LyraTheme.divider,
              width: 3,
            ),
          ),
          child: Icon(
            _isListening ? Icons.mic : Icons.mic_none,
            size: 48,
            color: _isListening ? Colors.white : (isActive ? LyraTheme.accent : LyraTheme.textMuted),
          ),
        ),
      ),
    );
  }

  Future<void> _startListening() async {
    final available = await _speech.initialize(
      onError: (error) {
        setState(() => _isListening = false);
      },
    );

    if (!available) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(content: Text('Распознавание речи недоступно')),
        );
      }
      return;
    }

    setState(() {
      _isListening = true;
      _recognizedText = '';
    });

    await _speech.listen(
      localeId: 'ru_RU',
      onResult: (result) {
        setState(() {
          _recognizedText = result.recognizedWords;
        });
      },
    );
  }

  Future<void> _stopAndSend() async {
    await _speech.stop();
    setState(() => _isListening = false);

    if (_recognizedText.isNotEmpty) {
      ref.read(sessionProvider(widget.sessionId).notifier)
          .sendVoiceText(_recognizedText);
      setState(() => _recognizedText = '');
    }
  }

  Widget _buildMediaButton({
    required IconData icon,
    required bool enabled,
    required VoidCallback onTap,
    bool highlighted = false,
  }) {
    return GestureDetector(
      onTap: enabled ? onTap : null,
      child: Opacity(
        opacity: enabled ? 1.0 : 0.3,
        child: Container(
          width: 120,
          height: 120,
          decoration: BoxDecoration(
            color: highlighted ? LyraTheme.accent : (enabled ? LyraTheme.accentBg : LyraTheme.bgAlt),
            borderRadius: BorderRadius.circular(LyraTheme.radius),
            border: Border.all(
              color: enabled ? LyraTheme.accent : LyraTheme.divider,
              width: 3,
            ),
          ),
          child: Icon(
            icon,
            size: 48,
            color: highlighted ? Colors.white : (enabled ? LyraTheme.accent : LyraTheme.textMuted),
          ),
        ),
      ),
    );
  }

  void _showInDevelopment(BuildContext context) {
    ScaffoldMessenger.of(context).showSnackBar(
      const SnackBar(content: Text('В разработке')),
    );
  }
}

final _connectionStateProvider =
    StreamProvider<CentrifugoConnectionState>((ref) {
  final client = ref.watch(centrifugoClientProvider);
  return client.connectionState;
});
