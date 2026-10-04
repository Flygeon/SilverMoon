import { defineStore } from "pinia";
import { computed, ref, watch } from "vue";
import { JsonStore } from "@/ipc/store";
import { capabilities } from "@/capabilities";
import { applySeedColor, clearSeedTokens } from "@/utils/dynamicTheme";
import { applySkin } from "@/utils/skinLoader";
import { activePrepared, activeSkinDoc, skinModeLock, skinSafeMode } from "@/utils/skinRuntime";
import type { MusicServer, OnlinePlaylistEntry } from "@shared/types";
import type { LyricSourcePref } from "@/utils/preciseLyrics";
import type { ObsceneMode } from "@/utils/obscene";

export type ThemeMode = "system" | "light" | "dark";
export type PdfReadMode = "single" | "dual" | "scroll";
/** 阅读器背景主题 */
export type ReaderThemeKey = "dark" | "light" | "sepia" | "green";
/** 阅读器正文字体 */
export type ReaderFontKey = "system" | "serif" | "sans" | "kai" | "yuan";
/** 歌词字体 */
export type LyricFontKey = "system" | "sans" | "serif" | "kai" | "yuan";
/** 播放器背景模式：animated 动态模糊 / amll AMLL 网格渐变 / image 仅图片模糊 / off 不启用 */
export type PlayerBgMode = "animated" | "amll" | "image" | "off";
/**
 * 歌词副行显示模式：原文 / 翻译 / 罗马音。
 *
 * `none` 表示**只显示原文**（不渲染副行）。播放器右上角的副行按钮在这三档间循环。
 */
export type LyricSubMode = "none" | "translation" | "romaji";
/**
 * 歌词渲染引擎：
 * - `native`：项目自研歌词视图（对齐 AMLL 语义的弹簧滚动 + 逐字填充）；
 * - `amll`：直接嵌入 AMLL 官方 `DomLyricPlayer`（AGPL-3.0-only），拿到行缩放、强调辉光、注音、
 *   滚轮浏览等本项目自研层还没实现的表现，动效参数由下面的 amll* 设置项控制。
 */
export type LyricEngine = "native" | "amll";
/**
 * 自研歌词视图的**换行动效方案**（两套并存，由用户在设置里切换）：
 * - `spring`（新版，默认）：对齐 AMLL —— 布局层只算目标位移，位移 / 缩放各一条弹簧逐帧
 *   积分；切行时速度连续，另有级联延迟（AMLL 的 1/1.05 衰减）与「失去焦点」缩放。
 * - `legacy`（旧版）：AMLL 改造之前的实现 —— 每行独立 CSS transition
 *   `0.7s cubic-bezier(.19,.11,0,1)`，级联延迟 (n*70 - n*10) ms，模糊随行距线性增长。
 *
 * 只影响「换行/滚动」这一层：逐字填充、逐字上浮（WAAPI）、AMLL 歌词解析与特殊标记
 * 渲染在两种方案下完全一致。
 */
export type LyricLineMotion = "spring" | "legacy";
/** 预设分享码偏好：仅中文 / 仅原版 / 两者同时输出 */
export type ShareCodePreference = "chinese" | "original" | "both";
/** 桌面歌词切换动画方案 */
export type DesktopLyricsAnimation = "fade" | "slide" | "scale" | "glow";
/** 桌面歌词控制栏显示策略：click 点击展开(5s 自动隐藏) / always 始终显示 */
export type DesktopLyricsToolbar = "click" | "always";
/** 双击桌面歌词动作：none 无操作 / toggle 播放暂停 */
export type DesktopLyricsDoubleClick = "none" | "toggle";
/** 桌面歌词窗口位置与尺寸（逻辑坐标） */
export interface DesktopLyricsBounds {
  x?: number;
  y?: number;
  width: number;
  height: number;
}
/** 本地音乐库展示模式 */
export type MusicViewMode = "grid" | "list";
/** Wenku8 节点 */
export type Wenku8Node = "cc" | "net";
/** 小说页面字符集 */
export type NovelCharset = "gbk" | "big5";
/** osu! 谱面下载镜像：auto 按官方 → Sayobot → Catboy → NeriNyan 依次回退 */
export type OsuMirror = "auto" | "official" | "sayobot" | "catboy" | "nerinyan";

const store = new JsonStore("settings.json");

