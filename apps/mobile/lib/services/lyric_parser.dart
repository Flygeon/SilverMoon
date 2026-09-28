import 'dart:convert';
import 'dart:io' show zlib;
import 'dart:typed_data';

import '../models/lyric.dart';

/// 逐字歌词时间轴引擎（Dart 版，1:1 移植自桌面端 utils/lyricTimeline.ts）。
///
/// 粗排策略：行 [start, end] 内把 N 个词均分到前 85% 时长，末尾留 ~15% 尾音停顿。
/// 行 end = 下一行 start（末行按字数估算）。纯比例，无音频分析。
class LyricParser {
  LyricParser._();

  // ------------------------------------------------------------ 分词 / 粗排

  /// 分词：CJK 每字一个单元；连续拉丁字母/数字/撇号/连字符合并为词。
  /// 空格结束当前词并并入词尾（保留英文词间分隔）。
  static List<String> tokenizeLyric(String text) {
    final List<String> parts = <String>[];
    for (final int r in text.runes) {
      parts.add(String.fromCharCode(r));
    }
    final List<String> tokens = <String>[];
    String latin = '';
    void push(String t) {
      if (t.isNotEmpty) tokens.add(t);
    }

    for (final String p in parts) {
      if (RegExp(r"[A-Za-z0-9'’’-]").hasMatch(p)) {
        latin += p;
      } else if (RegExp(r'\s').hasMatch(p)) {
        if (latin.isNotEmpty) {
          latin += p;
          push(latin);
          latin = '';
        } else if (tokens.isNotEmpty) {
          tokens[tokens.length - 1] = tokens[tokens.length - 1] + p;
        }
      } else {
        if (latin.isNotEmpty) {
          push(latin);
          latin = '';
        }
        push(p);
      }
    }
    push(latin);
    return tokens;
  }

  /// 行内按字数比例生成粗略时间轴；end 为下一行 start。
  static List<WordUnit> buildRoughUnits(String text, double start, double end) {
    final List<String> tokens = tokenizeLyric(text);
    if (tokens.isEmpty) return const <WordUnit>[];
    final double total = (end - start) < 0.05 ? 0.05 : (end - start);
    final double sung = total * 0.85;
    final double step = (sung / tokens.length) < 0.03 ? 0.03 : (sung / tokens.length);
    final List<WordUnit> out = <WordUnit>[];
    for (int i = 0; i < tokens.length; i++) {
      out.add(WordUnit(
        text: tokens[i],
        start: start + i * step,
        end: i == tokens.length - 1 ? start + sung : start + (i + 1) * step,
      ));
    }
    return out;
  }

  /// 末行无下一行时按字数估算时长
  static double estimateLineEnd(String text) {
    final double est = text.length * 0.4;
    return est < 2 ? 2 : est;
  }

  static void attachRoughTimeline(List<LyricLine> lines) {
    for (int i = 0; i < lines.length; i++) {
      final LyricLine line = lines[i];
      final double nextStart =
          i + 1 < lines.length ? lines[i + 1].time : line.time + estimateLineEnd(line.text);
      lines[i] = line.copyWith(units: buildRoughUnits(line.text, line.time, nextStart));
    }
  }

  // ------------------------------------------------------ 前奏 / 间奏识别

  /// 纯停顿超过此秒数视为间奏，插入三点等待
  static const double instrumentalThreshold = 3.0;

  /// 作词/作曲/编曲等元数据行（前奏信息，隐藏原文替换为三点）。
  static final RegExp metaRe = RegExp(
    r'^\s*(作词|作曲|编曲|制作人|出品人|OP|SP|监制|混音|录音|和声|母带|编曲人|制作|出品|词|曲)\s*[:：]'
    r'|^QQ音乐享有本[^。]*著作权',
  );

  static const String _punct =
      '，。！？、；：""\'\'（）《》〈〉【】…—,.!?;:"\'()[]{}<>~-·|/\\*&^%#@+=_';

