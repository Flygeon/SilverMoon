import 'dart:async';
import 'dart:math' as math;

import 'package:file_selector/file_selector.dart';
import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';
import 'package:provider/provider.dart';
import 'package:url_launcher/url_launcher.dart';

import '../../bridge/backend_client.dart';
import '../../host/host_controller.dart';
import '../../host/json_store.dart';
import '../../host/settings_store.dart';
import '../../i18n/sm_strings.dart';
import '../../state/app_state.dart';
import '../../theme/app_theme.dart';
import '../../theme/design_tokens.dart';
import 'settings_controller.dart';
import 'settings_schema.dart';

/// /settings —— 真实设置页。
///
/// 布局对齐 Electron 版 SettingsView.vue：左侧分节导航 + 右侧单列滚动，
/// 分节顺序与之一致（扫描目录 → 外观 → 配色 → 皮肤 → 播放器 → 歌词 →
/// 桌面歌词 → 阅读 → FFmpeg → 在线 → 弹幕 → WebDAV → 音效 → 关于）。
///
/// 73 个字段的键名、默认值、取值范围全部来自归档 stores/settings.ts 的 DEFAULTS，
/// 落盘走 SettingsStore.merge（只覆盖改动字段，不会抹掉尚未接管的字段）。
class SettingsPage extends StatelessWidget {
  const SettingsPage({super.key});

  @override
  Widget build(BuildContext context) {
    return const _SettingsView();
  }
}

class _SettingsView extends StatefulWidget {
  const _SettingsView();

  @override
  State<_SettingsView> createState() => _SettingsViewState();
}

class _SettingsViewState extends State<_SettingsView> {
  final ScrollController _scroll = ScrollController();
  final Map<String, GlobalKey> _sectionKeys = <String, GlobalKey>{};

  SettingsController? _controller;
  String _current = kSettingsSections.first.id;

  @override
  void initState() {
    super.initState();
    for (final SmSection section in kSettingsSections) {
      _sectionKeys[section.id] = GlobalKey();
    }
  }

  @override
  void dispose() {
    _scroll.dispose();
    _controller?.dispose();
    super.dispose();
  }

  /// 后端尚未就绪时 store 为空；就绪后自动补上（设置页可能先被打开）。
  void _ensureController(JsonStore? store) {
    if (_controller != null || store == null || !mounted) return;
    final SettingsController controller = SettingsController(
      store: SettingsStore(store),
      appState: context.read<AppState>(),
    );
    controller.load();
    setState(() => _controller = controller);
  }

  void _jumpTo(String id) {
    final BuildContext? target = _sectionKeys[id]?.currentContext;
    if (target == null) return;
    setState(() => _current = id);
    Scrollable.ensureVisible(
      target,
      duration: const Duration(milliseconds: 260),
      curve: SM.emphasizedDecelerate,
      alignment: 0.02,
    );
  }

  @override
  Widget build(BuildContext context) {
    final HostController host = context.watch<HostController>();
    final SmStrings sm = context.watch<AppState>().strings;
    _ensureController(host.store);
    final SettingsController? controller = _controller;

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: <Widget>[
        Padding(
          padding: const EdgeInsets.fromLTRB(SM.contentPad, SM.contentPad, SM.contentPad, 12),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: <Widget>[
              Text(
                sm.t('settings.title'),
                style: SmText.titleLarge.copyWith(color: context.scheme.onSurface),
              ),
              const SizedBox(height: 2),
              Text(
                sm.t('app.tagline'),
                style: SmText.bodySmall.copyWith(color: context.scheme.onSurfaceVariant),
              ),
            ],
          ),
        ),
        Expanded(
          child: controller == null
              ? Center(
                  child: Text(
                    sm.t('host.connecting'),
                    style: SmText.bodyMedium.copyWith(color: context.scheme.onSurfaceVariant),
                  ),
                )
              : Row(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: <Widget>[
                    _SectionNav(
                      current: _current,
                      onSelect: _jumpTo,
                      sm: sm,
                    ),
                    const VerticalDivider(width: 1),
                    Expanded(
                      child: Scrollbar(
                        controller: _scroll,
                        child: ListView(
                          controller: _scroll,
                          padding: const EdgeInsets.fromLTRB(SM.contentPad, 4, SM.contentPad, 40),
                          children: <Widget>[
                            for (final SmSection section in kSettingsSections)
                              _SectionCard(
                                key: _sectionKeys[section.id],
                                section: section,
                                controller: controller,
                                host: host,
                                sm: sm,
                              ),
                          ],
                        ),
                      ),
                    ),
                  ],
                ),
        ),
      ],
    );
  }
}

