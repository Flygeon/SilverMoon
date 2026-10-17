<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from "vue";
import { useRouter } from "vue-router";
import PageHeader from "@/components/PageHeader.vue";
import ExtensionSlot from "@/components/ExtensionSlot.vue";
import {
  useSettingsStore,
  type PdfReadMode,
  type ThemeMode,
  type PlayerBgMode,
  type LyricFontKey,
  type LyricEngine,
  type LyricLineMotion,
  type ShareCodePreference,
  type DesktopLyricsAnimation,
  type DesktopLyricsAnchor,
  type DesktopLyricsAnchorAlign,
  type DesktopLyricsIdleMode,
  type DesktopLyricsToolbar,
  type DesktopLyricsDoubleClick,
} from "@/stores/settings";
import type { ObsceneMode } from "@/utils/obscene";
import { listCacheClear } from "@/utils/onlineListCache";
import { useDesktopStore } from "@/stores/desktop";
import { useBangumiCollectStore } from "@/stores/bangumiCollect";
import { useLibraryStore } from "@/stores/library";
import AudioEffectsPanel from "@/components/AudioEffectsPanel.vue";
import SegmentedTabs from "@/components/SegmentedTabs.vue";
import SettingRow from "@/components/SettingRow.vue";
import {
  capabilities,
  type BenchStatus,
  type BenchSummary,
  type MemoryMetrics,
} from "@/capabilities";
import { formatSize } from "@/utils/format";
import { activeSkinDoc, skinModeLock, skinSafeMode } from "@/utils/skinRuntime";
import { SB_CATEGORIES } from "@/utils/sponsorBlock";
import { translate } from "@shared/i18n";
import { SETTINGS_INDEX } from "@/views/settingsIndex.generated";
import { matchSettings, type SettingsHit } from "@/views/settingsSearch";
import type { FfmpegStatus } from "@shared/types";
import { listen } from "@/ipc/events";

const settings = useSettingsStore();
const library = useLibraryStore();
const router = useRouter();
const bangumiCollect = useBangumiCollectStore();
const bangumiTokenDraft = ref(settings.bangumiToken);

async function connectBangumi() {
  await bangumiCollect.init();
  await bangumiCollect.connect(bangumiTokenDraft.value);
}

function disconnectBangumi() {
  bangumiCollect.disconnect();
  bangumiTokenDraft.value = "";
}

async function openBangumiTokenPage() {
  try {
    await capabilities.openUrl("https://next.bgm.tv/demo/access-token");
  } catch {
    /* 打不开浏览器时用户可手动访问 */
  }
}

const ffmpeg = ref<FfmpegStatus | null>(null);
const checking = ref(false);
const toast = ref("");
const devtoolsEnabled = ref(
  typeof window !== "undefined" && localStorage.getItem("lumiluna-devtools-enabled") === "1",
);

/** 应用版本号：构建期由 vite define 注入（来源 package.json），勿再写死字符串 */
const APP_VERSION = __APP_VERSION__;

/**
 * 自动更新状态。
 *
 * 事件在主进程里就绪时可能早于本组件挂载，所以挂载时先拉一次当前状态，
 * 之后靠 `updater:status` 事件增量更新（见 electron/updater.ts 的 emit）。
 */
interface UpdateState {
  status:
    "idle" | "checking" | "available" | "not-available" | "downloading" | "downloaded" | "error";
  info?: { version: string };
  percent?: number;
}
const updateState = ref<UpdateState>({ status: "idle" });
import { isDesktop } from "@/capabilities";

async function onCheckUpdate() {
  updateState.value = { status: "checking" };
  await capabilities.checkForUpdates();
}
async function onInstallUpdate() {
  await capabilities.installUpdate();
}
/**
 * 内存诊断：按进程列出 Electron 各进程的工作集。
 *
 * 只在用户点「刷新」时拉一次 —— 它本身要遍历所有进程，没必要常驻轮询。
 */
const memoryMetrics = ref<MemoryMetrics | null>(null);
const memoryLoading = ref(false);
async function refreshMemory() {
  memoryLoading.value = true;
  try {
    memoryMetrics.value = await capabilities.memoryMetrics();
  } finally {
    memoryLoading.value = false;
  }
}

/**
 * 内存基准测试（P0）：五组固定口径的自动采样 + 标记 + 导出。
 *
 * 与上面的「内存诊断」互补——诊断是**单点快照**，基准是**一段操作的曲线**。
 * 口径定义见 `electron/bench.ts` 文件头；这里只负责驱动与展示。
 * 标签按口径顺序自动取，用户不必手输。
 */
const BENCH_STEP_KEYS = [
  "settings.benchStep1",
  "settings.benchStep2",
  "settings.benchStep3",
  "settings.benchStep4",
  "settings.benchStep5",
] as const;

const benchStatus = ref<BenchStatus>({
  running: false,
  intervalMs: 0,
  sampleCount: 0,
  markCount: 0,
  elapsedMs: 0,
});
const benchSummary = ref<BenchSummary | null>(null);
const benchBusy = ref(false);
const benchExportPath = ref("");

async function benchToggle() {
  benchBusy.value = true;
  try {
    const wasRunning = benchStatus.value.running;
    benchStatus.value = wasRunning
      ? await capabilities.benchStop()
      : await capabilities.benchStart();
    if (wasRunning) {
      // 停止后把汇总拉一次，用户不必先导出才能看到增量
      benchSummary.value = (await capabilities.benchReport()).summary;
    } else {
      benchSummary.value = null;
      benchExportPath.value = "";
    }
  } finally {
    benchBusy.value = false;
  }
}

async function benchMark() {
  const step = benchStatus.value.markCount;
  const key = BENCH_STEP_KEYS[step];
  benchBusy.value = true;
  try {
    await capabilities.benchMark(key ? t(key) : `#${step + 1}`);
    benchStatus.value = await capabilities.benchStatus();
    benchSummary.value = (await capabilities.benchReport()).summary;
  } finally {
    benchBusy.value = false;
  }
}

async function benchExport() {
  benchBusy.value = true;
  try {
    const r = await capabilities.benchExport();
    benchExportPath.value = r.path;
    benchSummary.value = r.summary;
  } finally {
    benchBusy.value = false;
  }
}

let unlistenUpdate: (() => void) | null = null;
onMounted(() => {
  void capabilities.updaterState().then((s) => {
    updateState.value = s as UpdateState;
  });
  void listen<UpdateState>("updater:status", (e) => {
    updateState.value = e.payload;
  }).then((un) => {
    unlistenUpdate = un;
  });
});
onBeforeUnmount(() => {
  unlistenUpdate?.();
  unlistenUpdate = null;
});

function t(key: string) {
  return translate(settings.lang, key);
}

const LYRIC_FONT_KEYS: LyricFontKey[] = ["system", "sans", "serif", "kai", "yuan"];
/** 歌词渲染引擎：native 自研 / amll 直接使用 AMLL 官方组件 */
const LYRIC_ENGINES: LyricEngine[] = ["native", "amll"];
/** 不雅用语遮蔽档位（AMLL 的 amll:obscene） */
const OBSCENE_MODES: ObsceneMode[] = ["off", "partial", "full"];
const LYRICS_ANIMATIONS: DesktopLyricsAnimation[] = ["fade", "slide", "scale", "glow"];

/**
 * 设置项单选行的候选项。
 *
 * 统一交给 SegmentedTabs（@m3e/web 连通按钮组）渲染，这里只把「取值 + 文案」列出来；
 * 文案走 t()，切语言时跟着变。收成一个工厂函数，避免十几处重复写同一份结构。
 */
function opts<T extends string>(values: readonly T[], label: (value: T) => string) {
  return computed(() => values.map((value) => ({ value, label: label(value) })));
}

const themeTabs = opts(["system", "light", "dark"] as ThemeMode[], (v) => t("settings." + v));
const langTabs = opts(["zh", "en"] as const, (v) => (v === "zh" ? "简体中文" : "English"));
const closeActionTabs = opts(["tray", "quit"] as const, (v) => t("settings.closeAction_" + v));
const pdfModeTabs = opts(["single", "dual", "scroll"] as PdfReadMode[], (v) =>
  t("settings.pdfMode_" + v),
);
const dlToolbarTabs = opts(["click", "always"] as DesktopLyricsToolbar[], (v) =>
  t("settings.desktopLyricsToolbar_" + v),
);
const dlDoubleClickTabs = opts(["none", "toggle"] as DesktopLyricsDoubleClick[], (v) =>
  t("settings.desktopLyricsDoubleClick_" + v),
);
const dlAnchorTabs = opts(["manual", "taskbar"] as DesktopLyricsAnchor[], (v) =>
  t("settings.desktopLyricsAnchor_" + v),
);
const dlAnchorAlignTabs = opts(["left", "center", "right"] as DesktopLyricsAnchorAlign[], (v) =>
  t("settings.desktopLyricsAnchorAlign_" + v),
);
const dlIdleTabs = opts(["none", "spectrum"] as DesktopLyricsIdleMode[], (v) =>
  t("settings.desktopLyricsIdleMode_" + v),
);
const playerBgTabs = opts(["animated", "amll", "image", "off"] as PlayerBgMode[], (v) =>
  t("settings.playerBg_" + v),
);
const lyricEngineTabs = opts(LYRIC_ENGINES, (v) => t("settings.lyricEngine_" + v));
/** 自研歌词视图的换行动效方案：spring 新版弹簧 / legacy 旧版 CSS 过渡 */
const LYRIC_LINE_MOTIONS: LyricLineMotion[] = ["spring", "legacy"];
const lyricLineMotionTabs = opts(LYRIC_LINE_MOTIONS, (v) => t("settings.lyricLineMotion_" + v));
const musicViewTabs = opts(["grid", "list"] as const, (v) => t("settings.musicViewMode_" + v));
const shareCodeTabs = opts(["chinese", "original", "both"] as ShareCodePreference[], (v) =>
  t("settings.shareCodePreference_" + v),
);
const musicServerTabs = opts(["netease", "kugou"] as const, (v) => t("settings.onlineServer_" + v));
/** 扫描范围模式：白名单（只扫列表）/ 黑名单（扫全局但排除列表） */
const scanModeTabs = opts(["whitelist", "blacklist"] as const, (v) => t("settings.scanMode_" + v));
const wenku8NodeTabs = opts(["cc", "net"] as const, (v) => t("settings.wenku8Node_" + v));
const novelCharsetTabs = opts(["gbk", "big5"] as const, (v) => t("settings.novelCharset_" + v));
const pixivQualityTabs = opts(["squareMedium", "medium", "large", "original"] as const, (v) =>
  t("settings.pixivQuality_" + v),
);

function notify(message: string) {
  toast.value = message;
  window.setTimeout(() => (toast.value = ""), 2400);
}

function toggleDevtools(event: Event) {
  const enabled = switchChecked(event);
  devtoolsEnabled.value = enabled;
  localStorage.setItem("lumiluna-devtools-enabled", enabled ? "1" : "0");
  if (enabled) {
    // 打开后立即打开一次 DevTools，方便定位问题
    void capabilities.openDevtools();
  }
}

onMounted(async () => {
  // 恢复上次手动指定的目录，再查询实际可用状态
  if (settings.ffmpegDir) {
    ffmpeg.value = await capabilities.ffmpegSetPath(settings.ffmpegDir);
  } else {
    ffmpeg.value = await capabilities.ffmpegStatus();
  }
});

async function recheckFfmpeg() {
  checking.value = true;
  try {
    ffmpeg.value = await capabilities.ffmpegSetPath(settings.ffmpegDir || null);
  } finally {
    checking.value = false;
  }
}

async function chooseFfmpegDir() {
  const dir = await capabilities.pickDirectory();
  if (!dir) return;
  settings.ffmpegDir = dir;
  ffmpeg.value = await capabilities.ffmpegSetPath(dir);
  if (!ffmpeg.value.available) {
    notify("该目录下未找到 ffmpeg 可执行文件");
  }
}

async function resetFfmpegDir() {
  settings.ffmpegDir = "";
  ffmpeg.value = await capabilities.ffmpegSetPath(null);
}

/** 弹幕时间轴偏移：UI 单位是秒，内部存毫秒 */
function onDanmakuOffsetChange(e: Event) {
  const v = Number((e.target as HTMLInputElement).value);
  if (Number.isFinite(v)) settings.danmakuTimeOffsetMs = Math.round(v * 1000);
}

function setTheme(mode: ThemeMode) {
  settings.applyTheme(mode);
}

// ---- 配色方案（Material You 种子色）----
const COLOR_SEEDS = [
  { key: "blue", hex: "#1A5C9E" },
  { key: "teal", hex: "#00696E" },
  { key: "violet", hex: "#6750A4" },
  { key: "green", hex: "#4C662B" },
  { key: "amber", hex: "#8F4C00" },
  { key: "rose", hex: "#B3261E" },
  { key: "pink", hex: "#8B4A6C" },
] as const;

const isCustomSeed = computed(
  () => !COLOR_SEEDS.some((c) => c.hex.toLowerCase() === settings.seedColor.toLowerCase()),
);

/** 系统强调色（UDA 读取）：平台不支持或未探测到时为 null */
const desktopEnv = useDesktopStore();
const systemAccentHex = computed(() => {
  const rgba = desktopEnv.accent;
  if (!rgba) return null;
  const [r, g, b] = rgba;
  return `#${[r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("")}`;
});

function pickSeed(hex: string) {
  // 手动取色即把种子来源切回 manual，避免「跟随后点色板不生效」
  settings.seedSource = "manual";
  settings.applyColorScheme(hex);
}

/** 切到「跟随系统」：由 store 的 watch 触发令牌重算 */
function pickSystemSeed() {
  settings.seedSource = "system";
  settings.applyTheme(settings.theme);
}

function onCustomSeed(event: Event) {
  settings.seedSource = "manual";
  settings.applyColorScheme((event.target as HTMLInputElement).value);
}

// ---- 皮肤（方案书 §9）----
//
// 皮肤功能已改由扩展承载：设置页不再有皮肤库的浏览/导入/删除入口，
// 用户装皮肤 = 装一个声明 contributes.themes 的扩展（应用经 ExtensionHost 的
// themes:apply / themes:clear 桥方法驱动 skins store 的引擎）。
// 这里保留的只有「当前皮肤是否门控设置项」这类**引擎状态到 UI 的投影**。