  static bool _isSungChar(String ch) {
    if (ch.trim().isEmpty) return false;
    return !_punct.contains(ch);
  }

  /// 行演唱时长估算：真实演唱字符按 0.3s，标点与空格按 0.05s。
  static double singingEstimate(String text) {
    double sung = 0;
    double other = 0;
    for (final int r in text.runes) {
      if (_isSungChar(String.fromCharCode(r))) {
        sung++;
      } else {
        other++;
      }
    }
    final double v = sung * 0.3 + other * 0.05;
    return v < 1.2 ? 1.2 : v;
  }

  /// 生成「三点」标记行：三个实心点逐字填充
  static LyricLine _makeDotsLine(double start, double end) {
    final double duration = (end - start) < 0.3 ? 0.3 : (end - start);
    final double step = duration / 3;
    return LyricLine(
      time: start,
      text: '•••',
      instrumental: true,
      units: <WordUnit>[
        for (int i = 0; i < 3; i++)
          WordUnit(text: '•', start: start + i * step, end: start + (i + 1) * step),
      ],
    );
  }

  /// 构建最终歌词序列（对应 buildLyricSequence）。
  static Lyrics buildSequence(List<LyricLine> rawLines, {bool detectInstrumental = true}) {
    if (rawLines.isEmpty) return Lyrics.empty;

    if (!detectInstrumental) {
      final List<LyricLine> copy = List<LyricLine>.from(rawLines);
      attachRoughTimeline(copy);
      return Lyrics(copy);
    }

    final List<LyricLine> meta = <LyricLine>[];
    final List<LyricLine> lyrics = <LyricLine>[];
    for (final LyricLine l in rawLines) {
      if (metaRe.hasMatch(l.text)) {
        meta.add(l);
      } else {
        lyrics.add(l);
      }
    }
    if (lyrics.isEmpty) return Lyrics(rawLines);

    final List<LyricLine> out = <LyricLine>[];
    final double introStart = meta.isNotEmpty ? meta.first.time : 0;
    if (lyrics.first.time - introStart >= 1.0) {
      out.add(_makeDotsLine(introStart, lyrics.first.time));
    }

    for (int i = 0; i < lyrics.length; i++) {
      final LyricLine line = lyrics[i];
      final LyricLine? next = i + 1 < lyrics.length ? lyrics[i + 1] : null;
      final double est = line.text.length * 0.4;
      final double end = next != null ? next.time : line.time + (est < 2 ? 2 : est);
      final double gap = end - line.time;
      final double sing = gap < singingEstimate(line.text) ? gap : singingEstimate(line.text);
      final double pause = gap - sing > 0 ? gap - sing : 0;
      out.add(line.copyWith(units: buildRoughUnits(line.text, line.time, line.time + sing)));
      if (next != null && pause >= instrumentalThreshold) {
        out.add(_makeDotsLine(line.time + sing, next.time));
      }
    }
    return Lyrics(out);
  }

  // ------------------------------------------------------------------- LRC

  /// LRC 时间戳：同时支持点号毫秒 [mm:ss.xx] / [mm:ss.xxx] 与冒号厘秒 [mm:ss:cc]。
  static final RegExp lrcTimeRe = RegExp(r'\[(\d{2}):(\d{2})(?:[:.]((?:\d{2}|\d{3})))?\]');
  static final RegExp lrcTrRe = RegExp(r'\[tr:(.*?)\]');
  static final RegExp _trailingParenRe = RegExp(r'\s*[（(]([^（）()]*)[）)]\s*$');
  static final RegExp _instrumentalPlaceholderRe = RegExp(r'^[•·。\s]+$');

  static double? _timeFromMatch(RegExpMatch m) {
    final int mm = int.tryParse(m.group(1) ?? '0') ?? 0;
    final int ss = int.tryParse(m.group(2) ?? '0') ?? 0;
    final String? frac = m.group(3);
    double sub = 0;
    if (frac != null) {
      if (frac.length == 3) {
        sub = (int.tryParse(frac) ?? 0) / 1000.0;
      } else {
        sub = (int.tryParse(frac) ?? 0) / 100.0;
      }
    }
    return mm * 60 + ss + sub;
  }