const DEFAULTS = {
  theme: "system" as ThemeMode,
  /** MD3 动态配色的种子色（十六进制）；由它实时生成整套颜色令牌 */
  seedColor: "#1A5C9E",
  /** 激活皮肤的 id；空串 = 默认皮肤（动态配色） */
  activeSkin: "",
  /** 已删除的内置皮肤 id（删除即记忆，不再播种复活） */
  hiddenBuiltinSkins: [] as string[],
  lang: "zh" as "zh" | "en",
  /** 歌词字号（px） */
  lyricFontSize: 35,
  /** 行内行高（font-size 的倍数） */
  lyricLineHeight: 1.8,
  /** 行间间距：相邻歌词行之间的竖直间距（px） */
  lyricLineGap: 27,
  /** 歌词字体 */
  lyricFont: "system" as LyricFontKey,
  /** 歌词翻译字号（相对主歌词字号的百分比） */
  lyricTranslationSize: 65,
  /** 歌词与翻译之间的间距（px） */
  lyricTranslationGap: 1,
  /** 歌词副行显示：原文（不显示副行）/ 翻译 / 罗马音 */
  lyricSubMode: "translation" as LyricSubMode,
  /** 逐字歌词（Apple Music 式逐字填充 + 唱完上浮） */
  wordLyrics: true,
  /**
   * 歌词渲染引擎：native 自研 / amll 直接使用 AMLL 的 DomLyricPlayer。
   *
   * 默认 native：AMLL 会为每行建模并逐行 ResizeObserver 测量、用 WAAPI 调度动画，
   * 行数多时开销高于自研视图（后者只给选中行渲染逐词 span）。AMLL 引擎适合想要
   * 完整表现（行缩放、强调辉光、注音、滚轮浏览）的用户。
   *
   * 依赖上两者只差随行的歌词视图代码与 AMLL 样式表（动态 import，约 11KB）；
   * AMLL core 本身早因 AMLL 背景被入口预加载（见 vite.config.ts 的说明），不算额外成本。
   */
  lyricEngine: "native" as LyricEngine,
  /** AMLL 引擎：非当前行缩放（凸显当前行） */
  amllEnableScale: true,
  /** AMLL 引擎：隐藏已唱过的行 */
  amllHidePassedLines: false,
  /** AMLL 引擎：文字渐变动画宽度（以主歌词字号为单位；0.5 ≈ iPad，1 ≈ Android） */
  amllWordFadeWidth: 0.5,
  /** AMLL 引擎：当前行垂直对齐位置（组件高度的 0~1 比例） */
  amllAlignPosition: 0.35,
  /** AMLL 引擎：启用物理弹簧滚动（关闭退回 CSS transition，低配机器更省） */
  amllEnableSpring: true,
  /** 更精确的逐字歌词：播放时按 AMLL → QQ → 酷狗 → [登录网易云后 Meting] → 本地回退链取逐字歌词 */
  preciseLyrics: false,
  /**
   * AMLL TTML DB 逐字歌词源开关。默认开启：它是回退链里质量最高的一档
   * （Apple Music 风格逐字时间轴，自带翻译/音译/背景和声），且上游是社区 CDN，
   * 命中失败会自然落到 QQ 逐字，不会有副作用，所以不必让用户先手动开启。
   */
  amllLyricsEnabled: true,
  /**
   * AMLL TTML DB 基地址。默认走 jsDelivr 主镜像；jsDelivr 在部分网络下不通，
   * 故开放为可配置项（社区镜像 / 自建均可，例如 https://amll.mirror.dimeta.top/api/db），
   * 仅影响歌词文件下载，不影响其它网络请求。
   */
  amllLyricBase: "https://cdn.jsdelivr.net/gh/amll-dev/amll-ttml-db@main",
  /** 各歌曲手动选择的歌词来源偏好（key = 归一化标题|时长ms，值 = qq/kg/meting/local） */
  lyricSourcePrefs: {} as Record<string, LyricSourcePref>,
  /** 自动识别前奏/间奏：隐藏作词/作曲/编曲为三点，长间奏插入三点 */
  detectInstrumental: true,
  /**
   * 不雅用语遮蔽（AMLL TTML 的 amll:obscene）：
   * off 不遮蔽 / partial 保留首尾字符 / full 全部遮蔽为 *。
   */
  obsceneMask: "off" as ObsceneMode,
  /** 播放器背景：动态模糊 / AMLL 网格渐变 / 仅图片模糊 / 关闭 */
  playerBg: "animated" as PlayerBgMode,
  lyricBlur: true,
  /**
   * 自研歌词视图的换行动效方案：spring = 新版（AMLL 弹簧滚动）/ legacy = 旧版（CSS 过渡）。
   *
   * 默认 spring（维持现状），旧版仅供怀念旧观感的用户切换。两套方案的逐字填充、
   * 逐字上浮、AMLL 歌词解析完全一致，只差换行时整摞歌词怎么走。
   */
  lyricLineMotion: "spring" as LyricLineMotion,
  scanDirs: [] as string[],
  gridColumns: 6,
  /** 最小文件体积过滤（MB）；0 表示不过滤 */
  minFileSizeMb: 0,
  /** PDF 阅读模式：single 单页 / dual 双页 / scroll 滚动 */
  pdfReadMode: "single" as PdfReadMode,
  /** 阅读器背景主题 */
  readerTheme: "dark" as ReaderThemeKey,
  /** 阅读器正文字体 */
  readerFont: "system" as ReaderFontKey,
  /** 阅读器字号（%） */
  readerFontPct: 100,
  /** 阅读器行距 */
  readerLineHeight: 1.75,
  /** 阅读器段落间距（px）；0 表示跟随原书排版 */
  readerParaSpacing: 0,
  /** 用户手动指定的 ffmpeg 目录；空串表示自动探测 PATH */
  ffmpegDir: "",
  /** 实验性：启用在线音乐（meting API 搜索/歌单） */
  enableOnlineMusic: false,
  /** 在线音乐平台 */
  musicServer: "netease" as MusicServer,
  /** 用户自添加的在线歌单 */
  onlinePlaylists: [] as OnlinePlaylistEntry[],
  /** 预设歌单的重命名覆盖（key = server:id） */
  playlistRenames: {} as Record<string, string>,
  /** WebDAV 远程媒体源：启用开关 */
  webdavEnabled: false,
  /** WebDAV 服务器根 URL（如 https://host/remote.php/dav/files/user/） */
  webdavUrl: "",
  /** WebDAV 用户名 */
  webdavUser: "",
  /** WebDAV 密码（明文存 settings.json，与现有配置项一致） */
  webdavPass: "",
  /** 实验性：网易云账号（扫码登录，我的歌单 + 云盘） */
  neteaseEnabled: false,
  /** 实验性：酷狗账号（扫码/手机号登录，每日推荐 + 排行榜） */
  kugouEnabled: false,
  /** 酷狗：登录后自动签到（今日已签则跳过） */
  kugouAutoSignIn: true,
  /** 实验性：在线小说（Wenku8 抓取） */
  onlineNovelEnabled: false,
  /** 实验性：笔趣阁网络小说（m.bqglll.cc，JS 验证门，走隐藏 WebView） */
  bqgNovelEnabled: false,
  /** 实验性：在线番剧（Kazumi 规则采集，仅桌面端） */
  onlineAnimeEnabled: false,
  /** 实验性：B 站视频（推荐流 / 搜索 / 扫码登录 / 解析播放，仅桌面端） */
  bilibiliEnabled: false,
  /**
   * 发评反诈：评论发出后自动复查是否公开可见。
   *
   * 默认关闭——复查要求登录，且会多发一次上游请求；需要的用户可在设置里打开。
   */
  biliAntifraudEnabled: false,
  /** 发布动态反诈：动态发出后自动复查是否公开可见（同样需要登录） */
  biliDynAntifraudEnabled: false,
  /** 屏蔽带货动态：动态流里隐藏挂了商品/带货卡片的动态 */
  biliAntiGoodsDyn: false,
  /** 屏蔽带货评论：评论区隐藏带商品链接推广的评论 */
  biliAntiGoodsReply: false,
  /**
   * 显示 AI 总结按钮。
   *
   * 默认开启（纯 UI 入口，不点不发请求），点击后才会拉取站内 AI 摘要；
   * 上游要求登录，未登录时 store 会直接提示而不是白跑一次风控。
   */
  biliAiSummaryEnabled: true,
  /** 带商品卡的动态发布前二次确认（默认关：只对挂商品卡的动态做拦截确认） */
  biliAntiGoodsPublish: false,
  /** 实验性：在线图片（Pixiv，移植自 Pixez） */
  onlinePixivEnabled: false,
  /** Pixiv refresh token（仅在本地磁盘与设置中保存，用于恢复会话） */
  pixivRefreshToken: "",
  /** Pixiv 图片质量：squareMedium / medium / large / original */
  pixivImageQuality: "large",
  /** Wenku8 节点：cc 主用 / net 备用 */
  wenku8Node: "cc" as Wenku8Node,
  /** 小说页面字符集：简中 GBK / 繁中 Big5 */
  novelCharset: "gbk" as NovelCharset,
  /** 预设分享码偏好：both（默认，两种同时输出）/ chinese / original */
  shareCodePreference: "both" as ShareCodePreference,
  /** 桌面歌词 */
  desktopLyricsEnabled: false,
  desktopLyricsFontSize: 28,
  desktopLyricsOpacity: 90,
  desktopLyricsLocked: false,
  desktopLyricsAlwaysOnTop: true,
  desktopLyricsShowNext: false,
  desktopLyricsShowTranslation: false,
  desktopLyricsClickThrough: false,
  desktopLyricsToolbar: "click" as DesktopLyricsToolbar,
  desktopLyricsDoubleClick: "toggle" as DesktopLyricsDoubleClick,
  desktopLyricsAnimation: "fade" as DesktopLyricsAnimation,
  desktopLyricsBounds: { width: 420, height: 120 } as DesktopLyricsBounds,
  /** 关闭窗口时最小化到托盘（而非退出应用） */
  closeToTray: true,
  /** 本地音乐库展示模式：网格 / 列表 */
  musicViewMode: "grid" as MusicViewMode,
  /**
   * 弹幕总开关：在线番剧（DanDanPlay）与 B 站视频（站内弹幕）共用。
   *
   * 默认开启。B 站弹幕无需任何凭证即可用；番剧那一侧的 DanDanPlay 无凭证时会降级
   * （频率受限但可用）。不想看弹幕的用户可以在视频详情页顶栏一键关闭，或在设置里
   * 关掉——两个入口写的是同一个设置项，会持久化。
   *
   * 注：此前默认为 false，叠加 danmaku 插件的 `visible` 只在构造时读一次，
   * 导致弹幕「完全不生效」；插件侧已改为恒定可见 + show()/hide()，见
   * BilibiliVideoView.syncDanmakuVisibility()。
   */
  danmakuEnabled: true,
  /** DanDanPlay AppId（无凭证时降级为无签名模式，频率受限） */
  dandanAppId: "",
  /** DanDanPlay AppSecret（与 AppId 配套；缺失时视为无凭证） */
  dandanAppSecret: "",
  /** 弹幕不透明度 0-100 */
  danmakuOpacity: 80,
  /** 弹幕字号（px） */
  danmakuFontSize: 22,
  /** 弹幕显示区域 0-100（占屏百分比，参考项目 area） */
  danmakuArea: 75,
  /** 弹幕时间轴偏移（毫秒） */
  danmakuTimeOffsetMs: 0,
  /** 弹幕滚动速度 1-10 */
  danmakuSpeed: 5,
  /** 弹幕防重叠 */
  danmakuAntiOverlap: true,
  /** B 站播放器音量 0-1（重开浮层不再回到硬编码的 0.8） */
  biliVolume: 0.8,
  /** B 站播放器倍速 */
  biliPlaybackRate: 1,
  /** B 站播放器是否上报观看进度（对标 PiliPlus 的「暂停观看记录」） */
  biliHistoryEnabled: true,
  /**
   * B 站播放器「氛围光」（ambient light / 环境光晕）。
   *
   * 把视频画面的边缘颜色模糊成大范围光晕铺在播放器四周，参考项目
   * youtube-ambilight（WesselKroos）。默认关闭：它会持续对每一帧做降采样 + 模糊，
   * 属于「好看但要花 GPU」的功能，应由用户自行开启。
   */
  ambilightEnabled: false,
  /** 光晕强度（模糊半径，px）：越大越弥散 */
  ambilightBlur: 60,
  /** 光晕外扩（相对播放器尺寸的百分比）：越大铺得越开 */
  ambilightSpread: 22,
  /** 光晕不透明度 0-100 */
  ambilightOpacity: 70,
  /** 光晕饱和度 0-200（100 = 原样） */
  ambilightSaturation: 140,
  /** 光晕亮度 0-200（100 = 原样） */
  ambilightBrightness: 100,
  /**
   * 空降助手（SponsorBlock）：跳过 B 站视频里的赞助/广告等片段。
   *
   * 数据来自社区众包的 BilibiliSponsorBlock 服务（默认 https://www.bsbsb.top）。
   * 默认关闭：开启后会把当前视频的 bvid/cid 发给该第三方服务。
   */
  sponsorBlockEnabled: false,
  /** 服务端地址（可换成自建 / 镜像实例） */
  sponsorBlockServer: "https://www.bsbsb.top",
  /**
   * 每个分类是否参与跳过。
   *
   * 默认只开「赞助/恰饭」——那才是用户说的广告。开场动画、三连提醒这些是社区标注的
   * 其他类型片段，全开会跳得莫名其妙，交给用户自己勾。
   */
  sponsorBlockCategories: {
    sponsor: true,
    selfpromo: false,
    exclusive_access: false,
    interaction: false,
    poi_highlight: false,
    intro: false,
    outro: false,
    preview: false,
    filler: false,
    music_offtopic: false,
    padding: false,
  } as Record<string, boolean>,
  /** 跳过时是否给提示 */
  sponsorBlockToast: true,
  /**
   * AutoMix（自动混音）：像 DJ 一样把相邻歌曲平滑地混在一起。
   *
   * 默认关闭：它会为当前曲与下一曲各做一次音频分析（读完整音频、解码、FFT），
   * 有一定 CPU 与带宽开销。开启后首个分析会在后台进行，不阻塞播放。
   */
  autoMixEnabled: false,
  /** 过渡时长（秒）。DJ 式混音通常 6~12 秒 */
  autoMixDuration: 8,
  /** 是否尝试对拍（按 BPM 微调速度，让两首的节拍对齐） */
  autoMixBeatMatch: true,
  /** 是否裁掉首尾静音（避免淡出到一片寂静再干等） */
  autoMixTrimSilence: true,
  /** 对拍允许的最大速度偏移（百分比）。超过就不对拍，避免明显走音 */
  autoMixMaxRateDeviation: 6,
  /** Bangumi 官方 Access Token（在 https://next.bgm.tv/demo/access-token 获取；与 pixivRefreshToken 同款本地保存） */
  bangumiToken: "",
  /** 当前连接的 Bangumi 用户名（token 校验成功后写入，收藏接口按它查询） */
  bangumiUsername: "",
  /** 上次成功同步 Bangumi 收藏的时间戳（0 = 从未同步；首次授权后自动做一次全量同步） */
  bangumiSyncedAt: 0,
  /** osu! 谱面下载镜像偏好 */
  osuMirror: "auto" as OsuMirror,
  /** osu! 谱面导入输出目录；空串表示 `{应用数据}/osu` */
  osuOutDir: "",
};