/// 左侧分节导航。
class _SectionNav extends StatelessWidget {
  const _SectionNav({required this.current, required this.onSelect, required this.sm});

  final String current;
  final void Function(String id) onSelect;
  final SmStrings sm;

  @override
  Widget build(BuildContext context) {
    final ColorScheme scheme = context.scheme;

    return SizedBox(
      width: 208,
      child: ListView(
        padding: const EdgeInsets.fromLTRB(12, 4, 12, 24),
        children: <Widget>[
          for (final SmSection section in kSettingsSections)
            Padding(
              padding: const EdgeInsets.only(bottom: 2),
              child: Material(
                color: current == section.id ? scheme.secondaryContainer : Colors.transparent,
                borderRadius: SM.rSmall,
                child: InkWell(
                  borderRadius: SM.rSmall,
                  onTap: () => onSelect(section.id),
                  child: Padding(
                    padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 9),
                    child: Row(
                      children: <Widget>[
                        Icon(
                          section.icon,
                          size: 18,
                          color: current == section.id
                              ? scheme.onSecondaryContainer
                              : scheme.onSurfaceVariant,
                        ),
                        const SizedBox(width: 10),
                        Expanded(
                          child: Text(
                            sm.t(section.titleKey),
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                            style: SmText.bodyMedium.copyWith(
                              color: current == section.id
                                  ? scheme.onSecondaryContainer
                                  : scheme.onSurfaceVariant,
                            ),
                          ),
                        ),
                      ],
                    ),
                  ),
                ),
              ),
            ),
        ],
      ),
    );
  }
}

/// 一个分节卡片：标题 + 说明 + 特殊区块 + 通用字段。
class _SectionCard extends StatelessWidget {
  const _SectionCard({
    super.key,
    required this.section,
    required this.controller,
    required this.host,
    required this.sm,
  });

  final SmSection section;
  final SettingsController controller;
  final HostController host;
  final SmStrings sm;

  @override
  Widget build(BuildContext context) {
    final ColorScheme scheme = context.scheme;

    return Padding(
      padding: const EdgeInsets.only(bottom: 14),
      child: Container(
        padding: const EdgeInsets.fromLTRB(20, 18, 20, 20),
        decoration: BoxDecoration(
          color: scheme.surfaceContainerLow,
          borderRadius: SM.rCard,
          border: Border.all(color: context.hairline),
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: <Widget>[
            Row(
              children: <Widget>[
                Icon(section.icon, size: 20, color: scheme.primary),
                const SizedBox(width: 10),
                Text(
                  sm.t(section.titleKey),
                  style: SmText.titleMedium.copyWith(color: scheme.onSurface),
                ),
              ],
            ),
            if (section.hintKey.isNotEmpty) ...<Widget>[
              const SizedBox(height: 6),
              Text(
                sm.t(section.hintKey),
                style: SmText.bodySmall.copyWith(color: scheme.onSurfaceVariant, height: 1.6),
              ),
            ],
            const SizedBox(height: 10),
            _slot(),
            for (final SmField field in section.fields)
              _FieldRow(field: field, controller: controller, sm: sm),
          ],
        ),
      ),
    );
  }