  /// 双语 LRC 解析器。支持：
  /// 1. 同时间戳双行  2. [tr:翻译] 标签  3. 同行尾部括号译文  4. 单语歌词
  static Lyrics parseLrc(String text, {bool detectInstrumental = true}) {
    final List<String> lines = text.trim().split(RegExp(r'\r?\n'));
    final Map<int, LyricLine> map = <int, LyricLine>{};

    for (final String rawLine in lines) {
      final String line = rawLine.trim();
      if (line.isEmpty) continue;

      String? trText;
      final RegExpMatch? trMatch = lrcTrRe.firstMatch(line);
      if (trMatch != null) trText = trMatch.group(1)?.trim();

      final List<RegExpMatch> matches = lrcTimeRe.allMatches(line).toList();
      if (matches.isEmpty) continue;

      String content = line.replaceAll(lrcTimeRe, '').replaceAll(lrcTrRe, '').trim();
      if (content.isEmpty && trText == null) continue;

      // 同行尾部括号译文（meting 常见）
      String? trailing;
      if (content.isNotEmpty) {
        final RegExpMatch? pm = _trailingParenRe.firstMatch(content);
        if (pm != null) {
          final String before = content.substring(0, pm.start).trim();
          if (before.isNotEmpty) {
            trailing = pm.group(1)?.trim();
            content = before;
          }
        }
      }
      if (content.isEmpty) continue;

      final String? translation = trText ?? trailing;

      for (final RegExpMatch m in matches) {
        final double? t = _timeFromMatch(m);
        if (t == null) continue;
        final int key = (t * 1000).round();
        final LyricLine? existing = map[key];
        if (existing == null) {
          map[key] = LyricLine(time: t, text: content, translation: translation);
        } else {
          // 同时间戳的第二行成为第一行的 translation；已存在则不覆盖
          if (existing.translation == null) {
            map[key] = existing.copyWith(translation: translation ?? content);
          }
        }
      }
    }

    final List<LyricLine> raw = map.values.toList()
      ..sort((LyricLine a, LyricLine b) => a.time.compareTo(b.time));
    return buildSequence(raw, detectInstrumental: detectInstrumental);
  }

  /// 去掉纯占位/空行
  static List<LyricLine> stripPlaceholders(List<LyricLine> lines) => lines
      .where((l) =>
          !(l.text.trim().isEmpty || _instrumentalPlaceholderRe.hasMatch(l.text.trim())))
      .toList();

  // ------------------------------------------------------------------- KRC

  /// 酷狗 KRC 解密密钥（16 字节）
  static const List<int> krcKey = <int>[
    0x40, 0x47, 0x61, 0x77, 0x5e, 0x32, 0x74, 0x47,
    0x51, 0x36, 0x31, 0x2d, 0xce, 0xd2, 0x6e, 0x69,
  ];

  /// base64 -> 跳过前 4 字节 -> 逐字节异或 -> zlib inflate -> UTF-8
  static String? krcDecrypt(String b64) {
    try {
      final Uint8List data = base64.decode(b64.trim().replaceAll(RegExp(r'\s'), ''));
      if (data.length <= 4) return null;
      final Uint8List body = Uint8List.sublistView(data, 4);
      final Uint8List dec = Uint8List(body.length);
      for (int i = 0; i < body.length; i++) {
        dec[i] = body[i] ^ krcKey[i % 16];
      }
      return utf8.decode(zlib.decode(dec), allowMalformed: true);
    } catch (_) {
      return null;
    }
  }

  static final RegExp _krcTagRe = RegExp(r'^\[(\w+):([^\]]*)\]$');
  static final RegExp _krcLineRe = RegExp(r'^\[(\d+),(\d+)\](.*)$');
  static final RegExp _krcWordRe = RegExp(
    r'(?:\[\d+,\d+\])?<(\d+),(\d+),\d+>((?:.(?!\d+,\d+,\d+>))*)',
    dotAll: true,
  );

