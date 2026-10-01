import '../../bridge/backend_client.dart';
import 'media_entry.dart';

/// 扫描任务进度，对应 Rust `commands::ScanJobInfo`（camelCase）。
class ScanJobInfo {
  const ScanJobInfo({
    required this.jobId,
    required this.stage,
    required this.done,
    required this.total,
    required this.percent,
    this.currentPath = '',
    this.added = 0,
    this.updated = 0,
    this.removed = 0,
    this.error,
  });

  factory ScanJobInfo.fromJson(Map<String, Object?> json) {
    return ScanJobInfo(
      jobId: _str(json['jobId']) ?? '',
      // enumerate | parse | store | done | cancelled | error
      stage: _str(json['stage']) ?? '',
      done: _int(json['done']) ?? 0,
      total: _int(json['total']) ?? 0,
      percent: _dbl(json['percent']) ?? 0,
      currentPath: _str(json['currentPath']) ?? '',
      added: _int(json['added']) ?? 0,
      updated: _int(json['updated']) ?? 0,
      removed: _int(json['removed']) ?? 0,
      error: _str(json['error']),
    );
  }

  final String jobId;
  final String stage;
  final int done;
  final int total;
  final double percent;
  final String currentPath;
  final int added;
  final int updated;
  final int removed;
  final String? error;

  bool get isFinished =>
      stage == 'done' || stage == 'cancelled' || stage == 'error';
}

/// 媒体库命令的类型化封装：只负责「命令名 + 参数形状 + 反序列化」，
/// 不放业务判断（那些属于各 feature 页）。
///
/// 命令与形状逐条对应 Rust：
///   * `list_files(query) -> Vec<MediaEntry>`
///   * `count_files(query) -> i64`
///   * `library_counts(minSize) -> HashMap<String, i64>`
///   * `get_thumbnail(fileId, size) -> String?`（磁盘路径）
///   * `get_thumbnails(fileIds, size) -> Vec<String?>`（与入参同下标）
///   * `scan_start(config) -> { jobId }` / `scan_status(jobId)` / `scan_cancel(jobId)`
class LibraryApi {
  LibraryApi(this._client);

  final BackendClient _client;

  Future<List<MediaEntry>> listFiles([
    ListQuery query = const ListQuery(),
  ]) async {
    final BackendReply reply = await _client.invoke(
      'list_files',
      <String, Object?>{'query': query.toJson()},
    );
    final Object? data = reply.unwrap();
    final List<MediaEntry> out = <MediaEntry>[];
    if (data is List) {
      for (final Object? item in data) {
        if (item is Map) out.add(MediaEntry.fromJson(item.cast<String, Object?>()));
      }
    }
    return out;
  }

  Future<int> countFiles([ListQuery query = const ListQuery()]) async {
    final BackendReply reply = await _client.invoke(
      'count_files',
      <String, Object?>{'query': query.toJson()},
    );
    return _asInt(reply.unwrap());
  }

  /// 各类型数量（导航栏角标用）。返回 `{image: n, video: n, ...}`。
  Future<Map<String, int>> libraryCounts({int? minSize}) async {
    final BackendReply reply = await _client.invoke(
      'library_counts',
      <String, Object?>{'minSize': minSize},
    );
    final Object? data = reply.unwrap();
    final Map<String, int> out = <String, int>{};
    if (data is Map) {
      data.forEach((Object? key, Object? value) {
        if (key is String) out[key] = _asInt(value);
      });
    }
    return out;
  }

  /// 单张缩略图（磁盘绝对路径）。返回 null 表示生成失败或无可用缩略图。
  Future<String?> thumbnail(String fileId, {int? size}) async {
    final BackendReply reply = await _client.invoke(
      'get_thumbnail',
      <String, Object?>{'fileId': fileId, 'size': size},
    );
    final Object? data = reply.unwrap();
    return data is String && data.isNotEmpty ? data : null;
  }

  /// 批量缩略图，返回值与 [fileIds] 按下标一一对应（这是列表滚动不卡的唯一正解）。
  Future<List<String?>> thumbnails(List<String> fileIds, {int? size}) async {
    if (fileIds.isEmpty) return const <String?>[];
    final BackendReply reply = await _client.invoke(
      'get_thumbnails',
      <String, Object?>{'fileIds': fileIds, 'size': size},
    );
    final Object? data = reply.unwrap();
    if (data is! List) return const <String?>[];
    return data
        .map((Object? item) => item is String && item.isNotEmpty ? item : null)
        .toList();
  }

  /// 启动异步扫描，立即返回 jobId；进度经 `scan:progress` 事件与 [scanStatus] 获取。
  Future<String> scanStart({
    required List<String> dirs,
    int? maxDepth,
    bool followLinks = false,
    bool forceReparse = false,
  }) async {
    final BackendReply reply = await _client.invoke(
      'scan_start',
      <String, Object?>{
        'config': <String, Object?>{
          'dirs': dirs,
          'maxDepth': maxDepth,
          'followLinks': followLinks,
          'forceReparse': forceReparse,
        },
      },
    );
    final Object? data = reply.unwrap();
    if (data is Map) {
      final Object? jobId = data['jobId'];
      if (jobId is String) return jobId;
    }
    throw BackendError('scan_start 未返回 jobId');
  }

  Future<ScanJobInfo?> scanStatus(String jobId) async {
    final BackendReply reply = await _client.invoke(
      'scan_status',
      <String, Object?>{'jobId': jobId},
    );
    final Object? data = reply.unwrap();
    if (data is Map) return ScanJobInfo.fromJson(data.cast<String, Object?>());
    return null;
  }

  Future<void> scanCancel(String jobId) async {
    final BackendReply reply = await _client.invoke(
      'scan_cancel',
      <String, Object?>{'jobId': jobId},
    );
    reply.unwrap();
  }
}

String? _str(Object? value) => value is String ? value : null;

int _asInt(Object? value) {
  if (value is int) return value;
  if (value is double) return value.toInt();
  if (value is String) return int.tryParse(value) ?? 0;
  return 0;
}

int? _int(Object? value) {
  if (value is int) return value;
  if (value is double) return value.toInt();
  return null;
}

double? _dbl(Object? value) {
  if (value is double) return value;
  if (value is int) return value.toDouble();
  return null;
}