  Widget _slot() {
    switch (section.slot) {
      case SmSectionSlot.none:
        return const SizedBox.shrink();
      case SmSectionSlot.scanDirs:
        return _ScanDirsSlot(controller: controller, sm: sm);
      case SmSectionSlot.skins:
        return _SkinsSlot(controller: controller, host: host, sm: sm);
      case SmSectionSlot.ffmpeg:
        return _FfmpegSlot(controller: controller, host: host, sm: sm);
      case SmSectionSlot.audioEffects:
        return _AudioEffectsSlot(sm: sm);
      case SmSectionSlot.about:
        return _AboutSlot(sm: sm, host: host);
    }
  }
}

/// 字段行：标签 / 说明在左，控件在右（滑块与文本占整行）。
class _FieldRow extends StatelessWidget {
  const _FieldRow({required this.field, required this.controller, required this.sm});

  final SmField field;
  final SettingsController controller;
  final SmStrings sm;

  @override
  Widget build(BuildContext context) {
    switch (field.kind) {
      case SmFieldKind.toggle:
        return _ToggleField(field: field, controller: controller, sm: sm);
      case SmFieldKind.sliderInt:
      case SmFieldKind.sliderDouble:
        return _SliderField(field: field, controller: controller, sm: sm);
      case SmFieldKind.text:
      case SmFieldKind.secret:
        return _TextFieldTile(field: field, controller: controller, sm: sm);
      case SmFieldKind.choice:
        return _ChoiceField(field: field, controller: controller, sm: sm);
      case SmFieldKind.colorSeed:
        return _SeedField(field: field, controller: controller, sm: sm);
      case SmFieldKind.readonly:
        return _ReadonlyField(field: field, controller: controller, sm: sm);
    }
  }
}

String _formatValue(SmStrings sm, SmField field, double value) {
  final Object? off = field.offAtValue;
  if (off is num && (off.toDouble() - value).abs() < 0.001 && field.offLabelKey.isNotEmpty) {
    return sm.t(field.offLabelKey);
  }
  final String number = field.kind == SmFieldKind.sliderDouble
      ? value.toStringAsFixed(2)
      : value.round().toString();
  return number + field.suffix;
}

class _FieldLabel extends StatelessWidget {
  const _FieldLabel({required this.field, required this.sm, this.trailing});

  final SmField field;
  final SmStrings sm;
  final Widget? trailing;

  @override
  Widget build(BuildContext context) {
    final ColorScheme scheme = context.scheme;

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: <Widget>[
        Row(
          children: <Widget>[
            Expanded(
              child: Text(
                sm.t(field.labelKey),
                style: SmText.bodyMedium.copyWith(color: scheme.onSurface),
              ),
            ),
            if (trailing != null) trailing!,
          ],
        ),
        if (field.hintKey.isNotEmpty) ...<Widget>[
          const SizedBox(height: 2),
          Text(
            sm.t(field.hintKey),
            style: SmText.bodySmall.copyWith(color: scheme.onSurfaceVariant, height: 1.55),
          ),
        ],
      ],
    );
  }
}

class _ToggleField extends StatelessWidget {
  const _ToggleField({required this.field, required this.controller, required this.sm});

  final SmField field;
  final SettingsController controller;
  final SmStrings sm;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 6),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          Expanded(child: _FieldLabel(field: field, sm: sm)),
          const SizedBox(width: 12),
          Switch(
            value: controller.boolOf(field),
            onChanged: (bool next) => controller.set(field, next),
          ),
        ],
      ),
    );
  }
}

class _SliderField extends StatelessWidget {
  const _SliderField({required this.field, required this.controller, required this.sm});

  final SmField field;
  final SettingsController controller;
  final SmStrings sm;