  static Lyrics parseKrc(String b64, {bool detectInstrumental = true}) {
    final String? plain = krcDecrypt(b64);
    if (plain == null) return Lyrics.empty;
    return parseKrcPlain(plain, detectInstrumental: detectInstrumental);
  }

  static Lyrics parseKrcPlain(String plain, {bool detectInstrumental = true}) {
    final List<String> rows = plain.split(RegExp(r'\r?\n'));
    final Map<String, String> tags = <String, String>{};
    final List<LyricLine> raw = <LyricLine>[];

    for (final String row in rows) {
      final String line = row.trimRight();
      if (!line.startsWith('[')) continue;

      final RegExpMatch? tag = _krcTagRe.firstMatch(line.trim());
      if (tag != null) {
        tags[tag.group(1) ?? ''] = tag.group(2) ?? '';
        continue;
      }

      final RegExpMatch? lm = _krcLineRe.firstMatch(line.trim());
      if (lm == null) continue;
      final double lineStart = double.parse(lm.group(1)!);
      final double lineDuration = double.parse(lm.group(2)!);
      final double lineEnd = lineStart + lineDuration;
      final String body = lm.group(3) ?? '';

      final List<WordUnit> words = <WordUnit>[];
      for (final RegExpMatch wm in _krcWordRe.allMatches(body)) {
        final String text = wm.group(3) ?? '';
        if (text.isEmpty) continue;
        final double rel = double.parse(wm.group(1)!);
        final double dur = double.parse(wm.group(2)!);
        final double absStart = lineStart + rel;
        words.add(WordUnit(
          text: text,
          start: absStart / 1000,
          end: (absStart + dur) / 1000,
        ));
      }

      if (words.isEmpty) {
        final String fallback = body.trim();
        if (fallback.isEmpty) continue;
        raw.add(LyricLine(
          time: lineStart / 1000,
          text: fallback,
          units: <WordUnit>[
            WordUnit(text: fallback, start: lineStart / 1000, end: lineEnd / 1000),
          ],
        ));
      } else {
        raw.add(LyricLine(
          time: lineStart / 1000,
          text: words.map((w) => w.text).join(),
          units: words,
        ));
      }
    }

    if (raw.isEmpty) return Lyrics.empty;

    // [language:] 标签：base64 -> UTF-8 -> JSON，含翻译轨与罗马音轨
    try {
      final String? langTag = tags['language'];
      if (langTag != null && langTag.isNotEmpty) {
        final Object? decoded = jsonDecode(utf8.decode(base64.decode(langTag.trim())));
        if (decoded is Map && decoded['content'] is List) {
          List<String>? trans;
          List<String>? roma;
          for (final Object? item in decoded['content'] as List<dynamic>) {
            if (item is! Map) continue;
            final int type = (item['type'] as num?)?.toInt() ?? -1;
            final List<dynamic> rows2 =
                (item['lyricContent'] as List<dynamic>?) ?? const <dynamic>[];
            final List<String> flat = rows2.map((e) {
              if (e is List) return e.whereType<String>().join();
              return e?.toString() ?? '';
            }).toList();
            if (type == 1) trans = flat;
            if (type == 0) roma = flat;
          }
          if (trans != null) {
            for (int i = 0; i < raw.length && i < trans.length; i++) {
              final String v = trans[i].trim();
              if (v.isNotEmpty) raw[i] = raw[i].copyWith(translation: v);
            }
          }
          if (roma != null) {
            int offset = 0;
            for (int i = 0; i < raw.length; i++) {
              if (raw[i].units?.isEmpty ?? true) {
                offset++;
                continue;
              }
              final int idx = i - offset;
              if (idx >= 0 && idx < roma.length) {
                final String v = roma[idx].trim();
                if (v.isNotEmpty) raw[i] = raw[i].copyWith(romaji: v);
              }
            }
          }
        }
      }
    } catch (_) {
      // 副轨解析失败不影响原文
    }

    return buildSequence(raw, detectInstrumental: detectInstrumental);
  }

