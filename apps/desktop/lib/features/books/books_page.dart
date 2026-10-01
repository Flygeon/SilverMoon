import 'dart:async';
import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../../bridge/backend_client.dart';
import '../../host/host_controller.dart';
import '../../i18n/sm_strings.dart';
import '../../state/app_state.dart';
import '../../theme/app_theme.dart';
import '../../theme/design_tokens.dart';
import '../library/library_api.dart';
import '../library/media_entry.dart';
import '../library/media_format.dart';

/// book::get_book_progress 的返回（后端 camelCase）。
@immutable
class BookProgress {
  const BookProgress({
    required this.bookId,
    required this.location,
    required this.page,
    required this.percent,
    required this.updatedAt,
  });

  factory BookProgress.fromJson(Map<String, Object?> json) {
    return BookProgress(
      bookId: _asString(json['bookId']) ?? '',
      location: _asString(json['location']) ?? '',
      page: _asInt(json['page']) ?? 0,
      percent: _asDouble(json['percent']) ?? 0,
      updatedAt: _asInt(json['updatedAt']) ?? 0,
    );
  }

  final String bookId;
  final String location;
  final int page;
  final double percent;
  final int updatedAt;
}

String? _asString(Object? value) => value is String ? value : null;

int? _asInt(Object? value) {
  if (value is int) return value;
  if (value is double) return value.toInt();
  return null;
}

double? _asDouble(Object? value) {
  if (value is num) return value.toDouble();
  return null;
}

/// /books —— 本地书籍列表与阅读进度。
///
/// 阅读器本身要复用 Vue 的 epub.js / pdf.js 渲染层（WebView2 宿主），还没有接；
/// 这一版先把「有哪些书、各自读到哪」用真实数据（list_files type=book +
/// book::get_book_progress）呈现出来，点开时明确提示阅读器尚未接入。
class BooksPage extends StatefulWidget {
  const BooksPage({super.key});

  @override
  State<BooksPage> createState() => _BooksPageState();
}

class _BooksPageState extends State<BooksPage> {
  /// 单批进度查询的条数。后端对一次 /batch 的条数有上限，这里保守切块。
  static const int _batchSize = 50;
  static const int _maxBooks = 1000;

  List<MediaEntry> _books = <MediaEntry>[];
  Map<String, BookProgress> _progress = <String, BookProgress>{};
  String? _error;
  bool _loading = false;
  bool _loaded = false;

  HostController get _host => context.read<HostController>();

  void _ensureLoaded(HostController host) {
    if (_loaded || host.library == null || host.client == null) return;
    _loaded = true;
    scheduleMicrotask(() {
      if (mounted) unawaited(_load());
    });
  }

