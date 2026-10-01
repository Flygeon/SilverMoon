import '../../bridge/backend_client.dart';

// ────────────────────────────────────────────────────────────────
// 模型 —— 字段名与 Rust 结构体逐一对应（serde rename_all = "camelCase"）
// ────────────────────────────────────────────────────────────────

/// 听歌统计的每日聚合，对应 `commands::stats::ListenStats`。
class ListenStats {
  const ListenStats({
    required this.day,
    required this.playCount,
    required this.uniqueTracks,
    required this.totalMs,
  });

  factory ListenStats.fromJson(Map<String, Object?> json) {
    return ListenStats(
      day: _string(json['day']) ?? '',
      playCount: _int(json['playCount']) ?? 0,
      uniqueTracks: _int(json['uniqueTracks']) ?? 0,
      totalMs: _int(json['totalMs']) ?? 0,
    );
  }

  /// yyyy-MM-dd（后端按本地时区切天）。
  final String day;
  final int playCount;

  /// 该天去重后的曲目数（后端 `listen_day_track`）。
  final int uniqueTracks;
  final int totalMs;
}

/// 听歌来源分布，对应 `commands::stats::ListenSourceStat`。
class ListenSourceStat {
  const ListenSourceStat({
    required this.source,
    required this.playCount,
    required this.totalMs,
  });

  factory ListenSourceStat.fromJson(Map<String, Object?> json) {
    return ListenSourceStat(
      source: _string(json['source']) ?? '',
      playCount: _int(json['playCount']) ?? 0,
      totalMs: _int(json['totalMs']) ?? 0,
    );
  }

  /// local | online | webdav
  final String source;
  final int playCount;
  final int totalMs;
}

/// 常听曲目聚合，对应 `commands::stats::TopTrackStat`。
class TopTrackStat {
  const TopTrackStat({
    required this.trackId,
    required this.source,
    required this.title,
    required this.artist,
    required this.album,
    required this.playCount,
    required this.totalMs,
    this.coverUrl,
    this.filePath,
    this.fileName,
    this.contentHash,
    this.srcUrl,
  });

  factory TopTrackStat.fromJson(Map<String, Object?> json) {
    return TopTrackStat(
      trackId: _string(json['trackId']) ?? '',
      source: _string(json['source']) ?? '',
      title: _string(json['title']) ?? '',
      artist: _string(json['artist']) ?? '',
      album: _string(json['album']) ?? '',
      playCount: _int(json['playCount']) ?? 0,
      totalMs: _int(json['totalMs']) ?? 0,
      coverUrl: _string(json['coverUrl']),
      filePath: _string(json['filePath']),
      fileName: _string(json['fileName']),
      contentHash: _string(json['contentHash']),
      srcUrl: _string(json['srcUrl']),
    );
  }

  final String trackId;
  final String source;
  final String title;
  final String artist;
  final String album;
  final String? coverUrl;
  final String? filePath;
  final String? fileName;
  final String? contentHash;
  final int playCount;
  final int totalMs;
  final String? srcUrl;

  /// 展示名：标题为空时退化到文件名，再退化到 trackId（与后端
  /// `COALESCE(NULLIF(MAX(s.title), ''), s.track_id)` 的兜底一致）。
  String get displayTitle {
    if (title.isNotEmpty) return title;
    final String? name = fileName;
    if (name != null && name.isNotEmpty) return name;
    return trackId;
  }
}

/// 小说阅读的每日聚合，对应 `novel::NovelDailyStat`。
class NovelDailyStat {
  const NovelDailyStat({
    required this.day,
    required this.readCount,
    required this.totalMs,
    required this.uniqueBooks,
    required this.localMs,
    required this.onlineMs,
  });

  factory NovelDailyStat.fromJson(Map<String, Object?> json) {
    return NovelDailyStat(
      day: _string(json['day']) ?? '',
      readCount: _int(json['readCount']) ?? 0,
      totalMs: _int(json['totalMs']) ?? 0,
      uniqueBooks: _int(json['uniqueBooks']) ?? 0,
      localMs: _int(json['localMs']) ?? 0,
      onlineMs: _int(json['onlineMs']) ?? 0,
    );
  }

  final String day;
  final int readCount;
  final int totalMs;

  /// 该天去重后的书籍数（后端 `novel_read_day_book`）。
  final int uniqueBooks;
  final int localMs;
  final int onlineMs;
}

/// 小说来源分布，对应 `novel::NovelSourceStat`。
class NovelSourceStat {
  const NovelSourceStat({
    required this.source,
    required this.readCount,
    required this.totalMs,
  });