  // ------------------------------------------------------------------ TTML

  /// Apple Music 风格 TTML（正则实现，容忍命名空间前缀差异）。
  /// 解析失败返回空歌词，不抛异常。
  static Lyrics parseTtml(String xml) {
    try {
      final List<LyricLine> out = <LyricLine>[];

      // 阶段 1：<translation><text for="KEY">译文</text></translation>
      final Map<String, String> headTranslations = <String, String>{};
      final RegExp transBlockRe =
          RegExp(r'<translation\b[^>]*>([\s\S]*?)</translation>', caseSensitive: false);
      final RegExp transTextRe = RegExp(
        r'<text\b[^>]*\bfor\s*=\s*"([^"]*)"[^>]*>([\s\S]*?)</text>',
        caseSensitive: false,
      );
      for (final RegExpMatch block in transBlockRe.allMatches(xml)) {
        for (final RegExpMatch t in transTextRe.allMatches(block.group(1) ?? '')) {
          headTranslations[t.group(1) ?? ''] = _stripTags(t.group(2) ?? '').trim();
        }
      }

      // 阶段 2：所有 <p>
      final RegExp pRe = RegExp(r'<p\b([^>]*)>([\s\S]*?)</p>', caseSensitive: false);
      final RegExp spanRe = RegExp(r'<span\b([^>]*)>([\s\S]*?)</span>', caseSensitive: false);

      for (final RegExpMatch p in pRe.allMatches(xml)) {
        final String attrs = p.group(1) ?? '';
        final String inner = p.group(2) ?? '';
        final String? beginRaw = _attr(attrs, 'begin');
        final String? endRaw = _attr(attrs, 'end');
        if (beginRaw == null && endRaw == null) continue;
        final double begin = _ttmlTime(beginRaw);

        final String role = _attr(attrs, 'role') ?? '';
        if (role == 'x-bg') continue;
        if (role == 'x-translation' || role == 'x-romanization') continue;

        final List<WordUnit> words = <WordUnit>[];
        for (final RegExpMatch s in spanRe.allMatches(inner)) {
          final String sAttrs = s.group(1) ?? '';
          final String? sBeginRaw = _attr(sAttrs, 'begin');
          if (sBeginRaw == null) continue;
          final double sBegin = _ttmlTime(sBeginRaw);
          final double sEnd = _ttmlTime(_attr(sAttrs, 'end'));
          final String text = _stripTags(s.group(2) ?? '');
          if (text.isEmpty) continue;
          words.add(WordUnit(
            text: text,
            start: sBegin,
            end: sEnd > sBegin ? sEnd : sBegin,
          ));
        }

        final String plainText = _stripTags(inner).trim();
        if (plainText.isEmpty) continue;

        String? translation;
        final String? key = _attr(attrs, 'key');
        if (key != null && headTranslations.containsKey(key)) {
          translation = headTranslations[key];
        }

        final double endTime = _ttmlTime(endRaw);
        out.add(LyricLine(
          time: begin,
          text: plainText,
          translation: translation,
          units: words.isEmpty
              ? <WordUnit>[
                  WordUnit(
                    text: plainText,
                    start: begin,
                    end: endTime > begin ? endTime : begin,
                  )
                ]
              : words,
        ));
      }

      if (out.isEmpty) return Lyrics.empty;
      out.sort((LyricLine a, LyricLine b) => a.time.compareTo(b.time));
      return Lyrics(out);
    } catch (_) {
      return Lyrics.empty;
    }
  }

  static String _stripTags(String s) =>
      s.replaceAll(RegExp(r'<[^>]*>'), '').replaceAll(RegExp(r'\s+'), ' ').trim();

  /// 属性读取：带命名空间前缀优先，裸属性名兜底。
  static String? _attr(String attrs, String name) {
    final RegExpMatch? m = RegExp(
      '(?:[A-Za-z0-9_-]+:)?' + RegExp.escape(name) + r'\s*=\s*"([^"]*)"',
      caseSensitive: false,
    ).firstMatch(attrs);
    return m?.group(1);
  }

