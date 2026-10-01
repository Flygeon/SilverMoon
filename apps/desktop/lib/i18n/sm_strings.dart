import 'generated/archive_messages.dart';

/// 桌面端文案表（zh / en）。
///
/// 词条来自两处，合并顺序即优先级（后者覆盖前者）：
///  1. `generated/archive_messages.dart` —— 由 `tool/gen_archive_messages.mjs` 从
///     `archive/electron-desktop/shared/i18n.ts` 生成，715 条，键名与 Electron 版
///     的 `translate()` 完全一致（点号路径）。**不要手抄这些词条**，改动归档后重新生成。
///  2. 下面的 `_hostOwned` —— Flutter 宿主自有、归档里没有的词条（自定义标题栏、
///     迷你播放条、占位页）。同名时以宿主表为准。
class SmStrings {
  const SmStrings(this.lang);

  final String lang;

  static const List<String> supportedLangs = <String>['zh', 'en'];

  static const String _fallbackLang = 'zh';

  /// 宿主自有词条（归档里没有的，见类文档）。
  static const Map<String, Map<String, String>> _hostOwned = <String, Map<String, String>>{
    'zh': <String, String>{
      'app.name': 'SilverMoon',
      'app.tagline': '光影 · 媒体库',

      'nav.images': '图片',
      'nav.videos': '视频',
      'nav.music': '音乐',
      'nav.books': '书籍',
      'nav.treasure': '百宝箱',
      'nav.settings': '设置',

      'titlebar.appearance': '外观',
      'titlebar.themeSystem': '跟随系统',
      'titlebar.themeLight': '浅色',
      'titlebar.themeDark': '深色',
      'titlebar.github': '在浏览器打开 GitHub 仓库',
      'titlebar.minimize': '最小化',
      'titlebar.maximize': '最大化',
      'titlebar.restore': '还原',
      'titlebar.close': '关闭',
      'titlebar.language': '语言',

      'miniplayer.prev': '上一首',
      'miniplayer.play': '播放',
      'miniplayer.next': '下一首',
      'miniplayer.expand': '展开播放器',
      'miniplayer.unknownArtist': '未知艺术家',

      'host.connecting': '正在连接后端…',
      'host.failed': '后端未就绪',
      'host.retry': '重试',

      'images.empty': '媒体库还没有图片',
      'images.emptyHint': '添加一个文件夹并扫描，图片会出现在这里',
      'images.addFolder': '添加文件夹并扫描',
      'images.loading': '正在读取媒体库…',
      'images.loadMore': '加载更多',
      'images.refresh': '刷新',
      'images.scanSaved': '扫描已保存的文件夹',
      'images.scanning': '正在扫描…',
      'images.total': '张图片',

      'shell.route': '路由',
      'shell.phase': '阶段',
      'shell.phaseValue': 'P0 · 界面框架',
      'shell.pendingTitle': '界面框架占位页',
      'shell.pendingDesc':
          '本页当前只提供路由、外壳与占位内容。功能实现等界面框架确认后再逐页填充，届时本页会被真实视图替换。',
      'shell.wired': '已接入',
      'shell.wiredShell': '窗口外壳 / 标题栏 / 导航 / 主题 / i18n 开关',
      'shell.notWired': '未接入',
      'shell.notWiredList': '命令通道、事件总线、Rust sidecar、WebView 播放层、持久化设置',

      'page.images.title': '图片',
      'page.images.desc': '照片与截图浏览（Rust 缩略图 + 虚拟滚动网格）',
      'page.videos.title': '视频',
      'page.videos.desc': '影片与短片（media_kit / libmpv 播放）',
      'page.music.title': '音乐',
      'page.music.desc': '本地与在线音乐库；播放层复用 Vue 产物',
      'page.musicPlayer.title': '播放器',
      'page.musicPlayer.desc': '全屏播放界面（WebView 复用 PlayerView + Web Audio 音效链）',
      'page.books.title': '书籍',
      'page.books.desc': '电子书与文档（EPUB / PDF）',
      'page.folders.title': '文件夹',
      'page.folders.desc': '按目录浏览已索引的媒体',
      'page.webdav.title': 'WebDAV',
      'page.webdav.desc': '远程媒体浏览器',
      'page.treasure.title': '百宝箱',
      'page.treasure.desc': '实用工具与扩展入口聚合',
      'page.presetMarket.title': '音效预设市场',
      'page.presetMarket.desc': '音效预设的在线获取与管理',
      'page.osu.title': 'osu!',
      'page.osu.desc': '谱面搜索、下载与导入',
      'page.favorites.title': '收藏',
      'page.favorites.desc': '收藏的媒体',
      'page.history.title': '历史',
      'page.history.desc': '最近播放记录',
      'page.stats.title': '统计',
      'page.stats.desc': '听歌与使用统计',
      'page.novelStats.title': '阅读统计',
      'page.novelStats.desc': '在线阅读的时长与进度统计',
      'page.trash.title': '回收站',
      'page.trash.desc': '已删除的媒体',
      'page.settings.title': '设置',
      'page.settings.desc': '82 项持久化设置与 4 条隐式副作用通道',
      'page.desktopLyrics.title': '桌面歌词',
      'page.desktopLyrics.desc': '透明置顶 + 鼠标穿透的独立歌词窗',
      'page.extensions.title': '扩展',
      'page.extensions.desc': '扩展管理与守护进程',
      'page.extensionHost.title': '扩展宿主',
      'page.extensionHost.desc': '第三方扩展 UI 的 WebView 宿主',
      'settings.gridColumns': '网格列数',
      'settings.gridColumnsHint': '图片墙每行显示的列数，影响图片页与视频页。',
      'settings.wordLyrics': '逐字歌词',
      'settings.lyricSubMode': '歌词副行',
      'settings.readerTheme': '阅读背景',
      'settings.readerTheme_sepia': '羊皮纸',
      'settings.readerTheme_green': '护眼绿',
      'settings.readerFont': '正文字体',
      'settings.readerFontPct': '正文字号',
      'settings.readerLineHeight': '正文行距',
      'settings.readerParaSpacing': '段落间距',
      'settings.readerParaSpacingHint': '0 表示跟随原书排版。',
      'settings.bqgNovelEnable': '笔趣阁小说',
      'settings.wenku8Node': 'Wenku8 节点',
      'settings.wenku8Node_cc': '主站 (cc)',
      'settings.wenku8Node_net': '备用 (net)',
      'settings.danmakuTimeOffsetMs': '时间轴偏移（毫秒）',
      'settings.bangumiSyncedAt': '上次同步',
      'settings.unknown': '未设置',
      'settings.audioEffectsPending': '音效参数存在 audio-effects.json；编辑界面依赖播放器层（复用 Vue 播放器的 WebView2 宿主）。播放器层接入前，这里只提供预设市场入口。',
      'videos.total': '个视频',
      'videos.empty': '媒体库还没有视频',
      'videos.emptyHint': '添加文件夹并扫描，视频会出现在这里',
      'folders.empty': '暂无已索引目录',
      'folders.items': '项',
      'books.progress': '阅读进度',
      'books.readerPending': '阅读器复用 Vue 的 epub.js / pdf.js 渲染层（WebView2 宿主），尚未接入；当前先列出本地书籍与阅读进度。',
      'webdav.saveConnect': '保存并连接',
      'webdav.up': '返回上级',
      'webdav.openFile': '用默认程序打开',
    },
    'en': <String, String>{
      'app.name': 'SilverMoon',
      'app.tagline': 'Light and Shadow · Media Library',

      'nav.images': 'Images',
      'nav.videos': 'Videos',
      'nav.music': 'Music',
      'nav.books': 'Books',
      'nav.treasure': 'Treasure',
      'nav.settings': 'Settings',

      'titlebar.appearance': 'Appearance',
      'titlebar.themeSystem': 'Follow system',
      'titlebar.themeLight': 'Light',
      'titlebar.themeDark': 'Dark',
      'titlebar.github': 'Open the GitHub repository in a browser',
      'titlebar.minimize': 'Minimize',
      'titlebar.maximize': 'Maximize',
      'titlebar.restore': 'Restore',
      'titlebar.close': 'Close',
      'titlebar.language': 'Language',

      'miniplayer.prev': 'Previous',
      'miniplayer.play': 'Play',
      'miniplayer.next': 'Next',
      'miniplayer.expand': 'Expand player',
      'miniplayer.unknownArtist': 'Unknown artist',

      'host.connecting': 'Connecting to the backend…',
      'host.failed': 'Backend not ready',
      'host.retry': 'Retry',

      'images.empty': 'No images in the library yet',
      'images.emptyHint': 'Add a folder and scan it — images will show up here',
      'images.addFolder': 'Add folder and scan',
      'images.loading': 'Loading library…',
      'images.loadMore': 'Load more',
      'images.refresh': 'Refresh',
      'images.scanSaved': 'Scan saved folders',
      'images.scanning': 'Scanning…',
      'images.total': 'images',

      'shell.route': 'Route',
      'shell.phase': 'Phase',
      'shell.phaseValue': 'P0 · UI framework',
      'shell.pendingTitle': 'Framework placeholder page',
      'shell.pendingDesc':
          'This page currently provides only its route, the app shell and placeholder content. Real features are filled in page by page once the framework is approved.',
      'shell.wired': 'Wired up',
      'shell.wiredShell': 'Window shell / title bar / navigation / theme / i18n switch',
      'shell.notWired': 'Not wired up',
      'shell.notWiredList':
          'Command channel, event bus, Rust sidecar, WebView player layer, persisted settings',

      'page.images.title': 'Images',
      'page.images.desc': 'Photos and screenshots (Rust thumbnails plus a virtualised grid)',
      'page.videos.title': 'Videos',
      'page.videos.desc': 'Films and clips (media_kit / libmpv)',
      'page.music.title': 'Music',
      'page.music.desc': 'Local and online library; the player layer reuses the Vue bundle',
      'page.musicPlayer.title': 'Player',
      'page.musicPlayer.desc':
          'Full-screen player (WebView reusing PlayerView plus the Web Audio effect chain)',
      'page.books.title': 'Books',
      'page.books.desc': 'E-books and documents (EPUB / PDF)',
      'page.folders.title': 'Folders',
      'page.folders.desc': 'Browse indexed media by directory',
      'page.webdav.title': 'WebDAV',
      'page.webdav.desc': 'Remote media browser',
      'page.treasure.title': 'Treasure',
      'page.treasure.desc': 'Aggregated utilities and extensions',
      'page.presetMarket.title': 'Effect preset market',
      'page.presetMarket.desc': 'Fetch and manage audio effect presets online',
      'page.osu.title': 'osu!',
      'page.osu.desc': 'Beatmap search, download and import',
      'page.favorites.title': 'Favorites',
      'page.favorites.desc': 'Bookmarked media',
      'page.history.title': 'History',
      'page.history.desc': 'Recently played items',
      'page.stats.title': 'Statistics',
      'page.stats.desc': 'Listening and usage statistics',
      'page.novelStats.title': 'Reading statistics',
      'page.novelStats.desc': 'Reading time and progress for online novels',
      'page.trash.title': 'Trash',
      'page.trash.desc': 'Deleted media',
      'page.settings.title': 'Settings',
      'page.settings.desc': '82 persisted settings plus 4 implicit side-effect channels',
      'page.desktopLyrics.title': 'Desktop lyrics',
      'page.desktopLyrics.desc': 'Always-on-top transparent lyrics window with click-through',
      'page.extensions.title': 'Extensions',
      'page.extensions.desc': 'Extension management and hosting',
      'page.extensionHost.title': 'Extension host',
      'page.extensionHost.desc': 'WebView host for third-party extension UI',
      'settings.gridColumns': 'Grid columns',
      'settings.gridColumnsHint': 'Columns per row on the image wall (images and videos pages).',
      'settings.wordLyrics': 'Word-by-word lyrics',
      'settings.lyricSubMode': 'Secondary lyric line',
      'settings.readerTheme': 'Reading background',
      'settings.readerTheme_sepia': 'Sepia',
      'settings.readerTheme_green': 'Eye-care green',
      'settings.readerFont': 'Body font',
      'settings.readerFontPct': 'Body font size',
      'settings.readerLineHeight': 'Body line height',
      'settings.readerParaSpacing': 'Paragraph spacing',
      'settings.readerParaSpacingHint': '0 follows the layout of the book.',
      'settings.bqgNovelEnable': 'Bqg novels',
      'settings.wenku8Node': 'Wenku8 node',
      'settings.wenku8Node_cc': 'Primary (cc)',
      'settings.wenku8Node_net': 'Backup (net)',
      'settings.danmakuTimeOffsetMs': 'Timeline offset (ms)',
      'settings.bangumiSyncedAt': 'Last synced',
      'settings.unknown': 'Not set',
      'settings.audioEffectsPending': 'Audio effect parameters live in audio-effects.json; the editor depends on the player layer (WebView2 hosting the Vue player). Until that layer lands, this only links to the preset market.',
      'videos.total': 'videos',
      'videos.empty': 'No videos in the library yet',
      'videos.emptyHint': 'Add a folder and scan it — videos will show up here',
      'folders.empty': 'No indexed folders yet',
      'folders.items': 'items',
      'books.progress': 'Reading progress',
      'books.readerPending': 'The reader reuses the Vue epub.js / pdf.js renderer (WebView2 host) and is not wired up yet; this page lists local books with their reading progress.',
      'webdav.saveConnect': 'Save & connect',
      'webdav.up': 'Go up',
      'webdav.openFile': 'Open with default app',
    },
  };

  /// 归档词条 + 宿主自有词条（宿主表后合并，同名时以宿主为准）。
  static final Map<String, Map<String, String>> _data = _merge();

  static Map<String, Map<String, String>> _merge() {
    final Map<String, Map<String, String>> merged = <String, Map<String, String>>{};
    for (final String lang in supportedLangs) {
      merged[lang] = <String, String>{
        ...?kArchiveMessages[lang],
        ...?_hostOwned[lang],
      };
    }
    return merged;
  }

  /// 基准语言（zh）的全部词条 key。
  static Set<String> get allKeys => _data[_fallbackLang]!.keys.toSet();

  /// 指定语言的词条 key 集合（语言不存在时为空集）。
  static Set<String> keysOf(String lang) => (_data[lang] ?? const <String, String>{}).keys.toSet();

  /// 按 key 取词条；缺失时回退到 zh，再缺失时原样返回 key（便于发现漏译）。
  String t(String key) {
    final Map<String, String> table = _data[lang] ?? _data[_fallbackLang]!;
    return table[key] ?? _data[_fallbackLang]![key] ?? key;
  }
}
