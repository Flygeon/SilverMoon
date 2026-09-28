import 'dart:typed_data';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';

/// 封面取色：把封面缩到 64px，做 4bit/通道的直方图量化，
/// 取「占比最高且有一定饱和度」的色作为种子色，再交给 ColorScheme.fromSeed。
///
/// 与桌面端一致：播放器背景与主题色跟随封面。
class PaletteService {
  PaletteService._();

  static final Map<String, Color> _cache = <String, Color>{};

  static void remember(String key, Color color) => _cache[key] = color;

  static Color? recall(String key) => _cache[key];

  /// 从图片字节提取种子色；失败返回 null。
  static Future<Color?> seedFromBytes(Uint8List bytes) async {
    ui.Image? image;
    try {
      final ui.Codec codec = await ui.instantiateImageCodec(bytes, targetWidth: 64);
      final ui.FrameInfo frame = await codec.getNextFrame();
      image = frame.image;
      final ByteData? data =
          await image.toByteData(format: ui.ImageByteFormat.rawRgba);
      if (data == null) return null;
      final Uint8List px = data.buffer.asUint8List();

      // 4bit/通道 -> 4096 桶
      final List<int> count = List<int>.filled(4096, 0);
      final List<int> sumR = List<int>.filled(4096, 0);
      final List<int> sumG = List<int>.filled(4096, 0);
      final List<int> sumB = List<int>.filled(4096, 0);

      for (int i = 0; i + 3 < px.length; i += 4) {
        final int a = px[i + 3];
        if (a < 128) continue;
        final int r = px[i];
        final int g = px[i + 1];
        final int b = px[i + 2];
        final int key = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
        count[key]++;
        sumR[key] += r;
        sumG[key] += g;
        sumB[key] += b;
      }

      int bestKey = -1;
      double bestScore = 0;
      for (int k = 0; k < 4096; k++) {
        final int c = count[k];
        if (c == 0) continue;
        final double r = sumR[k] / c;
        final double g = sumG[k] / c;
        final double b = sumB[k] / c;
        final HSVColor hsv = HSVColor.fromColor(Color.fromARGB(255, r.round(), g.round(), b.round()));
        // 太暗/太亮/太灰的桶降权，避免取到黑边或白底
        double sat = hsv.saturation;
        double val = hsv.value;
        if (val < 0.18 || val > 0.95) continue;
        final double weight = c * (0.25 + sat * 0.75);
        if (weight > bestScore) {
          bestScore = weight;
          bestKey = k;
        }
      }

      if (bestKey < 0) return null;
      final int c = count[bestKey];
      final int r = (sumR[bestKey] / c).round();
      final int g = (sumG[bestKey] / c).round();
      final int b = (sumB[bestKey] / c).round();
      Color color = Color.fromARGB(255, r, g, b);
      // 提饱和，让种子色更有辨识度
      final HSVColor hsv = HSVColor.fromColor(color);
      color = hsv
          .withSaturation((hsv.saturation * 1.25).clamp(0.35, 0.9).toDouble())
          .withValue((hsv.value * 1.05).clamp(0.35, 0.95).toDouble())
          .toColor();
      return color;
    } catch (_) {
      return null;
    } finally {
      image?.dispose();
    }
  }

  /// 由种子色生成明暗两套 ColorScheme
  static ColorScheme schemeFromSeed(Color seed, Brightness brightness) =>
      ColorScheme.fromSeed(seedColor: seed, brightness: brightness);
}