export const useSettingsStore = defineStore("settings", () => {
  const theme = ref<ThemeMode>(DEFAULTS.theme);
  const seedColor = ref(DEFAULTS.seedColor);
  const activeSkin = ref(DEFAULTS.activeSkin);
  const hiddenBuiltinSkins = ref<string[]>([...DEFAULTS.hiddenBuiltinSkins]);
  const lang = ref<"zh" | "en">(DEFAULTS.lang);
  const lyricFontSize = ref(DEFAULTS.lyricFontSize);
  const lyricLineHeight = ref(DEFAULTS.lyricLineHeight);
  const lyricLineGap = ref(DEFAULTS.lyricLineGap);
  const lyricFont = ref<LyricFontKey>(DEFAULTS.lyricFont);
  const lyricTranslationSize = ref(DEFAULTS.lyricTranslationSize);
  const lyricTranslationGap = ref(DEFAULTS.lyricTranslationGap);
  const lyricSubMode = ref<LyricSubMode>(DEFAULTS.lyricSubMode);
  const wordLyrics = ref(DEFAULTS.wordLyrics);
  const lyricEngine = ref<LyricEngine>(DEFAULTS.lyricEngine);
  const amllEnableScale = ref(DEFAULTS.amllEnableScale);
  const amllHidePassedLines = ref(DEFAULTS.amllHidePassedLines);
  const amllWordFadeWidth = ref(DEFAULTS.amllWordFadeWidth);
  const amllAlignPosition = ref(DEFAULTS.amllAlignPosition);
  const amllEnableSpring = ref(DEFAULTS.amllEnableSpring);
  const preciseLyrics = ref(DEFAULTS.preciseLyrics);
  const amllLyricsEnabled = ref(DEFAULTS.amllLyricsEnabled);
  const amllLyricBase = ref(DEFAULTS.amllLyricBase);
  const lyricSourcePrefs = ref<Record<string, LyricSourcePref>>({ ...DEFAULTS.lyricSourcePrefs });
  const detectInstrumental = ref(DEFAULTS.detectInstrumental);
  const obsceneMask = ref<ObsceneMode>(DEFAULTS.obsceneMask);
  const playerBg = ref<PlayerBgMode>(DEFAULTS.playerBg);
  const lyricBlur = ref(DEFAULTS.lyricBlur);
  const lyricLineMotion = ref<LyricLineMotion>(DEFAULTS.lyricLineMotion);
  const scanDirs = ref<string[]>([...DEFAULTS.scanDirs]);
  const gridColumns = ref(DEFAULTS.gridColumns);
  const minFileSizeMb = ref(DEFAULTS.minFileSizeMb);
  const pdfReadMode = ref<PdfReadMode>(DEFAULTS.pdfReadMode);
  const readerTheme = ref<ReaderThemeKey>(DEFAULTS.readerTheme);
  const readerFont = ref<ReaderFontKey>(DEFAULTS.readerFont);
  const readerFontPct = ref(DEFAULTS.readerFontPct);
  const readerLineHeight = ref(DEFAULTS.readerLineHeight);
  const readerParaSpacing = ref(DEFAULTS.readerParaSpacing);
  const ffmpegDir = ref(DEFAULTS.ffmpegDir);
  const enableOnlineMusic = ref(DEFAULTS.enableOnlineMusic);
  const musicServer = ref<MusicServer>(DEFAULTS.musicServer);
  const onlinePlaylists = ref<OnlinePlaylistEntry[]>([...DEFAULTS.onlinePlaylists]);
  const playlistRenames = ref<Record<string, string>>({ ...DEFAULTS.playlistRenames });
  const webdavEnabled = ref(DEFAULTS.webdavEnabled);
  const webdavUrl = ref(DEFAULTS.webdavUrl);
  const webdavUser = ref(DEFAULTS.webdavUser);
  const webdavPass = ref(DEFAULTS.webdavPass);
  const neteaseEnabled = ref(DEFAULTS.neteaseEnabled);
  const kugouEnabled = ref(DEFAULTS.kugouEnabled);
  const kugouAutoSignIn = ref(DEFAULTS.kugouAutoSignIn);
  const onlineNovelEnabled = ref(DEFAULTS.onlineNovelEnabled);
  const bqgNovelEnabled = ref(DEFAULTS.bqgNovelEnabled);
  const onlineAnimeEnabled = ref(DEFAULTS.onlineAnimeEnabled);
  const bilibiliEnabled = ref(DEFAULTS.bilibiliEnabled);
  const biliAntifraudEnabled = ref(DEFAULTS.biliAntifraudEnabled);
  const biliDynAntifraudEnabled = ref(DEFAULTS.biliDynAntifraudEnabled);
  const biliAntiGoodsDyn = ref(DEFAULTS.biliAntiGoodsDyn);
  const biliAntiGoodsReply = ref(DEFAULTS.biliAntiGoodsReply);
  const biliAiSummaryEnabled = ref(DEFAULTS.biliAiSummaryEnabled);
  const biliAntiGoodsPublish = ref(DEFAULTS.biliAntiGoodsPublish);
  const onlinePixivEnabled = ref(DEFAULTS.onlinePixivEnabled);
  const pixivRefreshToken = ref(DEFAULTS.pixivRefreshToken);
  const pixivImageQuality = ref(DEFAULTS.pixivImageQuality);
  const wenku8Node = ref<Wenku8Node>(DEFAULTS.wenku8Node);
  const novelCharset = ref<NovelCharset>(DEFAULTS.novelCharset);
  const shareCodePreference = ref<ShareCodePreference>(DEFAULTS.shareCodePreference);
  const desktopLyricsEnabled = ref(DEFAULTS.desktopLyricsEnabled);
  const desktopLyricsFontSize = ref(DEFAULTS.desktopLyricsFontSize);
  const desktopLyricsOpacity = ref(DEFAULTS.desktopLyricsOpacity);
  const desktopLyricsLocked = ref(DEFAULTS.desktopLyricsLocked);
  const desktopLyricsAlwaysOnTop = ref(DEFAULTS.desktopLyricsAlwaysOnTop);
  const desktopLyricsShowNext = ref(DEFAULTS.desktopLyricsShowNext);
  const desktopLyricsShowTranslation = ref(DEFAULTS.desktopLyricsShowTranslation);
  const desktopLyricsClickThrough = ref(DEFAULTS.desktopLyricsClickThrough);
  const desktopLyricsToolbar = ref<DesktopLyricsToolbar>(DEFAULTS.desktopLyricsToolbar);
  const desktopLyricsDoubleClick = ref<DesktopLyricsDoubleClick>(DEFAULTS.desktopLyricsDoubleClick);
  const desktopLyricsAnimation = ref<DesktopLyricsAnimation>(DEFAULTS.desktopLyricsAnimation);
  const desktopLyricsBounds = ref<DesktopLyricsBounds>({ ...DEFAULTS.desktopLyricsBounds });
  const closeToTray = ref(DEFAULTS.closeToTray);
  const musicViewMode = ref<MusicViewMode>(DEFAULTS.musicViewMode);
  const danmakuEnabled = ref(DEFAULTS.danmakuEnabled);
  const dandanAppId = ref(DEFAULTS.dandanAppId);
  const dandanAppSecret = ref(DEFAULTS.dandanAppSecret);
  const danmakuOpacity = ref(DEFAULTS.danmakuOpacity);
  const danmakuFontSize = ref(DEFAULTS.danmakuFontSize);
  const danmakuArea = ref(DEFAULTS.danmakuArea);
  const danmakuTimeOffsetMs = ref(DEFAULTS.danmakuTimeOffsetMs);
  const danmakuSpeed = ref(DEFAULTS.danmakuSpeed);
  const danmakuAntiOverlap = ref(DEFAULTS.danmakuAntiOverlap);
  const biliVolume = ref(DEFAULTS.biliVolume);
  const biliPlaybackRate = ref(DEFAULTS.biliPlaybackRate);
  const biliHistoryEnabled = ref(DEFAULTS.biliHistoryEnabled);
  const ambilightEnabled = ref(DEFAULTS.ambilightEnabled);
  const ambilightBlur = ref(DEFAULTS.ambilightBlur);
  const ambilightSpread = ref(DEFAULTS.ambilightSpread);
  const ambilightOpacity = ref(DEFAULTS.ambilightOpacity);
  const ambilightSaturation = ref(DEFAULTS.ambilightSaturation);
  const ambilightBrightness = ref(DEFAULTS.ambilightBrightness);
  const sponsorBlockEnabled = ref(DEFAULTS.sponsorBlockEnabled);
  const sponsorBlockServer = ref(DEFAULTS.sponsorBlockServer);
  const sponsorBlockCategories = ref<Record<string, boolean>>({
    ...DEFAULTS.sponsorBlockCategories,
  });
  const sponsorBlockToast = ref(DEFAULTS.sponsorBlockToast);
  const autoMixEnabled = ref(DEFAULTS.autoMixEnabled);
  const autoMixDuration = ref(DEFAULTS.autoMixDuration);
  const autoMixBeatMatch = ref(DEFAULTS.autoMixBeatMatch);
  const autoMixTrimSilence = ref(DEFAULTS.autoMixTrimSilence);
  const autoMixMaxRateDeviation = ref(DEFAULTS.autoMixMaxRateDeviation);
  const bangumiToken = ref(DEFAULTS.bangumiToken);
  const bangumiUsername = ref(DEFAULTS.bangumiUsername);
  const bangumiSyncedAt = ref(DEFAULTS.bangumiSyncedAt);
  const osuMirror = ref<OsuMirror>(DEFAULTS.osuMirror);
  const osuOutDir = ref(DEFAULTS.osuOutDir);
  const loaded = ref(false);

  /**
   * 已启用的在线平台（固定展示顺序）。
   * 平台切换条只在长度 ≥ 2 时渲染——单平台用户界面与改造前完全一致。
   */
  const enabledServers = computed<MusicServer[]>(() => {
    const list: MusicServer[] = [];
    if (neteaseEnabled.value) list.push("netease");
    if (kugouEnabled.value) list.push("kugou");
    return list;
  });

  // 单一注册表：新增设置项只需在此加一行，load/save 自动覆盖
  const fields = {
    theme,
    seedColor,
    activeSkin,
    hiddenBuiltinSkins,
    lang,
    lyricFontSize,
    lyricLineHeight,
    lyricLineGap,
    lyricFont,
    lyricTranslationSize,
    lyricTranslationGap,
    lyricSubMode,
    wordLyrics,
    lyricEngine,
    amllEnableScale,
    amllHidePassedLines,
    amllWordFadeWidth,
    amllAlignPosition,
    amllEnableSpring,
    preciseLyrics,
    amllLyricsEnabled,
    amllLyricBase,
    lyricSourcePrefs,
    detectInstrumental,
    obsceneMask,
    playerBg,
    lyricBlur,
    lyricLineMotion,
    scanDirs,
    gridColumns,
    minFileSizeMb,
    pdfReadMode,
    readerTheme,
    readerFont,
    readerFontPct,
    readerLineHeight,
    readerParaSpacing,
    ffmpegDir,
    enableOnlineMusic,
    musicServer,
    onlinePlaylists,
    playlistRenames,
    webdavEnabled,
    webdavUrl,
    webdavUser,
    webdavPass,
    neteaseEnabled,
    kugouEnabled,
    kugouAutoSignIn,
    onlineNovelEnabled,
    bqgNovelEnabled,
    onlineAnimeEnabled,
    bilibiliEnabled,
    biliAntifraudEnabled,
    biliDynAntifraudEnabled,
    biliAntiGoodsDyn,
    biliAntiGoodsReply,
    biliAiSummaryEnabled,
    biliAntiGoodsPublish,
    onlinePixivEnabled,
    pixivRefreshToken,
    pixivImageQuality,
    wenku8Node,
    novelCharset,
    shareCodePreference,
    desktopLyricsEnabled,
    desktopLyricsFontSize,
    desktopLyricsOpacity,
    desktopLyricsLocked,
    desktopLyricsAlwaysOnTop,
    desktopLyricsShowNext,
    desktopLyricsShowTranslation,
    desktopLyricsClickThrough,
    desktopLyricsToolbar,
    desktopLyricsDoubleClick,
    desktopLyricsAnimation,
    desktopLyricsBounds,
    closeToTray,
    musicViewMode,
    danmakuEnabled,
    dandanAppId,
    dandanAppSecret,
    danmakuOpacity,
    danmakuFontSize,
    danmakuArea,
    danmakuTimeOffsetMs,
    danmakuSpeed,
    danmakuAntiOverlap,
    biliVolume,
    biliPlaybackRate,
    biliHistoryEnabled,
    ambilightEnabled,
    ambilightBlur,
    ambilightSpread,
    ambilightOpacity,
    ambilightSaturation,
    ambilightBrightness,
    sponsorBlockEnabled,
    sponsorBlockServer,
    sponsorBlockCategories,
    sponsorBlockToast,
    autoMixEnabled,
    autoMixDuration,
    autoMixBeatMatch,
    autoMixTrimSilence,
    autoMixMaxRateDeviation,
    bangumiToken,
    bangumiUsername,
    bangumiSyncedAt,
    osuMirror,
    osuOutDir,
  } as const;

  async function load() {
    try {
      const saved = await store.get<Record<string, unknown>>("settings");
      if (saved) {
        for (const [key, refObj] of Object.entries(fields)) {
          const value = saved[key];
          if (value !== undefined && value !== null) {
            (refObj as { value: unknown }).value = value;
          }
        }
      }
    } catch (e) {
      console.warn("Failed to load settings:", e);
    }
    // 兼容旧版本：历史上只支持网易云，未知平台值归一化到网易云
    if (musicServer.value !== "netease" && musicServer.value !== "kugou") {
      musicServer.value = "netease";
    }
    onlinePlaylists.value = onlinePlaylists.value.filter(
      (p) => p.server === "netease" || p.server === "kugou",
    );
    loaded.value = true;
  }

  /**
   * 应用原生设置页推来的改动。
   *
   * 移动端有两套设置：原生是扁平键，这里把整个设置对象存在单个 `settings`
   * 键下（见上面的 save()）。键名由原生侧映射好（只有 themeMode -> theme
   * 不同），这里只负责落到对应的 ref 上，让音乐页立刻生效而不必重启。
   *
   * 不写盘：原生那边已经写进同一个文件了，这里的 watch 会在下次变更时
   * 带上这些值一起保存。
   */
  function applyPatch(patch: Record<string, unknown>) {
    if (!patch || typeof patch !== "object") return;
    for (const [key, value] of Object.entries(patch)) {
      const refObj = (fields as Record<string, unknown>)[key] as { value: unknown } | undefined;
      if (refObj && typeof refObj === "object" && "value" in refObj) {
        refObj.value = value;
      }
    }
  }

  async function save() {
    try {
      const payload: Record<string, unknown> = {};
      for (const [key, refObj] of Object.entries(fields)) {
        payload[key] = (refObj as { value: unknown }).value;
      }
      await store.set("settings", payload);
      await store.save();
    } catch (e) {
      console.warn("Failed to save settings:", e);
    }
  }

  /**
   * 自动保存节流。
   *
   * 设置页的滑块用 `@input`（拖动过程中连续触发）、文本框逐键触发，而 `save()` 会把
   * **整个** settings 对象序列化两次（渲染进程的 toCloneable 深拷贝 + IPC/HTTP）再写整文件。
   * 不节流时拖一次滑块就是几十次全量落盘，设置页明显发涩。
   *
   * 只对"自动保存"节流；显式调用 `save()` 仍是立即落盘。
   */
  let saveTimer: number | null = null;
  function scheduleSave() {
    if (saveTimer !== null) clearTimeout(saveTimer);
    saveTimer = window.setTimeout(() => {
      saveTimer = null;
      void save();
    }, 400);
  }

  /** 立即落盘待写入的改动（窗口关闭/隐藏前兜底，避免丢掉最后 400ms 的编辑）。 */
  function flushSave() {
    if (saveTimer === null) return;
    clearTimeout(saveTimer);
    saveTimer = null;
    void save();
  }
  if (typeof window !== "undefined" && typeof document !== "undefined") {
    window.addEventListener("beforeunload", flushSave);
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) flushSave();
    });
  }

  let mediaQuery: MediaQueryList | null = null;
  function resolveTheme() {
    // 单模式皮肤强制锁定解析结果（方案书 §6.4）：settings.theme 保留用户原偏好，
    // 换回双模式皮肤后自动恢复
    const lock = skinModeLock.value;
    const dark = lock
      ? lock === "dark"
      : theme.value === "dark" ||
        (theme.value === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches);
    document.documentElement.setAttribute("data-theme", dark ? "dark" : "light");
    // 令牌写入顺序（§3 层次）：清种子残留 → 皮肤令牌/CSS → 种子色（最后写入，
    // 同为内联样式时后者覆盖前者；clearSeedTokens 必须先于 applySkin，否则会抹掉皮肤颜色）
    const skin = activeSkinDoc.value;
    const seedAllowed = !skinSafeMode.value && (!skin || skin.manifest.seedColor);
    if (!seedAllowed) clearSeedTokens();
    applySkin(skinSafeMode.value ? null : skin, dark, activePrepared.value ?? undefined);
    if (seedAllowed) applySeedColor(seedColor.value, dark);
  }

  function applyTheme(mode: ThemeMode) {
    theme.value = mode;
    resolveTheme();
    // 跟随系统时需要监听系统切换
    if (!mediaQuery) {
      mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
      mediaQuery.addEventListener("change", () => {
        if (theme.value === "system") resolveTheme();
      });
    }
  }

  /** 切换配色种子色并立即重算令牌 */
  function applyColorScheme(hex: string) {
    seedColor.value = hex;
    resolveTheme();
  }

  watch(
    Object.values(fields),
    () => {
      // 节流落盘：拖动滑块/逐键输入会高频触发，不能每次都全量序列化 + 写文件
      if (loaded.value) scheduleSave();
    },
    { deep: true },
  );

  // WebDAV 配置推送到 Rust（凭据只在 Rust 侧；代理/列举命令读取它）
  watch(
    [webdavEnabled, webdavUrl, webdavUser, webdavPass],
    async () => {
      if (!loaded.value) return;
      try {
        await capabilities.webdavConfigure(webdavUrl.value, webdavUser.value, webdavPass.value);
      } catch (e) {
        console.warn("[WebDAV] 配置推送失败:", e);
      }
    },
    { deep: false },
  );

  // FFmpeg 路径推送到 Rust：保证 OVERRIDE_DIR 始终与 settings.ffmpegDir 同步。
  // 修复「已指定 ffmpeg 包仍报未检测到」bug——
  // 原先依赖 Settings 页 onMounted 显式调 ffmpegSetPath，首次进入「视频」页时
  // OVERRIDE_DIR 还是 None；切回视频页时 VideosView 已挂载也不会再刷一次。
  watch(
    () => ffmpegDir.value,
    async (newDir) => {
      try {
        await capabilities.ffmpegSetPath(newDir || null);
      } catch (e) {
        console.warn("[FFmpeg] 配置推送失败:", e);
      }
    },
    { immediate: true },
  );

  return {
    ...fields,
    enabledServers,
    loaded,
    load,
    save,
    flushSave,
    applyPatch,
    applyTheme,
    applyColorScheme,
    resolveTheme,
  };
});
