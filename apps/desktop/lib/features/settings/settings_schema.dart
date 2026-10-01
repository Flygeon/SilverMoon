import 'package:flutter/material.dart';

/// 设置项的控件类型。
enum SmFieldKind {
  /// 开关
  toggle,
  /// 整数滑块（拖动即生效，松手后节流落盘）
  sliderInt,
  /// 小数滑块
  sliderDouble,
  /// 单行文本
  text,
  /// 单行文本（掩码显示）
  secret,
  /// 单选（≤3 项用分段控件，>3 项用下拉）
  choice,
  /// 种子色色板（Material You）
  colorSeed,
  /// 只读展示（Bangumi 用户名、上次同步时间等）
  readonly,
}

/// 分节里不适配通用字段渲染器的区块。
enum SmSectionSlot {
  none,
  /// 扫描目录列表（增删目录 + 全局扫描提示）
  scanDirs,
  /// 皮肤管理（后端 skin_list / skin_restore）
  skins,
  /// FFmpeg 检测与指定目录
  ffmpeg,
  /// 音效（audio-effects.json，依赖播放器层）
  audioEffects,
  /// 关于（版本 / 许可证 / DevTools）
  about,
}

/// 单选控件的一个选项。
@immutable
class SmChoice {
  const SmChoice(this.value, this.labelKey);

  final String value;

  /// 词条 key（一般来自归档的 settings.* 组）。
  final String labelKey;
}

/// 一个设置项。
///
/// [key] 必须与归档 stores/settings.ts 的 DEFAULTS 逐字一致：settings.json 是两边
/// 共用的同一份文件，键名错了就既读不到也存不上。
/// [defaultValue] 同样取自那份 DEFAULTS，保证「文件里没有该键」时与 Electron 版一致。
@immutable
class SmField {
  const SmField({
    required this.key,
    required this.kind,
    required this.defaultValue,
    this.labelKey = '',
    this.hintKey = '',
    this.choices = const <SmChoice>[],
    this.min = 0,
    this.max = 100,
    this.divisions,
    this.suffix = '',
    this.offAtValue,
    this.offLabelKey = '',
    this.placeholderKey = '',
  });

  final String key;
  final SmFieldKind kind;
  final Object? defaultValue;
  final String labelKey;
  final String hintKey;
  final List<SmChoice> choices;
  final num min;
  final num max;
  final int? divisions;
  /// 数值后缀（%、px、MB…）
  final String suffix;
  /// 等于该值时按「关闭」渲染（如最小文件体积 0 = 不过滤）
  final Object? offAtValue;
  final String offLabelKey;
  final String placeholderKey;
}

/// 设置分节，顺序与 Electron 版 SettingsView.vue 的分节顺序一致。
@immutable
class SmSection {
  const SmSection({
    required this.id,
    required this.titleKey,
    required this.icon,
    this.fields = const <SmField>[],
    this.slot = SmSectionSlot.none,
    this.hintKey = '',
  });

  final String id;
  final String titleKey;
  final IconData icon;
  final List<SmField> fields;
  final SmSectionSlot slot;
  final String hintKey;
}

/// 归档 SettingsView.vue 第 126-134 行的 7 个预设种子色（十六进制原样搬运）。
const List<SmChoice> kColorSeeds = <SmChoice>[
  SmChoice('#1A5C9E', 'settings.colorSeed_blue'),
  SmChoice('#00696E', 'settings.colorSeed_teal'),
  SmChoice('#6750A4', 'settings.colorSeed_violet'),
  SmChoice('#4C662B', 'settings.colorSeed_green'),
  SmChoice('#8F4C00', 'settings.colorSeed_amber'),
  SmChoice('#B3261E', 'settings.colorSeed_rose'),
  SmChoice('#8B4A6C', 'settings.colorSeed_pink'),
];

/// 阅读器正文字体与歌词字体共用的 5 个选项。
const List<SmChoice> kFontChoices = <SmChoice>[
  SmChoice('system', 'settings.lyricFont_system'),
  SmChoice('serif', 'settings.lyricFont_serif'),
  SmChoice('sans', 'settings.lyricFont_sans'),
  SmChoice('kai', 'settings.lyricFont_kai'),
  SmChoice('yuan', 'settings.lyricFont_yuan'),
];