  factory NovelSourceStat.fromJson(Map<String, Object?> json) {
    return NovelSourceStat(
      source: _string(json['source']) ?? '',
      readCount: _int(json['readCount']) ?? 0,
      totalMs: _int(json['totalMs']) ?? 0,
    );
  }

  /// local | online
  final String source;
  final int readCount;
  final int totalMs;
}

/// 在读排行，对应 `novel::NovelTopBook`。
class NovelTopBook {
  const NovelTopBook({
    required this.bookId,
    required this.source,
    required this.title,
    required this.chapterTitle,
    required this.readCount,
    required this.totalMs,
  });

  factory NovelTopBook.fromJson(Map<String, Object?> json) {
    return NovelTopBook(
      bookId: _string(json['bookId']) ?? '',
      source: _string(json['source']) ?? '',
      title: _string(json['title']) ?? '',
      chapterTitle: _string(json['chapterTitle']) ?? '',
      readCount: _int(json['readCount']) ?? 0,
      totalMs: _int(json['totalMs']) ?? 0,
    );
  }

  final String bookId;
  final String source;
  final String title;
  final String chapterTitle;
  final int readCount;
  final int totalMs;
}

// ────────────────────────────────────────────────────────────────
// 命令封装 —— 只负责「命令名 + 参数形状 + 反序列化」
// ────────────────────────────────────────────────────────────────

/// 统计命令的类型化封装。
///
/// 命令与形状逐条对应 Rust：
///   * `list_listen_stats(days?, fromDay?, toDay?) -> Vec<ListenStats>`
///   * `get_listen_stats(day?) -> ListenStats?`
///   * `list_top_tracks(limit?, days?, fromDay?, toDay?) -> Vec<TopTrackStat>`
///   * `listen_source_breakdown(days?, fromDay?, toDay?) -> Vec<ListenSourceStat>`
///   * `novel_stats_list(days?, fromDay?, toDay?) -> Vec<NovelDailyStat>`
///   * `novel_source_breakdown(days?, fromDay?, toDay?) -> Vec<NovelSourceStat>`
///   * `novel_top_books(limit?, days?) -> Vec<NovelTopBook>`
///
/// （`apps/desktop/backend/src/commands/stats.rs` 与 `src/novel.rs`）
class StatsApi {
  StatsApi(this._client);

  final BackendClient _client;

  Future<List<ListenStats>> listenDaily({int? days, String? fromDay, String? toDay}) async {
    final BackendReply reply = await _client.invoke('list_listen_stats', <String, Object?>{
      'days': days,
      'fromDay': fromDay,
      'toDay': toDay,
    });
    return _decodeList<ListenStats>(
      reply.unwrap(),
      ListenStats.fromJson,
    );
  }

  /// 今日（或指定日）的听歌汇总；没有记录时后端返回 null。
  Future<ListenStats?> listenDay({String? day}) async {
    final BackendReply reply = await _client.invoke(
      'get_listen_stats',
      <String, Object?>{'day': day},
    );
    final Object? data = reply.unwrap();
    if (data is Map) return ListenStats.fromJson(data.cast<String, Object?>());
    return null;
  }

  Future<List<TopTrackStat>> topTracks({
    int? limit,
    int? days,
    String? fromDay,
    String? toDay,
  }) async {
    final BackendReply reply = await _client.invoke('list_top_tracks', <String, Object?>{
      'limit': limit,
      'days': days,
      'fromDay': fromDay,
      'toDay': toDay,
    });
    return _decodeList<TopTrackStat>(
      reply.unwrap(),
      TopTrackStat.fromJson,
    );
  }

  Future<List<ListenSourceStat>> listenSources({int? days, String? fromDay, String? toDay}) async {
    final BackendReply reply = await _client.invoke(
      'listen_source_breakdown',
      <String, Object?>{'days': days, 'fromDay': fromDay, 'toDay': toDay},
    );
    return _decodeList<ListenSourceStat>(
      reply.unwrap(),
      ListenSourceStat.fromJson,
    );
  }

  Future<List<NovelDailyStat>> novelDaily({int? days, String? fromDay, String? toDay}) async {
    final BackendReply reply = await _client.invoke('novel_stats_list', <String, Object?>{
      'days': days,
      'fromDay': fromDay,
      'toDay': toDay,
    });
    return _decodeList<NovelDailyStat>(
      reply.unwrap(),
      NovelDailyStat.fromJson,
    );
  }