  /// 1.5s / 1500ms / 00:01.500 / 裸数字按秒
  static double _ttmlTime(String? raw) {
    if (raw == null) return 0;
    final String v = raw.trim();
    if (v.isEmpty) return 0;

    final RegExpMatch? ms = RegExp(r'^(\d+(?:\.\d+)?)ms$').firstMatch(v);
    if (ms != null) return (double.tryParse(ms.group(1)!) ?? 0) / 1000.0;

    final RegExpMatch? sec = RegExp(r'^(\d+(?:\.\d+)?)s$').firstMatch(v);
    if (sec != null) return double.tryParse(sec.group(1)!) ?? 0;

    final RegExpMatch? clock =
        RegExp(r'^(?:(\d+):)?(\d+):(\d+(?:\.\d+)?)$').firstMatch(v);
    if (clock != null) {
      final double h = double.tryParse(clock.group(1) ?? '0') ?? 0;
      final double m = double.tryParse(clock.group(2)!) ?? 0;
      final double s = double.tryParse(clock.group(3)!) ?? 0;
      return h * 3600 + m * 60 + s;
    }

    final double? bare = double.tryParse(v);
    if (bare != null) return bare;
    return 0;
  }

  // --------------------------------------------------------- 网易云 yrc（逐字）

  /// 网易云 yrc 逐字格式：`[行起始,行时长](字起始,字时长,0)字(字起始,字时长,0)字...`
  /// 时间戳为**绝对毫秒**，且**文字在时间戳之后**（与 QQ QRC 相反）。
  static final RegExp _yrcLineRe = RegExp(r'^\[(\d+),(\d+)\](.*)$');
  static final RegExp _yrcWordRe = RegExp(r'\((\d+),(\d+),\d+\)');

  static Lyrics parseYrc(String text, {bool detectInstrumental = true}) {
    final List<LyricLine> raw = <LyricLine>[];
    for (final String row in text.split(RegExp(r'\r?\n'))) {
      final RegExpMatch? lm = _yrcLineRe.firstMatch(row.trim());
      if (lm == null) continue;
      final double lineStart = double.parse(lm.group(1)!);
      final double lineEnd = lineStart + double.parse(lm.group(2)!);
      final String body = lm.group(3) ?? '';

      final List<RegExpMatch> ts = _yrcWordRe.allMatches(body).toList();
      final List<WordUnit> words = <WordUnit>[];
      for (int i = 0; i < ts.length; i++) {
        final double wStart = double.parse(ts[i].group(1)!);
        final double wDur = double.parse(ts[i].group(2)!);
        final int textStart = ts[i].end;
        final int textEnd = i + 1 < ts.length ? ts[i + 1].start : body.length;
        if (textEnd <= textStart) continue;
        final String w = body.substring(textStart, textEnd);
        if (w.isEmpty) continue;
        words.add(WordUnit(text: w, start: wStart / 1000, end: (wStart + wDur) / 1000));
      }
      // 末字结束时间用行结束兜底（yrc 的字时长可能短于行时长）
      if (words.isNotEmpty && lineEnd / 1000 > words.last.end) {
        final WordUnit last = words.last;
        words[words.length - 1] =
            WordUnit(text: last.text, start: last.start, end: lineEnd / 1000);
      }

      if (words.isEmpty) {
        final String fallback = body.trim();
        if (fallback.isEmpty) continue;
        raw.add(LyricLine(time: lineStart / 1000, text: fallback));
      } else {
        raw.add(LyricLine(
          time: lineStart / 1000,
          text: words.map((w) => w.text).join(),
          units: words,
        ));
      }
    }
    if (raw.isEmpty) return Lyrics.empty;
    return buildSequence(raw, detectInstrumental: detectInstrumental);
  }