  @override
  Widget build(BuildContext context) {
    final ColorScheme scheme = context.scheme;
    final double value = controller.numOf(field);
    final int? divisions = field.divisions ?? (field.kind == SmFieldKind.sliderInt
        ? (field.max - field.min).round()
        : null);

    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 6),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          _FieldLabel(
            field: field,
            sm: sm,
            trailing: Text(
              _formatValue(sm, field, value),
              style: SmText.labelMedium.copyWith(color: scheme.primary),
            ),
          ),
          Slider(
            // 用 math.min/max 而不是 clamp：clamp 的静态返回类型是 num。
            value: math.max(field.min.toDouble(), math.min(field.max.toDouble(), value)),
            min: field.min.toDouble(),
            max: field.max.toDouble(),
            divisions: divisions,
            onChanged: (double next) {
              controller.set(field, field.kind == SmFieldKind.sliderInt ? next.round() : next);
            },
          ),
        ],
      ),
    );
  }
}

/// 文本字段自持一个 TextEditingController，避免每次重建打断输入法。
class _TextFieldTile extends StatefulWidget {
  const _TextFieldTile({required this.field, required this.controller, required this.sm});

  final SmField field;
  final SettingsController controller;
  final SmStrings sm;

  @override
  State<_TextFieldTile> createState() => _TextFieldTileState();
}

class _TextFieldTileState extends State<_TextFieldTile> {
  late final TextEditingController _text =
      TextEditingController(text: widget.controller.stringOf(widget.field));

  @override
  void dispose() {
    _text.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final String current = widget.controller.stringOf(widget.field);
    if (current != _text.text && !_text.selection.isValid) {
      _text.text = current;
    }

    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 6),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          _FieldLabel(field: widget.field, sm: widget.sm),
          const SizedBox(height: 8),
          TextField(
            controller: _text,
            obscureText: widget.field.kind == SmFieldKind.secret,
            style: SmText.bodyMedium,
            decoration: InputDecoration(
              hintText: widget.field.placeholderKey.isEmpty
                  ? null
                  : widget.sm.t(widget.field.placeholderKey),
            ),
            onChanged: (String next) => widget.controller.set(widget.field, next.trim()),
          ),
        ],
      ),
    );
  }
}

class _ChoiceField extends StatelessWidget {
  const _ChoiceField({required this.field, required this.controller, required this.sm});

  final SmField field;
  final SettingsController controller;
  final SmStrings sm;

  @override
  Widget build(BuildContext context) {
    final String current = controller.stringOf(field);

    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 6),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          _FieldLabel(field: field, sm: sm),
          const SizedBox(height: 8),
          Wrap(
            spacing: 8,
            runSpacing: 8,
            children: <Widget>[
              for (final SmChoice choice in field.choices)
                ChoiceChip(
                  label: Text(sm.t(choice.labelKey)),
                  selected: current == choice.value,
                  onSelected: (bool selected) {
                    if (selected) controller.set(field, choice.value);
                  },
                ),
            ],
          ),
        ],
      ),
    );
  }
}

/// 种子色色板：7 个预设 + 自定义十六进制。
class _SeedField extends StatefulWidget {
  const _SeedField({required this.field, required this.controller, required this.sm});

  final SmField field;
  final SettingsController controller;
  final SmStrings sm;

  @override
  State<_SeedField> createState() => _SeedFieldState();
}

class _SeedFieldState extends State<_SeedField> {
  late final TextEditingController _hex =
      TextEditingController(text: widget.controller.stringOf(widget.field));
  static final RegExp _hexPattern = RegExp(r'^#[0-9a-fA-F]{6}$');

  @override
  void dispose() {
    _hex.dispose();
    super.dispose();
  }

  static Color _parse(String hex) {
    final String body = hex.replaceFirst('#', '');
    final int? value = int.tryParse(body, radix: 16);
    return value == null ? const Color(0xFF1A5C9E) : Color(0xFF000000 | value);
  }

