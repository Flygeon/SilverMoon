import 'package:flutter/material.dart';

import '../models/audio_effect_config.dart';
import '../models/play_mode.dart';
import '../models/settings.dart';
import '../services/json_store.dart';

/// 设置状态：持久化 + 主题/背景等派生视图。
class SettingsController extends ChangeNotifier {
  SettingsController({JsonStore? store, JsonStore? effectsStore})
      : _store = store ?? JsonStore('settings.json'),
        _effectsStore = effectsStore ?? JsonStore('effects.json');

  final JsonStore _store;
  final JsonStore _effectsStore;

  AppSettings _settings = const AppSettings();
  AudioEffectConfig _effects = AudioEffectConfig();
  bool _loaded = false;

  AppSettings get settings => _settings;

  AudioEffectConfig get effects => _effects;

  bool get loaded => _loaded;

  ThemeMode get themeMode {
    if (_settings.themeMode == 'light') return ThemeMode.light;
    if (_settings.themeMode == 'dark') return ThemeMode.dark;
    return ThemeMode.system;
  }

  bool get useDynamicColor => _settings.dynamicColor;

  PlayerBackground get playerBackground {
    for (final PlayerBackground b in PlayerBackground.values) {
      if (b.name == _settings.playerBg) return b;
    }
    return PlayerBackground.animated;
  }

  String get musicServerId => _settings.musicServer;

  Future<void> load() async {
    try {
      final Map<String, dynamic>? s = await _store.read();
      if (s != null) _settings = AppSettings.fromJson(s);
      final Map<String, dynamic>? e = await _effectsStore.read();
      if (e != null) _effects = AudioEffectConfig.fromJson(e);
    } catch (_) {
      // 用默认值
    }
    _loaded = true;
    notifyListeners();
  }

  Future<void> update(AppSettings Function(AppSettings) fn) async {
    _settings = fn(_settings);
    notifyListeners();
    await _store.write(_settings.toJson());
  }

  Future<void> setEffects(AudioEffectConfig cfg) async {
    _effects = cfg;
    notifyListeners();
    await _effectsStore.write(cfg.toJson());
  }

  Future<void> setThemeMode(String mode) =>
      update((AppSettings s) => s.copyWith(themeMode: mode));

  Future<void> setDynamicColor(bool on) =>
      update((AppSettings s) => s.copyWith(dynamicColor: on));

  Future<void> setPlayerBg(String bg) =>
      update((AppSettings s) => s.copyWith(playerBg: bg));

  Future<void> setMusicServer(String server) =>
      update((AppSettings s) => s.copyWith(musicServer: server));

  Future<void> setEnableOnlineMusic(bool on) =>
      update((AppSettings s) => s.copyWith(enableOnlineMusic: on));

  Future<void> setNeteaseEnabled(bool on) =>
      update((AppSettings s) => s.copyWith(neteaseEnabled: on));

  Future<void> setKugouEnabled(bool on) =>
      update((AppSettings s) => s.copyWith(kugouEnabled: on));

  Future<void> setWordLyrics(bool on) =>
      update((AppSettings s) => s.copyWith(wordLyrics: on));

  Future<void> setDetectInstrumental(bool on) =>
      update((AppSettings s) => s.copyWith(detectInstrumental: on));

  Future<void> setLyricFontSize(double v) =>
      update((AppSettings s) => s.copyWith(lyricFontSize: v));

  Future<void> setLyricLineGap(double v) =>
      update((AppSettings s) => s.copyWith(lyricLineGap: v));

  Future<void> setLyricTranslationSize(double v) =>
      update((AppSettings s) => s.copyWith(lyricTranslationSize: v));

  Future<void> setLyricSubMode(String v) =>
      update((AppSettings s) => s.copyWith(lyricSubMode: v));

  Future<void> setLyricBlur(bool on) =>
      update((AppSettings s) => s.copyWith(lyricBlur: on));

  Future<void> setMusicViewMode(String v) =>
      update((AppSettings s) => s.copyWith(musicViewMode: v));

  Future<void> setMinFileSizeMb(double v) =>
      update((AppSettings s) => s.copyWith(minFileSizeMb: v));

  Future<void> setScanDirs(List<String> dirs) =>
      update((AppSettings s) => s.copyWith(scanDirs: dirs));

  Future<void> setVolume(double v) =>
      update((AppSettings s) => s.copyWith(volume: v));

  Future<void> setPlaybackRate(double v) =>
      update((AppSettings s) => s.copyWith(playbackRate: v));

  Future<void> setEffectsEnabled(bool on) =>
      update((AppSettings s) => s.copyWith(effectsEnabled: on));
}
