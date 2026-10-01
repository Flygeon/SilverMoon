import 'package:flutter/material.dart';

import 'music_webview.dart';

/// /music/player —— 复用归档 Vue 播放层的全屏播放器。
///
/// 播放链路整体在 WebView 里（原样复用的 MusicView / PlayerView / MiniPlayer，
/// 以及 Web Audio 效果链），本页只负责把它挂进 Flutter 窗口。
class MusicPlayerPage extends StatelessWidget {
  const MusicPlayerPage({super.key});

  @override
  Widget build(BuildContext context) {
    return const MusicWebview(route: '/player');
  }
}