/** 皮肤未适配种子色（且非安全模式）时，配色方案行置灰 */
const seedLocked = computed(
  () => !!activeSkinDoc.value && !skinSafeMode.value && !activeSkinDoc.value.manifest.seedColor,
);
/** dark-only / light-only 皮肤锁定浅深切换（安全模式下皮肤不生效、锁随之解除） */
const themeLocked = computed(() => !!skinModeLock.value && !skinSafeMode.value);
const themeLockHint = computed(() =>
  themeLocked.value
    ? t("settings.skinModeLocked").replace(
        "{mode}",
        t(skinModeLock.value === "dark" ? "settings.dark" : "settings.light"),
      )
    : "",
);

// ---- WebDAV ----

const davTesting = ref(false);
const davResult = ref<{ ok: boolean; error?: string } | null>(null);
const showDavPass = ref(false);

async function testWebDav() {
  davTesting.value = true;
  davResult.value = null;
  try {
    await capabilities.webdavConfigure(
      settings.webdavUrl,
      settings.webdavUser,
      settings.webdavPass,
    );
    const res = await capabilities.webdavTest();
    if (res.ok) {
      davResult.value = { ok: true };
      notify(res.rootName ? `${t("settings.webdavOk")} · ${res.rootName}` : t("settings.webdavOk"));
    } else {
      davResult.value = { ok: false, error: t("settings.webdavFail") };
    }
  } catch (e) {
    davResult.value = { ok: false, error: String(e) };
    notify(`${t("settings.webdavFail")}：${e}`);
  } finally {
    davTesting.value = false;
  }
}

// ---- M3E 表单控件（m3e-switch / m3e-slider）事件桥 ----

/** m3e-switch 的选中态：change 事件由开关自身派发，e.target 即 m3e-switch */
function switchChecked(e: Event): boolean {
  return !!(e.target as HTMLElement & { checked?: boolean }).checked;
}

/** 把开关选中态写回对应布尔设置项 */
function setSwitch(key: BoolSettingKey, e: Event) {
  settings[key] = switchChecked(e);
}

/**
 * 读取 m3e-slider 当前值。值挂在 m3e-slider-thumb 上，而 input 事件由 thumb 冒泡到外层
 * m3e-slider，故用 e.currentTarget（监听所在的 slider）取 thumb.value。
 * 注意：上一版误读 e.target.thumb.value —— thumb 自身并无 thumb 属性，导致滑动不写回设置。
 */
