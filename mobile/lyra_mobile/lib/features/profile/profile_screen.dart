import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../app/theme.dart';
import '../../core/storage/secure_storage.dart';

class ProfileScreen extends ConsumerStatefulWidget {
  const ProfileScreen({super.key});

  @override
  ConsumerState<ProfileScreen> createState() => _ProfileScreenState();
}

class _ProfileScreenState extends ConsumerState<ProfileScreen> {
  final _nameController = TextEditingController();
  String _selectedRole = 'user';
  bool _isLoading = true;

  static const _roles = [
    ('user', 'Пользователь'),
    ('advanced_user_analyst', 'Системный аналитик'),
    ('advanced_user_dev', 'Программист 1С'),
  ];

  @override
  void initState() {
    super.initState();
    _loadProfile();
  }

  Future<void> _loadProfile() async {
    final storage = ref.read(secureStorageProvider);
    final name = await storage.getUserName();
    final role = await storage.getUserRole();
    if (mounted) {
      setState(() {
        if (name != null) _nameController.text = name;
        if (role != null) _selectedRole = role;
        _isLoading = false;
      });
    }
  }

  Future<void> _save() async {
    final storage = ref.read(secureStorageProvider);
    await storage.saveUserName(_nameController.text.trim());
    await storage.saveUserRole(_selectedRole);
    if (mounted) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('Сохранено')),
      );
    }
  }

  @override
  void dispose() {
    _nameController.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    if (_isLoading) {
      return const Scaffold(
        body: Center(child: CircularProgressIndicator()),
      );
    }

    return Scaffold(
      body: SafeArea(
        child: Column(
          children: [
            // Header
            _buildHeader(),
            // Content
            Expanded(
              child: Padding(
                padding: const EdgeInsets.all(20),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    const SizedBox(height: 4),
                    _buildSectionLabel('ИМЯ'),
                    const SizedBox(height: 8),
                    _buildNameField(),
                    const SizedBox(height: 24),
                    _buildSectionLabel('РОЛЬ'),
                    const SizedBox(height: 8),
                    ..._buildRoleOptions(),
                    const SizedBox(height: 8),
                    const Text(
                      'Определяет стиль общения с Лирой',
                      style: TextStyle(
                        fontSize: 13,
                        color: LyraTheme.textSecondary,
                      ),
                    ),
                    const Spacer(),
                    _buildSaveButton(),
                  ],
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }

  Widget _buildHeader() {
    return Container(
      decoration: const BoxDecoration(
        border: Border(
          bottom: BorderSide(color: LyraTheme.divider, width: 2),
        ),
      ),
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
        child: Row(
          children: [
            _buildBackButton(),
            const SizedBox(width: 8),
            const Text(
              'Профиль',
              style: TextStyle(
                fontSize: 17,
                fontWeight: FontWeight.w800,
                color: LyraTheme.textPrimary,
              ),
            ),
          ],
        ),
      ),
    );
  }

  Widget _buildBackButton() {
    return GestureDetector(
      onTap: () => context.go('/home'),
      child: Container(
        width: 40,
        height: 40,
        decoration: BoxDecoration(
          color: LyraTheme.bgAlt,
          border: Border.all(color: LyraTheme.divider),
          borderRadius: BorderRadius.circular(LyraTheme.radiusSm),
        ),
        child: const Icon(
          Icons.arrow_back,
          size: 20,
          color: LyraTheme.textSecondary,
        ),
      ),
    );
  }

  Widget _buildSectionLabel(String text) {
    return Text(
      text,
      style: const TextStyle(
        color: LyraTheme.textSecondary,
        fontSize: 12,
        fontWeight: FontWeight.w800,
        letterSpacing: 2,
      ),
    );
  }

  Widget _buildNameField() {
    return TextField(
      controller: _nameController,
      style: const TextStyle(fontSize: 16, color: LyraTheme.textPrimary),
      decoration: const InputDecoration(
        hintText: 'Как вас зовут?',
        hintStyle: TextStyle(color: LyraTheme.textMuted),
      ),
    );
  }

  List<Widget> _buildRoleOptions() {
    return _roles.map((entry) {
      final (key, label) = entry;
      final isSelected = _selectedRole == key;
      return Padding(
        padding: const EdgeInsets.only(bottom: 8),
        child: _buildRoleOption(
          label,
          isSelected,
          () => setState(() => _selectedRole = key),
        ),
      );
    }).toList();
  }

  Widget _buildRoleOption(String text, bool selected, VoidCallback onTap) {
    return GestureDetector(
      onTap: onTap,
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 14),
        decoration: BoxDecoration(
          color: selected ? LyraTheme.accentBg : Colors.white,
          border: Border.all(
            color: selected ? LyraTheme.accent : LyraTheme.divider,
            width: 2,
          ),
          borderRadius: BorderRadius.circular(LyraTheme.radiusSm),
        ),
        child: Row(
          children: [
            // Radio circle
            Container(
              width: 20,
              height: 20,
              decoration: BoxDecoration(
                shape: BoxShape.circle,
                border: Border.all(
                  color: selected ? LyraTheme.accent : LyraTheme.textMuted,
                  width: 2,
                ),
              ),
              child: selected
                  ? Center(
                      child: Container(
                        width: 10,
                        height: 10,
                        decoration: const BoxDecoration(
                          shape: BoxShape.circle,
                          color: LyraTheme.accent,
                        ),
                      ),
                    )
                  : null,
            ),
            const SizedBox(width: 12),
            Text(
              text,
              style: TextStyle(
                fontSize: 15,
                fontWeight: selected ? FontWeight.w700 : FontWeight.w600,
                color: selected ? LyraTheme.accent : LyraTheme.textPrimary,
              ),
            ),
          ],
        ),
      ),
    );
  }

  Widget _buildSaveButton() {
    return SizedBox(
      width: double.infinity,
      height: 52,
      child: ElevatedButton(
        onPressed: _save,
        child: const Text('СОХРАНИТЬ'),
      ),
    );
  }
}
