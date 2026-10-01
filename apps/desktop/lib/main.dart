import 'dart:async';

import 'package:flutter/material.dart';
import 'package:window_manager/window_manager.dart';

import 'app.dart';
import 'host/app_config.dart';
import 'host/host_controller.dart';

/// SilverMoon 桌面端（Flutter 宿主）入口。
///
/// 启动顺序沿用 Electron 版语义：**窗口先出来**，后端握手并行进行，
/// 不允许退化成启动白屏。窗口尺寸/标题/最小尺寸都取自
/// `backend/silvermoon.config.json`（单一真源），不在这里硬编码。
Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  await windowManager.ensureInitialized();

  final AppConfig config = await AppConfig.load();

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
  runApp(SilverMoonApp(host: host));

  // 窗口已经出来了，后端拉起与握手在这里并行推进；失败只降级成提示条。
  unawaited(host.start());
}
