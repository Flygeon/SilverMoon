/// 10 段 EQ 的固定频点（Hz），索引 0..9。
/// 首段 lowshelf(31Hz)、末段 highshelf(16kHz)、其余 peaking，Q = 1。
const List<double> kEqFrequencies = <double>[
  31, 62, 125, 250, 500, 1000, 2000, 4000, 8000, 16000,
];

const double kEqQ = 1;
const double kReverbSeconds = 1.8;
const double kReverbDecay = 3;
/// 参数平滑时间常数（秒）——对应 Web Audio 的 setTargetAtTime(t, 0.03)
const double kParamSmoothingSeconds = 0.03;

class EqBand {
  const EqBand({required this.frequency, this.gain = 0});

  final double frequency;

  /// 增益（dB）
  final double gain;

  EqBand copyWith({double? frequency, double? gain}) =>
      EqBand(frequency: frequency ?? this.frequency, gain: gain ?? this.gain);

  /// 频率显示：`31 / 62 / 125 / 250 / 500 / 1k / 2k / 4k / 8k / 16k`
  String get label => frequency >= 1000
      ? '${(frequency / 1000).round()}k'
      : frequency.round().toString();

  /// 增益显示：正数带 +
  String get gainLabel => gain > 0 ? '+${gain.round()}' : gain.round().toString();

  Map<String, dynamic> toJson() =>
      <String, dynamic>{'frequency': frequency, 'gain': gain};

  factory EqBand.fromJson(Map<String, dynamic> j) => EqBand(
        frequency: (j['frequency'] as num?)?.toDouble() ?? 0,
        gain: (j['gain'] as num?)?.toDouble() ?? 0,
      );
}

class AudioEffectConfig {
  AudioEffectConfig({
    this.enabled = false,
    List<EqBand>? eqBands,
    this.bassBoost = 0,
    this.reverb = 0,
    this.stereoWidth = 50,
    this.presetId = 'flat',
  }) : eqBands = eqBands ?? defaultEqBands();

  /// 关闭时走 bypass 直通，节点不销毁
  final bool enabled;

  /// 长度必须 = 10
  final List<EqBand> eqBands;

  /// 低音增强 dB，[-12, 12] 整数
  final double bassBoost;

  /// 混响干湿比，[0, 100] 整数
  final double reverb;

  /// 立体声宽度，[0, 100] 整数（0=单声道、50=原始、100=加宽）
  final double stereoWidth;

  /// 内置 id / `custom` / `custom-<timestamp>`
  final String presetId;

  static List<EqBand> defaultEqBands() =>
      kEqFrequencies.map((f) => EqBand(frequency: f)).toList(growable: false);

  AudioEffectConfig copyWith({
    bool? enabled,
    List<EqBand>? eqBands,
    double? bassBoost,
    double? reverb,
    double? stereoWidth,
    String? presetId,
  }) {
    return AudioEffectConfig(
      enabled: enabled ?? this.enabled,
      eqBands: eqBands ?? this.eqBands,
      bassBoost: bassBoost ?? this.bassBoost,
      reverb: reverb ?? this.reverb,
      stereoWidth: stereoWidth ?? this.stereoWidth,
      presetId: presetId ?? this.presetId,
    );
  }

  /// 手动改任一参数即置 custom
  AudioEffectConfig markCustom() => copyWith(presetId: 'custom');

  AudioEffectConfig deepCopy() => AudioEffectConfig(
        enabled: enabled,
        eqBands: eqBands.map((b) => b.copyWith()).toList(),
        bassBoost: bassBoost,
        reverb: reverb,
        stereoWidth: stereoWidth,
        presetId: presetId,
      );

  Map<String, dynamic> toJson() => <String, dynamic>{
        'enabled': enabled,
        'eqBands': eqBands.map((b) => b.toJson()).toList(),
        'bassBoost': bassBoost,
        'reverb': reverb,
        'stereoWidth': stereoWidth,
        'presetId': presetId,
      };

  factory AudioEffectConfig.fromJson(Map<String, dynamic> j) {
    final List<dynamic>? raw = j['eqBands'] as List<dynamic>?;
    List<EqBand> bands;
    if (raw == null || raw.length != 10) {
      bands = defaultEqBands();
    } else {
      bands = raw
          .map((e) => EqBand.fromJson(Map<String, dynamic>.from(e as Map)))
          .toList();
    }
    return AudioEffectConfig(
      enabled: j['enabled'] == true,
      eqBands: bands,
      bassBoost: _clampNum(j['bassBoost'], -12, 12, 0),
      reverb: _clampNum(j['reverb'], 0, 100, 0),
      stereoWidth: _clampNum(j['stereoWidth'], 0, 100, 50),
      presetId: (j['presetId'] ?? 'flat').toString(),
    );
  }