  @override
  Widget build(BuildContext context) {
    final ColorScheme scheme = context.scheme;
    final String current = widget.controller.stringOf(widget.field).toUpperCase();

    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 6),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          _FieldLabel(field: widget.field, sm: widget.sm),
          const SizedBox(height: 10),
          Wrap(
            spacing: 12,
            runSpacing: 12,
            children: <Widget>[
              for (final SmChoice seed in kColorSeeds)
                Tooltip(
                  message: widget.sm.t(seed.labelKey),
                  child: InkWell(
                    borderRadius: BorderRadius.circular(SM.cornerFull),
                    onTap: () {
                      widget.controller.set(widget.field, seed.value);
                      _hex.text = seed.value;
                    },
                    child: Container(
                      width: 34,
                      height: 34,
                      decoration: BoxDecoration(
                        color: _parse(seed.value),
                        shape: BoxShape.circle,
                        border: Border.all(
                          color: current == seed.value.toUpperCase()
                              ? scheme.onSurface
                              : Colors.transparent,
                          width: 3,
                        ),
                      ),
                    ),
                  ),
                ),
            ],
          ),
          const SizedBox(height: 12),
          Row(
            children: <Widget>[
              Expanded(
                child: TextField(
                  controller: _hex,
                  style: SmText.bodyMedium,
                  decoration: InputDecoration(
                    labelText: widget.sm.t('settings.colorCustom'),
                    hintText: '#1A5C9E',
                  ),
                  onChanged: (String next) {
                    final String value = next.trim();
                    if (_hexPattern.hasMatch(value)) {
                      widget.controller.set(widget.field, value.toUpperCase());
                    }
                  },
                ),
              ),
            ],
          ),
        ],
      ),
    );
  }
}

class _ReadonlyField extends StatelessWidget {
  const _ReadonlyField({required this.field, required this.controller, required this.sm});

  final SmField field;
  final SettingsController controller;
  final SmStrings sm;

  @override
  Widget build(BuildContext context) {
    final ColorScheme scheme = context.scheme;
    final Object? value = controller.valueOf(field);
    String text = value == null ? '' : value.toString();
    if (text.isEmpty) text = sm.t('settings.unknown');

    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 6),
      child: Row(
        children: <Widget>[
          Expanded(
            child: Text(
              sm.t(field.labelKey),
              style: SmText.bodyMedium.copyWith(color: scheme.onSurface),
            ),
          ),
          const SizedBox(width: 12),
          Flexible(
            child: Text(
              text,
              textAlign: TextAlign.right,
              style: SmText.bodySmall.copyWith(color: scheme.onSurfaceVariant),
            ),
          ),
        ],
      ),
    );
  }
}

/// 扫描目录：逐个添加 / 删除，空列表即全局扫描。
class _ScanDirsSlot extends StatelessWidget {
  const _ScanDirsSlot({required this.controller, required this.sm});

  final SettingsController controller;
  final SmStrings sm;

  Future<void> _add() async {
    final String? dir = await getDirectoryPath(confirmButtonText: sm.t('settings.addScanDir'));
    if (dir != null && dir.isNotEmpty) controller.addScanDir(dir);
  }

  @override
  Widget build(BuildContext context) {
    final ColorScheme scheme = context.scheme;
    final List<String> dirs = controller.scanDirs();

    return Padding(
      padding: const EdgeInsets.only(bottom: 6),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          Container(
            width: double.infinity,
            padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
            decoration: BoxDecoration(
              color: scheme.surfaceContainerHigh,
              borderRadius: SM.rSmall,
            ),
            child: Row(
              children: <Widget>[
                Icon(
                  dirs.isEmpty ? Icons.public : Icons.folder_outlined,
                  size: 16,
                  color: scheme.onSurfaceVariant,
                ),
                const SizedBox(width: 8),
                Expanded(
                  child: Text(
                    dirs.isEmpty ? sm.t('settings.globalScanHint') : sm.t('settings.scanDirs'),
                    style: SmText.bodySmall.copyWith(color: scheme.onSurfaceVariant),
                  ),
                ),
              ],
            ),
          ),
          const SizedBox(height: 8),
          for (final String dir in dirs)
            Padding(
              padding: const EdgeInsets.only(bottom: 4),
              child: Row(
                children: <Widget>[
                  Expanded(
                    child: Text(
                      dir,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: SmText.bodySmall.copyWith(color: scheme.onSurface),
                    ),
                  ),
                  IconButton(
                    tooltip: sm.t('actions.delete'),
                    icon: const Icon(Icons.close, size: 16),
                    onPressed: () => controller.removeScanDir(dir),
                  ),
                ],
              ),
            ),
          const SizedBox(height: 4),
          Wrap(
            spacing: 8,
            children: <Widget>[
              FilledButton.tonalIcon(
                onPressed: () => unawaited(_add()),
                icon: const Icon(Icons.add, size: 16),
                label: Text(sm.t('settings.addScanDir')),
              ),
              if (dirs.isNotEmpty)
                TextButton(
                  onPressed: controller.clearScanDirs,
                  child: Text(sm.t('settings.clearScanDirs')),
                ),
            ],
          ),
        ],
      ),
    );
  }
}

