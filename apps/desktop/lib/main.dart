import 'dart:async';

import 'package:flutter/material.dart';
import 'package:window_manager/window_manager.dart';

import 'app.dart';
import 'host/app_config.dart';
import 'host/host_controller.dart';
import 'host/json_store.dart';
import 'host/settings_store.dart';
import 'state/app_state.dart';

/// SilverMoon 桌面端（Flutter 宿主）入口。
///
/// 启动顺序沿用 Electron 版语义：**窗口先出来**，后端握手并行进行，
/// 不允许退化成启动白屏。窗口尺寸/标题/最小尺寸都取自
/// `backend/silvermoon.config.json`（单一真源），不在这里硬编码。
Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  await windowManager.ensureInitialized();

  final AppConfig config = await AppConfig.load();
  final AppState appState = AppState();

  final WindowOptions windowOptions = WindowOptions(
    size: Size(config.windowWidth, config.windowHeight),
    minimumSize: Size(config.windowMinWidth, config.windowMinHeight),
    center: config.windowCenter,
    backgroundColor: const Color(0xFFFCFCFC),
    title: config.windowTitle,
    // 无边框：Windows 原生标题栏被移除，改由 Flutter 的 WindowTitleBar 承担。
    titleBarStyle: TitleBarStyle.hidden,
  );

  await windowManager.waitUntilReadyToShow(windowOptions, () async {
    await windowManager.show();
    await windowManager.focus();
  });

  final HostController host = HostController(config);
  runApp(SilverMoonApp(host: host, appState: appState));

  // 窗口已经出来了，后端拉起与握手在这里并行推进；失败只降级成提示条。
  unawaited(_startHost(host, appState));
}

/// 拉起后端，并在数据目录就绪后接上「设置 ↔ settings.json」的读写回路。
///
/// 放在这里而不是 AppState 里的原因：settings.json 的路径由宿主层决定
/// （APPDATA/cn.cool.silvermoon），UI 状态不应当知道磁盘布局。
Future<void> _startHost(HostController host, AppState appState) async {
  await host.start();
  final JsonStore? store = host.store;
  if (store == null) return;

  final SettingsStore settings = SettingsStore(store);
  final Map<String, Object?> saved = settings.read();
  appState.applyStored(
    theme: saved['theme']?.toString(),
    lang: saved['lang']?.toString(),
  );
  appState.onPersist = (String key, Object? value) {
    settings.merge(<String, Object?>{key: value});
  };
}