  Future<void> _load() async {
    final LibraryApi? api = _host.library;
    final BackendClient? client = _host.client;
    if (api == null || client == null) return;
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final List<MediaEntry> books = await api.listFiles(
        const ListQuery(type: 'book', limit: _maxBooks),
      );
      // 进度逐本批量取，避免 N 次往返。
      final Map<String, BookProgress> progress = <String, BookProgress>{};
      for (int start = 0; start < books.length; start += _batchSize) {
        final int end = math.min(start + _batchSize, books.length);
        final List<MediaEntry> chunk = books.sublist(start, end);
        final List<Map<String, Object?>> calls = chunk
            .map((MediaEntry book) => <String, Object?>{
                  'cmd': 'get_book_progress',
                  'args': <String, Object?>{'fileId': book.id},
                })
            .toList();
        final List<BackendReply> replies = await client.batch(calls);
        for (int index = 0;
            index < chunk.length && index < replies.length;
            index++) {
          final BackendReply reply = replies[index];
          final Object? data = reply.data;
          if (!reply.ok || data is! Map) continue;
          progress[chunk[index].id] =
              BookProgress.fromJson(data.cast<String, Object?>());
        }
      }
      if (!mounted) return;
      setState(() {
        _books = books;
        _progress = progress;
        _loading = false;
      });
    } catch (error) {
      if (!mounted) return;
      setState(() {
        _error = error.toString();
        _loading = false;
      });
    }
  }

  /// 进度条取值：后端 percent 是 0..100，夹到 0..1。
  static double _fraction(double percent) =>
      math.max(0.0, math.min(1.0, percent / 100));

  Future<void> _openBook(MediaEntry book, SmStrings sm) async {
    await showDialog<void>(
      context: context,
      builder: (BuildContext dialogContext) {
        return AlertDialog(
          title: Text(book.displayName),
          content: Text(sm.t('books.readerPending')),
          actions: <Widget>[
            TextButton(
              onPressed: () => Navigator.of(dialogContext).pop(),
              child: Text(sm.t('actions.confirm')),
            ),
          ],
        );
      },
    );
  }

  @override
  Widget build(BuildContext context) {
    final HostController host = context.watch<HostController>();
    final SmStrings sm = context.watch<AppState>().strings;
    _ensureLoaded(host);

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: <Widget>[
        _header(sm),
        if (_error != null) _errorLine(),
        Expanded(child: _body(sm, host)),
      ],
    );
  }

  Widget _header(SmStrings sm) {
    final ColorScheme scheme = context.scheme;

    return Padding(
      padding: const EdgeInsets.fromLTRB(SM.contentPad, SM.contentPad, SM.contentPad, 10),
      child: Row(
        children: <Widget>[
          Icon(Icons.menu_book_outlined, size: 22, color: scheme.primary),
          const SizedBox(width: 10),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: <Widget>[
                Text(
                  sm.t('nav.books'),
                  style: SmText.titleLarge.copyWith(color: scheme.onSurface),
                ),
                const SizedBox(height: 2),
                Text(
                  _books.isEmpty
                      ? sm.t('navDesc.books')
                      : sm.t('navDesc.books') +
                          ' · ' +
                          _books.length.toString() +
                          ' ' +
                          sm.t('books.local'),
                  style: SmText.bodySmall.copyWith(color: scheme.onSurfaceVariant),
                ),
              ],
            ),
          ),
          IconButton(
            tooltip: sm.t('actions.rescan'),
            onPressed: _loading ? null : () => unawaited(_load()),
            icon: _loading
                ? const SizedBox(
                    width: 18,
                    height: 18,
                    child: CircularProgressIndicator(strokeWidth: 2),
                  )
                : const Icon(Icons.refresh, size: 20),
          ),
        ],
      ),
    );
  }

  Widget _errorLine() {
    final ColorScheme scheme = context.scheme;

    return Padding(
      padding: const EdgeInsets.fromLTRB(SM.contentPad, 0, SM.contentPad, 8),
      child: Container(
        width: double.infinity,
        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
        decoration: BoxDecoration(
          color: scheme.errorContainer,
          borderRadius: SM.rSmall,
        ),
        child: Text(
          _error!,
          style: SmText.bodySmall.copyWith(color: scheme.onErrorContainer),
        ),
      ),
    );
  }

  Widget _body(SmStrings sm, HostController host) {
    final ColorScheme scheme = context.scheme;

    if (host.library == null) {
      return Center(
        child: Text(
          sm.t('host.connecting'),
          style: SmText.bodyMedium.copyWith(color: scheme.onSurfaceVariant),
        ),
      );
    }
    if (_books.isEmpty) {
      return Center(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: <Widget>[
            Icon(Icons.menu_book_outlined, size: 40, color: scheme.outlineVariant),
            const SizedBox(height: 10),
            Text(
              sm.t('library.empty'),
              style: SmText.bodyMedium.copyWith(color: scheme.onSurfaceVariant),
            ),
          ],
        ),
      );
    }

    return ListView.separated(
      padding: const EdgeInsets.fromLTRB(SM.contentPad, 0, SM.contentPad, 24),
      itemCount: _books.length,
      separatorBuilder: (BuildContext context, int index) =>
          Divider(height: 1, color: context.hairline),
      itemBuilder: (BuildContext context, int index) =>
          _bookRow(_books[index], sm, scheme),
    );
  }

  Widget _bookRow(MediaEntry book, SmStrings sm, ColorScheme scheme) {
    final BookProgress? progress = _progress[book.id];
    final bool hasProgress = progress != null && progress.percent > 0;
    final String size = formatMediaSize(book.size);

    return InkWell(
      onTap: () => unawaited(_openBook(book, sm)),
      child: Padding(
        padding: const EdgeInsets.symmetric(vertical: 10),
        child: Row(
          children: <Widget>[
            Container(
              width: 36,
              height: 46,
              decoration: BoxDecoration(
                color: scheme.surfaceContainerHighest,
                borderRadius: SM.rSmall,
              ),
              child: Icon(
                Icons.menu_book_outlined,
                size: 20,
                color: scheme.onSurfaceVariant,
              ),
            ),
            const SizedBox(width: 12),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: <Widget>[
                  Text(
                    book.displayName,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: SmText.bodyMedium.copyWith(color: scheme.onSurface),
                  ),
                  const SizedBox(height: 3),
                  Text(
                    size.isEmpty
                        ? book.ext.toUpperCase()
                        : book.ext.toUpperCase() + ' · ' + size,
                    style: SmText.bodySmall.copyWith(color: scheme.onSurfaceVariant),
                  ),
                  if (hasProgress) ...<Widget>[
                    const SizedBox(height: 6),
                    Row(
                      children: <Widget>[
                        Expanded(
                          child: ClipRRect(
                            borderRadius: SM.rSmall,
                            child: LinearProgressIndicator(
                              value: _fraction(progress.percent),
                              minHeight: 4,
                              backgroundColor: scheme.surfaceContainerHighest,
                            ),
                          ),
                        ),
                        const SizedBox(width: 8),
                        Text(
                          sm.t('books.progress') +
                              ' ' +
                              progress.percent.toStringAsFixed(0) +
                              '%',
                          style: SmText.labelSmall.copyWith(color: scheme.outline),
                        ),
                      ],
                    ),
                  ],
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }
}
