import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../models/play_mode.dart';
import '../services/player_service.dart';
import '../state/library_controller.dart';
import '../state/settings_controller.dart';
import 'sheets.dart';
import 'widgets.dart';

/// 设置页（仅覆盖音乐播放器相关项，其余功能为占位）
class SettingsPage extends StatelessWidget {
  const SettingsPage({super.key});

  @override
  Widget build(BuildContext context) {
    final SettingsController s = context.watch<SettingsController>();
    final LibraryController lib = context.watch<LibraryController>();

    return Scaffold(
      appBar: AppBar(title: const Text('设置')),
      body: ListView(
        padding: const EdgeInsets.only(bottom: 32),
        children: <Widget>[
          const SmSectionHeader(title: '外观'),
          Padding(
            padding: const EdgeInsets.fromLTRB(20, 4, 20, 12),
            child: SmSegmented<String>(
              values: const <String>['system', 'light', 'dark'],
              labels: const <String>['跟随系统', '浅色', '深色'],
              selected: s.settings.themeMode,
              dense: true,
              onChanged: (String v) => s.setThemeMode(v),
            ),
          ),
          SwitchListTile(
            secondary: const Icon(Icons.palette_outlined),
            title: const Text('动态取色'),
            subtitle: const Text('跟随系统壁纸（Android 12+ / iOS 16+）'),
            value: s.settings.dynamicColor,
            onChanged: s.setDynamicColor,
          ),
          const SmSectionHeader(title: '播放器'),
          Padding(
            padding: const EdgeInsets.fromLTRB(20, 4, 20, 12),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: <Widget>[
                const Text('动态背景', style: TextStyle(fontWeight: FontWeight.w600)),
                const SizedBox(height: 8),
                SmSegmented<String>(
                  values: const <String>['animated', 'amll', 'image', 'off'],
                  labels: const <String>['动态渐变', 'AMLL', '封面模糊', '关闭'],
                  selected: s.settings.playerBg,
                  dense: true,
                  onChanged: (String v) => s.setPlayerBg(v),
                ),
              ],
            ),
          ),
          SwitchListTile(
            secondary: const Icon(Icons.blur_on_rounded),
            title: const Text('歌词背景模糊'),
            value: s.settings.lyricBlur,
            onChanged: s.setLyricBlur,
          ),
          SwitchListTile(
            secondary: const Icon(Icons.abc_rounded),
            title: const Text('逐字歌词'),
            subtitle: const Text('有逐字时间轴时按字高亮'),
            value: s.settings.wordLyrics,
            onChanged: s.setWordLyrics,
          ),
          SwitchListTile(
            secondary: const Icon(Icons.hourglass_empty_rounded),
            title: const Text('间奏识别'),
            subtitle: const Text('纯停顿超过 3 秒时插入等待标记'),
            value: s.settings.detectInstrumental,
            onChanged: (bool v) {
              s.setDetectInstrumental(v);
              context.read<PlayerService>().detectInstrumental = v;
            },
          ),
          const SmSectionHeader(title: '歌词'),
          _slider(
            context,
            icon: Icons.format_size_rounded,
            title: '歌词字号',
            value: s.settings.lyricFontSize,
            min: 16,
            max: 56,
            label: s.settings.lyricFontSize.round().toString(),
            onChanged: s.setLyricFontSize,
          ),
          _slider(
            context,
            icon: Icons.format_line_spacing_rounded,
            title: '歌词行间距',
            value: s.settings.lyricLineGap,
            min: 0,
            max: 60,
            label: s.settings.lyricLineGap.round().toString(),
            onChanged: s.setLyricLineGap,
          ),
          _slider(
            context,
            icon: Icons.translate_rounded,
            title: '翻译字号比例',
            value: s.settings.lyricTranslationSize,
            min: 40,
            max: 100,
            label: s.settings.lyricTranslationSize.round().toString() + '%',
            onChanged: s.setLyricTranslationSize,
          ),
          const Padding(
            padding: EdgeInsets.fromLTRB(20, 8, 20, 8),
            child: Text('副歌词显示', style: TextStyle(fontWeight: FontWeight.w600)),
          ),
          Padding(
            padding: const EdgeInsets.fromLTRB(20, 0, 20, 12),
            child: SmSegmented<String>(
              values: const <String>['translation', 'romaji', 'none'],
              labels: const <String>['翻译', '罗马音', '关闭'],
              selected: s.settings.lyricSubMode,
              dense: true,
              onChanged: (String v) => s.setLyricSubMode(v),
            ),
          ),
          const SmSectionHeader(title: '音效'),
          SwitchListTile(
            secondary: const Icon(Icons.graphic_eq_rounded),
            title: const Text('启用均衡器 / 音效'),
            subtitle: const Text('移动端支持硬件多段 EQ 与低音增强'),
            value: s.settings.effectsEnabled,
            onChanged: (bool v) {
              s.setEffectsEnabled(v);
              final PlayerService p = context.read<PlayerService>();
              p.setEffects(s.effects.copyWith(enabled: v));
            },
          ),
          ListTile(
            leading: const Icon(Icons.tune_rounded),
            title: const Text('打开音效面板'),
            trailing: const Icon(Icons.chevron_right_rounded),
            onTap: () => showEffectsSheet(context),
          ),
          const SmSectionHeader(title: '本地音乐'),
          ListTile(
            leading: const Icon(Icons.folder_outlined),
            title: const Text('扫描目录'),
            subtitle: Text(
              s.settings.scanDirs.isEmpty
                  ? '未设置（使用默认目录）'
                  : s.settings.scanDirs.join('\n'),
            ),
            isThreeLine: s.settings.scanDirs.length > 1,
            trailing: const Icon(Icons.refresh_rounded),
            onTap: () async {
              List<String> dirs = s.settings.scanDirs;
              if (dirs.isEmpty) {
                dirs = await lib.service.defaultScanDirs();
                await s.setScanDirs(dirs);
              }
              await lib.scan(dirs, minFileSizeMb: s.settings.minFileSizeMb);
              if (!context.mounted) return;
              ScaffoldMessenger.of(context).showSnackBar(
                SnackBar(content: Text(lib.message ?? '扫描完成')),
              );
              lib.clearMessage();
            },
          ),
          _slider(
            context,
            icon: Icons.filter_alt_outlined,
            title: '最小文件大小',
            value: s.settings.minFileSizeMb,
            min: 0,
            max: 20,
            label: s.settings.minFileSizeMb.round().toString() + ' MB',
            onChanged: s.setMinFileSizeMb,
          ),
          const SmSectionHeader(title: '在线音乐'),
          SwitchListTile(
            secondary: const Icon(Icons.cloud_outlined),
            title: const Text('启用在线音乐'),
            value: s.settings.enableOnlineMusic,
            onChanged: s.setEnableOnlineMusic,
          ),
          ListTile(
            leading: const Icon(Icons.dns_outlined),
            title: const Text('默认音源'),
            subtitle: Text(_serverLabel(s.settings.musicServer)),
            trailing: const Icon(Icons.chevron_right_rounded),
            onTap: () => _pickServer(context, s),
          ),
          const SmSectionHeader(title: '关于'),
          const ListTile(
            leading: Icon(Icons.info_outline_rounded),
            title: Text('SilverMoon'),
            subtitle: Text('Flutter 移动版 · 音乐播放器 · 0.0.1'),
          ),
        ],
      ),
    );
  }

  static String _serverLabel(String id) {
    for (final MusicServer m in MusicServer.values) {
      if (m.id == id) return m.label;
    }
    return id;
  }

  void _pickServer(BuildContext context, SettingsController s) {
    showModalBottomSheet<void>(
      context: context,
      showDragHandle: true,
      builder: (BuildContext c) => SafeArea(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: <Widget>[
            for (final MusicServer m in MusicServer.values)
              ListTile(
                title: Text(m.label),
                trailing: s.settings.musicServer == m.id
                    ? const Icon(Icons.check_rounded)
                    : null,
                onTap: () {
                  s.setMusicServer(m.id);
                  Navigator.pop(c);
                },
              ),
          ],
        ),
      ),
    );
  }

  Widget _slider(
    BuildContext context, {
    required IconData icon,
    required String title,
    required double value,
    required double min,
    required double max,
    required String label,
    required ValueChanged<double> onChanged,
  }) {
    return ListTile(
      leading: Icon(icon),
      title: Text(title),
      subtitle: Slider(
        value: value.clamp(min, max),
        min: min,
        max: max,
        divisions: (max - min).round(),
        label: label,
        onChanged: onChanged,
      ),
      trailing: SizedBox(
        width: 58,
        child: Text(label, textAlign: TextAlign.end),
      ),
    );
  }
}