/// 皮肤：列出后端已装皮肤 + 恢复默认。
class _SkinsSlot extends StatefulWidget {
  const _SkinsSlot({required this.controller, required this.host, required this.sm});

  final SettingsController controller;
  final HostController host;
  final SmStrings sm;

  @override
  State<_SkinsSlot> createState() => _SkinsSlotState();
}

class _SkinsSlotState extends State<_SkinsSlot> {
  List<Map<String, Object?>> _skins = <Map<String, Object?>>[];
  String? _error;

  @override
  void initState() {
    super.initState();
    unawaited(_load());
  }

  Future<void> _load() async {
    final BackendClient? client = widget.host.client;
    if (client == null) return;
    try {
      final Object? data = (await client.invoke('skin_list', const <String, Object?>{})).unwrap();
      final List<Map<String, Object?>> skins = <Map<String, Object?>>[];
      if (data is List) {
        for (final Object? item in data) {
          if (item is Map) skins.add(item.cast<String, Object?>());
        }
      }
      if (mounted) setState(() {
        _skins = skins;
        _error = null;
      });
    } catch (error) {
      if (mounted) setState(() => _error = error.toString());
    }
  }

  Future<void> _openDir() async {
    final BackendClient? client = widget.host.client;
    if (client == null) return;
    try {
      final Object? dir = (await client.invoke('skin_dir', const <String, Object?>{}))
          .unwrap();
      if (dir is String && dir.isNotEmpty) {
        await launchUrl(Uri.file(dir));
      }
    } catch (_) {
      // 目录打不开不影响设置页其余部分
    }
  }

  @override
  Widget build(BuildContext context) {
    final ColorScheme scheme = context.scheme;
    final String active = widget.controller.stringValue('activeSkin', '');

    return Padding(
      padding: const EdgeInsets.only(bottom: 6),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          if (_error != null)
            Text(
              widget.sm.t('settings.skinBroken') + ' ' + _error!,
              style: SmText.bodySmall.copyWith(color: scheme.error),
            )
          else if (_skins.isEmpty)
            Text(
              widget.sm.t('settings.skinDefault'),
              style: SmText.bodySmall.copyWith(color: scheme.onSurfaceVariant),
            )
          else
            Wrap(
              spacing: 8,
              runSpacing: 8,
              children: <Widget>[
                for (final Map<String, Object?> skin in _skins)
                  ChoiceChip(
                    label: Text(
                      (skin['name'] ?? skin['id'] ?? '?').toString(),
                      style: SmText.bodySmall,
                    ),
                    selected: active.isNotEmpty && active == skin['id']?.toString(),
                    onSelected: (bool selected) {
                      if (selected) widget.controller.setRaw('activeSkin', skin['id']);
                    },
                  ),
              ],
            ),
          const SizedBox(height: 10),
          Wrap(
            spacing: 8,
            children: <Widget>[
              TextButton(
                onPressed: () => widget.controller.setRaw('activeSkin', ''),
                child: Text(widget.sm.t('settings.skinRestoreDefault')),
              ),
              TextButton(
                onPressed: () => unawaited(_openDir()),
                child: Text(widget.sm.t('settings.skinImport')),
              ),
            ],
          ),
        ],
      ),
    );
  }
}

