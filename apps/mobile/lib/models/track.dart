/// 在线音源标识。
enum MusicServer {
  netease('netease', '网易云'),
  kugou('kugou', '酷狗'),
  meting('meting', 'Meting');

  const MusicServer(this.id, this.label);

  final String id;
  final String label;

  static MusicServer? fromId(String? v) {
    if (v == null) return null;
    for (final s in MusicServer.values) {
      if (s.id == v) return s;
    }
    return null;
  }
}

enum TrackKind { local, online }

/// 统一曲目模型：本地文件与在线歌曲归一化成同一个结构。
///
/// 对应桌面端的 `MediaEntry | OnlineSong`，字段取两者的并集。
class Track {
  const Track({
    required this.id,
    required this.title,
    this.artist = '',
    this.album = '',
    this.duration,
    this.coverUrl,
    this.filePath,
    this.url,
    this.server,
    this.sourceKey,
    this.lyricText,
    this.bitrate,
    this.folder,
    this.addedAt,
  });

  /// 本地：文件绝对路径；在线：`<server>:<sourceKey>`
  final String id;
  final String title;
  final String artist;
  final String album;
  final Duration? duration;

  /// 本地：file:// 或 content:// 封面；在线：http(s) 封面
  final String? coverUrl;

  /// 本地文件绝对路径
  final String? filePath;

  /// 在线播放直链（酷狗惰性解析后写回）
  final String? url;

  final MusicServer? server;

  /// 各音源的主键：网易云 songId / 酷狗 hash+albumId / Meting 的 id
  final String? sourceKey;

  /// 内嵌歌词或音源直接给的 LRC 原文
  final String? lyricText;

  final int? bitrate;

  /// 本地文件所在目录（用于「文件夹」视图）
  final String? folder;

  final DateTime? addedAt;

  TrackKind get kind => filePath != null ? TrackKind.local : TrackKind.online;

  bool get isLocal => filePath != null;

  String get displayTitle {
    final String t = title.trim();
    if (t.isNotEmpty) return t;
    final String? p = filePath;
    if (p != null) {
      final String name = p.split(RegExp(r'[/\\]')).last;
      final int dot = name.lastIndexOf('.');
      return dot > 0 ? name.substring(0, dot) : name;
    }
    return '未知曲目';
  }

  String get displayArtist => artist.trim().isEmpty ? '未知艺术家' : artist.trim();

  String get displayAlbum => album.trim().isEmpty ? '未知专辑' : album.trim();

  String get displayDuration => formatDuration(duration);

  /// 专辑分组键（专辑名 + 歌手，避免同名专辑合并）
  String get albumKey => '${displayAlbum}::${displayArtist}';

  String get folderKey => folder ?? '';

  Track copyWith({
    String? id,
    String? title,
    String? artist,
    String? album,
    Duration? duration,
    String? coverUrl,
    String? filePath,
    String? url,
    MusicServer? server,
    String? sourceKey,
    String? lyricText,
    int? bitrate,
    String? folder,
    DateTime? addedAt,
  }) {
    return Track(
      id: id ?? this.id,
      title: title ?? this.title,
      artist: artist ?? this.artist,
      album: album ?? this.album,
      duration: duration ?? this.duration,
      coverUrl: coverUrl ?? this.coverUrl,
      filePath: filePath ?? this.filePath,
      url: url ?? this.url,
      server: server ?? this.server,
      sourceKey: sourceKey ?? this.sourceKey,
      lyricText: lyricText ?? this.lyricText,
      bitrate: bitrate ?? this.bitrate,
      folder: folder ?? this.folder,
      addedAt: addedAt ?? this.addedAt,
    );
  }

  Map<String, dynamic> toJson() => <String, dynamic>{
        'id': id,
        'title': title,
        'artist': artist,
        'album': album,
        'durationMs': duration?.inMilliseconds,
        'coverUrl': coverUrl,
        'filePath': filePath,
        'url': url,
        'server': server?.id,
        'sourceKey': sourceKey,
        'bitrate': bitrate,
        'folder': folder,
        'addedAt': addedAt?.millisecondsSinceEpoch,
      };

  factory Track.fromJson(Map<String, dynamic> j) {
    final Object? ms = j['durationMs'];
    return Track(
      id: (j['id'] ?? '').toString(),
      title: (j['title'] ?? '').toString(),
      artist: (j['artist'] ?? '').toString(),
      album: (j['album'] ?? '').toString(),
      duration: ms is num ? Duration(milliseconds: ms.toInt()) : null,
      coverUrl: j['coverUrl'] as String?,
      filePath: j['filePath'] as String?,
      url: j['url'] as String?,
      server: MusicServer.fromId(j['server'] as String?),
      sourceKey: j['sourceKey'] as String?,
      bitrate: (j['bitrate'] as num?)?.toInt(),
      folder: j['folder'] as String?,
      addedAt: j['addedAt'] is num
          ? DateTime.fromMillisecondsSinceEpoch((j['addedAt'] as num).toInt())
          : null,
    );
  }

  @override
  String toString() => 'Track($id, $displayTitle — $displayArtist)';

  @override
  bool operator ==(Object other) => other is Track && other.id == id;

  @override
  int get hashCode => id.hashCode;
}

/// 秒 -> `m:ss` / `h:mm:ss`；null 或 <=0 返回 `--:--`。
String formatDuration(Duration? d) {
  if (d == null || d.inMilliseconds <= 0) return '--:--';
  final int total = d.inSeconds;
  final int h = total ~/ 3600;
  final int m = (total % 3600) ~/ 60;
  final int s = total % 60;
  final String ss = s.toString().padLeft(2, '0');
  if (h > 0) return '$h:${m.toString().padLeft(2, '0')}:$ss';
  return '$m:$ss';
}

/// 毫秒 -> `m:ss`（播放进度用，不带负号）
String formatMs(int ms) => formatDuration(Duration(milliseconds: ms));

/// 在线歌单
class OnlinePlaylist {
  const OnlinePlaylist({
    required this.server,
    required this.id,
    required this.name,
    this.coverUrl,
    this.trackCount,
    this.creator,
  });

  final MusicServer server;
  final String id;
  final String name;
  final String? coverUrl;
  final int? trackCount;
  final String? creator;

  String get key => '${server.id}:$id';

  Map<String, dynamic> toJson() => <String, dynamic>{
        'server': server.id,
        'id': id,
        'name': name,
        'coverUrl': coverUrl,
        'trackCount': trackCount,
        'creator': creator,
      };

  factory OnlinePlaylist.fromJson(Map<String, dynamic> j) => OnlinePlaylist(
        server: MusicServer.fromId(j['server'] as String?) ?? MusicServer.netease,
        id: (j['id'] ?? '').toString(),
        name: (j['name'] ?? '').toString(),
        coverUrl: j['coverUrl'] as String?,
        trackCount: (j['trackCount'] as num?)?.toInt(),
        creator: j['creator'] as String?,
      );
}
