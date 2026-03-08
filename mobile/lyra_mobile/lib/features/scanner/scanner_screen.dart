import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:mobile_scanner/mobile_scanner.dart';

import 'scanner_provider.dart';

class ScannerScreen extends ConsumerStatefulWidget {
  const ScannerScreen({super.key});

  @override
  ConsumerState<ScannerScreen> createState() => _ScannerScreenState();
}

class _ScannerScreenState extends ConsumerState<ScannerScreen> {
  final MobileScannerController _scannerController = MobileScannerController();
  bool _scanned = false;

  @override
  void dispose() {
    _scannerController.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final state = ref.watch(scannerProvider);

    ref.listen<ScannerState>(scannerProvider, (prev, next) {
      if (next.step == ScannerStep.done && next.session != null) {
        context.go('/session/${next.session!.sessionId}');
      }
    });

    return Scaffold(
      appBar: AppBar(
        title: const Text('Сканировать QR'),
        leading: IconButton(
          icon: const Icon(Icons.arrow_back),
          onPressed: () => context.go('/home'),
        ),
      ),
      body: switch (state.step) {
        ScannerStep.scanning => _buildScanner(),
        ScannerStep.connecting => _buildStatus('Подключение...'),
        ScannerStep.authenticating => _buildStatus('Авторизация...'),
        ScannerStep.done => _buildStatus('Готово'),
        ScannerStep.error => _buildError(state),
      },
    );
  }

  Widget _buildScanner() {
    return Column(
      children: [
        Expanded(
          child: MobileScanner(
            controller: _scannerController,
            onDetect: (capture) {
              if (_scanned) return;
              final barcodes = capture.barcodes;
              for (final barcode in barcodes) {
                final value = barcode.rawValue;
                if (value != null && value.startsWith('eyJ')) {
                  _scanned = true;
                  ref.read(scannerProvider.notifier).onQrScanned(value);
                  break;
                }
              }
            },
          ),
        ),
        const Padding(
          padding: EdgeInsets.all(16.0),
          child: Text(
            'Наведите камеру на QR-код в 1С',
            style: TextStyle(fontSize: 16),
            textAlign: TextAlign.center,
          ),
        ),
      ],
    );
  }

  Widget _buildStatus(String text) {
    return Center(
      child: Column(
        mainAxisAlignment: MainAxisAlignment.center,
        children: [
          const CircularProgressIndicator(),
          const SizedBox(height: 16),
          Text(text, style: const TextStyle(fontSize: 16)),
        ],
      ),
    );
  }

  Widget _buildError(ScannerState state) {
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(24.0),
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            const Icon(Icons.error_outline, size: 64, color: Colors.red),
            const SizedBox(height: 16),
            Text(
              state.errorMessage ?? 'Произошла ошибка',
              style: const TextStyle(fontSize: 16),
              textAlign: TextAlign.center,
            ),
            const SizedBox(height: 24),
            FilledButton(
              onPressed: () {
                _scanned = false;
                ref.invalidate(scannerProvider);
              },
              child: const Text('Попробовать снова'),
            ),
            const SizedBox(height: 12),
            TextButton(
              onPressed: () => context.go('/home'),
              child: const Text('На главную'),
            ),
          ],
        ),
      ),
    );
  }
}