/// FFmpeg：显示检测结果，可指定目录 / 重新检测 / 打开下载页。
class _FfmpegSlot extends StatefulWidget {
  const _FfmpegSlot({required this.controller, required this.host, required this.sm});

  final SettingsController controller;
  final HostController host;
  final SmStrings sm;

  @override
  State<_FfmpegSlot> createState() => _FfmpegSlotState();
}

class _FfmpegSlotState extends State<_FfmpegSlot> {
  Map<String, Object?> _status = <String, Object?>{};
  bool _busy = false;

  @override
  void initState() {
    super.initState();
    unawaited(_refresh());
  }

  Future<void> _refresh() async {
    final BackendClient? client = widget.host.client;
    if (client == null || _busy) return;
    setState(() => _busy = true);
    try {
      final Object? data = (await client.invoke('ffmpeg_status', const <String, Object?>{})).unwrap();
      if (mounted && data is Map) setState(() => _status = data.cast<String, Object?>());
    } catch (_) {
      // 未就绪时保持上一次结果
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _pickDir() async {
    final String? dir = await getDirectoryPath(confirmButtonText: widget.sm.t('settings.ffmpegChoose'));
    if (dir == null || dir.isEmpty) return;
    await _setPath(dir);
  }

  Future<void> _setPath(String? dir) async {
    final BackendClient? client = widget.host.client;
    widget.controller.setRaw('ffmpegDir', dir ?? '');
    if (client == null) return;
    try {
      final Object? data = (await client.invoke('ffmpeg_set_path', <String, Object?>{'dir': dir}))
          .unwrap();
      if (mounted && data is Map) setState(() => _status = data.cast<String, Object?>());
    } catch (_) {
      // 忽略：状态行会保持旧值
    }
  }

  Future<void> _openDownload() async {
    final BackendClient? client = widget.host.client;
    if (client == null) return;
    try {
      final Object? url = (await client.invoke('ffmpeg_download_url', const <String, Object?>{})).unwrap();
      if (url is String && url.isNotEmpty) await launchUrl(Uri.parse(url));
    } catch (_) {
      // 打不开下载页不影响设置页
    }
  }

  @override
  Widget build(BuildContext context) {
    final ColorScheme scheme = context.scheme;
    final bool available = _status['available'] == true || _status['found'] == true;
    final String source = (_status['source'] ?? '').toString();
    final String version = (_status['version'] ?? '').toString();
    final String dir = widget.controller.stringValue('ffmpegDir', '');

    return Padding(
      padding: const EdgeInsets.only(bottom: 6),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          Row(
            children: <Widget>[
              Icon(
                available ? Icons.check_circle_outline : Icons.error_outline,
                size: 16,
                color: available ? scheme.primary : scheme.error,
              ),
              const SizedBox(width: 8),
              Expanded(
                child: Text(
                  (available
                          ? widget.sm.t('settings.ffmpegDetected')
                          : widget.sm.t('settings.ffmpegMissing')) +
                      (version.isEmpty ? '' : ' · ' + version) +
                      (source.isEmpty ? '' : ' · ' + source),
                  style: SmText.bodySmall.copyWith(color: scheme.onSurfaceVariant),
                ),
              ),
            ],
          ),
          if (dir.isNotEmpty) ...<Widget>[
            const SizedBox(height: 4),
            Text(
              widget.sm.t('settings.ffmpegFromOverride') + '：' + dir,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: SmText.bodySmall.copyWith(color: scheme.onSurfaceVariant),
            ),
          ],
          const SizedBox(height: 10),
          Wrap(
            spacing: 8,
            runSpacing: 8,
            children: <Widget>[
              FilledButton.tonalIcon(
                onPressed: () => unawaited(_pickDir()),
                icon: const Icon(Icons.folder_open, size: 16),
                label: Text(widget.sm.t('settings.ffmpegChoose')),
              ),
              TextButton(
                onPressed: () => unawaited(_refresh()),
                child: Text(widget.sm.t('settings.ffmpegRecheck')),
              ),
              TextButton(
                onPressed: dir.isEmpty ? null : () => unawaited(_setPath(null)),
                child: Text(widget.sm.t('settings.ffmpegReset')),
              ),
              TextButton(
                onPressed: () => unawaited(_openDownload()),
                child: Text(widget.sm.t('settings.ffmpegDownload')),
              ),
            ],
          ),
        ],
      ),
    );
  }
}

