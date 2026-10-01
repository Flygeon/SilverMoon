import 'package:flutter/material.dart';
import 'package:window_manager/window_manager.dart';

import 'app.dart';

/// SilverMoon 桌面端（Flutter 宿主）入口。
///
/// 启动顺序沿用 Electron 版的语义：**窗口先出来**，后端握手并行进行，
/// 不允许退化成启动白屏。后端 sidecar 的拉起与握手属于 P0 后续步骤，
/// 在这里追加「并行 + 失败降级提示」，不要阻塞 runApp。
Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  await windowManager.ensureInitialized();

  const WindowOptions windowOptions = WindowOptions(
    size: Size(1280, 800),
    minimumSize: Size(1024, 640),
    center: true,
    backgroundColor: Color(0xFFFCFCFC),
    title: 'SilverMoon',
    // 无边框：Windows 原生标题栏被移除，改由 Flutter 的 WindowTitleBar 承担。
    titleBarStyle: TitleBarStyle.hidden,
  );

  await windowManager.waitUntilReadyToShow(windowOptions, () async {
    await windowManager.show();
    await windowManager.focus();
  });

  runApp(const SilverMoonApp());
}
