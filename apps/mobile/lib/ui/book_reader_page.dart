import 'dart:convert';
import 'dart:io';

import 'package:flutter/material.dart';

import '../services/media_service.dart';

/// 纯文本阅读器（.txt / .md）。
///
/// 刻意做成最朴素的分段 ListView：几 MB 的中文小说也不会一次性构建全部文本。
/// epub / pdf 需要额外的渲染库，这里明确提示暂不支持，不做半成品。
class BookReaderPage extends StatefulWidget {
  const BookReaderPage({super.key, required this.item});

  final MediaItem item;

  @override
  State<BookReaderPage> createState() => _BookReaderPageState();
}

class _BookReaderPageState extends State<BookReaderPage> {
  List<String>? _paragraphs;
  String? _error;
  String? _encodingNote;
  double _fontSize = 17;
  final ScrollController _scroll = ScrollController();

  static const int _maxBytes = 8 * 1024 * 1024;

  @override
  void initState() {
    super.initState();
    _load();
  }

  @override
  void dispose() {
    _scroll.dispose();
    super.dispose();
  }

  Future<void> _load() async {
    try {
      final File f = File(widget.item.path);
      final int len = await f.length();
      final RandomAccessFile raf = await f.open();
      final int readLen = len > _maxBytes ? _maxBytes : len;
      final List<int> bytes = await raf.read(readLen);
      await raf.close();

      String text;
      String? note;
      try {
        text = utf8.decode(bytes);
      } catch (_) {
        // 中文 txt 常见 GBK/GB18030，Dart 没有内置解码器；
        // 这里退化为「尽量解」，并在顶部如实提示，不假装读对了。
        text = utf8.decode(bytes, allowMalformed: true);
        final int bad = '\uFFFD'.allMatches(text).length;
        if (bad > 8) {
          note = '这个文件不是 UTF-8 编码（可能是 GBK/GB18030），中文会显示异常。';
        }
      }
      if (len > _maxBytes) {
        note = (note == null ? '' : '$note ') +
            '文件较大，只载入了前 ${(_maxBytes / 1024 / 1024).round()} MB。';
      }

      final List<String> paras = text
          .replaceAll('\r\n', '\n')
          .replaceAll('\r', '\n')
          .split('\n')
          .map((String s) => s.trim())
          .toList();

      if (!mounted) return;
      setState(() {
        _paragraphs = paras;
        _encodingNote = note;
      });
    } catch (e) {
      if (!mounted) return;
      setState(() => _error = '读取失败：$e');
    }
  }

  @override
  Widget build(BuildContext context) {
    final ColorScheme scheme = Theme.of(context).colorScheme;
    return Scaffold(
      appBar: AppBar(
        title: Text(widget.item.title,
            maxLines: 1, overflow: TextOverflow.ellipsis),
        actions: <Widget>[
          IconButton(
            tooltip: '减小字号',
            icon: const Icon(Icons.text_decrease_rounded),
            onPressed: () => setState(
                () => _fontSize = (_fontSize - 1).clamp(12, 32).toDouble()),
          ),
          IconButton(
            tooltip: '增大字号',
            icon: const Icon(Icons.text_increase_rounded),
            onPressed: () => setState(
                () => _fontSize = (_fontSize + 1).clamp(12, 32).toDouble()),
          ),
        ],
      ),
      body: _buildBody(scheme),
    );
  }

  Widget _buildBody(ColorScheme scheme) {
    if (_error != null) {
      return Center(
        child: Padding(
          padding: const EdgeInsets.all(32),
          child: Text(_error!, textAlign: TextAlign.center),
        ),
      );
    }
    final List<String>? paras = _paragraphs;
    if (paras == null) {
      return const Center(child: CircularProgressIndicator());
    }
    return Scrollbar(
      controller: _scroll,
      child: ListView.builder(
        controller: _scroll,
        padding: const EdgeInsets.fromLTRB(18, 12, 18, 48),
        itemCount: paras.length + (_encodingNote == null ? 0 : 1),
        itemBuilder: (BuildContext c, int i) {
          if (_encodingNote != null && i == 0) {
            return Container(
              margin: const EdgeInsets.only(bottom: 14),
              padding: const EdgeInsets.all(10),
              decoration: BoxDecoration(
                color: scheme.errorContainer.withValues(alpha: 0.5),
                borderRadius: BorderRadius.circular(10),
              ),
              child: Text(
                _encodingNote!,
                style: TextStyle(
                    fontSize: 12.5, color: scheme.onErrorContainer),
              ),
            );
          }
          final int index = i - (_encodingNote == null ? 0 : 1);
          final String line = paras[index];
          if (line.isEmpty) {
            return const SizedBox(height: 12);
          }
          return Padding(
            padding: const EdgeInsets.only(bottom: 6),
            child: SelectableText(
              line,
              style: TextStyle(
                fontSize: _fontSize,
                height: 1.75,
                color: scheme.onSurface,
              ),
            ),
          );
        },
      ),
    );
  }
}
