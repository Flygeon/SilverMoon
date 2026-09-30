import 'dart:async';
import 'dart:io';

import 'package:dynamic_color/dynamic_color.dart';
import 'package:flutter/material.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:permission_handler/permission_handler.dart';
import 'package:provider/provider.dart';

import 'services/bridge_commands.dart';
import 'services/bridge_service.dart';
import 'services/media_service.dart';
import 'services/player_service.dart';
import 'services/web_host_service.dart';
import 'state/library_controller.dart';
import 'state/media_controller.dart';
import 'state/online_controller.dart';
import 'models/settings.dart';
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

  /// 音乐页签的 WebView 宿主：loopback HTTP 服务 + JS 桥。
  late final WebHostService _webHost;
  late final BridgeService _bridge;
  late final MediaController _media;
  bool _ready = false;

  @override
  void initState() {
    super.initState();
    _settings = SettingsController();
    _player = PlayerService();
    _library = LibraryController();
    _online = OnlineController(repository: _player.repository);
    _webHost = WebHostService();
    _bridge = BridgeService(host: _webHost);
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
    // 原生设置页改动的项要能作用到 WebView 里的音乐页。两套设置的键空间
    // 不同（见 BridgeService.pushWebSettings），所以这里显式推一次；
    // 首次启动时这一推也顺带把 enableOnlineMusic 这类默认值对齐 ——
    // Vue 侧的默认是关，原生侧默认是开，不推的话音乐页永远看不到在线入口。
    _settings.addListener(_scheduleWebSettingsPush);
    unawaited(_bridge.pushWebSettings(_webSettingsPatch(_settings.settings)));
    await _player.init(
      volume: _settings.settings.volume,
      speed: _settings.settings.playbackRate,
      effectsConfig: _settings.effects,
      detectInstrumental: _settings.settings.detectInstrumental,
      restoreLastSession: true,
    );
    await _library.load();
    // 先把 loopback 服务起起来，WebView 才能加载到 Vue 产物与本地媒体文件
    await _webHost.start();
    _bridge.registerCommands(
      buildBridgeCommands(host: _webHost, bridge: _bridge),
    );
    if (!mounted) return;
    setState(() => _ready = true);
  }

  /// 原生设置 -> WebView 设置的键映射。
  ///
  /// 只有 theme 一个名字不同（Vue 用 theme，原生的 AppSettings 用 themeMode），
  /// 其余字段刻意同名 —— AppSettings 的字段名本来就是照着 settings.ts 的
  /// DEFAULTS 起的，便于两边互导。
  Map<String, Object?> _webSettingsPatch(AppSettings s) => <String, Object?>{
        'theme': s.themeMode,
        'enableOnlineMusic': s.enableOnlineMusic,
        'musicServer': s.musicServer,
        // Vue 侧的 enabledServers 由这两个开关推导（settings.ts:269），
        // 它们为 false 时平台条整个不渲染 —— 也就是没有切源、没有登录入口。
        'neteaseEnabled': s.neteaseEnabled,
        'kugouEnabled': s.kugouEnabled,
        'playerBg': s.playerBg,
        'wordLyrics': s.wordLyrics,
        'detectInstrumental': s.detectInstrumental,
        'lyricBlur': s.lyricBlur,
        'lyricFontSize': s.lyricFontSize,
        'lyricLineGap': s.lyricLineGap,
        'lyricTranslationSize': s.lyricTranslationSize,
        'lyricSubMode': s.lyricSubMode,
        'minFileSizeMb': s.minFileSizeMb,
      };

  /// 拖滑块会高频触发 notifyListeners，每次都落盘没必要。
  Timer? _webPushTimer;

  void _scheduleWebSettingsPush() {
    _webPushTimer?.cancel();
    _webPushTimer = Timer(const Duration(milliseconds: 400), () {
      unawaited(_bridge.pushWebSettings(_webSettingsPatch(_settings.settings)));
    });
  }

  @override
  void dispose() {
    _webPushTimer?.cancel();
    _bridge.dispose();
    _webHost.stop();
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
        Provider<WebHostService>.value(value: _webHost),
        Provider<BridgeService>.value(value: _bridge),
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