function sliderValue(e: Event): number | null {
  const host = e.currentTarget as { thumb?: { value?: number | null } | null } | null;
  const v = host?.thumb?.value;
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** 空降助手的分类勾选（对象里存每个分类的布尔值）。 */
function toggleSponsorCategory(key: string): void {
  const next = { ...settings.sponsorBlockCategories };
  next[key] = next[key] !== true;
  settings.sponsorBlockCategories = next;
}

/** 整数滑块写回（除歌词行距外的全部滑块） */
function onSliderInt(e: Event, key: SliderIntKey) {
  const v = sliderValue(e);
  if (v != null) settings[key] = Math.round(v);
}

/** 歌词行距滑块（0.1 步进，保留一位小数） */
function onSliderLineHeight(e: Event) {
  const v = sliderValue(e);
  if (v != null) settings.lyricLineHeight = Math.round(v * 10) / 10;
}

/** AMLL 对齐位置滑块（0~100 的百分比 → 0.0~1.0 的比例） */
function onSliderAmllAlignPosition(e: Event) {
  const v = sliderValue(e);
  if (v != null) settings.amllAlignPosition = Math.round(v) / 100;
}

/** AMLL 渐变宽度滑块（0~1，0.05 步进，保留两位小数） */
function onSliderAmllWordFadeWidth(e: Event) {
  const v = sliderValue(e);
  if (v != null) settings.amllWordFadeWidth = Math.round(v * 100) / 100;
}

/** 布尔设置项键（供 setSwitch 复用，避免每个开关重复写事件表达式） */
type BoolSettingKey =
  | "wordLyrics"
  | "amllEnableScale"
  | "amllHidePassedLines"
  | "amllEnableSpring"
  | "preciseLyrics"
  | "amllLyricsEnabled"
  | "detectInstrumental"
  | "loudnessNormalize"
  | "desktopLyricsEnabled"
  | "taskbarLyricsEnabled"
  | "taskbarLyricsShowTranslation"
  | "desktopLyricsShowNext"
  | "desktopLyricsShowTranslation"
  | "desktopLyricsLocked"
  | "desktopLyricsClickThrough"
  | "desktopLyricsAlwaysOnTop"
  | "desktopLyricsWordByWord"
  | "lyricBlur"
  | "enableOnlineMusic"
  | "neteaseEnabled"
  | "kugouEnabled"
  | "kugouAutoSignIn"
  | "onlineNovelEnabled"
  | "bqgNovelEnabled"
  | "onlineAnimeEnabled"
  | "bilibiliEnabled"
  | "biliAntifraudEnabled"
  | "biliDynAntifraudEnabled"
  | "biliAntiGoodsDyn"
  | "biliAntiGoodsReply"
  | "biliAiSummaryEnabled"
  | "biliAntiGoodsPublish"
  | "onlinePixivEnabled"
  | "danmakuEnabled"
  | "danmakuAntiOverlap"
  | "ambilightEnabled"
  | "autoMixEnabled"
  | "autoMixBeatMatch"
  | "autoMixTrimSilence"
  | "sponsorBlockEnabled"
  | "sponsorBlockToast"
  | "webdavEnabled";

/** 整数滑块对应的数值设置项键 */
type SliderIntKey =
  | "lyricFontSize"
  | "lyricLineGap"
  | "lyricTranslationSize"
  | "lyricTranslationGap"
  | "desktopLyricsFontSize"
  | "desktopLyricsOpacity"
  | "taskbarLyricsFontSize"
  | "taskbarLyricsOpacity"
  | "desktopLyricsAnchorOffsetX"
  | "desktopLyricsAnchorOffsetY"
  | "danmakuOpacity"
  | "danmakuFontSize"
  | "danmakuArea"
  | "danmakuSpeed"
  | "autoMixDuration"
  | "autoMixMaxRateDeviation"
  | "ambilightBlur"
  | "ambilightSpread"
  | "ambilightOpacity"
  | "ambilightSaturation"
  | "ambilightBrightness";

// ---- 最小体积过滤 ----

const SIZE_PRESETS = [0, 1, 5, 20, 100];
/** 滑块上限 2GB */
const MAX_MB = 2048;

/**
 * 滑块位置与体积之间用对数映射：0-100 的行程覆盖 0MB–2GB，
 * 又能在几 MB 的常用区间给出足够精细的调节粒度（线性映射下
 * 1MB 和 5MB 会挤在同一格里，几乎选不中）。
 */
function posToMb(pos: number): number {
  if (pos <= 0) return 0;
  const mb = Math.pow(MAX_MB, pos / 100);
  return mb < 10 ? Math.round(mb * 10) / 10 : Math.round(mb);
}

function mbToPos(mb: number): number {
  if (mb <= 0) return 0;
  return Math.round((Math.log(mb) / Math.log(MAX_MB)) * 100);
}

const sliderPos = computed(() => mbToPos(settings.minFileSizeMb));

const sizeLabel = computed(() => {
  const mb = settings.minFileSizeMb;
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${mb} MB`;
});

function onSizeSlider(e: Event) {
  const v = sliderValue(e);
  if (v != null) applySize(posToMb(v));
}

function applySize(mb: number) {
  settings.minFileSizeMb = mb;
  // 阈值变了，已缓存的各类型列表和角标都要重取
  library.invalidate();
  void library.refreshCounts();
}

async function addScanDir() {
  const dir = await capabilities.pickDirectory();
  if (dir && !settings.scanDirs.includes(dir)) {
    settings.scanDirs.push(dir);
  }
}

function removeScanDir(index: number) {
  settings.scanDirs.splice(index, 1);
}

function clearScanDirs() {
  settings.scanDirs.splice(0, settings.scanDirs.length);
}

async function clearCache() {
  // M6：连在线封面缓存一起清（此前只清缩略图，covers/ 会静默堆积）
  const [thumbs, covers] = await Promise.all([
    capabilities.clearThumbnailCache(),
    capabilities.clearCoverCache(),
  ]);
  // 在线歌单/榜单的磁盘缓存（IndexedDB）不占封面缓存的空间，
  // 但用户点「清空缓存」时的预期是「把在线内容也重新拉一遍」，因此一起清。
  await listCacheClear();
  const freed = thumbs + covers;
  library.invalidate();
  notify(`${t("settings.cacheCleared")}${freed ? ` · ${formatSize(freed)}` : ""}`);
}
function resetDesktopLyricsBounds() {
  // 回到默认尺寸，并把锚点微调一并归零 —— 用户点「重置」的预期是「回到出厂位置」，
  // 只重置尺寸而留着 ±200px 的偏移会让人以为重置没生效。
  settings.desktopLyricsBounds = { width: 420, height: 120 };
  settings.desktopLyricsAnchorOffsetX = 0;
  settings.desktopLyricsAnchorOffsetY = 0;
}

/**
 * 左侧分类导航：一次只显示一个分类，点谁切谁。
 *
 * ## 为什么拆得这么细（2026-10 改版）
 *
 * 改版前只有 6 个分类，却装了 116 个设置项 / 18 张卡 —— 其中「播放」一个分类里
 * 塞了 7 张卡（约 510 行），想改「歌词字体」要滚 4~5 屏；而「关于」只有 1 张卡。
 * 更要命的是**分类名无法预测内容**：「播放」里装着**阅读排版**和 **ffmpeg 路径**，
 * 「在线服务」把网易云/酷狗/Pixiv/番剧/B站/小说全塞在一起。
 *
 * 现在按「一个分类 ≈ 一屏」重排，并让分类名能直接预测内容：
 * - **阅读** 从「播放」搬到「媒体库」：它管的是 EPUB/PDF 排版，与播放无关；
 * - **ffmpeg** 从「播放」搬到「系统 · 外部依赖」：它是外部程序路径；
 * - **在线源各自独立**：用户找的是"某个源"，分类名就该是源名。
 *
 * ## i18n
 *
 * 改版前这里的 `title` / `label` 是**硬编码中文**，英文界面下导航仍然显示中文。
 * 现在一律走 i18n 键（`nav.settings*`），由模板 `t()` 渲染。
 *
 * ## 注意
 *
 * 分类变多后导航会超出一屏，所以 `.settings-nav` 必须可滚动
 * （见样式里的 max-height + overflow-y）——sticky 元素高于视口时，
 * 不加滚动会让**底部几个分类永远点不到**。
 */
const settingNav = [
  {
    titleKey: "nav.settingsGroupGeneral",
    items: [{ id: "settings-appearance", labelKey: "nav.settingsAppearance", icon: "palette" }],
  },
  {
    titleKey: "nav.settingsGroupLibrary",
    items: [
      { id: "settings-scan", labelKey: "nav.settingsScan", icon: "folder_open" },
      { id: "settings-reading", labelKey: "nav.settingsReading", icon: "menu_book" },
    ],
  },
  {
    titleKey: "nav.settingsGroupPlayback",
    items: [
      { id: "settings-playback", labelKey: "nav.settingsPlayback", icon: "play_circle" },
      { id: "settings-lyrics", labelKey: "nav.settingsLyrics", icon: "lyrics" },
      { id: "settings-dlyrics", labelKey: "nav.settingsDesktopLyrics", icon: "subtitles" },
      {
        id: "settings-taskbar-lyrics",
        labelKey: "nav.settingsTaskbarLyrics",
        icon: "dock_to_bottom",
      },
      { id: "settings-effects", labelKey: "nav.settingsAudioEffects", icon: "equalizer" },
      { id: "settings-automix", labelKey: "nav.settingsAutoMix", icon: "shuffle" },
    ],
  },
  {
    titleKey: "nav.settingsGroupOnline",
    items: [
      { id: "settings-onlinemusic", labelKey: "nav.settingsOnlineMusic", icon: "library_music" },
      { id: "settings-netease", labelKey: "nav.settingsNetease", icon: "cloud_queue" },
      { id: "settings-kugou", labelKey: "nav.settingsKugou", icon: "music_note" },
      { id: "settings-bilibili", labelKey: "nav.settingsBilibili", icon: "smart_display" },
      { id: "settings-anime", labelKey: "nav.settingsAnime", icon: "movie" },
      { id: "settings-danmaku", labelKey: "nav.settingsDanmaku", icon: "chat" },
      { id: "settings-novel", labelKey: "nav.settingsNovel", icon: "auto_stories" },
      { id: "settings-pixiv", labelKey: "nav.settingsPixiv", icon: "image" },
    ],
  },
  {
    titleKey: "nav.settingsGroupSystem",
    items: [
      { id: "settings-sync", labelKey: "nav.settingsSync", icon: "cloud" },
      { id: "settings-deps", labelKey: "nav.settingsDeps", icon: "extension" },
      { id: "settings-about", labelKey: "nav.settingsAbout", icon: "info" },
    ],
  },
];

const activeSection = ref(settingNav[0].items[0].id);

/** 右栏滚动容器（切换分类时用它回到顶部，见 selectSection） */
const settingsBodyEl = ref<HTMLElement | null>(null);

/**
 * 切换分类：右栏只渲染该分类的卡片，并把内容带回顶部。
 *
 * 滚动的是 **.settings-body**（右栏自己的容器），不是 .settings-view ——
 * 后者现在 overflow:hidden、根本不滚（见样式区注释）。原先调
 * `scrollIntoView` 在「整页滚动」时代是有效的，改造后会静默失效：
 * 分类切换了但视图停在上一屏的位置。
 */
function selectSection(id: string) {
  if (activeSection.value === id) return;
  activeSection.value = id;
  // 不同分类高度差很大，不回到顶部会让短分类停在上一屏的滚动位置
  settingsBodyEl.value?.scrollTo({ top: 0 });
}

// ---------------------------------------------------------------- 设置搜索

/**
 * 设置搜索。
 *
 * ## 为什么必须有
 *
 * 改版后分类从 6 个变成 19 个、设置项有 163 个。分类重排解决的是「浏览」——
 * 想看有什么可调的；而「我记得有个开关叫…」是**检索**，只能靠搜索一步到位。
 * 两者不能互相替代。
 *
 * ## 索引从哪来
 *
 * `SETTINGS_INDEX`（i18n 键 → 所属分类）由 `scripts/gen-settings-index.mjs`
 * **从模板结构生成**，并有守卫测试保证它不会过期 —— 手写映射表必然漂移。
 */
const settingsQuery = ref("");

/** 分类 id → 该分类的显示名 */
const sectionLabelById = computed<Record<string, string>>(() => {
  const out: Record<string, string> = {};
  for (const group of settingNav) {
    for (const item of group.items) out[item.id] = t(item.labelKey);
  }
  return out;
});

const settingsHits = computed<SettingsHit[]>(() =>
  matchSettings(
    SETTINGS_INDEX,
    settingsQuery.value,
    /*
     * 中英双语文案都参与匹配：中文界面下用户也可能敲英文关键词
     * （例如 UI 是中文但习惯打 "loudness"）。匹配逻辑本身是纯函数，见 settingsSearch.ts。
     */
    (key) => t(key) + " " + translate("en", key),
    (id) => sectionLabelById.value[id] ?? id,
  ),
);

/** 刚刚跳转过去、正在闪烁高亮的那一项 */
const flashKey = ref<string | null>(null);
let flashTimer: number | null = null;

/** 跳到具体某一项：切分类 → 等 DOM 换出 → 滚动并闪烁高亮。 */
async function goToSetting(hit: SettingsHit) {
  activeSection.value = hit.section;
  settingsQuery.value = "";
  // 目标卡片此刻还没渲染出来（v-if 刚翻转），必须等一次 DOM 更新再找锚点
  await nextTick();
  const el = document.querySelector('[data-setting="' + hit.key + '"]');
  // block:"center" 在最近的滚动祖先里居中；这里最近的滚动祖先就是 .settings-body，
  // 所以跳转只会滚右栏，不会把左栏或整页带走。
  el?.scrollIntoView({ block: "center", behavior: "smooth" });
  el?.classList.add("setting-flash");
  flashKey.value = hit.key;
  if (flashTimer !== null) window.clearTimeout(flashTimer);
  flashTimer = window.setTimeout(() => {
    document.querySelector('[data-setting="' + hit.key + '"]')?.classList.remove("setting-flash");
    flashKey.value = null;
    flashTimer = null;
  }, 1600);
}

onBeforeUnmount(() => {
  if (flashTimer !== null) window.clearTimeout(flashTimer);
});
</script>

<template>
  <div class="settings-view">
    <PageHeader :title="t('nav.settings')" :description="t('navDesc.settings')" />
    <aside class="settings-nav" aria-label="设置分类">
      <!--
        设置搜索：163 个设置项里一步定位。
        分类重排解决的是「浏览」（想看有什么可调的），这里解决「检索」
        （我记得有个开关叫…）—— 两者不能互相替代。
      -->
      <div class="settings-search">
        <span class="material-symbols-outlined settings-search-icon">search</span>
        <input
          v-model="settingsQuery"
          type="search"
          :placeholder="t('settings.searchPlaceholder')"
          :aria-label="t('settings.searchPlaceholder')"
          spellcheck="false"
        />
      </div>
      <div v-if="settingsQuery.trim()" class="settings-hits">
        <p v-if="!settingsHits.length" class="settings-hit-empty">
          {{ t("settings.searchNoResult") }}
        </p>
        <button
          v-for="hit in settingsHits"
          :key="hit.key"
          type="button"
          class="settings-hit"
          @click="goToSetting(hit)"
        >
          <span class="settings-hit-label">{{ hit.label }}</span>
          <span class="settings-hit-where">{{ hit.where }}</span>
        </button>
      </div>
      <m3e-nav-menu v-else>
        <m3e-nav-menu-item-group v-for="group in settingNav" :key="group.titleKey">
          <div slot="label" class="settings-nav-group">{{ t(group.titleKey) }}</div>
          <m3e-nav-menu-item
            v-for="item in group.items"
            :key="item.id"
            :selected="activeSection === item.id"
            @click="selectSection(item.id)"
          >
            <span slot="icon" class="material-symbols-outlined">{{ item.icon }}</span>
            <span slot="label" class="settings-nav-label">{{ t(item.labelKey) }}</span>
          </m3e-nav-menu-item>
        </m3e-nav-menu-item-group>

        <!--
          扩展注册的设置入口（contributes.ui surface="slot" slot="settings.sidebar"）。
          扩展想给自己的设置做个页面，就在这里冒一行 —— 不必再自己弹窗，用户也找得到。
        -->
        <ExtensionSlot slot="settings.sidebar" mode="entry" />
      </m3e-nav-menu>
    </aside>

    <!--
      右栏：唯一的内容滚动容器。
      左栏（.settings-nav）与右栏各自独立滚动，互不带动 —— 这也是「鼠标在列表处
      滚列表、在右侧滚界面」这个诉求的实现方式（两栏各有一个 overflow 容器，
      外层 .settings-view 自己不滚）。
    -->
    <div ref="settingsBodyEl" class="settings-body">
      <!-- 外观 -->
      <m3e-card
        v-if="activeSection === 'settings-appearance'"
        id="settings-appearance"
        class="card"
        variant="outlined"
      >
        <div slot="content">
          <h3>{{ t("settings.appearance") }}</h3>

          <div class="row">
            <div class="row-label">
              <span>{{ t("settings.theme") }}</span>
            </div>
            <SegmentedTabs
              bare
              :model-value="settings.theme"
              :tabs="themeTabs"
              :disabled="themeLocked"
              @update:model-value="setTheme"
            />
          </div>
          <p v-if="themeLockHint" class="hint">{{ themeLockHint }}</p>

          <div class="row">
            <div class="row-label">
              <span>{{ t("settings.language") }}</span>
            </div>
            <SegmentedTabs v-model="settings.lang" bare :tabs="langTabs" />
          </div>

          <div class="row">
            <div class="row-label">
              <span>{{ t("settings.colorScheme") }}</span>
            </div>
            <div class="swatches" :class="{ disabled: seedLocked }">
              <button
                v-for="c in COLOR_SEEDS"
                :key="c.key"
                class="swatch"
                :class="{ active: settings.seedColor.toLowerCase() === c.hex.toLowerCase() }"
                :style="{ '--sw': c.hex }"
                :title="t('settings.colorSeed_' + c.key)"
                :aria-label="t('settings.colorSeed_' + c.key)"
                :disabled="seedLocked"
                @click="pickSeed(c.hex)"
              >
                <span class="material-symbols-outlined">check</span>
              </button>
              <label
                class="swatch custom"
                :class="{ active: isCustomSeed && settings.seedSource !== 'system' }"
                :style="{ '--sw': settings.seedColor }"
                :title="t('settings.colorCustom')"
              >
                <span class="material-symbols-outlined">{{
                  isCustomSeed ? "check" : "colorize"
                }}</span>
                <input
                  type="color"
                  :value="settings.seedColor"
                  :disabled="seedLocked"
                  @input="onCustomSeed"
                />
              </label>
              <!-- 系统强调色（UDA）：平台支持时作为第三个种子来源出现 -->
              <button
                v-if="systemAccentHex"
                class="swatch"
                :class="{ active: settings.seedSource === 'system' }"
                :style="{ '--sw': systemAccentHex }"
                :title="t('settings.system')"
                :aria-label="t('settings.system')"
                :disabled="seedLocked"
                @click="pickSystemSeed()"
              >
                <span class="material-symbols-outlined">check</span>
              </button>
            </div>
          </div>
          <p class="hint">
            {{ seedLocked ? t("settings.skinSeedLocked") : t("settings.colorSchemeHint") }}
          </p>

          <div class="row">
            <div class="row-label">
              <span>{{ t("settings.closeAction") }}</span>
            </div>
            <SegmentedTabs
              bare
              :model-value="settings.closeToTray ? 'tray' : 'quit'"
              :tabs="closeActionTabs"
              @update:model-value="settings.closeToTray = $event === 'tray'"
            />
          </div>
          <p class="hint">{{ t("settings.closeToTrayHint") }}</p>
        </div>
      </m3e-card>

      <!-- 扩展挂到「外观」分类的卡片（slot="settings.appearance"）。
         扩展要往设置里加自己的配置块，就在这里冒出来，与内置卡片同一版式。 -->
      <ExtensionSlot
        v-if="activeSection === 'settings-appearance'"
        slot="settings.appearance"
        mode="panel"
      />

      <!-- 扫描目录 -->
      <m3e-card
        v-if="activeSection === 'settings-scan'"
        id="settings-scan"
        class="card"
        variant="outlined"
      >
        <div slot="content">
          <h3>{{ t("settings.scanDirs") }}</h3>

          <!-- 扫描范围模式：白名单 = 只扫列表；黑名单 = 扫全局但排除列表 -->
          <SettingRow :label="t('settings.scanMode')" setting-key="settings.scanMode">
            <SegmentedTabs v-model="settings.scanMode" bare :tabs="scanModeTabs" />
          </SettingRow>
          <p class="hint">
            {{
              settings.scanMode === "blacklist"
                ? t("settings.scanBlacklistHint")
                : t("settings.scanWhitelistHint")
            }}
          </p>

          <div v-if="settings.scanDirs.length" class="dir-list">
            <div v-for="(dir, i) in settings.scanDirs" :key="dir" class="dir-item">
              <span class="material-symbols-outlined">folder</span>
              <span class="dir-path" :title="dir">{{ dir }}</span>
              <m3e-icon-button class="lm-icon-btn-sm danger" size="small" @click="removeScanDir(i)">
                <span class="material-symbols-outlined">close</span>
              </m3e-icon-button>
            </div>
          </div>
          <!--
          空列表的含义随模式变化，提示必须跟着变：
          白名单下「空」= 扫不了（必须先加目录）；黑名单下「空」= 全局扫描且不排除任何目录。
          此前这里不分模式一律显示「当前：全局扫描」，而白名单下点扫描只会报错 —— 界面在说谎。
        -->
          <div v-else class="notice">
            {{
              settings.scanMode === "blacklist"
                ? t("settings.globalScanHint")
                : t("settings.scanWhitelistEmpty")
            }}
          </div>

          <div class="actions">
            <m3e-button variant="tonal" size="small" @click="addScanDir">
              <span slot="icon" class="material-symbols-outlined">create_new_folder</span>
              {{
                settings.scanMode === "blacklist"
                  ? t("settings.addScanDirExclude")
                  : t("settings.addScanDir")
              }}
            </m3e-button>
            <m3e-button
              v-if="settings.scanDirs.length"
              variant="text"
              size="small"
              @click="clearScanDirs"
            >
              {{ t("settings.clearScanDirs") }}
            </m3e-button>
          </div>
        </div>
      </m3e-card>

      <!-- 体积过滤 -->
      <m3e-card v-if="activeSection === 'settings-scan'" class="card" variant="outlined">
        <div slot="content">
          <h3>{{ t("settings.minSize") }}</h3>
          <p class="hint">{{ t("settings.minSizeHint") }}</p>
          <div class="row">
            <m3e-slider :min="0" :max="100" @input="onSizeSlider">
              <m3e-slider-thumb :value="sliderPos" />
            </m3e-slider>
            <span class="value tabular-nums">
              {{ settings.minFileSizeMb > 0 ? sizeLabel : t("settings.minSizeOff") }}
            </span>
          </div>
          <div class="presets">
            <m3e-filter-chip
              v-for="p in SIZE_PRESETS"
              :key="p"
              class="chip"
              :selected="settings.minFileSizeMb === p"
              @click.prevent="applySize(p)"
            >
              {{ p === 0 ? t("settings.minSizeOff") : `${p} MB` }}
            </m3e-filter-chip>
          </div>
        </div>
      </m3e-card>

      <!-- 阅读 -->
      <ExtensionSlot
        v-if="activeSection === 'settings-reading'"
        slot="settings.library"
        mode="panel"
      />
      <m3e-card v-if="activeSection === 'settings-reading'" class="card" variant="outlined">
        <div slot="content">
          <h3>{{ t("settings.reading") }}</h3>
          <p class="hint">{{ t("settings.pdfModeHint") }}</p>
          <div class="row">
            <div class="row-label">
              <span>{{ t("settings.pdfMode") }}</span>
            </div>
            <SegmentedTabs v-model="settings.pdfReadMode" bare :tabs="pdfModeTabs" />
          </div>
        </div>
      </m3e-card>

      <!-- 扩展挂到「系统」分类的卡片 -->
      <ExtensionSlot v-if="activeSection === 'settings-deps'" slot="settings.system" mode="panel" />

      <!-- FFmpeg -->
      <m3e-card
        v-if="activeSection === 'settings-deps'"
        id="settings-deps"
        class="card"
        variant="outlined"
      >
        <div slot="content">
          <h3>{{ t("settings.ffmpeg") }}</h3>
          <p class="hint">{{ t("settings.ffmpegHint") }}</p>

          <div class="status" :class="ffmpeg?.available ? 'ok' : 'warn'">
            <span class="material-symbols-outlined">
              {{ ffmpeg?.available ? "check_circle" : "error" }}
            </span>
            <div class="status-text">
              <strong>
                {{ ffmpeg?.available ? t("settings.ffmpegDetected") : t("settings.ffmpegMissing") }}
              </strong>
              <span v-if="ffmpeg?.available" class="mono">{{ ffmpeg.ffmpegPath }}</span>
              <span v-if="ffmpeg?.version" class="version">{{ ffmpeg.version }}</span>
              <span v-if="ffmpeg?.available" class="source">
                {{
                  ffmpeg.source === "override"
                    ? t("settings.ffmpegFromOverride")
                    : t("settings.ffmpegFromPath")
                }}
              </span>
            </div>
          </div>

          <div v-if="settings.ffmpegDir" class="dir-item override">
            <span class="material-symbols-outlined">tune</span>
            <span class="dir-path" :title="settings.ffmpegDir">{{ settings.ffmpegDir }}</span>
          </div>

          <div class="actions">
            <m3e-button variant="tonal" size="small" @click="chooseFfmpegDir">
              <span slot="icon" class="material-symbols-outlined">folder_open</span>
              {{ t("settings.ffmpegChoose") }}
            </m3e-button>
            <m3e-button variant="outlined" size="small" :disabled="checking" @click="recheckFfmpeg">
              <span slot="icon" class="material-symbols-outlined">refresh</span>
              {{ t("settings.ffmpegRecheck") }}
            </m3e-button>
            <m3e-button
              v-if="settings.ffmpegDir"
              variant="text"
              size="small"
              @click="resetFfmpegDir"
            >
              {{ t("settings.ffmpegReset") }}
            </m3e-button>
            <m3e-button
              v-if="!ffmpeg?.available"
              variant="text"
              size="small"
              @click="capabilities.openFfmpegDownloadPage()"
            >
              <span slot="icon" class="material-symbols-outlined">download</span>
              {{ t("settings.ffmpegDownload") }}
            </m3e-button>
          </div>
        </div>
      </m3e-card>

      <!-- 歌词 -->
      <m3e-card v-if="activeSection === 'settings-lyrics'" class="card" variant="outlined">
        <div slot="content">
          <h3>{{ t("settings.lyrics") }}</h3>
          <div class="row">
            <div class="row-label">
              <span>{{ t("settings.lyricEngine") }}</span>
            </div>
            <SegmentedTabs v-model="settings.lyricEngine" bare :tabs="lyricEngineTabs" />
          </div>
          <p class="hint">{{ t("settings.lyricEngineHint") }}</p>

          <!--
          换行动效方案：只对自研引擎生效（AMLL 引擎是官方组件，换行由它自己管）。
          与下面的「歌词行缩放 / 物理弹簧滚动」是两套并列的实现，因此不放进 AMLL 专属区。
        -->
          <template v-if="settings.lyricEngine === 'native'">
            <div class="row">
              <div class="row-label">
                <span>{{ t("settings.lyricLineMotion") }}</span>
              </div>
              <SegmentedTabs v-model="settings.lyricLineMotion" bare :tabs="lyricLineMotionTabs" />
            </div>
            <p class="hint">{{ t("settings.lyricLineMotionHint") }}</p>
          </template>

          <!-- AMLL 引擎专属动效设置：仅在选用 AMLL 时展示，避免与自研视图的选项混在一起 -->
          <template v-if="settings.lyricEngine === 'amll'">
            <SettingRow
              :label="t('settings.amllEnableScale')"
              setting-key="settings.amllEnableScale"
              clickable
            >
              <m3e-switch
                :checked="settings.amllEnableScale"
                @change="setSwitch('amllEnableScale', $event)"
              />
            </SettingRow>
            <p class="hint">{{ t("settings.amllEnableScaleHint") }}</p>

            <SettingRow
              :label="t('settings.amllHidePassedLines')"
              setting-key="settings.amllHidePassedLines"
              clickable
            >
              <m3e-switch
                :checked="settings.amllHidePassedLines"
                @change="setSwitch('amllHidePassedLines', $event)"
              />
            </SettingRow>

            <SettingRow
              :label="t('settings.amllEnableSpring')"
              setting-key="settings.amllEnableSpring"
              clickable
            >
              <m3e-switch
                :checked="settings.amllEnableSpring"
                @change="setSwitch('amllEnableSpring', $event)"
              />
            </SettingRow>
            <p class="hint">{{ t("settings.amllEnableSpringHint") }}</p>

            <div class="row">
              <div class="row-label">
                <span>{{ t("settings.amllWordFadeWidth") }}</span>
              </div>
              <m3e-slider
                :min="0.05"
                :max="1"
                :step="0.05"
                @input="onSliderAmllWordFadeWidth($event)"
              >
                <m3e-slider-thumb :value="settings.amllWordFadeWidth" />
              </m3e-slider>
              <span class="value tabular-nums">{{ settings.amllWordFadeWidth.toFixed(2) }}em</span>
            </div>
            <p class="hint">{{ t("settings.amllWordFadeWidthHint") }}</p>

            <div class="row">
              <div class="row-label">
                <span>{{ t("settings.amllAlignPosition") }}</span>
              </div>
              <m3e-slider :min="10" :max="90" @input="onSliderAmllAlignPosition($event)">
                <m3e-slider-thumb :value="Math.round(settings.amllAlignPosition * 100)" />
              </m3e-slider>
              <span class="value tabular-nums"
                >{{ Math.round(settings.amllAlignPosition * 100) }}%</span
              >
            </div>
          </template>

          <SettingRow :label="t('settings.wordLyrics')" setting-key="settings.wordLyrics" clickable>
            <m3e-switch :checked="settings.wordLyrics" @change="setSwitch('wordLyrics', $event)" />
          </SettingRow>
          <p class="hint">{{ t("settings.wordLyricsHint") }}</p>
          <SettingRow
            :label="t('settings.preciseLyrics')"
            setting-key="settings.preciseLyrics"
            clickable
          >
            <m3e-switch
              :checked="settings.preciseLyrics"
              @change="setSwitch('preciseLyrics', $event)"
            />
          </SettingRow>
          <p class="hint">{{ t("settings.preciseLyricsHint") }}</p>
          <SettingRow :label="t('settings.amllLyrics')" setting-key="settings.amllLyrics" clickable>
            <m3e-switch
              :checked="settings.amllLyricsEnabled"
              @change="setSwitch('amllLyricsEnabled', $event)"
            />
          </SettingRow>
          <p class="hint">{{ t("settings.amllLyricsHint") }}</p>
          <!-- 地址框仅在源开启时展示：关掉 AMLL 后该地址不会被使用，避免误导 -->
          <m3e-form-field v-if="settings.amllLyricsEnabled" variant="filled" class="field">
            <label slot="label">{{ t("settings.amllLyricBase") }}</label>
            <input v-model="settings.amllLyricBase" type="text" spellcheck="false" />
          </m3e-form-field>
          <p v-if="settings.amllLyricsEnabled" class="hint">
            {{ t("settings.amllLyricBaseHint") }}
          </p>
          <SettingRow
            :label="t('settings.detectInstrumental')"
            setting-key="settings.detectInstrumental"
            clickable
          >
            <m3e-switch
              :checked="settings.detectInstrumental"
              @change="setSwitch('detectInstrumental', $event)"
            />
          </SettingRow>
          <p class="hint">{{ t("settings.detectInstrumentalHint") }}</p>
          <SettingRow
            :label="t('settings.loudnessNormalize')"
            setting-key="settings.loudnessNormalize"
            clickable
          >
            <m3e-switch
              :checked="settings.loudnessNormalize"
              @change="setSwitch('loudnessNormalize', $event)"
            />
          </SettingRow>
          <p class="hint">{{ t("settings.loudnessNormalizeHint") }}</p>
          <div v-if="settings.loudnessNormalize" class="row">
            <span class="row-label">{{ t("settings.loudnessTarget") }}</span>
            <m3e-slider
              :min="-20"
              :max="-8"
              @input="settings.loudnessTarget = $event.detail ?? $event"
            >
              <m3e-slider-thumb :value="settings.loudnessTarget" />
            </m3e-slider>
            <span class="value tabular-nums">{{ settings.loudnessTarget }} LUFS</span>
          </div>
          <p v-if="settings.loudnessNormalize" class="hint">
            {{ t("settings.loudnessTargetHint") }}
          </p>
          <div class="row">
            <div class="row-label">
              <span>{{ t("settings.obsceneMask") }}</span>
            </div>
            <div class="presets inline">
              <m3e-filter-chip
                v-for="m in OBSCENE_MODES"
                :key="m"
                class="chip"
                :selected="settings.obsceneMask === m"
                @click.prevent="settings.obsceneMask = m"
              >
                {{ t("settings.obsceneMode_" + m) }}
              </m3e-filter-chip>
            </div>
          </div>
          <p class="hint">{{ t("settings.obsceneMaskHint") }}</p>
          <div class="row">
            <div class="row-label">
              <span>{{ t("settings.lyricFont") }}</span>
            </div>
            <div class="presets inline">
              <m3e-filter-chip
                v-for="k in LYRIC_FONT_KEYS"
                :key="k"
                class="chip"
                :selected="settings.lyricFont === k"
                @click.prevent="settings.lyricFont = k"
              >
                {{ t("settings.lyricFont_" + k) }}
              </m3e-filter-chip>
            </div>
          </div>
          <div class="row">
            <div class="row-label">
              <span>{{ t("settings.lyricFontSize") }}</span>
            </div>
            <m3e-slider :min="16" :max="48" @input="onSliderInt($event, 'lyricFontSize')">
              <m3e-slider-thumb :value="settings.lyricFontSize" />
            </m3e-slider>
            <span class="value tabular-nums">{{ settings.lyricFontSize }}px</span>
          </div>
          <div class="row">
            <div class="row-label">
              <span>{{ t("settings.lyricLineHeight") }}</span>
            </div>
            <m3e-slider :min="1.6" :max="3.2" :step="0.1" @input="onSliderLineHeight">
              <m3e-slider-thumb :value="settings.lyricLineHeight" />
            </m3e-slider>
            <span class="value tabular-nums">{{ settings.lyricLineHeight.toFixed(1) }}</span>
          </div>
          <div class="row">
            <div class="row-label">
              <span>{{ t("settings.lyricLineGap") }}</span>
            </div>
            <m3e-slider :min="0" :max="64" @input="onSliderInt($event, 'lyricLineGap')">
              <m3e-slider-thumb :value="settings.lyricLineGap" />
            </m3e-slider>
            <span class="value tabular-nums">{{ settings.lyricLineGap }}px</span>
          </div>
          <div class="row">
            <div class="row-label">
              <span>{{ t("settings.lyricTranslationSize") }}</span>
            </div>
            <m3e-slider
              :min="40"
              :max="120"
              :step="5"
              @input="onSliderInt($event, 'lyricTranslationSize')"
            >
              <m3e-slider-thumb :value="settings.lyricTranslationSize" />
            </m3e-slider>
            <span class="value tabular-nums">{{ settings.lyricTranslationSize }}%</span>
          </div>
          <div class="row">
            <div class="row-label">
              <span>{{ t("settings.lyricTranslationGap") }}</span>
            </div>
            <m3e-slider :min="0" :max="24" @input="onSliderInt($event, 'lyricTranslationGap')">
              <m3e-slider-thumb :value="settings.lyricTranslationGap" />
            </m3e-slider>
            <span class="value tabular-nums">{{ settings.lyricTranslationGap }}px</span>
          </div>
        </div>
      </m3e-card>
      <!-- 桌面歌词 -->
      <m3e-card v-if="activeSection === 'settings-dlyrics'" class="card" variant="outlined">
        <div slot="content">
          <h3>{{ t("settings.desktopLyrics") }}</h3>
          <p class="hint">{{ t("settings.desktopLyricsHint") }}</p>

          <SettingRow
            :label="t('settings.desktopLyricsEnable')"
            setting-key="settings.desktopLyricsEnable"
            clickable
          >
            <m3e-switch
              :checked="settings.desktopLyricsEnabled"
              @change="setSwitch('desktopLyricsEnabled', $event)"
            />
          </SettingRow>

          <!-- 窗口定位：手动拖放 / 吸附任务栏 -->
          <div class="row">
            <div class="row-label">
              <span>{{ t("settings.desktopLyricsAnchor") }}</span>
            </div>
            <SegmentedTabs v-model="settings.desktopLyricsAnchor" bare :tabs="dlAnchorTabs" />
          </div>
          <p class="hint">{{ t("settings.desktopLyricsAnchorHint") }}</p>

          <template v-if="settings.desktopLyricsAnchor === 'taskbar'">
            <div class="row">
              <div class="row-label">
                <span>{{ t("settings.desktopLyricsAnchorAlign") }}</span>
              </div>
              <SegmentedTabs
                v-model="settings.desktopLyricsAnchorAlign"
                bare
                :tabs="dlAnchorAlignTabs"
              />
            </div>
            <div class="row">
              <div class="row-label">
                <span>{{ t("settings.desktopLyricsAnchorOffsetX") }}</span>
              </div>
              <m3e-slider
                :min="-600"
                :max="600"
                :step="10"
                @input="onSliderInt($event, 'desktopLyricsAnchorOffsetX')"
              >
                <m3e-slider-thumb :value="settings.desktopLyricsAnchorOffsetX" />
              </m3e-slider>
              <span class="value tabular-nums">{{ settings.desktopLyricsAnchorOffsetX }}px</span>
            </div>
            <div class="row">
              <div class="row-label">
                <span>{{ t("settings.desktopLyricsAnchorOffsetY") }}</span>
              </div>
              <m3e-slider
                :min="-200"
                :max="200"
                :step="5"
                @input="onSliderInt($event, 'desktopLyricsAnchorOffsetY')"
              >
                <m3e-slider-thumb :value="settings.desktopLyricsAnchorOffsetY" />
              </m3e-slider>
              <span class="value tabular-nums">{{ settings.desktopLyricsAnchorOffsetY }}px</span>
            </div>
          </template>

          <SettingRow
            :label="t('settings.desktopLyricsWordByWord')"
            setting-key="settings.desktopLyricsWordByWord"
            clickable
          >
            <m3e-switch
              :checked="settings.desktopLyricsWordByWord"
              @change="setSwitch('desktopLyricsWordByWord', $event)"
            />
          </SettingRow>
          <p class="hint">{{ t("settings.desktopLyricsWordByWordHint") }}</p>

          <div class="row">
            <div class="row-label">
              <span>{{ t("settings.desktopLyricsIdleMode") }}</span>
            </div>
            <SegmentedTabs v-model="settings.desktopLyricsIdleMode" bare :tabs="dlIdleTabs" />
          </div>
          <p class="hint">{{ t("settings.desktopLyricsIdleModeHint") }}</p>

          <SettingRow
            :label="t('settings.desktopLyricsShowNext')"
            setting-key="settings.desktopLyricsShowNext"
            clickable
          >
            <m3e-switch
              :checked="settings.desktopLyricsShowNext"
              @change="setSwitch('desktopLyricsShowNext', $event)"
            />
          </SettingRow>

          <SettingRow
            :label="t('settings.desktopLyricsShowTranslation')"
            setting-key="settings.desktopLyricsShowTranslation"
            clickable
          >
            <m3e-switch
              :checked="settings.desktopLyricsShowTranslation"
              @change="setSwitch('desktopLyricsShowTranslation', $event)"
            />
          </SettingRow>

          <div class="row">
            <div class="row-label">
              <span>{{ t("settings.desktopLyricsToolbar") }}</span>
            </div>
            <SegmentedTabs v-model="settings.desktopLyricsToolbar" bare :tabs="dlToolbarTabs" />
          </div>
          <div class="row">
            <div class="row-label">
              <span>{{ t("settings.desktopLyricsDoubleClick") }}</span>
            </div>
            <SegmentedTabs
              v-model="settings.desktopLyricsDoubleClick"
              bare
              :tabs="dlDoubleClickTabs"
            />
          </div>

          <div class="row">
            <div class="row-label">
              <span>{{ t("settings.desktopLyricsFontSize") }}</span>
            </div>
            <m3e-slider :min="16" :max="64" @input="onSliderInt($event, 'desktopLyricsFontSize')">
              <m3e-slider-thumb :value="settings.desktopLyricsFontSize" />
            </m3e-slider>
            <span class="value tabular-nums">{{ settings.desktopLyricsFontSize }}px</span>
          </div>

          <div class="row">
            <div class="row-label">
              <span>{{ t("settings.desktopLyricsOpacity") }}</span>
            </div>
            <m3e-slider
              :min="30"
              :max="100"
              :step="5"
              @input="onSliderInt($event, 'desktopLyricsOpacity')"
            >
              <m3e-slider-thumb :value="settings.desktopLyricsOpacity" />
            </m3e-slider>
            <span class="value tabular-nums">{{ settings.desktopLyricsOpacity }}%</span>
          </div>

          <div class="row">
            <div class="row-label">
              <span>{{ t("settings.desktopLyricsAnimation") }}</span>
            </div>
            <div class="presets inline">
              <m3e-filter-chip
                v-for="k in LYRICS_ANIMATIONS"
                :key="k"
                class="chip"
                :selected="settings.desktopLyricsAnimation === k"
                @click.prevent="settings.desktopLyricsAnimation = k"
              >
                {{ t("settings.desktopLyricsAnim_" + k) }}
              </m3e-filter-chip>
            </div>
          </div>

          <SettingRow
            :label="t('settings.desktopLyricsLocked')"
            setting-key="settings.desktopLyricsLocked"
            clickable
          >
            <m3e-switch
              :checked="settings.desktopLyricsLocked"
              @change="setSwitch('desktopLyricsLocked', $event)"
            />
          </SettingRow>

          <SettingRow
            :label="t('settings.desktopLyricsClickThrough')"
            setting-key="settings.desktopLyricsClickThrough"
            clickable
          >
            <m3e-switch
              :checked="settings.desktopLyricsClickThrough"
              @change="setSwitch('desktopLyricsClickThrough', $event)"
            />
          </SettingRow>
          <p class="hint">{{ t("settings.desktopLyricsClickThroughHint") }}</p>

          <SettingRow
            :label="t('settings.desktopLyricsAlwaysOnTop')"
            setting-key="settings.desktopLyricsAlwaysOnTop"
            clickable
          >
            <m3e-switch
              :checked="settings.desktopLyricsAlwaysOnTop"
              @change="setSwitch('desktopLyricsAlwaysOnTop', $event)"
            />
          </SettingRow>

          <div class="actions">
            <m3e-button variant="outlined" size="small" @click="resetDesktopLyricsBounds">
              {{ t("settings.desktopLyricsResetPos") }}
            </m3e-button>
          </div>
        </div>
      </m3e-card>

      <!-- 任务栏歌词（独立业务：Rust 进程 + SetParent 进任务栏，与上面的桌面歌词无关） -->
      <m3e-card v-if="activeSection === 'settings-taskbar-lyrics'" class="card" variant="outlined">
        <div slot="content">
          <h3>{{ t("settings.taskbarLyrics") }}</h3>
          <p class="hint">{{ t("settings.taskbarLyricsHint") }}</p>

          <SettingRow
            :label="t('settings.taskbarLyricsEnable')"
            setting-key="settings.taskbarLyricsEnable"
            clickable
          >
            <m3e-switch
              :checked="settings.taskbarLyricsEnabled"
              @change="setSwitch('taskbarLyricsEnabled', $event)"
            />
          </SettingRow>
          <p class="hint">{{ t("settings.taskbarLyricsEnableHint") }}</p>

          <div class="row">
            <div class="row-label">
              <span>{{ t("settings.taskbarLyricsFontSize") }}</span>
            </div>
            <m3e-slider
              :min="12"
              :max="40"
              :step="1"
              @input="onSliderInt($event, 'taskbarLyricsFontSize')"
            >
              <m3e-slider-thumb :value="settings.taskbarLyricsFontSize" />
            </m3e-slider>
            <span class="value tabular-nums">{{ settings.taskbarLyricsFontSize }}px</span>
          </div>

          <div class="row">
            <div class="row-label">
              <span>{{ t("settings.taskbarLyricsOpacity") }}</span>
            </div>
            <m3e-slider
              :min="20"
              :max="100"
              :step="1"
              @input="onSliderInt($event, 'taskbarLyricsOpacity')"
            >
              <m3e-slider-thumb :value="settings.taskbarLyricsOpacity" />
            </m3e-slider>
            <span class="value tabular-nums">{{ settings.taskbarLyricsOpacity }}%</span>
          </div>

          <SettingRow
            :label="t('settings.taskbarLyricsShowTranslation')"
            setting-key="settings.taskbarLyricsShowTranslation"
            clickable
          >
            <m3e-switch
              :checked="settings.taskbarLyricsShowTranslation"
              @change="setSwitch('taskbarLyricsShowTranslation', $event)"
            />
          </SettingRow>
        </div>
      </m3e-card>

      <!-- 播放器 -->
      <ExtensionSlot
        v-if="activeSection === 'settings-playback'"
        slot="settings.playback"
        mode="panel"
      />
      <m3e-card v-if="activeSection === 'settings-playback'" class="card" variant="outlined">
        <div slot="content">
          <h3>{{ t("settings.playback") }}</h3>
          <p class="hint">{{ t("settings.playerBgHint") }}</p>
          <div class="row">
            <div class="row-label">
              <span>{{ t("settings.playerBg") }}</span>
            </div>
            <SegmentedTabs v-model="settings.playerBg" bare :tabs="playerBgTabs" />
          </div>
          <div class="row">
            <div class="row-label">
              <span>{{ t("settings.musicViewMode") }}</span>
            </div>
            <SegmentedTabs v-model="settings.musicViewMode" bare :tabs="musicViewTabs" />
          </div>
          <p class="hint">{{ t("player.hotkeysHint") }}</p>
          <SettingRow :label="t('settings.lyricBlur')" setting-key="settings.lyricBlur" clickable>
            <m3e-switch :checked="settings.lyricBlur" @change="setSwitch('lyricBlur', $event)" />
          </SettingRow>
        </div>
      </m3e-card>

      <!-- AutoMix 自动混音 -->
      <m3e-card v-if="activeSection === 'settings-automix'" class="card" variant="outlined">
        <div slot="content">
          <h3>{{ t("settings.autoMix") }}</h3>
          <SettingRow
            :label="t('settings.autoMixEnabled')"
            setting-key="settings.autoMixEnabled"
            clickable
          >
            <m3e-switch
              :checked="settings.autoMixEnabled"
              @change="setSwitch('autoMixEnabled', $event)"
            />
          </SettingRow>
          <p class="hint">{{ t("settings.autoMixHint") }}</p>

          <template v-if="settings.autoMixEnabled">
            <div class="row">
              <div class="row-label">
                <span>{{ t("settings.autoMixDuration") }}</span>
              </div>
              <m3e-slider
                :min="3"
                :max="16"
                :step="1"
                @input="onSliderInt($event, 'autoMixDuration')"
              >
                <m3e-slider-thumb :value="settings.autoMixDuration" />
              </m3e-slider>
              <span class="value">{{ settings.autoMixDuration }}s</span>
            </div>

            <SettingRow
              :label="t('settings.autoMixBeatMatch')"
              setting-key="settings.autoMixBeatMatch"
              clickable
            >
              <m3e-switch
                :checked="settings.autoMixBeatMatch"
                @change="setSwitch('autoMixBeatMatch', $event)"
              />
            </SettingRow>

            <SettingRow
              :label="t('settings.autoMixTrimSilence')"
              setting-key="settings.autoMixTrimSilence"
              clickable
            >
              <m3e-switch
                :checked="settings.autoMixTrimSilence"
                @change="setSwitch('autoMixTrimSilence', $event)"
              />
            </SettingRow>

            <div class="row">
              <div class="row-label">
                <span>{{ t("settings.autoMixMaxRate") }}</span>
              </div>
              <m3e-slider
                :min="1"
                :max="12"
                :step="1"
                @input="onSliderInt($event, 'autoMixMaxRateDeviation')"
              >
                <m3e-slider-thumb :value="settings.autoMixMaxRateDeviation" />
              </m3e-slider>
              <span class="value">±{{ settings.autoMixMaxRateDeviation }}%</span>
            </div>
            <p class="hint">{{ t("settings.autoMixMaxRateHint") }}</p>
            <p class="hint debug-hint">{{ t("settings.autoMixDebugHint") }}</p>
          </template>
        </div>
      </m3e-card>

      <!-- 音效 -->
      <m3e-card v-if="activeSection === 'settings-effects'" class="card" variant="outlined">
        <div slot="content">
          <h3>{{ t("settings.audioEffects") }}</h3>
          <p class="hint">{{ t("settings.audioEffectsHint") }}</p>
          <div class="row">
            <div class="row-label">
              <span>{{ t("settings.shareCodePreference") }}</span>
            </div>
            <SegmentedTabs v-model="settings.shareCodePreference" bare :tabs="shareCodeTabs" />
          </div>
          <p class="hint">{{ t("settings.shareCodePreferenceHint") }}</p>
          <AudioEffectsPanel />
        </div>
      </m3e-card>

      <!-- 在线音乐：分组级开关 + 默认音源（两个源共用的部分） -->
      <m3e-card
        v-if="activeSection === 'settings-onlinemusic'"
        id="settings-onlinemusic"
        class="card"
        variant="outlined"
      >
        <div slot="content">
          <h3>{{ t("nav.settingsOnlineMusic") }}</h3>
          <p class="hint">{{ t("settings.onlineHint") }}</p>
          <SettingRow
            :label="t('settings.onlineEnable')"
            setting-key="settings.onlineEnable"
            clickable
          >
            <m3e-switch
              :checked="settings.enableOnlineMusic"
              @change="setSwitch('enableOnlineMusic', $event)"
            />
          </SettingRow>
          <div v-if="settings.enableOnlineMusic" class="row">
            <div class="row-label">
              <span>{{ t("settings.onlineServer") }}</span>
            </div>
            <SegmentedTabs v-model="settings.musicServer" bare :tabs="musicServerTabs" />
          </div>
        </div>
      </m3e-card>

      <!-- 扩展挂到「在线源」分类的卡片 -->
      <ExtensionSlot
        v-if="activeSection === 'settings-onlinemusic'"
        slot="settings.online"
        mode="panel"
      />

      <!-- 网易云 -->
      <m3e-card
        v-if="activeSection === 'settings-netease'"
        id="settings-netease"
        class="card"
        variant="outlined"
      >
        <div slot="content">
          <h3>{{ t("nav.settingsNetease") }}</h3>
          <SettingRow
            :label="t('settings.neteaseEnable')"
            setting-key="settings.neteaseEnable"
            clickable
          >
            <m3e-switch
              :checked="settings.neteaseEnabled"
              @change="setSwitch('neteaseEnabled', $event)"
            />
          </SettingRow>
          <p class="hint">{{ t("settings.neteaseHint") }}</p>
        </div>
      </m3e-card>

      <!-- 酷狗 -->
      <m3e-card
        v-if="activeSection === 'settings-kugou'"
        id="settings-kugou"
        class="card"
        variant="outlined"
      >
        <div slot="content">
          <h3>{{ t("nav.settingsKugou") }}</h3>
          <SettingRow
            :label="t('settings.kugouEnable')"
            setting-key="settings.kugouEnable"
            clickable
          >
            <m3e-switch
              :checked="settings.kugouEnabled"
              @change="setSwitch('kugouEnabled', $event)"
            />
          </SettingRow>
          <p class="hint">{{ t("settings.kugouHint") }}</p>
          <SettingRow
            v-if="settings.kugouEnabled"
            :label="t('settings.kugouAutoSignIn')"
            setting-key="settings.kugouAutoSignIn"
            clickable
          >
            <m3e-switch
              :checked="settings.kugouAutoSignIn"
              @change="setSwitch('kugouAutoSignIn', $event)"
            />
          </SettingRow>
        </div>
      </m3e-card>

      <!-- 在线小说 -->
      <m3e-card v-if="activeSection === 'settings-novel'" class="card" variant="outlined">
        <div slot="content">
          <h3>{{ t("settings.onlineNovel") }}</h3>
          <p class="hint">{{ t("settings.onlineNovelHint") }}</p>
          <SettingRow
            :label="t('settings.onlineNovelEnable')"
            setting-key="settings.onlineNovelEnable"
            clickable
          >
            <m3e-switch
              :checked="settings.onlineNovelEnabled"
              @change="setSwitch('onlineNovelEnabled', $event)"
            />
          </SettingRow>
          <SettingRow
            :label="t('settings.bqgNovelEnable')"
            setting-key="settings.bqgNovelEnable"
            clickable
          >
            <m3e-switch
              :checked="settings.bqgNovelEnabled"
              @change="setSwitch('bqgNovelEnabled', $event)"
            />
          </SettingRow>
          <div v-if="settings.onlineNovelEnabled" class="row">
            <div class="row-label">
              <span>{{ t("settings.wenku8Node") }}</span>
            </div>
            <SegmentedTabs v-model="settings.wenku8Node" bare :tabs="wenku8NodeTabs" />
          </div>
          <div v-if="settings.onlineNovelEnabled" class="row">
            <div class="row-label">
              <span>{{ t("settings.novelCharset") }}</span>
            </div>
            <SegmentedTabs v-model="settings.novelCharset" bare :tabs="novelCharsetTabs" />
          </div>
        </div>
      </m3e-card>

      <!-- 在线 B 站视频 -->
      <m3e-card v-if="activeSection === 'settings-bilibili'" class="card" variant="outlined">
        <div slot="content">
          <h3>{{ t("settings.bilibili") }}</h3>
          <p class="hint">{{ t("settings.bilibiliHint") }}</p>
          <SettingRow
            :label="t('settings.bilibiliEnable')"
            setting-key="settings.bilibiliEnable"
            clickable
          >
            <m3e-switch
              :checked="settings.bilibiliEnabled"
              @change="setSwitch('bilibiliEnabled', $event)"
            />
          </SettingRow>
          <p v-if="settings.bilibiliEnabled" class="hint">
            {{ t("settings.bilibiliLoginHint") }}
          </p>

          <!-- 反诈 / 带货过滤 / AI 总结：仅在启用 B 站视频后才有意义 -->
          <template v-if="settings.bilibiliEnabled">
            <SettingRow
              :label="t('settings.biliAntifraud')"
              setting-key="settings.biliAntifraud"
              clickable
            >
              <m3e-switch
                :checked="settings.biliAntifraudEnabled"
                @change="setSwitch('biliAntifraudEnabled', $event)"
              />
            </SettingRow>
            <p class="hint">{{ t("settings.biliAntifraudHint") }}</p>

            <SettingRow
              :label="t('settings.biliDynAntifraud')"
              setting-key="settings.biliDynAntifraud"
              clickable
            >
              <m3e-switch
                :checked="settings.biliDynAntifraudEnabled"
                @change="setSwitch('biliDynAntifraudEnabled', $event)"
              />
            </SettingRow>
            <p class="hint">{{ t("settings.biliDynAntifraudHint") }}</p>

            <SettingRow
              :label="t('settings.biliAntiGoodsDyn')"
              setting-key="settings.biliAntiGoodsDyn"
              clickable
            >
              <m3e-switch
                :checked="settings.biliAntiGoodsDyn"
                @change="setSwitch('biliAntiGoodsDyn', $event)"
              />
            </SettingRow>
            <p class="hint">{{ t("settings.biliAntiGoodsDynHint") }}</p>

            <SettingRow
              :label="t('settings.biliAntiGoodsReply')"
              setting-key="settings.biliAntiGoodsReply"
              clickable
            >
              <m3e-switch
                :checked="settings.biliAntiGoodsReply"
                @change="setSwitch('biliAntiGoodsReply', $event)"
              />
            </SettingRow>
            <p class="hint">{{ t("settings.biliAntiGoodsReplyHint") }}</p>

            <SettingRow
              :label="t('settings.biliAiSummary')"
              setting-key="settings.biliAiSummary"
              clickable
            >
              <m3e-switch
                :checked="settings.biliAiSummaryEnabled"
                @change="setSwitch('biliAiSummaryEnabled', $event)"
              />
            </SettingRow>
            <p class="hint">{{ t("settings.biliAiSummaryHint") }}</p>

            <SettingRow
              :label="t('settings.biliAntiGoodsPublish')"
              setting-key="settings.biliAntiGoodsPublish"
              clickable
            >
              <m3e-switch
                :checked="settings.biliAntiGoodsPublish"
                @change="setSwitch('biliAntiGoodsPublish', $event)"
              />
            </SettingRow>
            <p class="hint">{{ t("settings.biliAntiGoodsPublishHint") }}</p>
          </template>

          <!-- 空降助手（SponsorBlock）：跳过赞助/广告段 -->
          <template v-if="settings.bilibiliEnabled">
            <SettingRow
              :label="t('settings.sponsorBlock')"
              setting-key="settings.sponsorBlock"
              clickable
            >
              <m3e-switch
                :checked="settings.sponsorBlockEnabled"
                @change="setSwitch('sponsorBlockEnabled', $event)"
              />
            </SettingRow>
            <p class="hint">{{ t("settings.sponsorBlockHint") }}</p>

            <template v-if="settings.sponsorBlockEnabled">
              <m3e-form-field variant="filled" class="field">
                <label slot="label">{{ t("settings.sponsorBlockServer") }}</label>
                <input v-model="settings.sponsorBlockServer" type="text" spellcheck="false" />
              </m3e-form-field>

              <div class="row-label sponsor-cats-label">
                <span>{{ t("settings.sponsorBlockCategories") }}</span>
              </div>
              <div class="sponsor-cats">
                <m3e-filter-chip
                  v-for="c in SB_CATEGORIES"
                  :key="c.key"
                  class="chip"
                  :selected="settings.sponsorBlockCategories[c.key] === true"
                  @click.prevent="toggleSponsorCategory(c.key)"
                >
                  <span class="dot" :style="{ background: c.color }" />
                  {{ c.short }}
                </m3e-filter-chip>
              </div>
              <p class="hint">{{ t("settings.sponsorBlockCategoriesHint") }}</p>

              <SettingRow
                :label="t('settings.sponsorBlockToast')"
                setting-key="settings.sponsorBlockToast"
                clickable
              >
                <m3e-switch
                  :checked="settings.sponsorBlockToast"
                  @change="setSwitch('sponsorBlockToast', $event)"
                />
              </SettingRow>
            </template>
          </template>

          <!-- 氛围光（ambient light）：默认关闭，参数可调 -->
          <template v-if="settings.bilibiliEnabled">
            <SettingRow :label="t('settings.ambilight')" setting-key="settings.ambilight" clickable>
              <m3e-switch
                :checked="settings.ambilightEnabled"
                @change="setSwitch('ambilightEnabled', $event)"
              />
            </SettingRow>
            <p class="hint">{{ t("settings.ambilightHint") }}</p>

            <template v-if="settings.ambilightEnabled">
              <div class="row">
                <div class="row-label">
                  <span>{{ t("settings.ambilightBlur") }}</span>
                </div>
                <m3e-slider :min="0" :max="160" @input="onSliderInt($event, 'ambilightBlur')">
                  <m3e-slider-thumb :value="settings.ambilightBlur" />
                </m3e-slider>
                <span class="value tabular-nums">{{ settings.ambilightBlur }}px</span>
              </div>
              <div class="row">
                <div class="row-label">
                  <span>{{ t("settings.ambilightSpread") }}</span>
                </div>
                <m3e-slider :min="0" :max="60" @input="onSliderInt($event, 'ambilightSpread')">
                  <m3e-slider-thumb :value="settings.ambilightSpread" />
                </m3e-slider>
                <span class="value tabular-nums">{{ settings.ambilightSpread }}%</span>
              </div>
              <div class="row">
                <div class="row-label">
                  <span>{{ t("settings.ambilightOpacity") }}</span>
                </div>
                <m3e-slider :min="10" :max="100" @input="onSliderInt($event, 'ambilightOpacity')">
                  <m3e-slider-thumb :value="settings.ambilightOpacity" />
                </m3e-slider>
                <span class="value tabular-nums">{{ settings.ambilightOpacity }}%</span>
              </div>
              <div class="row">
                <div class="row-label">
                  <span>{{ t("settings.ambilightSaturation") }}</span>
                </div>
                <m3e-slider
                  :min="50"
                  :max="250"
                  @input="onSliderInt($event, 'ambilightSaturation')"
                >
                  <m3e-slider-thumb :value="settings.ambilightSaturation" />
                </m3e-slider>
                <span class="value tabular-nums">{{ settings.ambilightSaturation }}%</span>
              </div>
              <div class="row">
                <div class="row-label">
                  <span>{{ t("settings.ambilightBrightness") }}</span>
                </div>
                <m3e-slider
                  :min="40"
                  :max="160"
                  @input="onSliderInt($event, 'ambilightBrightness')"
                >
                  <m3e-slider-thumb :value="settings.ambilightBrightness" />
                </m3e-slider>
                <span class="value tabular-nums">{{ settings.ambilightBrightness }}%</span>
              </div>
            </template>
          </template>
        </div>
      </m3e-card>

      <!-- 在线番剧 -->
      <m3e-card v-if="activeSection === 'settings-anime'" class="card" variant="outlined">
        <div slot="content">
          <h3>{{ t("settings.onlineAnime") }}</h3>
          <p class="hint">{{ t("settings.onlineAnimeHint") }}</p>
          <SettingRow
            :label="t('settings.onlineAnimeEnable')"
            setting-key="settings.onlineAnimeEnable"
            clickable
          >
            <m3e-switch
              :checked="settings.onlineAnimeEnabled"
              @change="setSwitch('onlineAnimeEnabled', $event)"
            />
          </SettingRow>
          <template v-if="settings.onlineAnimeEnabled">
            <p class="hint">{{ t("settings.bangumiHint") }}</p>
            <div class="dav-form">
              <m3e-form-field variant="filled" class="field">
                <label slot="label" for="bangumi-token">{{
                  t("settings.bangumiTokenLabel")
                }}</label>
                <div class="token-line">
                  <input
                    id="bangumi-token"
                    v-model="bangumiTokenDraft"
                    type="password"
                    spellcheck="false"
                    autocomplete="off"
                    :placeholder="t('settings.bangumiTokenPlaceholder')"
                  />
                  <m3e-button
                    variant="filled"
                    size="small"
                    :disabled="bangumiCollect.authState === 'checking' || !bangumiTokenDraft.trim()"
                    @click="connectBangumi"
                  >
                    {{ t("settings.bangumiConnect") }}
                  </m3e-button>
                  <m3e-button
                    v-if="bangumiCollect.authorized"
                    variant="text"
                    size="small"
                    @click="disconnectBangumi"
                  >
                    {{ t("settings.bangumiDisconnect") }}
                  </m3e-button>
                </div>
              </m3e-form-field>
              <p v-if="bangumiCollect.authorized" class="token-state ok">
                {{
                  t("settings.bangumiConnected").replace(
                    "{u}",
                    bangumiCollect.user?.nickname || settings.bangumiUsername,
                  )
                }}
              </p>
              <p v-else-if="bangumiCollect.authError" class="token-state err">
                {{ bangumiCollect.authError }}
              </p>
              <p class="hint">
                {{ t("settings.bangumiTokenHelp") }}
                <button class="link-inline" @click="openBangumiTokenPage">
                  {{ t("settings.bangumiTokenLink") }}
                </button>
              </p>
            </div>
          </template>
        </div>
      </m3e-card>

      <!-- 在线 Pixiv -->
      <m3e-card v-if="activeSection === 'settings-pixiv'" class="card" variant="outlined">
        <div slot="content">
          <h3>{{ t("settings.onlinePixivEnabled") }}</h3>
          <p class="hint">{{ t("settings.onlinePixivHint") }}</p>
          <SettingRow
            :label="t('settings.onlinePixivEnabled')"
            setting-key="settings.onlinePixivEnabled"
            clickable
          >
            <m3e-switch
              :checked="settings.onlinePixivEnabled"
              @change="setSwitch('onlinePixivEnabled', $event)"
            />
          </SettingRow>
          <template v-if="settings.onlinePixivEnabled">
            <div class="row">
              <div class="row-label">
                <span>{{ t("settings.pixivQuality") }}</span>
              </div>
              <SegmentedTabs v-model="settings.pixivImageQuality" bare :tabs="pixivQualityTabs" />
            </div>
            <p class="hint">{{ t("settings.pixivRefreshTokenHint") }}</p>
            <div class="dav-form">
              <m3e-form-field variant="filled" class="field">
                <label slot="label" for="pixiv-refresh-token">{{
                  t("settings.pixivRefreshTokenLabel")
                }}</label>
                <input
                  id="pixiv-refresh-token"
                  v-model="settings.pixivRefreshToken"
                  type="password"
                  spellcheck="false"
                  autocomplete="off"
                />
              </m3e-form-field>
            </div>
          </template>
        </div>
      </m3e-card>

      <!-- 弹幕：番剧走 DanDanPlay，B 站走站内弹幕，但「是否显示弹幕」是同一个开关 -->
      <m3e-card
        v-if="activeSection === 'settings-danmaku'"
        id="settings-danmaku"
        class="card"
        variant="outlined"
      >
        <div slot="content">
          <h3>{{ t("settings.danmaku") }}</h3>
          <p class="hint">{{ t("settings.danmakuHint") }}</p>
          <SettingRow
            :label="t('settings.danmakuEnable')"
            setting-key="settings.danmakuEnable"
            clickable
          >
            <m3e-switch
              :checked="settings.danmakuEnabled"
              @change="setSwitch('danmakuEnabled', $event)"
            />
          </SettingRow>
          <template v-if="settings.danmakuEnabled">
            <div class="dav-form">
              <m3e-form-field variant="filled" class="field">
                <label slot="label" for="dandan-app-id">{{ t("settings.danmakuAppId") }}</label>
                <input
                  id="dandan-app-id"
                  v-model="settings.dandanAppId"
                  type="text"
                  spellcheck="false"
                  autocomplete="off"
                />
              </m3e-form-field>
              <m3e-form-field variant="filled" class="field">
                <label slot="label" for="dandan-app-secret">{{
                  t("settings.danmakuAppSecret")
                }}</label>
                <input
                  id="dandan-app-secret"
                  v-model="settings.dandanAppSecret"
                  type="password"
                  spellcheck="false"
                  autocomplete="off"
                />
              </m3e-form-field>
            </div>
            <div class="dav-grid">
              <label class="field">
                <span>{{ t("settings.danmakuOpacity") }} {{ settings.danmakuOpacity }}%</span>
                <m3e-slider
                  :min="10"
                  :max="100"
                  :step="5"
                  @input="onSliderInt($event, 'danmakuOpacity')"
                >
                  <m3e-slider-thumb :value="settings.danmakuOpacity" />
                </m3e-slider>
              </label>
              <label class="field">
                <span>{{ t("settings.danmakuFontSize") }} {{ settings.danmakuFontSize }}px</span>
                <m3e-slider :min="12" :max="48" @input="onSliderInt($event, 'danmakuFontSize')">
                  <m3e-slider-thumb :value="settings.danmakuFontSize" />
                </m3e-slider>
              </label>
              <label class="field">
                <span>{{ t("settings.danmakuArea") }} {{ settings.danmakuArea }}%</span>
                <m3e-slider
                  :min="20"
                  :max="100"
                  :step="5"
                  @input="onSliderInt($event, 'danmakuArea')"
                >
                  <m3e-slider-thumb :value="settings.danmakuArea" />
                </m3e-slider>
              </label>
              <label class="field">
                <span>{{ t("settings.danmakuSpeed") }} {{ settings.danmakuSpeed }}</span>
                <m3e-slider :min="1" :max="10" @input="onSliderInt($event, 'danmakuSpeed')">
                  <m3e-slider-thumb :value="settings.danmakuSpeed" />
                </m3e-slider>
              </label>
            </div>
            <div class="dav-grid">
              <m3e-form-field variant="filled" class="field">
                <label slot="label" for="danmaku-offset">{{
                  t("settings.danmakuTimeOffset")
                }}</label>
                <input
                  id="danmaku-offset"
                  :value="(settings.danmakuTimeOffsetMs / 1000).toFixed(1)"
                  type="number"
                  step="0.1"
                  min="-30"
                  max="30"
                  @change="onDanmakuOffsetChange"
                />
              </m3e-form-field>
              <SettingRow
                :label="t('settings.danmakuAntiOverlap')"
                setting-key="settings.danmakuAntiOverlap"
                clickable
              >
                <m3e-switch
                  :checked="settings.danmakuAntiOverlap"
                  @change="setSwitch('danmakuAntiOverlap', $event)"
                />
              </SettingRow>
            </div>
          </template>
        </div>
      </m3e-card>

      <!-- WebDAV -->
      <m3e-card
        v-if="activeSection === 'settings-sync'"
        id="settings-sync"
        class="card"
        variant="outlined"
      >
        <div slot="content">
          <h3>{{ t("settings.webdav") }}</h3>
          <p class="hint">{{ t("settings.webdavHint") }}</p>

          <SettingRow
            :label="t('settings.webdavEnable')"
            setting-key="settings.webdavEnable"
            clickable
          >
            <m3e-switch
              :checked="settings.webdavEnabled"
              @change="setSwitch('webdavEnabled', $event)"
            />
          </SettingRow>

          <div v-if="settings.webdavEnabled" class="dav-form">
            <m3e-form-field variant="filled" class="field">
              <label slot="label" for="webdav-url">{{ t("settings.webdavUrl") }}</label>
              <input
                id="webdav-url"
                v-model="settings.webdavUrl"
                type="url"
                :placeholder="t('settings.webdavUrlPlaceholder')"
                spellcheck="false"
                autocomplete="off"
              />
            </m3e-form-field>
            <div class="dav-grid">
              <m3e-form-field variant="filled" class="field">
                <label slot="label" for="webdav-user">{{ t("settings.webdavUser") }}</label>
                <input
                  id="webdav-user"
                  v-model="settings.webdavUser"
                  type="text"
                  spellcheck="false"
                  autocomplete="off"
                />
              </m3e-form-field>
              <m3e-form-field variant="filled" class="field">
                <label slot="label" for="webdav-pass">{{ t("settings.webdavPass") }}</label>
                <div class="pass-wrap">
                  <input
                    id="webdav-pass"
                    v-model="settings.webdavPass"
                    :type="showDavPass ? 'text' : 'password'"
                    spellcheck="false"
                    autocomplete="new-password"
                  />
                  <m3e-icon-button
                    class="lm-icon-btn-sm"
                    size="small"
                    :title="showDavPass ? 'hide' : 'show'"
                    @click="showDavPass = !showDavPass"
                  >
                    <span class="material-symbols-outlined">
                      {{ showDavPass ? "visibility_off" : "visibility" }}
                    </span>
                  </m3e-icon-button>
                </div>
              </m3e-form-field>
            </div>

            <div v-if="davResult" class="status" :class="davResult.ok ? 'ok' : 'warn'">
              <span class="material-symbols-outlined">
                {{ davResult.ok ? "check_circle" : "error" }}
              </span>
              <div class="status-text">
                <strong>
                  {{ davResult.ok ? t("settings.webdavOk") : t("settings.webdavFail") }}
                </strong>
                <span v-if="!davResult.ok && davResult.error">{{ davResult.error }}</span>
              </div>
            </div>

            <div class="actions">
              <m3e-button variant="tonal" size="small" :disabled="davTesting" @click="testWebDav">
                <span slot="icon" class="material-symbols-outlined">cloud_sync</span>
                {{ davTesting ? t("settings.webdavTesting") : t("settings.webdavTest") }}
              </m3e-button>
              <m3e-button variant="outlined" size="small" @click="router.push('/webdav')">
                <span slot="icon" class="material-symbols-outlined">cloud</span>
                {{ t("settings.webdavOpen") }}
              </m3e-button>
            </div>
          </div>
        </div>
      </m3e-card>

      <!-- 关于 -->
      <m3e-card
        v-if="activeSection === 'settings-about'"
        id="settings-about"
        class="card"
        variant="outlined"
      >
        <div slot="content">
          <h3>{{ t("settings.about") }}</h3>
          <div class="row">
            <span class="row-label">{{ t("settings.version") }}</span>
            <span class="value">{{ APP_VERSION }}</span>
          </div>
          <div class="row">
            <span class="row-label">{{ t("settings.checkUpdate") }}</span>
            <m3e-button
              variant="outlined"
              size="small"
              :disabled="updateState.status === 'checking' || updateState.status === 'downloading'"
              @click="onCheckUpdate"
            >
              {{ t("settings.checkUpdate") }}
            </m3e-button>
          </div>
          <p v-if="updateState.status === 'idle' && !isDesktop" class="hint">
            {{ t("settings.updateNotSupported") }}
          </p>
          <p v-else-if="updateState.status === 'checking'" class="hint">…</p>
          <p v-else-if="updateState.status === 'available'" class="hint">
            {{
              t("settings.updateAvailable").replace("{version}", updateState.info?.version ?? "")
            }}
          </p>
          <p v-else-if="updateState.status === 'downloading'" class="hint">
            {{
              t("settings.updateDownloading").replace(
                "{percent}",
                (updateState.percent ?? 0).toFixed(0),
              )
            }}
          </p>
          <p v-else-if="updateState.status === 'not-available'" class="hint">
            {{ t("settings.updateUpToDate") }}
          </p>
          <div v-else-if="updateState.status === 'downloaded'" class="actions">
            <m3e-button variant="filled" size="small" @click="onInstallUpdate">
              {{ t("settings.updateRestartNow") }}
            </m3e-button>
          </div>
          <p v-else-if="updateState.status === 'error'" class="hint">
            {{ t("settings.updateNotSupported") }}
          </p>
          <p class="hint">{{ t("settings.checkUpdateHint") }}</p>

          <!-- 内存诊断：按进程列出 Electron 各进程的工作集（内存优化的验收工具） -->
          <div class="row">
            <span class="row-label">{{ t("settings.memoryDiagnostics") }}</span>
            <m3e-button
              variant="outlined"
              size="small"
              :disabled="memoryLoading"
              @click="refreshMemory"
            >
              {{ t("settings.memoryRefresh") }}
            </m3e-button>
          </div>
          <p class="hint">{{ t("settings.memoryDiagnosticsHint") }}</p>
          <div v-if="memoryMetrics && memoryMetrics.processes.length" class="mem-table">
            <div class="mem-row mem-head">
              <span>{{ t("settings.memoryProcessType") }}</span>
              <span>{{ t("settings.memoryProcessName") }}</span>
              <span class="tabular-nums">{{ t("settings.memoryWorkingSet") }}</span>
              <span class="tabular-nums">{{ t("settings.memoryPeak") }}</span>
            </div>
            <div v-for="p in memoryMetrics.processes" :key="p.pid" class="mem-row">
              <span>{{ p.type }}</span>
              <span class="mem-name">{{ p.name || p.pid }}</span>
              <span class="tabular-nums">{{ p.workingSetMB }} MB</span>
              <span class="tabular-nums">{{ p.peakMB }} MB</span>
            </div>
            <div class="mem-row mem-total">
              <span></span>
              <span>{{ t("settings.memoryTotal") }}</span>
              <span class="tabular-nums">{{ memoryMetrics.totalMB }} MB</span>
              <span></span>
            </div>
          </div>
          <!-- 内存基准测试（P0）：五组固定口径的自动采样 + 标记 + 导出 -->
          <div class="row">
            <span class="row-label">{{ t("settings.benchTitle") }}</span>
            <m3e-button variant="outlined" size="small" :disabled="benchBusy" @click="benchToggle">
              {{ benchStatus.running ? t("settings.benchStop") : t("settings.benchStart") }}
            </m3e-button>
            <m3e-button
              variant="text"
              size="small"
              :disabled="benchBusy || benchStatus.sampleCount === 0"
              @click="benchMark"
            >
              {{ t("settings.benchMark") }}
            </m3e-button>
            <m3e-button
              variant="outlined"
              size="small"
              :disabled="benchBusy || benchStatus.sampleCount === 0"
              @click="benchExport"
            >
              {{ t("settings.benchExport") }}
            </m3e-button>
          </div>
          <p class="hint">{{ t("settings.benchHint") }}</p>
          <p v-if="benchStatus.sampleCount" class="hint tabular-nums">
            {{ t("settings.benchSamples") }}: {{ benchStatus.sampleCount }} ·
            {{ t("settings.benchMarks") }}: {{ benchStatus.markCount }}
          </p>
          <div v-if="benchSummary && benchSummary.markSummary.length" class="mem-table">
            <div class="mem-row mem-head">
              <span>{{ t("settings.benchStepLabel") }}</span>
              <span class="tabular-nums">{{ t("settings.benchAt") }}</span>
              <span class="tabular-nums">{{ t("settings.memoryWorkingSet") }}</span>
              <span class="tabular-nums">{{ t("settings.benchDelta") }}</span>
            </div>
            <div v-for="(m, i) in benchSummary.markSummary" :key="i" class="mem-row">
              <span class="mem-name">{{ m.label }}</span>
              <span class="tabular-nums">{{ (m.t / 1000).toFixed(1) }}s</span>
              <span class="tabular-nums">{{ m.totalMB }} MB</span>
              <span class="tabular-nums">{{ m.deltaMB >= 0 ? "+" : "" }}{{ m.deltaMB }} MB</span>
            </div>
          </div>
          <p v-if="benchExportPath" class="hint">
            {{ t("settings.benchExported") }}: {{ benchExportPath }}
          </p>
          <SettingRow :label="t('settings.devtools')" setting-key="settings.devtools" clickable>
            <m3e-switch :checked="devtoolsEnabled" @change="toggleDevtools" />
          </SettingRow>
          <p class="hint">{{ t("settings.devtoolsHint") }}</p>
          <div class="actions">
            <m3e-button variant="outlined" size="small" @click="clearCache">
              <span slot="icon" class="material-symbols-outlined">cleaning_services</span>
              {{ t("settings.clearCache") }}
            </m3e-button>
          </div>
        </div>
      </m3e-card>
    </div>

    <transition name="toast">
      <div v-if="toast" class="toast">{{ toast }}</div>
    </transition>
  </div>
</template>

<style scoped>
/* 内存诊断表：4 列（类型 / 进程 / 工作集 / 峰值），等宽数字便于纵向比较 */
.mem-table {
  display: flex;
  flex-direction: column;
  gap: 2px;
  margin: 6px 0 2px;
  font-size: var(--md-sys-typescale-body-small-size, 12px);
}
.mem-row {
  display: grid;
  grid-template-columns: 64px minmax(0, 1fr) 84px 84px;
  gap: 8px;
  align-items: center;
  padding: 3px 0;
}
.mem-head,
.mem-total {
  color: var(--md-sys-color-on-surface-variant);
}
.mem-total {
  border-top: 1px solid var(--md-sys-color-outline-variant);
  padding-top: 5px;
  font-weight: 500;
}
.mem-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/*
 * 布局：**两栏各自滚动，整页不滚**。
 *
 * 改版前这里是「整页一个滚动容器 + 左栏 sticky 自己再套一个滚动条」——
 * 于是同一个页面里出现两个嵌套的 overflow 容器，鼠标落在哪边就滚哪边
 * （左栏滚列表、右侧滚整页），而且左栏那个 `max-height: calc(100vh - 120px)`
 * 没算底部 72px 的固定迷你播放条，最后几个分类被压在播放条底下滚不出来。
 *
 * 现在改成：`.settings-view` 自己不滚（height:100% + overflow:hidden），
 * 左栏与右栏各占一个 grid 行、各自 overflow-y —— 两个滚动容器**平级**，
 * 不再嵌套，也就不会互相带动。
 */
.settings-view {
  display: grid;
  grid-template-columns: 168px minmax(0, 1fr);
  grid-template-rows: auto minmax(0, 1fr);
  /* 必须是 stretch（默认）：左栏/右栏要撑满第 2 行，才能各自成为等高滚动容器。
     旧布局是 sticky + start 对齐，那套在「两栏各自滚动」下不再成立。 */
  align-items: stretch;
  gap: 0 20px;
  /* 由 .settings-page .main-content（flex column）拉伸到确定高度 */
  flex: 1;
  min-height: 0;
  /* ⚠️ width:100% 不能删。父级 .main-content 是 flex 容器时，下面的
     margin:0 auto 是「自动外边距」——它会吞掉交叉轴剩余空间，使本元素
     不再被 stretch 拉伸，宽度退化成 fit-content（卡片宽度随内容长短乱跳、
     右侧空一大片）。显式 width:100% 让宽度先撑满、再由 max-width 封顶、
     最后靠 margin:auto 居中。 */
  width: 100%;
  /* 原本 1040px 且右栏封顶 800px：窗口一拉宽，卡片就不再变宽，
     右侧空出一大片。这里放宽上限，并把右栏改成 1fr 吃满剩余宽度。 */
  max-width: 1180px;
  margin: 0 auto;
  overflow: hidden;
}
/* PageHeader 的根类名是 .page-head（不是 .page-header）——
   之前写错导致标题没占满整行、被挤进 180px 左栏，整页错位。 */
.settings-view :deep(.page-head) {
  grid-column: 1 / -1;
  grid-row: 1;
}
.settings-nav {
  grid-column: 1;
  grid-row: 2;
  /* 不再是 sticky：本层就是滚动容器，自己占满右栏高度。
     （sticky + max-height 那套是「整页滚动」时代的下策，见 .settings-view 注释） */
  height: 100%;
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: 1px;
  padding: 2px 0 8px;
  overflow-y: auto;
  overscroll-behavior: contain;
  scrollbar-width: thin;
}

/* 右栏：唯一的内容滚动容器，与左栏平级 */
.settings-body {
  grid-column: 2;
  grid-row: 2;
  height: 100%;
  min-height: 0;
  overflow-y: auto;
  overscroll-behavior: contain;
  scrollbar-gutter: stable;
  padding-bottom: 40px;
}
/* ---- 设置搜索 ---- */
.settings-search {
  position: relative;
  display: flex;
  align-items: center;
  margin-bottom: 8px;
}
.settings-search-icon {
  position: absolute;
  left: 10px;
  font-size: 18px;
  color: var(--md-sys-color-on-surface-variant);
  pointer-events: none;
}
.settings-search input {
  width: 100%;
  height: 36px;
  padding: 0 10px 0 34px;
  border: 1px solid var(--md-sys-color-outline-variant);
  border-radius: var(--md-sys-shape-corner-full);
  background: var(--md-sys-color-surface-container-low);
  color: var(--md-sys-color-on-surface);
  font: inherit;
  font-size: var(--md-sys-typescale-body-small-size);
  outline: none;
}
.settings-search input:focus {
  border-color: var(--md-sys-color-primary);
}
.settings-hits {
  display: flex;
  flex-direction: column;
  gap: 1px;
  overflow-y: auto;
  /* 搜索结果也挂在左栏里；不设上限时它会顶掉下方的分类列表，
     并让左栏出现「搜索命中 + 分类」两个滚不完的区块。 */
  max-height: 46vh;
  overscroll-behavior: contain;
}
.settings-hit {
  display: flex;
  flex-direction: column;
  gap: 1px;
  padding: 7px 10px;
  border: none;
  border-radius: var(--md-sys-shape-corner-small);
  background: transparent;
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
}
.settings-hit:hover {
  background: var(--md-sys-color-surface-container-high);
}
.settings-hit-label {
  font-size: var(--md-sys-typescale-body-small-size);
}
.settings-hit-where {
  font-size: 11px;
  color: var(--md-sys-color-on-surface-variant);
}
.settings-hit-empty {
  margin: 4px 0;
  padding: 0 10px;
  font-size: var(--md-sys-typescale-body-small-size);
  color: var(--md-sys-color-on-surface-variant);
}
/*
 * 跳转后的闪烁高亮。
 * 用 :deep() 是因为目标行可能来自 SettingRow 子组件（scoped 不穿透），
 * 也可能仍是本文件里的裸行 —— 两种都要能高亮。
 */
.settings-view :deep([data-setting].setting-flash) {
  animation: setting-flash 1.6s ease-out;
  border-radius: var(--md-sys-shape-corner-small);
}
@keyframes setting-flash {
  0%,
  60% {
    background: var(--md-sys-color-primary-container);
  }
  100% {
    background: transparent;
  }
}

.settings-nav-group {
  padding: 6px 0 2px;
  color: var(--md-sys-color-on-surface-variant);
  font-size: 12px;
  font-weight: 500;
  letter-spacing: 0.4px;
  opacity: 0.8;
}
/* 导航项交给 m3e-nav-menu；这里只把默认 56dp 的行高压回原来的紧凑尺寸 */
.settings-nav m3e-nav-menu {
  width: 100%;
  --m3e-nav-menu-padding-top: 0;
  --m3e-nav-menu-padding-bottom: 0;
  --m3e-nav-menu-padding-left: 0;
  --m3e-nav-menu-padding-right: 0;
  --m3e-nav-menu-item-height: 32px;
  --m3e-nav-menu-item-padding: 12px;
  --m3e-nav-menu-item-spacing: 8px;
  --m3e-nav-menu-item-icon-size: 20px;
  --m3e-nav-menu-item-group-label-inset: 12px;
  --m3e-nav-menu-item-group-label-space: 0px;
}
.settings-nav-label {
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.card {
  /* 注意：卡片现在挂在 .settings-body 里，不再是 .settings-view 的 grid 子项，
     所以这里**不能**再写 grid-column: 2（写了也没用，且会误导）。
     右栏宽度由 .settings-body 的 1fr 决定。 */
  scroll-margin-top: 18px;
  margin-bottom: 16px;
  animation: lm-rise 340ms var(--md-sys-motion-spring-spatial) both;
  /* 底色 / 圆角 / 描边改由 m3e-card（variant=outlined）提供，内边距走组件的 content 槽令牌 */
  --m3e-card-padding: 20px;
  --m3e-card-shape: var(--lm-shape-card);
  --m3e-outlined-card-container-color: var(--md-sys-color-surface-container-low);
  --m3e-outlined-card-outline-color: var(--lm-hairline);
}
.card h3 {
  margin-bottom: 6px;
  font-size: var(--md-sys-typescale-title-medium-size);
  font-weight: var(--md-sys-typescale-title-medium-weight);
}

.token-line {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
/* 输入框外框 / 焦点态由 m3e-form-field 提供（组件会 unset 掉 slot 内 input 的边框与底色），
   这里只留弹性布局，避免手写边框套在 M3 填充容器里变成双层框 */
.token-line input {
  flex: 1;
  min-width: 220px;
}

/* 表单字段宽度跟随容器（组件默认固定 270px） */
.field {
  --m3e-form-field-width: 100%;
  width: 100%;
}
.token-line .material-symbols-outlined {
  font-size: 18px;
}
.token-state {
  margin: 6px 0 0;
  font-size: var(--md-sys-typescale-body-small-size);
}
.token-state.ok {
  color: var(--md-sys-color-primary);
}
.token-state.err {
  color: var(--md-sys-color-error);
}
.link-inline {
  border: none;
  background: transparent;
  color: var(--md-sys-color-primary);
  font-family: inherit;
  font-size: inherit;
  text-decoration: underline;
  cursor: pointer;
  padding: 0;
}
.hint {
  margin-bottom: 16px;
  font-size: var(--md-sys-typescale-body-small-size);
  line-height: 1.6;
  color: var(--md-sys-color-on-surface-variant);
}

.row {
  display: flex;
  align-items: center;
  gap: 14px;
  min-height: 48px;
}
.row-label {
  flex: 1;
  font-size: var(--md-sys-typescale-body-medium-size);
}
.row m3e-slider {
  flex: 2;
  min-width: 0;
  --m3e-slider-min-width: 0px;
}
.value {
  min-width: 52px;
  text-align: right;
  font-size: var(--md-sys-typescale-body-small-size);
  color: var(--md-sys-color-on-surface-variant);
}

/* AutoMix 调试提示：等宽字体，提示这是给控制台用的 */
.debug-hint {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  opacity: 0.8;
}

/* ---- 空降助手：分类勾选 ---- */
.sponsor-cats-label {
  margin-top: 12px;
}
.sponsor-cats {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin: 8px 0 4px;
}
.sponsor-cats .chip {
  --m3e-chip-container-height: 32px;
}
/* 分类色点：与进度条上的刻痕同色，方便用户对上号 */
.sponsor-cats .dot {
  display: inline-block;
  width: 8px;
  height: 8px;
  margin-right: 6px;
  border-radius: 50%;
  vertical-align: middle;
}

/* 开关改用 @m3e/web 的 m3e-switch（视觉令牌见 tokens/theme.css），此处只管点击区域 */
.switch-row {
  cursor: pointer;
}
.switch-row m3e-switch {
  flex: none;
}

/* 配色方案色板 */
.swatches {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  justify-content: flex-end;
}
.swatch {
  position: relative;
  display: grid;
  place-items: center;
  width: 30px;
  height: 30px;
  padding: 0;
  border: none;
  border-radius: 50%;
  background: var(--sw, var(--md-sys-color-primary));
  color: #fff;
  cursor: pointer;
  box-shadow: inset 0 0 0 1px rgba(0, 0, 0, 0.12);
  transition:
    transform 160ms var(--md-sys-motion-spring),
    box-shadow 160ms var(--md-sys-motion-spring-effects-fast);
}
.swatch:hover {
  transform: scale(1.12);
}
.swatch:active {
  transform: scale(0.94);
}
.swatch .material-symbols-outlined {
  font-size: 18px;
  opacity: 0;
  transform: scale(0.4);
  text-shadow: 0 1px 2px rgba(0, 0, 0, 0.35);
  transition:
    opacity 160ms var(--md-sys-motion-spring-effects-fast),
    transform 160ms var(--md-sys-motion-spring);
}
.swatch.active {
  box-shadow:
    0 0 0 2px var(--md-sys-color-surface),
    0 0 0 4px var(--sw, var(--md-sys-color-primary));
}
.swatch.active .material-symbols-outlined {
  opacity: 1;
  transform: scale(1);
}
/* 自定义色：原生取色器铺满圆点但透明，仅保留点击唤起 */
.swatch.custom .material-symbols-outlined {
  opacity: 1;
  transform: scale(1);
}
.swatch.custom input[type="color"] {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  padding: 0;
  border: none;
  opacity: 0;
  cursor: pointer;
}
/* 种子色被皮肤门控时整组置灰 */
.swatches.disabled {
  opacity: 0.4;
  pointer-events: none;
}

.dir-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-bottom: 12px;
}
.dir-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 8px 8px 12px;
  background: var(--md-sys-color-surface-container-high);
  border-radius: var(--md-sys-shape-corner-medium);
}
.dir-item > .material-symbols-outlined {
  font-size: 19px;
  color: var(--md-sys-color-on-surface-variant);
}
.dir-item.override {
  margin-bottom: 12px;
}
.dir-path {
  flex: 1;
  min-width: 0;
  font-size: var(--md-sys-typescale-body-small-size);
  font-family: ui-monospace, "Cascadia Code", Consolas, monospace;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  direction: rtl;
  text-align: left;
}
/* 30×30 的尺寸与 17px 图标由全局 .lm-icon-btn-sm 提供 */
m3e-icon-button.danger:hover {
  --m3e-standard-icon-button-hover-state-layer-color: var(--md-sys-color-error-container);
  --m3e-standard-icon-button-hover-icon-color: var(--md-sys-color-error);
}

.notice {
  padding: 12px 14px;
  margin-bottom: 12px;
  font-size: var(--md-sys-typescale-body-small-size);
  color: var(--md-sys-color-on-surface-variant);
  background: var(--md-sys-color-surface-container-high);
  border-radius: var(--md-sys-shape-corner-medium);
}

.status {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  padding: 14px 16px;
  margin-bottom: 12px;
  border-radius: var(--md-sys-shape-corner-medium);
}
.status.ok {
  background: color-mix(in srgb, var(--md-sys-color-primary) 12%, transparent);
  color: var(--md-sys-color-on-surface);
}
.status.warn {
  background: var(--md-sys-color-error-container);
  color: var(--md-sys-color-on-error-container);
}
.status > .material-symbols-outlined {
  font-size: 22px;
}
.status-text {
  display: flex;
  flex-direction: column;
  gap: 3px;
  min-width: 0;
  font-size: var(--md-sys-typescale-body-small-size);
}
.status-text .mono {
  font-family: ui-monospace, "Cascadia Code", Consolas, monospace;
  word-break: break-all;
  opacity: 0.85;
}
.status-text .version,
.status-text .source {
  opacity: 0.7;
}

.actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 4px;
}
.actions .material-symbols-outlined {
  font-size: 18px;
}

.presets {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 12px;
}
/* 放在 .row 里的选择芯片：去掉上边距，与标签对齐 */
.presets.inline {
  margin-top: 0;
}

.toast {
  position: fixed;
  left: 50%;
  bottom: 90px;
  transform: translateX(-50%);
  padding: 12px 20px;
  border-radius: var(--md-sys-shape-corner-small);
  background: var(--md-sys-color-inverse-surface);
  color: var(--md-sys-color-inverse-on-surface);
  box-shadow: var(--md-elevation-3);
  font-size: var(--md-sys-typescale-body-medium-size);
  z-index: 100;
}
.toast-enter-active,
.toast-leave-active {
  transition: all 240ms var(--md-sys-motion-spring-spatial);
}
.toast-enter-from,
.toast-leave-to {
  opacity: 0;
  transform: translate(-50%, 12px);
}

@media (max-width: 760px) {
  /*
   * 窄屏：两栏并排已经不成立，退回**单一滚动容器**（.settings-view 自己）。
   * 不能只写 display:block —— 那样 nav / body 的 height:100% 会各自撑满，
   * 两层叠起来又被外层 overflow:hidden 裁掉，底部内容直接消失。
   */
  .settings-view {
    display: block;
    max-width: 760px;
    overflow-y: auto;
    overscroll-behavior: contain;
  }
  .settings-nav {
    height: auto;
    overflow: visible;
    margin-bottom: 12px;
    padding: 0 0 4px;
  }
  .settings-body {
    height: auto;
    overflow: visible;
    padding-bottom: 0;
  }
  /* 窄屏把纵向导航菜单摊平成横向可滚动的胶囊行 */
  .settings-nav m3e-nav-menu {
    display: flex;
    flex-direction: row;
    gap: 6px;
    overflow-x: auto;
    overflow-y: hidden;
  }
  .settings-nav-group {
    display: none;
  }
  .card {
    scroll-margin-top: 12px;
  }
}
/* chip 本体交给 m3e-filter-chip / m3e-assist-chip（选中态即 M3 规范：secondary-container 底 +
   on-secondary-container 文字 + 无描边，与改造前 .chip.active 一致）；
   下面把度量对齐改造前的 .chip（含选中时组件会占用 icon 槽展示勾选标记所需的 with-icon 内边距） */
.presets m3e-filter-chip {
  --m3e-chip-container-height: 32px;
  --m3e-chip-padding-start: 14px;
  --m3e-chip-padding-end: 14px;
  --m3e-chip-with-icon-padding-start: 14px;
  --m3e-chip-with-icon-padding-end: 14px;
  --m3e-chip-unselected-state-layer-hover-color: var(--md-sys-color-surface-container-high);
}
.presets.inline m3e-filter-chip {
  --m3e-chip-container-height: 30px;
  --m3e-chip-padding-start: 12px;
  --m3e-chip-padding-end: 12px;
  --m3e-chip-with-icon-padding-start: 12px;
  --m3e-chip-with-icon-padding-end: 12px;
}
</style>
