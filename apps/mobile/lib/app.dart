import 'dart:io';

import 'package:dynamic_color/dynamic_color.dart';
import 'package:flutter/material.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:permission_handler/permission_handler.dart';
import 'package:provider/provider.dart';

import 'services/bridge_online.dart';
import 'services/media_service.dart';
import 'services/player_service.dart';
import 'state/library_controller.dart';
import 'state/media_controller.dart';
import 'state/online_controller.dart';
import 'state/settings_controller.dart';
import 'theme/app_theme.dart';
import 'ui/app_shell.dart';

class SilverMoonApp extends StatefulWidget {
  const SilverMoonApp({super.key});

  @override
  State<SilverMoonApp> createState() => _SilverMoonAppState();
}

class _SilverMoonAppState extends State<SilverMoonApp> {
  late final SettingsController _settings;
  late final PlayerService _player;
  late final LibraryController _library;
  late final OnlineController _online;

  /// 在线服务（网易云 / 酷狗）。原生 UI 与桥接**共用这一个实例** ——
  /// 否则 cookie jar 各建各的，一边登录另一边看不见。
  late final OnlineMusicService _onlineMusic;

  late final MediaController _media;
  bool _ready = false;

  @override
  void initState() {
    super.initState();
    _settings = SettingsController();
    _player = PlayerService();
    _library = LibraryController();
    _onlineMusic = OnlineMusicService();
    _online = OnlineController(
      repository: _player.repository,
      online: _onlineMusic,
    );
    _media = MediaController(MediaService());
    _bootstrap();
  }

  Future<void> _bootstrap() async {
    // Android 13+ 的通知权限（媒体通知），失败不影响播放
    if (Platform.isAndroid) {
      try {
        await Permission.notification.request();
      } catch (_) {}
    }
    await _settings.load();
    await _player.init(
      volume: _settings.settings.volume,
      speed: _settings.settings.playbackRate,
      effectsConfig: _settings.effects,
      detectInstrumental: _settings.settings.detectInstrumental,
      // 必须是 false。这里是应用启动的最早期，恢复上次会话会让播放器预载
      // 一首歌、挂上自己的 MediaItem，冷启动就冒出一条「正在播放」通知，
      // 与用户「打开应用但还没点播放」的预期不符。
      restoreLastSession: false,
    );
    await _library.load();
    if (!mounted) return;
    setState(() => _ready = true);
  }

  @override
  void dispose() {
    _media.dispose();
    _player.dispose();
    _settings.dispose();
    _library.dispose();
    _online.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return MultiProvider(
      providers: [
        ChangeNotifierProvider<SettingsController>.value(value: _settings),
        ChangeNotifierProvider<PlayerService>.value(value: _player),
        ChangeNotifierProvider<LibraryController>.value(value: _library),
        ChangeNotifierProvider<OnlineController>.value(value: _online),
        Provider<OnlineMusicService>.value(value: _onlineMusic),
        ChangeNotifierProvider<MediaController>.value(value: _media),
      ],
      child: DynamicColorBuilder(builder: _buildThemedApp),
    );
  }

  Widget _buildThemedApp(ColorScheme? lightDynamic, ColorScheme? darkDynamic) {
    return Consumer<SettingsController>(
      builder: (BuildContext context, SettingsController s, Widget? _) {
              final ColorScheme light = AppTheme.schemeFor(
                Brightness.light,
                s.useDynamicColor ? lightDynamic : null,
              );
              final ColorScheme dark = AppTheme.schemeFor(
                Brightness.dark,
                s.useDynamicColor ? darkDynamic : null,
              );
              return MaterialApp(
                title: 'SilverMoon',
                debugShowCheckedModeBanner: false,
                theme: AppTheme.build(light),
                darkTheme: AppTheme.build(dark),
                themeMode: s.themeMode,
                localizationsDelegates: const <LocalizationsDelegate<dynamic>>[
                  GlobalMaterialLocalizations.delegate,
                  GlobalWidgetsLocalizations.delegate,
                  GlobalCupertinoLocalizations.delegate,
                ],
                supportedLocales: const <Locale>[
                  Locale('zh', 'CN'),
                  Locale('en', 'US'),
                ],
                locale: const Locale('zh', 'CN'),
                home: _ready
                    ? const AppShell()
                    : const _BootSplash(),
              );
      },
    );
  }
}

class _BootSplash extends StatelessWidget {
  const _BootSplash();

  @override
  Widget build(BuildContext context) {
    final ColorScheme scheme = Theme.of(context).colorScheme;
    return Scaffold(
      body: Center(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: <Widget>[
            Container(
              width: 84,
              height: 84,
              decoration: BoxDecoration(
                color: scheme.primaryContainer,
                borderRadius: BorderRadius.circular(24),
              ),
              child: Icon(
                Icons.nightlight_round,
                size: 42,
                color: scheme.onPrimaryContainer,
              ),
            ),
            const SizedBox(height: 20),
            Text(
              'SilverMoon',
              style: Theme.of(context).textTheme.titleLarge?.copyWith(
                    fontWeight: FontWeight.w700,
                    letterSpacing: 0.4,
                  ),
            ),
            const SizedBox(height: 18),
            const SizedBox(
              width: 22,
              height: 22,
              child: CircularProgressIndicator(strokeWidth: 2.4),
            ),
          ],
        ),
      ),
    );
  }
}