/// 桌面端全部设置项：73 个字段按 15 个分节分组，与归档 DEFAULTS 逐条对应。
const List<SmSection> kSettingsSections = <SmSection>[
  SmSection(
    id: 'scanDirs',
    titleKey: 'settings.scanDirs',
    icon: Icons.folder_copy_outlined,
    hintKey: 'settings.scanDirsHint',
    slot: SmSectionSlot.scanDirs,
    fields: <SmField>[
      SmField(
        key: 'minFileSizeMb',
        kind: SmFieldKind.sliderInt,
        defaultValue: 0,
        labelKey: 'settings.minSize',
        hintKey: 'settings.minSizeHint',
        min: 0,
        max: 200,
        suffix: ' MB',
        offAtValue: 0,
        offLabelKey: 'settings.minSizeOff',
      ),
    ],
  ),
  SmSection(
    id: 'appearance',
    titleKey: 'settings.appearance',
    icon: Icons.palette_outlined,
    fields: <SmField>[
      SmField(
        key: 'theme',
        kind: SmFieldKind.choice,
        defaultValue: 'system',
        labelKey: 'settings.theme',
        choices: <SmChoice>[
          SmChoice('system', 'settings.system'),
          SmChoice('light', 'settings.light'),
          SmChoice('dark', 'settings.dark'),
        ],
      ),
      SmField(
        key: 'lang',
        kind: SmFieldKind.choice,
        defaultValue: 'zh',
        labelKey: 'settings.language',
        choices: <SmChoice>[
          SmChoice('zh', '中文'),
          SmChoice('en', 'English'),
        ],
      ),
      SmField(
        key: 'closeToTray',
        kind: SmFieldKind.toggle,
        defaultValue: true,
        labelKey: 'settings.closeToTray',
        hintKey: 'settings.closeToTrayHint',
      ),
      SmField(
        key: 'gridColumns',
        kind: SmFieldKind.sliderInt,
        defaultValue: 6,
        labelKey: 'settings.gridColumns',
        hintKey: 'settings.gridColumnsHint',
        min: 2,
        max: 12,
      ),
    ],
  ),
  SmSection(
    id: 'colorScheme',
    titleKey: 'settings.colorScheme',
    icon: Icons.color_lens_outlined,
    hintKey: 'settings.colorSchemeHint',
    fields: <SmField>[
      SmField(
        key: 'seedColor',
        kind: SmFieldKind.colorSeed,
        defaultValue: '#1A5C9E',
        labelKey: 'settings.colorScheme',
      ),
    ],
  ),
  SmSection(
    id: 'skins',
    titleKey: 'settings.skins',
    icon: Icons.auto_awesome_outlined,
    hintKey: 'settings.skinsHint',
    slot: SmSectionSlot.skins,
    fields: <SmField>[
      SmField(
        key: 'activeSkin',
        kind: SmFieldKind.readonly,
        defaultValue: '',
        labelKey: 'settings.skinDefault',
      ),
    ],
  ),
  SmSection(
    id: 'playback',
    titleKey: 'settings.playback',
    icon: Icons.play_circle_outline,
    fields: <SmField>[
      SmField(
        key: 'playerBg',
        kind: SmFieldKind.choice,
        defaultValue: 'animated',
        labelKey: 'settings.playerBg',
        hintKey: 'settings.playerBgHint',
        choices: <SmChoice>[
          SmChoice('animated', 'settings.playerBg_animated'),
          SmChoice('amll', 'settings.playerBg_amll'),
          SmChoice('image', 'settings.playerBg_image'),
          SmChoice('off', 'settings.playerBg_off'),
        ],
      ),
      SmField(
        key: 'musicViewMode',
        kind: SmFieldKind.choice,
        defaultValue: 'grid',
        labelKey: 'settings.musicViewMode',
        choices: <SmChoice>[
          SmChoice('grid', 'settings.musicViewMode_grid'),
          SmChoice('list', 'settings.musicViewMode_list'),
        ],
      ),
      SmField(key: 'lyricBlur', kind: SmFieldKind.toggle, defaultValue: true, labelKey: 'settings.lyricBlur'),
      SmField(key: 'wordLyrics', kind: SmFieldKind.toggle, defaultValue: true, labelKey: 'settings.wordLyrics'),
      SmField(
        key: 'preciseLyrics',
        kind: SmFieldKind.toggle,
        defaultValue: false,
        labelKey: 'settings.preciseLyrics',
        hintKey: 'settings.preciseLyricsHint',
      ),
      SmField(
        key: 'detectInstrumental',
        kind: SmFieldKind.toggle,
        defaultValue: true,
        labelKey: 'settings.detectInstrumental',
        hintKey: 'settings.detectInstrumentalHint',
      ),
      SmField(
        key: 'shareCodePreference',
        kind: SmFieldKind.choice,
        defaultValue: 'both',
        labelKey: 'settings.shareCodePreference',
        hintKey: 'settings.shareCodePreferenceHint',
        choices: <SmChoice>[
          SmChoice('both', 'settings.shareCodePreference_both'),
          SmChoice('chinese', 'settings.shareCodePreference_chinese'),
          SmChoice('original', 'settings.shareCodePreference_original'),
        ],
      ),
    ],
  ),
  SmSection(
    id: 'lyrics',
    titleKey: 'settings.lyrics',
    icon: Icons.lyrics_outlined,
    fields: <SmField>[
      SmField(
        key: 'lyricFont',
        kind: SmFieldKind.choice,
        defaultValue: 'system',
        labelKey: 'settings.lyricFont',
        choices: kFontChoices,
      ),
      SmField(
        key: 'lyricFontSize',
        kind: SmFieldKind.sliderInt,
        defaultValue: 30,
        labelKey: 'settings.lyricFontSize',
        min: 12,
        max: 72,
        suffix: ' px',
      ),
      SmField(
        key: 'lyricLineHeight',
        kind: SmFieldKind.sliderDouble,
        defaultValue: 2.5,
        labelKey: 'settings.lyricLineHeight',
        min: 1.0,
        max: 3.0,
        divisions: 40,
      ),
      SmField(
        key: 'lyricLineGap',
        kind: SmFieldKind.sliderInt,
        defaultValue: 20,
        labelKey: 'settings.lyricLineGap',
        min: 0,
        max: 80,
        suffix: ' px',
      ),
      SmField(
        key: 'lyricSubMode',
        kind: SmFieldKind.choice,
        defaultValue: 'translation',
        labelKey: 'settings.lyricSubMode',
        choices: <SmChoice>[
          SmChoice('translation', 'player.translation'),
          SmChoice('romaji', 'player.romaji'),
        ],
      ),
      SmField(
        key: 'lyricTranslationSize',
        kind: SmFieldKind.sliderInt,
        defaultValue: 62,
        labelKey: 'settings.lyricTranslationSize',
        min: 20,
        max: 120,
        suffix: ' %',
      ),
      SmField(
        key: 'lyricTranslationGap',
        kind: SmFieldKind.sliderInt,
        defaultValue: 4,
        labelKey: 'settings.lyricTranslationGap',
        min: 0,
        max: 40,
        suffix: ' px',
      ),
    ],
  ),
  SmSection(
    id: 'desktopLyrics',
    titleKey: 'settings.desktopLyrics',
    icon: Icons.subtitles_outlined,
    hintKey: 'settings.desktopLyricsHint',
    fields: <SmField>[
      SmField(
        key: 'desktopLyricsEnabled',
        kind: SmFieldKind.toggle,
        defaultValue: false,
        labelKey: 'settings.desktopLyricsEnable',
      ),
      SmField(
        key: 'desktopLyricsFontSize',
        kind: SmFieldKind.sliderInt,
        defaultValue: 28,
        labelKey: 'settings.desktopLyricsFontSize',
        min: 12,
        max: 64,
        suffix: ' px',
      ),
      SmField(
        key: 'desktopLyricsOpacity',
        kind: SmFieldKind.sliderInt,
        defaultValue: 90,
        labelKey: 'settings.desktopLyricsOpacity',
        min: 10,
        max: 100,
        suffix: ' %',
      ),
      SmField(
        key: 'desktopLyricsAlwaysOnTop',
        kind: SmFieldKind.toggle,
        defaultValue: true,
        labelKey: 'settings.desktopLyricsAlwaysOnTop',
      ),
      SmField(
        key: 'desktopLyricsLocked',
        kind: SmFieldKind.toggle,
        defaultValue: false,
        labelKey: 'settings.desktopLyricsLocked',
      ),
      SmField(
        key: 'desktopLyricsShowNext',
        kind: SmFieldKind.toggle,
        defaultValue: false,
        labelKey: 'settings.desktopLyricsShowNext',
      ),
      SmField(
        key: 'desktopLyricsShowTranslation',
        kind: SmFieldKind.toggle,
        defaultValue: false,
        labelKey: 'settings.desktopLyricsShowTranslation',
      ),
      SmField(
        key: 'desktopLyricsClickThrough',
        kind: SmFieldKind.toggle,
        defaultValue: false,
        labelKey: 'settings.desktopLyricsClickThrough',
        hintKey: 'settings.desktopLyricsClickThroughHint',
      ),
      SmField(
        key: 'desktopLyricsToolbar',
        kind: SmFieldKind.choice,
        defaultValue: 'click',
        labelKey: 'settings.desktopLyricsToolbar',
        choices: <SmChoice>[
          SmChoice('click', 'settings.desktopLyricsToolbar_click'),
          SmChoice('always', 'settings.desktopLyricsToolbar_always'),
        ],
      ),
      SmField(
        key: 'desktopLyricsDoubleClick',
        kind: SmFieldKind.choice,
        defaultValue: 'toggle',
        labelKey: 'settings.desktopLyricsDoubleClick',
        choices: <SmChoice>[
          SmChoice('none', 'settings.desktopLyricsDoubleClick_none'),
          SmChoice('toggle', 'settings.desktopLyricsDoubleClick_toggle'),
        ],
      ),
      SmField(
        key: 'desktopLyricsAnimation',
        kind: SmFieldKind.choice,
        defaultValue: 'fade',
        labelKey: 'settings.desktopLyricsAnimation',
        choices: <SmChoice>[
          SmChoice('fade', 'settings.desktopLyricsAnim_fade'),
          SmChoice('slide', 'settings.desktopLyricsAnim_slide'),
          SmChoice('scale', 'settings.desktopLyricsAnim_scale'),
          SmChoice('glow', 'settings.desktopLyricsAnim_glow'),
        ],
      ),
    ],
  ),
  SmSection(
    id: 'reading',
    titleKey: 'settings.reading',
    icon: Icons.menu_book_outlined,
    fields: <SmField>[
      SmField(
        key: 'pdfReadMode',
        kind: SmFieldKind.choice,
        defaultValue: 'single',
        labelKey: 'settings.pdfMode',
        hintKey: 'settings.pdfModeHint',
        choices: <SmChoice>[
          SmChoice('single', 'settings.pdfMode_single'),
          SmChoice('dual', 'settings.pdfMode_dual'),
          SmChoice('scroll', 'settings.pdfMode_scroll'),
        ],
      ),
      SmField(
        key: 'readerTheme',
        kind: SmFieldKind.choice,
        defaultValue: 'dark',
        labelKey: 'settings.readerTheme',
        choices: <SmChoice>[
          SmChoice('dark', 'settings.dark'),
          SmChoice('light', 'settings.light'),
          SmChoice('sepia', 'settings.readerTheme_sepia'),
          SmChoice('green', 'settings.readerTheme_green'),
        ],
      ),
      SmField(
        key: 'readerFont',
        kind: SmFieldKind.choice,
        defaultValue: 'system',
        labelKey: 'settings.readerFont',
        choices: kFontChoices,
      ),
      SmField(
        key: 'readerFontPct',
        kind: SmFieldKind.sliderInt,
        defaultValue: 100,
        labelKey: 'settings.readerFontPct',
        min: 50,
        max: 200,
        suffix: ' %',
      ),
      SmField(
        key: 'readerLineHeight',
        kind: SmFieldKind.sliderDouble,
        defaultValue: 1.75,
        labelKey: 'settings.readerLineHeight',
        min: 1.0,
        max: 3.0,
        divisions: 40,
      ),
      SmField(
        key: 'readerParaSpacing',
        kind: SmFieldKind.sliderInt,
        defaultValue: 0,
        labelKey: 'settings.readerParaSpacing',
        hintKey: 'settings.readerParaSpacingHint',
        min: 0,
        max: 40,
        suffix: ' px',
      ),
      SmField(
        key: 'novelCharset',
        kind: SmFieldKind.choice,
        defaultValue: 'gbk',
        labelKey: 'settings.novelCharset',
        choices: <SmChoice>[
          SmChoice('gbk', 'settings.novelCharset_gbk'),
          SmChoice('big5', 'settings.novelCharset_big5'),
        ],
      ),
    ],
  ),
  SmSection(
    id: 'ffmpeg',
    titleKey: 'settings.ffmpeg',
    icon: Icons.movie_filter_outlined,
    hintKey: 'settings.ffmpegHint',
    slot: SmSectionSlot.ffmpeg,
  ),
  SmSection(
    id: 'online',
    titleKey: 'settings.online',
    icon: Icons.cloud_outlined,
    hintKey: 'settings.onlineHint',
    fields: <SmField>[
      SmField(
        key: 'enableOnlineMusic',
        kind: SmFieldKind.toggle,
        defaultValue: false,
        labelKey: 'settings.onlineEnable',
      ),
      SmField(
        key: 'musicServer',
        kind: SmFieldKind.choice,
        defaultValue: 'netease',
        labelKey: 'settings.onlineServer',
        choices: <SmChoice>[
          SmChoice('netease', 'settings.onlineServer_netease'),
          SmChoice('kugou', 'settings.onlineServer_kugou'),
        ],
      ),
      SmField(
        key: 'neteaseEnabled',
        kind: SmFieldKind.toggle,
        defaultValue: false,
        labelKey: 'settings.neteaseEnable',
        hintKey: 'settings.neteaseHint',
      ),
      SmField(
        key: 'kugouEnabled',
        kind: SmFieldKind.toggle,
        defaultValue: false,
        labelKey: 'settings.kugouEnable',
        hintKey: 'settings.kugouHint',
      ),
      SmField(
        key: 'kugouAutoSignIn',
        kind: SmFieldKind.toggle,
        defaultValue: true,
        labelKey: 'settings.kugouAutoSignIn',
      ),
      SmField(
        key: 'onlineNovelEnabled',
        kind: SmFieldKind.toggle,
        defaultValue: false,
        labelKey: 'settings.onlineNovelEnable',
        hintKey: 'settings.onlineNovelHint',
      ),
      SmField(
        key: 'bqgNovelEnabled',
        kind: SmFieldKind.toggle,
        defaultValue: false,
        labelKey: 'settings.bqgNovelEnable',
      ),
      SmField(
        key: 'onlineAnimeEnabled',
        kind: SmFieldKind.toggle,
        defaultValue: false,
        labelKey: 'settings.onlineAnimeEnable',
        hintKey: 'settings.onlineAnimeHint',
      ),
      SmField(
        key: 'onlinePixivEnabled',
        kind: SmFieldKind.toggle,
        defaultValue: false,
        labelKey: 'settings.onlinePixivEnabled',
        hintKey: 'settings.onlinePixivHint',
      ),
      SmField(
        key: 'pixivRefreshToken',
        kind: SmFieldKind.secret,
        defaultValue: '',
        labelKey: 'settings.pixivRefreshTokenLabel',
        hintKey: 'settings.pixivRefreshTokenHint',
      ),
      SmField(
        key: 'pixivImageQuality',
        kind: SmFieldKind.choice,
        defaultValue: 'large',
        labelKey: 'settings.pixivQuality',
        choices: <SmChoice>[
          SmChoice('squareMedium', 'settings.pixivQuality_squareMedium'),
          SmChoice('medium', 'settings.pixivQuality_medium'),
          SmChoice('large', 'settings.pixivQuality_large'),
          SmChoice('original', 'settings.pixivQuality_original'),
        ],
      ),
      SmField(
        key: 'wenku8Node',
        kind: SmFieldKind.choice,
        defaultValue: 'cc',
        labelKey: 'settings.wenku8Node',
        choices: <SmChoice>[
          SmChoice('cc', 'settings.wenku8Node_cc'),
          SmChoice('net', 'settings.wenku8Node_net'),
        ],
      ),
      SmField(
        key: 'bangumiToken',
        kind: SmFieldKind.secret,
        defaultValue: '',
        labelKey: 'settings.bangumiTokenLabel',
        hintKey: 'settings.bangumiHint',
        placeholderKey: 'settings.bangumiTokenPlaceholder',
      ),
      SmField(
        key: 'bangumiUsername',
        kind: SmFieldKind.readonly,
        defaultValue: '',
        labelKey: 'settings.bangumiConnect',
      ),
      SmField(
        key: 'bangumiSyncedAt',
        kind: SmFieldKind.readonly,
        defaultValue: 0,
        labelKey: 'settings.bangumiSyncedAt',
      ),
    ],
  ),
  SmSection(
    id: 'danmaku',
    titleKey: 'settings.danmaku',
    icon: Icons.comment_outlined,
    hintKey: 'settings.danmakuHint',
    fields: <SmField>[
      SmField(
        key: 'danmakuEnabled',
        kind: SmFieldKind.toggle,
        defaultValue: false,
        labelKey: 'settings.danmakuEnable',
      ),
      SmField(key: 'dandanAppId', kind: SmFieldKind.text, defaultValue: '', labelKey: 'settings.danmakuAppId'),
      SmField(
        key: 'dandanAppSecret',
        kind: SmFieldKind.secret,
        defaultValue: '',
        labelKey: 'settings.danmakuAppSecret',
      ),
      SmField(
        key: 'danmakuOpacity',
        kind: SmFieldKind.sliderInt,
        defaultValue: 80,
        labelKey: 'settings.danmakuOpacity',
        min: 0,
        max: 100,
        suffix: ' %',
      ),
      SmField(
        key: 'danmakuFontSize',
        kind: SmFieldKind.sliderInt,
        defaultValue: 22,
        labelKey: 'settings.danmakuFontSize',
        min: 12,
        max: 48,
        suffix: ' px',
      ),
      SmField(
        key: 'danmakuArea',
        kind: SmFieldKind.sliderInt,
        defaultValue: 75,
        labelKey: 'settings.danmakuArea',
        min: 0,
        max: 100,
        suffix: ' %',
      ),
      SmField(
        key: 'danmakuTimeOffsetMs',
        kind: SmFieldKind.sliderInt,
        defaultValue: 0,
        labelKey: 'settings.danmakuTimeOffsetMs',
        min: -10000,
        max: 10000,
        suffix: ' ms',
      ),
      SmField(
        key: 'danmakuSpeed',
        kind: SmFieldKind.sliderInt,
        defaultValue: 5,
        labelKey: 'settings.danmakuSpeed',
        min: 1,
        max: 10,
      ),
      SmField(
        key: 'danmakuAntiOverlap',
        kind: SmFieldKind.toggle,
        defaultValue: true,
        labelKey: 'settings.danmakuAntiOverlap',
      ),
    ],
  ),
  SmSection(
    id: 'webdav',
    titleKey: 'settings.webdav',
    icon: Icons.cloud_queue_outlined,
    hintKey: 'settings.webdavHint',
    fields: <SmField>[
      SmField(
        key: 'webdavEnabled',
        kind: SmFieldKind.toggle,
        defaultValue: false,
        labelKey: 'settings.webdavEnable',
      ),
      SmField(
        key: 'webdavUrl',
        kind: SmFieldKind.text,
        defaultValue: '',
        labelKey: 'settings.webdavUrl',
        placeholderKey: 'settings.webdavUrlPlaceholder',
      ),
      SmField(key: 'webdavUser', kind: SmFieldKind.text, defaultValue: '', labelKey: 'settings.webdavUser'),
      SmField(key: 'webdavPass', kind: SmFieldKind.secret, defaultValue: '', labelKey: 'settings.webdavPass'),
    ],
  ),
  SmSection(
    id: 'audioEffects',
    titleKey: 'settings.audioEffects',
    icon: Icons.graphic_eq,
    hintKey: 'settings.audioEffectsHint',
    slot: SmSectionSlot.audioEffects,
  ),
  SmSection(
    id: 'about',
    titleKey: 'settings.about',
    icon: Icons.info_outline,
    slot: SmSectionSlot.about,
  ),
];
