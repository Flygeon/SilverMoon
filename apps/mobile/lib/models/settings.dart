import 'play_mode.dart';

/// 音乐播放相关设置项。字段名与桌面端 `settings.ts` 的 DEFAULTS 保持同名，
/// 便于将来与桌面端 settings.json 互导。
class AppSettings {
  const AppSettings({
    this.lang = 'zh',
    this.themeMode = 'system',
    this.dynamicColor = true,
    this.lyricFontSize = 30,
    this.lyricLineHeight = 2.5,
    this.lyricLineGap = 20,
    this.lyricTranslationSize = 62,
    this.lyricTranslationGap = 4,
    this.lyricSubMode = 'translation',
    this.wordLyrics = true,
    this.detectInstrumental = true,
    this.playerBg = 'animated',
    this.lyricBlur = true,
    this.musicViewMode = 'list',
    this.scanDirs = const <String>[],
    this.minFileSizeMb = 0,
    this.enableOnlineMusic = true,
    this.musicServer = 'netease',
    // 两个平台默认都开。Vue 侧这两个默认是关的，而能改它们的 Vue 设置页
    // 在移动端没进路由 —— 只有这里开着，音乐页才会显示平台条（切源 + 登录）。
    this.neteaseEnabled = true,
    this.kugouEnabled = true,
    this.onlinePlaylists = const <String>[],
    this.volume = 1.0,
    this.playbackRate = 1.0,
    this.effectsEnabled = false,
  });

  final String lang;

  /// system / light / dark
  final String themeMode;

  /// Android 12+ Monet 系统取色
  final bool dynamicColor;

  final double lyricFontSize;
  final double lyricLineHeight;
  final double lyricLineGap;
  final double lyricTranslationSize;
  final double lyricTranslationGap;

  /// translation / romaji
  final String lyricSubMode;

  final bool wordLyrics;
  final bool detectInstrumental;

  /// animated / amll / image / off
  final String playerBg;

  final bool lyricBlur;

  /// grid / list
  final String musicViewMode;

  final List<String> scanDirs;
  final double minFileSizeMb;
  final bool enableOnlineMusic;

  /// netease / kugou
  final String musicServer;

  /// 是否启用网易云账号（扫码登录、我的歌单、云盘）
  final bool neteaseEnabled;

  /// 是否启用酷狗账号（扫码/手机号登录、每日推荐、榜单）
  final bool kugouEnabled;

  /// `server:id` 列表
  final List<String> onlinePlaylists;

  final double volume;
  final double playbackRate;
  final bool effectsEnabled;

  PlayerBackground get background => PlayerBackground.fromId(playerBg);

  AppSettings copyWith({
    String? lang,
    String? themeMode,
    bool? dynamicColor,
    double? lyricFontSize,
    double? lyricLineHeight,
    double? lyricLineGap,
    double? lyricTranslationSize,
    double? lyricTranslationGap,
    String? lyricSubMode,
    bool? wordLyrics,
    bool? detectInstrumental,
    String? playerBg,
    bool? lyricBlur,
    String? musicViewMode,
    List<String>? scanDirs,
    double? minFileSizeMb,
    bool? enableOnlineMusic,
    String? musicServer,
    bool? neteaseEnabled,
    bool? kugouEnabled,
    List<String>? onlinePlaylists,
    double? volume,
    double? playbackRate,
    bool? effectsEnabled,
  }) {
    return AppSettings(
      lang: lang ?? this.lang,
      themeMode: themeMode ?? this.themeMode,
      dynamicColor: dynamicColor ?? this.dynamicColor,
      lyricFontSize: lyricFontSize ?? this.lyricFontSize,
      lyricLineHeight: lyricLineHeight ?? this.lyricLineHeight,
      lyricLineGap: lyricLineGap ?? this.lyricLineGap,
      lyricTranslationSize: lyricTranslationSize ?? this.lyricTranslationSize,
      lyricTranslationGap: lyricTranslationGap ?? this.lyricTranslationGap,
      lyricSubMode: lyricSubMode ?? this.lyricSubMode,
      wordLyrics: wordLyrics ?? this.wordLyrics,
      detectInstrumental: detectInstrumental ?? this.detectInstrumental,
      playerBg: playerBg ?? this.playerBg,
      lyricBlur: lyricBlur ?? this.lyricBlur,
      musicViewMode: musicViewMode ?? this.musicViewMode,
      scanDirs: scanDirs ?? this.scanDirs,
      minFileSizeMb: minFileSizeMb ?? this.minFileSizeMb,
      enableOnlineMusic: enableOnlineMusic ?? this.enableOnlineMusic,
      musicServer: musicServer ?? this.musicServer,
      neteaseEnabled: neteaseEnabled ?? this.neteaseEnabled,
      kugouEnabled: kugouEnabled ?? this.kugouEnabled,
      onlinePlaylists: onlinePlaylists ?? this.onlinePlaylists,
      volume: volume ?? this.volume,
      playbackRate: playbackRate ?? this.playbackRate,
      effectsEnabled: effectsEnabled ?? this.effectsEnabled,
    );
  }

