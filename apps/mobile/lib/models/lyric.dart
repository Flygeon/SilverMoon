/// 逐字单元：一个字/词的绝对起止时间（秒）。
class WordUnit {
  const WordUnit({required this.text, required this.start, required this.end});

  final String text;
  final double start;
  final double end;

  double get duration => end - start;

  Map<String, dynamic> toJson() =>
      <String, dynamic>{'text': text, 'start': start, 'end': end};

  factory WordUnit.fromJson(Map<String, dynamic> j) => WordUnit(
        text: (j['text'] ?? '').toString(),
        start: (j['start'] as num?)?.toDouble() ?? 0,
        end: (j['end'] as num?)?.toDouble() ?? 0,
      );
}

/// 一行歌词。**没有 end 字段**（按需由下一行推导，见 [Lyrics.lineEnd]）。
class LyricLine {
  const LyricLine({
    required this.time,
    required this.text,
    this.translation,
    this.romaji,
    this.units,
    this.instrumental = false,
  });

  /// 行起始（秒）
  final double time;
  final String text;
  final String? translation;
  final String? romaji;

  /// 逐字时间轴；null = 整行一次性高亮
  final List<WordUnit>? units;

  /// 前奏/间奏「三点」标记行
  final bool instrumental;

  bool get hasWords => (units?.length ?? 0) > 1;

  /// 行结束时间的本地估计：有逐字时间轴时取末字结束，否则按字数估算。
  /// （精确的行结束需要下一行时间，见 [Lyrics.lineEnd]。）
  double get endTimeEstimate {
    final List<WordUnit>? u = units;
    if (u != null && u.isNotEmpty) return u.last.end;
    final double est = text.length * 0.4;
    return time + (est < 2 ? 2 : est);
  }

  /// 副行（翻译 / 罗马音二选一，不并排）
  String? subText(bool preferRomaji) {
    if (preferRomaji) {
      final String? r = romaji;
      if (r != null && r.trim().isNotEmpty) return r.trim();
    }
    final String? t = translation;
    if (t != null && t.trim().isNotEmpty) return t.trim();
    if (preferRomaji) {
      final String? t2 = translation;
      if (t2 != null && t2.trim().isNotEmpty) return t2.trim();
    }
    return null;
  }

  LyricLine copyWith({
    double? time,
    String? text,
    String? translation,
    String? romaji,
    List<WordUnit>? units,
    bool? instrumental,
  }) {
    return LyricLine(
      time: time ?? this.time,
      text: text ?? this.text,
      translation: translation ?? this.translation,
      romaji: romaji ?? this.romaji,
      units: units ?? this.units,
      instrumental: instrumental ?? this.instrumental,
    );
  }

  Map<String, dynamic> toJson() => <String, dynamic>{
        'time': time,
        'text': text,
        if (translation != null) 'translation': translation,
        if (romaji != null) 'romaji': romaji,
        if (units != null) 'units': units!.map((u) => u.toJson()).toList(),
        if (instrumental) 'instrumental': true,
      };

  factory LyricLine.fromJson(Map<String, dynamic> j) => LyricLine(
        time: (j['time'] as num?)?.toDouble() ?? 0,
        text: (j['text'] ?? '').toString(),
        translation: j['translation'] as String?,
        romaji: j['romaji'] as String?,
        units: (j['units'] as List<dynamic>?)
            ?.map((e) => WordUnit.fromJson(Map<String, dynamic>.from(e as Map)))
            .toList(),
        instrumental: j['instrumental'] == true,
      );
}

/// 一首歌的完整歌词（按 time 升序）。
class Lyrics {
  const Lyrics(this.lines);

  static const Lyrics empty = Lyrics(<LyricLine>[]);

  final List<LyricLine> lines;

  bool get isEmpty => lines.isEmpty;
  bool get isNotEmpty => lines.isNotEmpty;

  /// 是否存在逐字时间轴（至少一行有 >1 个词）
  bool get hasWordLevel => lines.any((l) => l.hasWords);

  /// 线性扫描，遇首个不满足即 break（依赖已升序）。
  /// 返回 -1 表示「还没到第一行」。
  int indexAt(double t) {
    int idx = -1;
    for (int i = 0; i < lines.length; i++) {
      if (t >= lines[i].time) {
        idx = i;
      } else {
        break;
      }
    }
    return idx;
  }

  LyricLine? lineAt(double t) {
    final int i = indexAt(t);
    return i >= 0 && i < lines.length ? lines[i] : null;
  }

  /// 行结束时间：下一行起始；末行用 `time + max(2, 字数 * 0.4)` 估算。
  double lineEnd(int index) {
    if (index < 0 || index >= lines.length) return 0;
    if (index + 1 < lines.length) return lines[index + 1].time;
    final LyricLine l = lines[index];
    final double est = l.text.length * 0.4;
    return l.time + (est < 2 ? 2 : est);
  }

  Lyrics withSubMode() => this;
}