  /// 把同时间戳的翻译轨（LRC 文本）合并到已有歌词上。
  static Lyrics mergeTranslation(Lyrics base, String translationLrc) {
    if (base.isEmpty || translationLrc.trim().isEmpty) return base;
    final Map<int, String> trans = <int, String>{};
    for (final String row in translationLrc.split(RegExp(r'\r?\n'))) {
      final List<RegExpMatch> ms = lrcTimeRe.allMatches(row).toList();
      if (ms.isEmpty) continue;
      final String content = row.replaceAll(lrcTimeRe, '').trim();
      if (content.isEmpty) continue;
      for (final RegExpMatch m in ms) {
        final double? t = _timeFromMatch(m);
        if (t == null) continue;
        trans[(t * 1000).round()] = content;
      }
    }
    if (trans.isEmpty) return base;
    final List<LyricLine> lines = <LyricLine>[];
    for (final LyricLine l in base.lines) {
      final String? t = trans[(l.time * 1000).round()];
      lines.add(t != null && t.isNotEmpty ? l.copyWith(translation: t) : l);
    }
    return Lyrics(lines);
  }

  /// 自动识别格式并解析
  static Lyrics parseAuto(String text, {bool detectInstrumental = true}) {
    final String t = text.trim();
    if (t.isEmpty) return Lyrics.empty;
    if (t.startsWith('<')) return parseTtml(t);
    if (t.contains('<Lyric_1') || t.contains('<LyricContent')) {
      return parseQrcPlain(t, detectInstrumental: detectInstrumental);
    }
    if (t.contains('<') && t.contains('>') && RegExp(r'^\[(\w+):').hasMatch(t)) {
      final Lyrics k = parseKrcPlain(t, detectInstrumental: detectInstrumental);
      if (k.isNotEmpty) return k;
    }
    return parseLrc(t, detectInstrumental: detectInstrumental);
  }

  /// QRC 明文（QQ 音乐逐字，未加密形态）。start 为**绝对**毫秒。
  static Lyrics parseQrcPlain(String text, {bool detectInstrumental = true}) {
    final RegExpMatch? lyric =
        RegExp(r'<Lyric_1[^>]*LyricContent="([\s\S]*?)"\s*/>').firstMatch(text);
    final String content = lyric?.group(1) ?? text;
    final List<LyricLine> raw = <LyricLine>[];
    for (final String line in content.split(RegExp(r'\r?\n'))) {
      final RegExpMatch? lm = RegExp(r'^\[(\d+),(\d+)\](.*)$').firstMatch(line.trim());
      if (lm == null) continue;
      final double lineStart = double.parse(lm.group(1)!);
      final double lineEnd = lineStart + double.parse(lm.group(2)!);
      final String body = lm.group(3) ?? '';
      if (RegExp(r'^\(\d+,\d+\)$').hasMatch(body.trim())) continue;

      final List<WordUnit> words = <WordUnit>[];
      for (final RegExpMatch wm in RegExp(
        r'(?:\[\d+,\d+\])?((?:(?!\(\d+,\d+\)).)*)\((\d+),(\d+)\)',
        dotAll: true,
      ).allMatches(body)) {
        final String wtext = wm.group(1) ?? '';
        if (wtext.isEmpty || wtext == '\r') continue;
        final double abs = double.parse(wm.group(2)!);
        words.add(WordUnit(
          text: wtext,
          start: abs / 1000,
          end: (abs + double.parse(wm.group(3)!)) / 1000,
        ));
      }
      if (words.isEmpty) {
        final String fallback = body.trim();
        if (fallback.isEmpty) continue;
        raw.add(LyricLine(
          time: lineStart / 1000,
          text: fallback,
          units: <WordUnit>[
            WordUnit(text: fallback, start: lineStart / 1000, end: lineEnd / 1000),
          ],
        ));
      } else {
        raw.add(LyricLine(
          time: lineStart / 1000,
          text: words.map((w) => w.text).join(),
          units: words,
        ));
      }
    }
    if (raw.isEmpty) return Lyrics.empty;
    return buildSequence(raw, detectInstrumental: detectInstrumental);
  }
}