/// 音效：数据在 audio-effects.json，编辑界面依赖播放器层（WebView2 复用 Vue 播放器）。
class _AudioEffectsSlot extends StatelessWidget {
  const _AudioEffectsSlot({required this.sm});

  final SmStrings sm;

  @override
  Widget build(BuildContext context) {
    final ColorScheme scheme = context.scheme;

    return Padding(
      padding: const EdgeInsets.only(bottom: 6),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          Text(
            sm.t('settings.audioEffectsPending'),
            style: SmText.bodySmall.copyWith(color: scheme.onSurfaceVariant, height: 1.6),
          ),
          const SizedBox(height: 10),
          FilledButton.tonalIcon(
            onPressed: () => context.go('/treasure/market'),
            icon: const Icon(Icons.storefront_outlined, size: 16),
            label: Text(sm.t('settings.market.title')),
          ),
        ],
      ),
    );
  }
}

/// 关于：版本 / 许可证 / 缓存 / DevTools。
class _AboutSlot extends StatefulWidget {
  const _AboutSlot({required this.sm, required this.host});

  final SmStrings sm;
  final HostController host;

  @override
  State<_AboutSlot> createState() => _AboutSlotState();
}

class _AboutSlotState extends State<_AboutSlot> {
  String _message = '';

  Future<void> _openDevTools() async {
    final BackendClient? client = widget.host.client;
    if (client == null) return;
    try {
      await client.invoke('open_devtools', const <String, Object?>{});
    } catch (error) {
      if (mounted) setState(() => _message = error.toString());
    }
  }

  Future<void> _clearCache() async {
    final BackendClient? client = widget.host.client;
    if (client == null) return;
    try {
      await client.invoke('clear_thumbnail_cache', const <String, Object?>{});
      if (mounted) setState(() => _message = widget.sm.t('settings.cacheCleared'));
    } catch (error) {
      if (mounted) setState(() => _message = error.toString());
    }
  }

  @override
  Widget build(BuildContext context) {
    final ColorScheme scheme = context.scheme;
    final String version = widget.host.config.version;

    return Padding(
      padding: const EdgeInsets.only(bottom: 6),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          Row(
            children: <Widget>[
              Text(
                widget.sm.t('app.name'),
                style: SmText.titleMedium.copyWith(color: scheme.onSurface),
              ),
              const SizedBox(width: 8),
              Text(
                widget.sm.t('settings.version') + ' ' + version,
                style: SmText.bodySmall.copyWith(color: scheme.onSurfaceVariant),
              ),
            ],
          ),
          const SizedBox(height: 4),
          Text(
            widget.sm.t('app.tagline'),
            style: SmText.bodySmall.copyWith(color: scheme.onSurfaceVariant),
          ),
          const SizedBox(height: 10),
          Wrap(
            spacing: 8,
            runSpacing: 8,
            children: <Widget>[
              TextButton(
                onPressed: () => showLicensePage(
                  context: context,
                  applicationName: widget.sm.t('app.name'),
                  applicationVersion: version,
                ),
                child: Text(widget.sm.t('settings.licenses')),
              ),
              TextButton(
                onPressed: () => unawaited(_clearCache()),
                child: Text(widget.sm.t('settings.clearCache')),
              ),
              TextButton(
                onPressed: () => unawaited(_openDevTools()),
                child: Text(widget.sm.t('settings.devtools')),
              ),
            ],
          ),
          if (_message.isNotEmpty) ...<Widget>[
            const SizedBox(height: 6),
            Text(
              _message,
              style: SmText.bodySmall.copyWith(color: scheme.onSurfaceVariant),
            ),
          ],
        ],
      ),
    );
  }
}
