import 'package:flutter/material.dart';
import 'package:just_audio_background/just_audio_background.dart';

import 'app.dart';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();

  // 后台播放 / 通知栏 / 锁屏控制（Android MediaSession、iOS Now Playing）
  await JustAudioBackground.init(
    androidNotificationChannelId: 'cn.cool.silvermoon.channel.audio',
    androidNotificationChannelName: 'SilverMoon 播放',
    androidNotificationChannelDescription: '音乐播放控制',
    androidNotificationOngoing: true,
    androidStopForegroundOnPause: true,
    androidNotificationIcon: 'mipmap/ic_launcher',
  );

  runApp(const SilverMoonApp());
}
