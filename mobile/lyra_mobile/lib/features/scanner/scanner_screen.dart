import 'package:flutter/foundation.dart' show kIsWeb;
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:mobile_scanner/mobile_scanner.dart';

import '../../app/theme.dart';
import 'scanner_provider.dart';

class ScannerScreen extends ConsumerStatefulWidget {
  const ScannerScreen({super.key});

  @override
  ConsumerState<ScannerScreen> createState() => _ScannerScreenState();
}

class _ScannerScreenState extends ConsumerState<ScannerScreen>
    with SingleTickerProviderStateMixin {
  MobileScannerController? _scannerController;
  final TextEditingController _jwtController = TextEditingController();
  bool _scanned = false;
  late AnimationController _scanLineController;

  @override
  void initState() {
    super.initState();
    if (!kIsWeb) {
      _scannerController = MobileScannerController();
    }
    _scanLineController = AnimationController(
      vsync: this,
      duration: const Duration(seconds: 2),
    )..repeat();
  }

  @override
  void dispose() {
    _scannerController?.dispose();
    _jwtController.dispose();
    _scanLineController.dispose();
    super.dispose();
  }

  void _onJwtSubmitted(String jwt) {
    final trimmed = jwt.trim();
    if (trimmed.isNotEmpty) {
      _scanned = true;
      ref.read(scannerProvider.notifier).onQrScanned(trimmed);
    }
  }

  @override
  Widget build(BuildContext context) {
    final state = ref.watch(scannerProvider);

    ref.listen<ScannerState>(scannerProvider, (prev, next) {
      if (next.step == ScannerStep.done && next.session != null) {
        context.go('/session/${next.session!.sessionId}');
      }
    });

    if (kIsWeb) {
      return _buildWebFallback(context, state);
    } else {
      return _buildCameraScanner(context, state);
    }
  }

  // ── Web fallback ──────────────────────────────────────────────────────

  Widget _buildWebFallback(BuildContext context, ScannerState state) {
    return Scaffold(
      backgroundColor: const Color(0xFF212121),
      body: SafeArea(
        child: Stack(
          children: [
            Padding(
              padding: const EdgeInsets.all(20),
              child: Column(
                children: [
                  Align(
                    alignment: Alignment.topLeft,
                    child: _buildBackButton(context),
                  ),
                  const Spacer(),
                  Icon(Icons.qr_code_scanner,
                      size: 80,
                      color: Colors.white.withValues(alpha: 0.3)),
                  const SizedBox(height: 24),
                  Text('Вставьте JWT из QR-кода',
                      style: TextStyle(
                          color: Colors.white.withValues(alpha: 0.7),
                          fontSize: 16)),
                  const SizedBox(height: 16),
                  TextField(
                    controller: _jwtController,
                    style: const TextStyle(color: Colors.white, fontSize: 14),
                    decoration: InputDecoration(
                      hintText: 'eyJ...',
                      hintStyle: TextStyle(
                          color: Colors.white.withValues(alpha: 0.3)),
                      border: OutlineInputBorder(
                          borderRadius:
                              BorderRadius.circular(LyraTheme.radiusSm)),
                      enabledBorder: OutlineInputBorder(
                          borderRadius:
                              BorderRadius.circular(LyraTheme.radiusSm),
                          borderSide: BorderSide(
                              color: Colors.white.withValues(alpha: 0.2))),
                      focusedBorder: OutlineInputBorder(
                          borderRadius:
                              BorderRadius.circular(LyraTheme.radiusSm),
                          borderSide:
                              const BorderSide(color: LyraTheme.accent)),
                    ),
                  ),
                  const SizedBox(height: 16),
                  SizedBox(
                    width: double.infinity,
                    height: 52,
                    child: ElevatedButton(
                      onPressed: state.step == ScannerStep.scanning
                          ? () => _onJwtSubmitted(_jwtController.text)
                          : null,
                      child: const Text('ПОДКЛЮЧИТЬСЯ'),
                    ),
                  ),
                  const Spacer(),
                ],
              ),
            ),
            // Status overlay on web too
            if (state.step != ScannerStep.scanning)
              _buildStatusOverlayForStep(state),
          ],
        ),
      ),
    );
  }

  // ── Camera scanner (mobile) ───────────────────────────────────────────

  Widget _buildCameraScanner(BuildContext context, ScannerState state) {
    return Scaffold(
      backgroundColor: const Color(0xFF212121),
      body: Stack(
        children: [
          // Camera + viewfinder
          Column(
            children: [
              Expanded(
                child: Stack(
                  children: [
                    // Camera feed
                    MobileScanner(
                      controller: _scannerController!,
                      onDetect: (capture) {
                        if (_scanned) return;
                        for (final barcode in capture.barcodes) {
                          final value = barcode.rawValue;
                          if (value != null && value.startsWith('eyJ')) {
                            _scanned = true;
                            ref
                                .read(scannerProvider.notifier)
                                .onQrScanned(value);
                            break;
                          }
                        }
                      },
                    ),
                    // Viewfinder overlay
                    _buildViewfinderOverlay(),
                  ],
                ),
              ),
            ],
          ),
          // Back button
          Positioned(
            top: MediaQuery.of(context).padding.top + 12,
            left: 20,
            child: _buildBackButton(context),
          ),
          // Status overlays
          if (state.step != ScannerStep.scanning)
            Positioned.fill(
              child: _buildStatusOverlayForStep(state),
            ),
        ],
      ),
    );
  }

  // ── Viewfinder with frame and scan line ───────────────────────────────

  Widget _buildViewfinderOverlay() {
    return Center(
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          SizedBox(
            width: 240,
            height: 240,
            child: Stack(
              children: [
                // Frame border
                Container(
                  width: 240,
                  height: 240,
                  decoration: BoxDecoration(
                    border: Border.all(
                        color: Colors.white.withValues(alpha: 0.15), width: 3),
                    borderRadius: BorderRadius.circular(LyraTheme.radius),
                  ),
                ),
                // Corner decorations
                _buildCorner(Alignment.topLeft),
                _buildCorner(Alignment.topRight),
                _buildCorner(Alignment.bottomLeft),
                _buildCorner(Alignment.bottomRight),
                // Animated scan line
                AnimatedBuilder(
                  animation: _scanLineController,
                  builder: (context, child) {
                    final top =
                        24.0 + (_scanLineController.value * (240 - 48));
                    return Positioned(
                      top: top,
                      left: 24,
                      right: 24,
                      child: Container(
                        height: 3,
                        decoration: BoxDecoration(
                          color: LyraTheme.accent.withValues(alpha: 0.8),
                          borderRadius: BorderRadius.circular(2),
                        ),
                      ),
                    );
                  },
                ),
              ],
            ),
          ),
          const SizedBox(height: 36),
          Text(
            'НАВЕДИТЕ КАМЕРУ НА QR-КОД В 1С',
            style: TextStyle(
              color: Colors.white.withValues(alpha: 0.5),
              fontSize: 14,
              fontWeight: FontWeight.w600,
              letterSpacing: 1,
            ),
            textAlign: TextAlign.center,
          ),
        ],
      ),
    );
  }

  Widget _buildCorner(Alignment alignment) {
    const size = 32.0;
    const thickness = 4.0;

    final isTop =
        alignment == Alignment.topLeft || alignment == Alignment.topRight;
    final isLeft =
        alignment == Alignment.topLeft || alignment == Alignment.bottomLeft;

    return Positioned(
      top: isTop ? -1 : null,
      bottom: !isTop ? -1 : null,
      left: isLeft ? -1 : null,
      right: !isLeft ? -1 : null,
      child: SizedBox(
        width: size,
        height: size,
        child: CustomPaint(
          painter: _CornerPainter(
            color: LyraTheme.accent,
            thickness: thickness,
            isTop: isTop,
            isLeft: isLeft,
          ),
        ),
      ),
    );
  }

  // ── Status overlays ───────────────────────────────────────────────────

  Widget _buildStatusOverlayForStep(ScannerState state) {
    return switch (state.step) {
      ScannerStep.scanning => const SizedBox.shrink(),
      ScannerStep.connecting => _buildStatusOverlay(
          icon: '\u23F3',
          title: 'ПОДКЛЮЧЕНИЕ',
          subtitle: 'Устанавливаем соединение',
          pulsing: true,
        ),
      ScannerStep.authenticating => _buildStatusOverlay(
          icon: '\uD83D\uDD10',
          title: 'АВТОРИЗАЦИЯ',
          subtitle: 'Проверяем данные',
          pulsing: true,
        ),
      ScannerStep.done => _buildStatusOverlay(
          icon: '\u2705',
          title: 'ПОДКЛЮЧЕНО',
          titleColor: LyraTheme.green,
          subtitle: 'Переход к сессии',
        ),
      ScannerStep.error => _buildStatusOverlay(
          icon: '\u274C',
          title: 'ОШИБКА',
          titleColor: LyraTheme.red,
          subtitle: state.errorMessage ??
              'Попробуйте отсканировать QR-код ещё раз',
          action: OutlinedButton(
            onPressed: () {
              setState(() => _scanned = false);
              ref.read(scannerProvider.notifier).reset();
            },
            style: OutlinedButton.styleFrom(
              foregroundColor: Colors.white,
              side: BorderSide(color: Colors.white.withValues(alpha: 0.3)),
              padding:
                  const EdgeInsets.symmetric(horizontal: 24, vertical: 12),
            ),
            child: const Text('ПОВТОРИТЬ',
                style: TextStyle(
                    fontWeight: FontWeight.w700, letterSpacing: 0.5)),
          ),
        ),
    };
  }

  Widget _buildStatusOverlay({
    required String icon,
    required String title,
    Color? titleColor,
    required String subtitle,
    Widget? action,
    bool pulsing = false,
  }) {
    Widget iconWidget = Text(icon, style: const TextStyle(fontSize: 64));
    if (pulsing) {
      iconWidget = _PulsingWidget(child: iconWidget);
    }

    return Container(
      color: const Color(0xFF212121).withValues(alpha: 0.95),
      child: Center(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            iconWidget,
            const SizedBox(height: 20),
            Text(
              title,
              style: TextStyle(
                color: titleColor ?? Colors.white,
                fontSize: 20,
                fontWeight: FontWeight.w800,
                letterSpacing: 1,
              ),
            ),
            const SizedBox(height: 8),
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: 40),
              child: Text(
                subtitle,
                style: TextStyle(
                  color: Colors.white.withValues(alpha: 0.4),
                  fontSize: 13,
                  fontWeight: FontWeight.w500,
                ),
                textAlign: TextAlign.center,
              ),
            ),
            if (action != null) ...[const SizedBox(height: 24), action],
          ],
        ),
      ),
    );
  }

  // ── Back button ───────────────────────────────────────────────────────

  Widget _buildBackButton(BuildContext context) {
    return SizedBox(
      width: 40,
      height: 40,
      child: IconButton(
        onPressed: () => context.go('/home'),
        icon: const Icon(Icons.arrow_back, color: Colors.white, size: 20),
        style: IconButton.styleFrom(
          backgroundColor: Colors.white.withValues(alpha: 0.1),
          shape: RoundedRectangleBorder(
            borderRadius: BorderRadius.circular(LyraTheme.radiusSm),
          ),
        ),
        padding: EdgeInsets.zero,
      ),
    );
  }
}

