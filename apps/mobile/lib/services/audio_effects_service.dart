import 'package:flutter/foundation.dart';
import 'package:just_audio/just_audio.dart';

import '../models/audio_effect_config.dart';

/// 音效引擎（移动端）。
///
/// 移动端没有 Web Audio 那种任意信号链，能力边界：
/// - 支持：多段硬件 EQ（AndroidEqualizer，频段数由设备决定，通常 5 段）
///         + 低音增强（低频段增益 + AndroidLoudnessEnhancer）
/// - 不支持：混响（桌面端 ConvolverNode）、立体声宽度矩阵（桌面端 Splitter/Merger）
///   —— 这两项由桌面端 Web Audio 实现，移动端 UI 会标注为不可用。
///
/// 桌面端 10 段 EQ 参数按「最近频点」映射到设备实际频段。
class AudioEffectsService {
  AudioEffectsService({
    required this.equalizer,
    required this.loudness,
  });

  final AndroidEqualizer equalizer;
  final AndroidLoudnessEnhancer loudness;

  bool _available = false;
  AndroidEqualizerParameters? _params;
  AudioEffectConfig _config = AudioEffectConfig();

  AudioEffectConfig get config => _config;

  /// 当前平台是否支持硬件音效
  bool get platformSupported =>
      !kIsWeb && defaultTargetPlatform == TargetPlatform.android;

  /// 硬件音效是否真的可用（初始化成功过）
  bool get available => _available;

  /// 设备实际频段中心频率；不可用时回落到桌面端 10 段频点
  List<double> get bandFrequencies {
    final AndroidEqualizerParameters? p = _params;
    if (p == null) return kEqFrequencies;
    return p.bands.map((AndroidEqualizerBand b) => b.centerFrequency).toList();
  }

  double get minDecibels => _params?.minDecibels ?? -15;

  double get maxDecibels => _params?.maxDecibels ?? 15;

  Future<void> init(AudioEffectConfig initial) async {
    _config = initial;
    if (!platformSupported) return;
    try {
      _params = await equalizer.parameters;
      _available = true;
      await apply(initial);
    } catch (e) {
      debugPrint('[Effects] 硬件均衡器不可用: ' + e.toString());
      _available = false;
    }
  }

  /// 把配置下发到硬件
  Future<void> apply(AudioEffectConfig cfg) async {
    _config = cfg;
    final AndroidEqualizerParameters? p = _params;
    if (!platformSupported || !_available || p == null) return;
    try {
      await equalizer.setEnabled(cfg.enabled);
      final bool bass = cfg.enabled && cfg.bassBoost > 0;
      await loudness.setEnabled(bass);
      if (bass) {
        await loudness.setTargetGain(cfg.bassBoost.clamp(0, 15).toDouble());
      }
      if (!cfg.enabled) return;
      for (final AndroidEqualizerBand band in p.bands) {
        final double g = deviceGainFor(band.centerFrequency, cfg)
            .clamp(p.minDecibels, p.maxDecibels)
            .toDouble();
        await band.setGain(g);
      }
    } catch (e) {
      debugPrint('[Effects] 下发失败: ' + e.toString());
    }
  }

  /// 某个设备频段应取的增益（dB）：
  /// 取 10 段配置里最近频点的增益；低频段（<=250Hz）额外叠加 bassBoost。
  double deviceGainFor(double centerHz, AudioEffectConfig cfg) {
    int nearest = 0;
    double best = double.infinity;
    for (int i = 0; i < cfg.eqBands.length && i < kEqFrequencies.length; i++) {
      final double d = (cfg.eqBands[i].frequency - centerHz).abs();
      if (d < best) {
        best = d;
        nearest = i;
      }
    }
    double gain = cfg.eqBands[nearest].gain;
    if (centerHz <= 250) gain += cfg.bassBoost;
    return gain;
  }

  Future<void> dispose() async {
    try {
      await equalizer.setEnabled(false);
      await loudness.setEnabled(false);
    } catch (_) {}
  }
}