  Map<String, dynamic> toJson() => <String, dynamic>{
        'lang': lang,
        'themeMode': themeMode,
        'dynamicColor': dynamicColor,
        'lyricFontSize': lyricFontSize,
        'lyricLineHeight': lyricLineHeight,
        'lyricLineGap': lyricLineGap,
        'lyricTranslationSize': lyricTranslationSize,
        'lyricTranslationGap': lyricTranslationGap,
        'lyricSubMode': lyricSubMode,
        'wordLyrics': wordLyrics,
        'detectInstrumental': detectInstrumental,
        'playerBg': playerBg,
        'lyricBlur': lyricBlur,
        'musicViewMode': musicViewMode,
        'scanDirs': scanDirs,
        'minFileSizeMb': minFileSizeMb,
        'enableOnlineMusic': enableOnlineMusic,
        'musicServer': musicServer,
        'neteaseEnabled': neteaseEnabled,
        'kugouEnabled': kugouEnabled,
        'onlinePlaylists': onlinePlaylists,
        'volume': volume,
        'playbackRate': playbackRate,
        'effectsEnabled': effectsEnabled,
      };

  factory AppSettings.fromJson(Map<String, dynamic> j) {
    final AppSettings d = const AppSettings();
    double num2(Object? v, double fb) => v is num ? v.toDouble() : fb;
    bool bool2(Object? v, bool fb) => v is bool ? v : fb;
    String str2(Object? v, String fb) => v is String && v.isNotEmpty ? v : fb;
    List<String> list2(Object? v) =>
        v is List ? v.map((e) => e.toString()).toList() : const <String>[];
    return AppSettings(
      lang: str2(j['lang'], d.lang),
      themeMode: str2(j['themeMode'], d.themeMode),
      dynamicColor: bool2(j['dynamicColor'], d.dynamicColor),
      lyricFontSize: num2(j['lyricFontSize'], d.lyricFontSize),
      lyricLineHeight: num2(j['lyricLineHeight'], d.lyricLineHeight),
      lyricLineGap: num2(j['lyricLineGap'], d.lyricLineGap),
      lyricTranslationSize: num2(j['lyricTranslationSize'], d.lyricTranslationSize),
      lyricTranslationGap: num2(j['lyricTranslationGap'], d.lyricTranslationGap),
      lyricSubMode: str2(j['lyricSubMode'], d.lyricSubMode),
      wordLyrics: bool2(j['wordLyrics'], d.wordLyrics),
      detectInstrumental: bool2(j['detectInstrumental'], d.detectInstrumental),
      playerBg: str2(j['playerBg'], d.playerBg),
      lyricBlur: bool2(j['lyricBlur'], d.lyricBlur),
      musicViewMode: str2(j['musicViewMode'], d.musicViewMode),
      scanDirs: list2(j['scanDirs']),
      minFileSizeMb: num2(j['minFileSizeMb'], d.minFileSizeMb),
      enableOnlineMusic: bool2(j['enableOnlineMusic'], d.enableOnlineMusic),
      musicServer: str2(j['musicServer'], d.musicServer),
      // 用 bool2 而不是 bool2(..., true)：用户关掉之后要能存住。
      // 值缺失时才落到 d.neteaseEnabled（默认 true）。
      neteaseEnabled: bool2(j['neteaseEnabled'], d.neteaseEnabled),
      kugouEnabled: bool2(j['kugouEnabled'], d.kugouEnabled),
      onlinePlaylists: list2(j['onlinePlaylists']),
      volume: num2(j['volume'], d.volume),
      playbackRate: num2(j['playbackRate'], d.playbackRate),
      effectsEnabled: bool2(j['effectsEnabled'], d.effectsEnabled),
    );
  }
}
