/// 媒体库列表项，对应后端 `src/lib.rs` 的 `MediaEntry`（serde camelCase）。
///
/// 一个细节值得留意：`thumbPath` 在**缩略图缓存已命中**时由 `list_files` 直接带上，
/// 未命中才是 null。图库滚动因此不必逐张再发 `get_thumbnail`——命中路径的命令数是 0，
/// 未命中的由批量通道 `get_thumbnails` 一次补齐。
class MediaEntry {
  const MediaEntry({
    required this.id,
    required this.path,
    required this.name,
    required this.type,
    required this.size,
    required this.mtime,
    this.parent = '',
    this.ext = '',
    this.scannedAt = 0,
    this.deleted = 0,
    this.title,
    this.artist,
    this.album,
    this.durationMs,
    this.width,
    this.height,
    this.codec,
    this.fps,
    this.takenAt,
    this.hasCover = false,
    this.favorite = false,
    this.thumbPath,
  });

  factory MediaEntry.fromJson(Map<String, Object?> json) {
    return MediaEntry(
      id: _string(json['id']) ?? '',
      path: _string(json['path']) ?? '',
      parent: _string(json['parent']) ?? '',
      name: _string(json['name']) ?? '',
      ext: _string(json['ext']) ?? '',
      type: _string(json['type']) ?? '',
      size: _int(json['size']) ?? 0,
      mtime: _int(json['mtime']) ?? 0,
      scannedAt: _int(json['scannedAt']) ?? 0,
      deleted: _int(json['deleted']) ?? 0,
      title: _string(json['title']),
      artist: _string(json['artist']),
      album: _string(json['album']),
      durationMs: _int(json['durationMs']),
      width: _int(json['width']),
      height: _int(json['height']),
      codec: _string(json['codec']),
      fps: _double(json['fps']),
      takenAt: _int(json['takenAt']),
      hasCover: json['hasCover'] == true,
      favorite: json['favorite'] == true,
      thumbPath: _string(json['thumbPath']),
    );
  }

  final String id;
  final String path;
  final String parent;
  final String name;
  final String ext;

  /// image | video | audio | book | ...（Rust `media::classify`）
  final String type;
  final int size;
  final int mtime;
  final int scannedAt;
  final int deleted;
  final String? title;
  final String? artist;
  final String? album;
  final int? durationMs;
  final int? width;
  final int? height;
  final String? codec;
  final double? fps;
  final int? takenAt;
  final bool hasCover;
  final bool favorite;

  /// 缩略图磁盘缓存路径；未生成时为 null。
  final String? thumbPath;

  /// 展示名：优先元数据标题，其次文件名。
  String get displayName {
    final String? t = title;
    if (t != null && t.isNotEmpty) return t;
    return name;
  }

  /// 网格用宽高比；未知时按 1:1 处理，避免布局跳动。
  double get aspectRatio {
    final int? w = width;
    final int? h = height;
    if (w == null || h == null || w <= 0 || h <= 0) return 1;
    return w / h;
  }

  MediaEntry copyWith({String? thumbPath}) {
    return MediaEntry(
      id: id,
      path: path,
      parent: parent,
      name: name,
      ext: ext,
      type: type,
      size: size,
      mtime: mtime,
      scannedAt: scannedAt,
      deleted: deleted,
      title: title,
      artist: artist,
      album: album,
      durationMs: durationMs,
      width: width,
      height: height,
      codec: codec,
      fps: fps,
      takenAt: takenAt,
      hasCover: hasCover,
      favorite: favorite,
      thumbPath: thumbPath ?? this.thumbPath,
    );
  }
}

/// `list_files` / `count_files` 的查询参数，对应 Rust `ListQuery`。
///
/// 注意 `type` 在线上是字段名 `type`（Rust 侧用 `#[serde(rename = "type")]`），
/// 不是 `kind`。
class ListQuery {
  const ListQuery({
    this.type,
    this.search,
    this.sortBy,
    this.desc,
    this.minSize,
    this.limit,
    this.offset,
  });

  final String? type;
  final String? search;

  /// name | mtime | size | title | takenAt
  final String? sortBy;
  final bool? desc;
  final int? minSize;
  final int? limit;
  final int? offset;

  Map<String, Object?> toJson() {
    return <String, Object?>{
      'type': type,
      'search': search,
      'sortBy': sortBy,
      'desc': desc,
      'minSize': minSize,
      'limit': limit,
      'offset': offset,
    };
  }
}

String? _string(Object? value) => value is String ? value : null;

int? _int(Object? value) {
  if (value is int) return value;
  if (value is double) return value.toInt();
  return null;
}

double? _double(Object? value) {
  if (value is double) return value;
  if (value is int) return value.toDouble();
  return null;
}
