import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import 'registration_provider.dart';

class RegistrationScreen extends ConsumerStatefulWidget {
  const RegistrationScreen({super.key});

  @override
  ConsumerState<RegistrationScreen> createState() =>
      _RegistrationScreenState();
}

class _RegistrationScreenState extends ConsumerState<RegistrationScreen> {
  final _phoneController = TextEditingController(text: '+7');
  final _codeController = TextEditingController();

  @override
  void dispose() {
    _phoneController.dispose();
    _codeController.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final state = ref.watch(registrationProvider);

    ref.listen<RegistrationState>(registrationProvider, (prev, next) {
      if (next.step == RegistrationStep.done) {
        context.go('/home');
      }
    });

    return Scaffold(
      appBar: AppBar(
        title: const Text('Регистрация'),
      ),
      body: Padding(
        padding: const EdgeInsets.all(24.0),
        child: switch (state.step) {
          RegistrationStep.phoneInput ||
          RegistrationStep.waitingSms =>
            _buildPhoneInput(state),
          RegistrationStep.codeInput ||
          RegistrationStep.confirming =>
            _buildCodeInput(state),
          RegistrationStep.error => _buildError(state),
          RegistrationStep.done => const Center(
              child: CircularProgressIndicator(),
            ),
        },
      ),
    );
  }

  Widget _buildPhoneInput(RegistrationState state) {
    final isLoading = state.step == RegistrationStep.waitingSms;

    return Column(
      mainAxisAlignment: MainAxisAlignment.center,
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        const Text(
          'Введите номер телефона',
          style: TextStyle(fontSize: 20, fontWeight: FontWeight.bold),
          textAlign: TextAlign.center,
        ),
        const SizedBox(height: 8),
        const Text(
          'Мы отправим SMS с кодом подтверждения',
          textAlign: TextAlign.center,
          style: TextStyle(color: Colors.grey),
        ),
        const SizedBox(height: 32),
        TextField(
          controller: _phoneController,
          keyboardType: TextInputType.phone,
          inputFormatters: [
            FilteringTextInputFormatter.allow(RegExp(r'[+0-9]')),
            LengthLimitingTextInputFormatter(12),
          ],
          decoration: const InputDecoration(
            labelText: 'Телефон',
            hintText: '+79001234567',
            border: OutlineInputBorder(),
            prefixIcon: Icon(Icons.phone),
          ),
          enabled: !isLoading,
        ),
        const SizedBox(height: 24),
        FilledButton(
          onPressed: isLoading
              ? null
              : () {
                  final phone = _phoneController.text.trim();
                  if (phone.length >= 11) {
                    ref.read(registrationProvider.notifier).sendPhone(phone);
                  }
                },
          child: isLoading
              ? const SizedBox(
                  height: 20,
                  width: 20,
                  child: CircularProgressIndicator(
                    strokeWidth: 2,
                    color: Colors.white,
                  ),
                )
              : const Text('Получить код'),
        ),
      ],
    );
  }

  Widget _buildCodeInput(RegistrationState state) {
    final isLoading = state.step == RegistrationStep.confirming;

    return Column(
      mainAxisAlignment: MainAxisAlignment.center,
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        const Text(
          'Введите код из SMS',
          style: TextStyle(fontSize: 20, fontWeight: FontWeight.bold),
          textAlign: TextAlign.center,
        ),
        const SizedBox(height: 32),
        TextField(
          controller: _codeController,
          keyboardType: TextInputType.number,
          inputFormatters: [
            FilteringTextInputFormatter.digitsOnly,
            LengthLimitingTextInputFormatter(4),
          ],
          decoration: const InputDecoration(
            labelText: 'Код',
            hintText: '1234',
            border: OutlineInputBorder(),
            prefixIcon: Icon(Icons.lock),
          ),
          textAlign: TextAlign.center,
          style: const TextStyle(fontSize: 24, letterSpacing: 8),
          enabled: !isLoading,
        ),
        if (state.errorMessage != null) ...[
          const SizedBox(height: 12),
          Text(
            state.errorMessage!,
            style: const TextStyle(color: Colors.red),
            textAlign: TextAlign.center,
          ),
        ],
        if (state.attemptsLeft != null) ...[
          const SizedBox(height: 4),
          Text(
            'Осталось попыток: ${state.attemptsLeft}',
            style: const TextStyle(color: Colors.orange),
            textAlign: TextAlign.center,
          ),
        ],
        const SizedBox(height: 24),
        FilledButton(
          onPressed: isLoading
              ? null
              : () {
                  final code = _codeController.text.trim();
                  if (code.length == 4) {
                    ref
                        .read(registrationProvider.notifier)
                        .confirmCode(code);
                  }
                },
          child: isLoading
              ? const SizedBox(
                  height: 20,
                  width: 20,
                  child: CircularProgressIndicator(
                    strokeWidth: 2,
                    color: Colors.white,
                  ),
                )
              : const Text('Подтвердить'),
        ),
      ],
    );
  }

  Widget _buildError(RegistrationState state) {
    return Column(
      mainAxisAlignment: MainAxisAlignment.center,
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        const Icon(Icons.error_outline, size: 64, color: Colors.red),
        const SizedBox(height: 16),
        Text(
          state.errorMessage ?? 'Произошла ошибка',
          style: const TextStyle(fontSize: 16),
          textAlign: TextAlign.center,
        ),
        if (state.retryAfter != null) ...[
          const SizedBox(height: 8),
          Text(
            'Повторите через ${(state.retryAfter! / 60).ceil()} мин.',
            style: const TextStyle(color: Colors.grey),
            textAlign: TextAlign.center,
          ),
        ],
        const SizedBox(height: 24),
        FilledButton(
          onPressed: () {
            ref.invalidate(registrationProvider);
          },
          child: const Text('Попробовать снова'),
        ),
      ],
    );
  }
}