  Future<List<NovelSourceStat>> novelSources({int? days, String? fromDay, String? toDay}) async {
    final BackendReply reply = await _client.invoke(
      'novel_source_breakdown',
      <String, Object?>{'days': days, 'fromDay': fromDay, 'toDay': toDay},
    );
    return _decodeList<NovelSourceStat>(
      reply.unwrap(),
      NovelSourceStat.fromJson,
    );
  }

  Future<List<NovelTopBook>> novelTopBooks({int? limit, int? days}) async {
    final BackendReply reply = await _client.invoke(
      'novel_top_books',
      <String, Object?>{'limit': limit, 'days': days},
    );
    return _decodeList<NovelTopBook>(
      reply.unwrap(),
      NovelTopBook.fromJson,
    );
  }
}

// ────────────────────────────────────────────────────────────────
// 展示小工具（两个统计页共用；不引任何依赖）
// ────────────────────────────────────────────────────────────────

/// 毫秒 → 「x 小时 y 分钟」；不足一分钟退化为秒。
///
/// 归档词条里没有「小时 / 分钟 / 秒」这类单位（只有 `stats.duration` 这种标签），
/// 与 Electron 版 `StatsView.vue` 的 `splitListenDuration` 一样直接用中文单位。
String formatListenDuration(int ms) {
  if (ms <= 0) return '0 分钟';
  final int totalMinutes = ms ~/ 60000;
  if (totalMinutes <= 0) {
    final int seconds = ms ~/ 1000;
    return seconds > 0 ? seconds.toString() + ' 秒' : '0 分钟';
  }
  final int hours = totalMinutes ~/ 60;
  final int minutes = totalMinutes % 60;
  if (hours <= 0) return minutes.toString() + ' 分钟';
  if (minutes <= 0) return hours.toString() + ' 小时';
  return hours.toString() + ' 小时 ' + minutes.toString() + ' 分钟';
}

/// 本地日期 → yyyy-MM-dd（与后端 `epoch_ms_to_day` 的格式一致）。
String formatDayKey(DateTime date) {
  final String month = date.month < 10 ? '0' + date.month.toString() : date.month.toString();
  final String day = date.day < 10 ? '0' + date.day.toString() : date.day.toString();
  return date.year.toString() + '-' + month + '-' + day;
}

/// yyyy-MM-dd → MM-dd（图表轴标签）。
String formatDayShort(String day) {
  return day.length >= 10 ? day.substring(5) : day;
}

/// 把「只有有数据的天」补成连续 [days] 天（升序，最后一天为今天）。
///
/// 后端只返回有记录的天（且是倒序），柱状图需要固定宽度的连续轴，
/// 所以按 Electron 版 `fillRecentDays` 的语义补零。
List<ListenStats> fillListenDays(List<ListenStats> rows, int days) {
  final Map<String, ListenStats> byDay = <String, ListenStats>{};
  for (final ListenStats row in rows) {
    byDay[row.day] = row;
  }
  final DateTime now = DateTime.now();
  final List<ListenStats> out = <ListenStats>[];
  for (int i = days - 1; i >= 0; i--) {
    final DateTime date = DateTime(now.year, now.month, now.day - i);
    final String key = formatDayKey(date);
    out.add(
      byDay[key] ?? ListenStats(day: key, playCount: 0, uniqueTracks: 0, totalMs: 0),
    );
  }
  return out;
}

/// `fillListenDays` 的小说版本。
List<NovelDailyStat> fillNovelDays(List<NovelDailyStat> rows, int days) {
  final Map<String, NovelDailyStat> byDay = <String, NovelDailyStat>{};
  for (final NovelDailyStat row in rows) {
    byDay[row.day] = row;
  }
  final DateTime now = DateTime.now();
  final List<NovelDailyStat> out = <NovelDailyStat>[];
  for (int i = days - 1; i >= 0; i--) {
    final DateTime date = DateTime(now.year, now.month, now.day - i);
    final String key = formatDayKey(date);
    out.add(
      byDay[key] ??
          NovelDailyStat(
            day: key,
            readCount: 0,
            totalMs: 0,
            uniqueBooks: 0,
            localMs: 0,
            onlineMs: 0,
          ),
    );
  }
  return out;
}

// ────────────────────────────────────────────────────────────────
// JSON 取值兜底
// ────────────────────────────────────────────────────────────────

List<T> _decodeList<T>(Object? data, T Function(Map<String, Object?> json) decode) {
  final List<T> out = <T>[];
  if (data is List) {
    for (final Object? item in data) {
      if (item is Map) out.add(decode(item.cast<String, Object?>()));
    }
  }
  return out;
}

String? _string(Object? value) => value is String ? value : null;

int? _int(Object? value) {
  if (value is int) return value;
  if (value is double) return value.toInt();
  return null;
}
