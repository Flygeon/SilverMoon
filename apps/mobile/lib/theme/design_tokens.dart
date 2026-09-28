import 'package:flutter/material.dart';

/// SilverMoon M3 / M3E 设计令牌。
///
/// 数值 1:1 对应桌面端 `apps/desktop/src/tokens/theme.css`，保证两端观感一致。
/// 组件里禁止出现魔法色值/魔法尺寸，一律走这里。
class SM {
  SM._();

  // ---------------------------------------------------------------- 圆角档位
  static const double cornerNone = 0;
  static const double cornerXs = 4;
  static const double cornerS = 8;
  static const double cornerM = 12;
  static const double cornerL = 16;
  static const double cornerLIncreased = 20;
  static const double cornerXl = 28;
  static const double cornerXlIncreased = 32;
  static const double corner2Xl = 48;
  static const double cornerFull = 999;

  /// 产品语义圆角：按钮=胶囊、卡片=20、对话框/浮层=28
  static const BorderRadius rButton = BorderRadius.all(Radius.circular(cornerFull));
  static const BorderRadius rCard = BorderRadius.all(Radius.circular(cornerLIncreased));
  static const BorderRadius rCardInner = BorderRadius.all(Radius.circular(cornerM));
  static const BorderRadius rDialog = BorderRadius.all(Radius.circular(cornerXl));
  static const BorderRadius rSmall = BorderRadius.all(Radius.circular(cornerS));
  static const BorderRadius rMedium = BorderRadius.all(Radius.circular(cornerM));

  // ---------------------------------------------------------------- 间距
  static const double space50 = 2;
  static const double space100 = 4;
  static const double space150 = 6;
  static const double space200 = 8;
  static const double space250 = 10;
  static const double space300 = 12;
  static const double space400 = 16;
  static const double space500 = 20;
  static const double space600 = 24;
  static const double space800 = 32;
  static const double space1000 = 40;

  // ---------------------------------------------------------------- 动效
  static const Duration durShort = Duration(milliseconds: 200);
  static const Duration durMedium = Duration(milliseconds: 300);
  static const Duration durLong = Duration(milliseconds: 500);

  /// M3E 空间弹簧（阻尼 0.8 / 刚度 400，峰值 1.0152）——位移、尺寸
  static const Curve springSpatial = Cubic(0.3, 1.4, 0.5, 1);

  /// M3E 快速空间弹簧（阻尼 0.8 / 刚度 1500）——小幅交互反馈
  static const Curve springSpatialFast = Cubic(0.34, 1.2, 0.64, 1);

  /// M3E 效果弹簧（临界阻尼，不回弹）——颜色、透明度、阴影
  static const Curve springEffects = Cubic(0.2, 0.0, 0.0, 1.0);
  static const Curve springEffectsFast = Cubic(0.2, 0.0, 0.0, 1.0);

  static const Curve emphasized = Cubic(0.2, 0.0, 0.0, 1.0);
  static const Curve emphasizedDecelerate = Cubic(0.05, 0.7, 0.1, 1.0);
  static const Curve emphasizedAccelerate = Cubic(0.3, 0.0, 0.8, 0.15);

  /// 播放器专用（Apple Music 蓝本，写死勿改）
  static const Curve amEaseOutBack = Cubic(0.25, 0.8, 0.25, 1.0);
  static const Curve amEaseLyric = Cubic(0.19, 0.11, 0.0, 1.0);

  /// 毛玻璃模糊量
  static const double surfaceBlur = 28;

  /// 迷你播放器高度
  static const double miniPlayerHeight = 64;

  // ---------------------------------------------------------------- 播放器
  static const double playerCoverRatio = 0.14; // 封面圆角 = 尺寸的 14%
  static const double playerProgressWidth = 425;
  static const double playerProgressHeight = 6;
  static const double playerProgressHeightHover = 12;
  static const double playerMainButton = 64;
  static const double playerSideButton = 44;

  // ---------------------------------------------------------------- 歌词
  static const Color lyricUnsung = Color(0x59FFFFFF); // rgba(255,255,255,0.35)
  static const Color lyricInactive = Color(0x33FFFFFF); // rgba(255,255,255,0.2)
  static const Color lyricSung = Color(0xFFFFFFFF);
  static const Color lyricSoft = Color(0x59FFFFFF);
  static const double lyricOffsetDivisor = 2.6; // 当前行停靠在容器高度 / 2.6
}

/// 播放器页配色令牌（Apple Music 风格，全屏黑底白字）
class PlayerTokens {
  PlayerTokens._();
  static const Color background = Color(0xFF000000);
  static const Color foreground = Color(0xFFFFFFFF);
  static const Color scrimTop = Color(0x80000000); // rgba(0,0,0,.5)
  static const Color panelSurface = Color(0xD11C1C1E); // rgba(28,28,30,.82)
  static const Color panelBorder = Color(0x1FFFFFFF); // rgba(255,255,255,.12)
  static const Color divider = Color(0x1FFFFFFF);
  static const Color currentQueueItem = Color(0x24FFFFFF); // rgba(255,255,255,.14)
  static const Color segmentedTrack = Color(0x1FFFFFFF); // rgba(255,255,255,.12)
}