  static double _clampNum(Object? v, double min, double max, double fallback) {
    if (v is! num) return fallback;
    return v.toDouble().clamp(min, max).toDouble();
  }
}

/// 内置/用户预设。`gains` 是「段索引 -> dB」，未列出的段为 0。
class AudioEffectPreset {
  const AudioEffectPreset(
    this.id,
    this.name,
    this.gains, {
    this.bassBoost = 0,
    this.reverb = 0,
    this.stereoWidth = 50,
    this.builtin = true,
  });

  final String id;
  final String name;
  final Map<int, double> gains;
  final double bassBoost;
  final double reverb;
  final double stereoWidth;
  final bool builtin;

  AudioEffectConfig toConfig() {
    final List<EqBand> bands = <EqBand>[];
    for (int i = 0; i < kEqFrequencies.length; i++) {
      bands.add(EqBand(frequency: kEqFrequencies[i], gain: gains[i] ?? 0));
    }
    return AudioEffectConfig(
      enabled: true,
      eqBands: bands,
      bassBoost: bassBoost,
      reverb: reverb,
      stereoWidth: stereoWidth,
      presetId: id,
    );
  }

  Map<String, dynamic> toJson() => <String, dynamic>{
        'id': id,
        'name': name,
        'gains': gains.map((k, v) => MapEntry<String, dynamic>(k.toString(), v)),
        'bassBoost': bassBoost,
        'reverb': reverb,
        'stereoWidth': stereoWidth,
      };

  factory AudioEffectPreset.fromJson(Map<String, dynamic> j) {
    final Map<String, dynamic> raw =
        Map<String, dynamic>.from((j['gains'] as Map?) ?? <String, dynamic>{});
    return AudioEffectPreset(
      (j['id'] ?? '').toString(),
      (j['name'] ?? '').toString(),
      raw.map((k, v) => MapEntry<int, double>(
          int.tryParse(k) ?? 0, (v as num?)?.toDouble() ?? 0)),
      bassBoost: (j['bassBoost'] as num?)?.toDouble() ?? 0,
      reverb: (j['reverb'] as num?)?.toDouble() ?? 0,
      stereoWidth: (j['stereoWidth'] as num?)?.toDouble() ?? 50,
      builtin: false,
    );
  }
}

/// 桌面端 8 个内置预设（参数 1:1 取自 `utils/audioEffects.ts`）。
const List<AudioEffectPreset> kBuiltinPresets = <AudioEffectPreset>[
  AudioEffectPreset('flat', 'Flat', <int, double>{}),
  AudioEffectPreset('pop', 'Pop', <int, double>{1: 3, 3: 2, 5: 1, 7: 3, 9: 2}),
  AudioEffectPreset('rock', 'Rock', <int, double>{1: 4, 2: 3, 5: 2, 7: 3, 9: 4}),
  AudioEffectPreset('classical', 'Classical', <int, double>{0: 3, 4: -1, 8: 3, 9: 4}),
  AudioEffectPreset('dance', 'Dance', <int, double>{1: 5, 3: 3, 5: 0, 7: 2, 9: 4}),
  AudioEffectPreset(
    'bass_boost',
    'Bass Boost',
    <int, double>{0: 6, 1: 5},
    bassBoost: 8,
  ),
  AudioEffectPreset('vocal', 'Vocal', <int, double>{2: -2, 3: -1, 4: 2, 5: 4, 6: 3, 8: -1}),
];

/// 移动端补充预设（5 区域 dB 值，按设备实际频段最近邻映射）。
/// 数据源：参考实现 `md3Music/equalizer_service.dart` 的 customPresets。
const Map<String, List<double>> kMobilePresets = <String, List<double>>{
  '正常': <double>[0, 0, 0, 0, 0],
  '流行': <double>[-1, 2, 4, 2, -1],
  '摇滚': <double>[4, -1, 0, 3, 4],
  '爵士': <double>[3, 2, -1, 1, 3],
  '古典': <double>[4, 0, -1, 2, 4],
  '重低音': <double>[6, 0, 0, 0, 0],
  '高音增强': <double>[0, 0, 0, 4, 6],
  '人声': <double>[-2, 2, 4, 3, -1],
  '电子': <double>[4, -2, 0, 3, 5],
};

/// 5 区域边界（Hz）：bass / lowmid / mid / highmid / treble
const List<double> kEqZoneBoundaries = <double>[250, 500, 2000, 6000];

/// 把频率（Hz）映射到 5 区域索引（0-4）
int eqZoneIndex(double hz) {
  for (int i = 0; i < kEqZoneBoundaries.length; i++) {
    if (hz < kEqZoneBoundaries[i]) return i;
  }
  return kEqZoneBoundaries.length;
}
