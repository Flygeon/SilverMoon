import 'package:flutter/material.dart';

/// SilverMoon 桌面端 M3 / M3E 设计令牌。
///
/// 数值 1:1 对应 Electron 版 `archive/electron-desktop/src/tokens/theme.css`，
/// 保证换壳前后的观感不漂移。组件里禁止出现魔法色值 / 魔法尺寸，一律走这里。
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

  // ---------------------------------------------------------------- 应用级布局
  // 对应 theme.css 的 --lm-* 令牌
  static const double titleBarHeight = 48;
  static const double navRailWidth = 88;
  static const double contentPad = 24;
  static const double miniPlayerHeight = 72;
  static const double navIndicatorWidth = 56;
  static const double navIndicatorHeight = 32;

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

  /// 毛玻璃模糊量（v2 皮肤布局令牌默认值）
  static const double surfaceBlur = 28;
}

/// M3 字阶（与 theme.css 的 --md-sys-typescale-* 同值）。
///
/// 只提供桌面端外壳真正用到的那几档，避免一上来堆一堆没人用的常量。
class SmText {
  SmText._();

  static const TextStyle titleLarge = TextStyle(
    fontSize: 22,
    fontWeight: FontWeight.w500,
    height: 28 / 22,
  );

  static const TextStyle titleMedium = TextStyle(
    fontSize: 16,
    fontWeight: FontWeight.w500,
    height: 24 / 16,
    letterSpacing: 0.15,
  );

  static const TextStyle titleSmall = TextStyle(
    fontSize: 14,
    fontWeight: FontWeight.w500,
    height: 20 / 14,
    letterSpacing: 0.1,
  );

  static const TextStyle bodyMedium = TextStyle(
    fontSize: 14,
    fontWeight: FontWeight.w400,
    height: 20 / 14,
    letterSpacing: 0.25,
  );

  static const TextStyle bodySmall = TextStyle(
    fontSize: 12,
    fontWeight: FontWeight.w400,
    height: 16 / 12,
    letterSpacing: 0.4,
  );

  static const TextStyle labelMedium = TextStyle(
    fontSize: 12,
    fontWeight: FontWeight.w500,
    height: 16 / 12,
    letterSpacing: 0.5,
  );

  static const TextStyle labelSmall = TextStyle(
    fontSize: 11,
    fontWeight: FontWeight.w500,
    height: 16 / 11,
    letterSpacing: 0.5,
  );
}
