import 'package:flutter/material.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:provider/provider.dart';

import 'host/host_controller.dart';
import 'router/app_router.dart';
import 'state/app_state.dart';
import 'theme/app_theme.dart';

/// 应用根：主题（浅色 / 深色 / 跟随系统）与语言由 [AppState] 驱动，
/// 后端生命周期由 [HostController] 驱动（进程级单例，由 main 创建后传入）。
class SilverMoonApp extends StatelessWidget {
  const SilverMoonApp({super.key, required this.host, required this.appState});

  final HostController host;

  /// 全局 UI 状态由 main.dart 创建：它要在宿主就绪后接入 settings.json 的读写回路。
  final AppState appState;

  @override
  Widget build(BuildContext context) {
    return MultiProvider(
      providers: [
        ChangeNotifierProvider<HostController>.value(value: host),
        ChangeNotifierProvider<AppState>.value(value: appState),
      ],
      child: Consumer<AppState>(
        builder: (BuildContext context, AppState state, Widget? child) {
          return MaterialApp.router(
            title: 'SilverMoon',
            debugShowCheckedModeBanner: false,
            theme: AppTheme.light(),
            darkTheme: AppTheme.dark(),
            themeMode: state.themeMode,
            routerConfig: appRouter,
            locale: state.locale,
            supportedLocales: AppState.supportedLocales,
            localizationsDelegates: const <LocalizationsDelegate<dynamic>>[
              GlobalMaterialLocalizations.delegate,
              GlobalWidgetsLocalizations.delegate,
              GlobalCupertinoLocalizations.delegate,
            ],
          );
        },
      ),
    );
  }
}