// ── Corner painter ──────────────────────────────────────────────────────

class _CornerPainter extends CustomPainter {
  final Color color;
  final double thickness;
  final bool isTop;
  final bool isLeft;

  _CornerPainter({
    required this.color,
    required this.thickness,
    required this.isTop,
    required this.isLeft,
  });

  @override
  void paint(Canvas canvas, Size size) {
    final paint = Paint()
      ..color = color
      ..strokeWidth = thickness
      ..style = PaintingStyle.stroke
      ..strokeCap = StrokeCap.square;

    final path = Path();

    if (isTop && isLeft) {
      path.moveTo(0, size.height);
      path.lineTo(0, 0);
      path.lineTo(size.width, 0);
    } else if (isTop && !isLeft) {
      path.moveTo(0, 0);
      path.lineTo(size.width, 0);
      path.lineTo(size.width, size.height);
    } else if (!isTop && isLeft) {
      path.moveTo(0, 0);
      path.lineTo(0, size.height);
      path.lineTo(size.width, size.height);
    } else {
      path.moveTo(size.width, 0);
      path.lineTo(size.width, size.height);
      path.lineTo(0, size.height);
    }

    canvas.drawPath(path, paint);
  }

  @override
  bool shouldRepaint(covariant _CornerPainter oldDelegate) => false;
}

// ── Pulsing animation widget ────────────────────────────────────────────

class _PulsingWidget extends StatefulWidget {
  final Widget child;
  const _PulsingWidget({required this.child});

  @override
  State<_PulsingWidget> createState() => _PulsingWidgetState();
}

class _PulsingWidgetState extends State<_PulsingWidget>
    with SingleTickerProviderStateMixin {
  late AnimationController _controller;

  @override
  void initState() {
    super.initState();
    _controller = AnimationController(
      vsync: this,
      duration: const Duration(milliseconds: 1500),
    )..repeat(reverse: true);
  }

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return AnimatedBuilder(
      animation: _controller,
      builder: (context, child) {
        final opacity = 0.6 + (_controller.value * 0.4);
        final scale = 0.95 + (_controller.value * 0.05);
        return Opacity(
          opacity: opacity,
          child: Transform.scale(
            scale: scale,
            child: widget.child,
          ),
        );
      },
    );
  }
}
