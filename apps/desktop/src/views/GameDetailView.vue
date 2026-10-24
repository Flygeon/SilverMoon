<script setup lang="ts">
/**
 * 游戏详情（游戏 → 点卡片 → 独立路由 /games/:appId）。
 *
 * ⚠️ 根节点内联了 `--lm-game-hero-vt` 等 CSS 变量（见模板第一行），
 * 用来承接 hero 的 `view-transition-name` 与补间时长 —— 详见
 * utils/gameHeroTransition.ts 的长注释。
 *
 * 排版参考 Steam 桌面版详情页，配色与形状全部走 MD3：
 * hero 大图（商店背景图 + 渐变遮罩）→ 操作栏 → 左主栏（简介 / 截图墙）
 * + 右栏（额外内容 → 成就 → 信息）。
 *
 * **成就挪到右栏**是照 Steam 的实际布局：左栏留给长篇正文（简介 / 截图），
 * 右栏放「一眼扫完」的速览信息。成就在右栏只出图标墙 + 进度，不铺长列表 ——
 * 逐条成就明细点「查看我的成就」去 Steam 社区看。
 *
 * 链路：本视图 → stores/steam.ts 的 openDetail() → capabilities.steam({op:"gameDetail"})
 *       → 宿主一次返回 { details, local, achievements }，**本页只发这一个请求**；
 *       DLC 名单拿不到名字时再补一次 appDetails 批量请求（见 loadDlc）。
 *
 * 约定（与 GamesView 一致）：
 * - 颜色只用 M3 令牌，不写死 Steam 的深蓝 / 绿色；
 * - 图标一律 Material Symbols Rounded，不用 emoji；
 * - 图片 URL **原样使用**（Steam 的图带 ?t=<时间戳> 查询串，截掉就 404），
 *   加载失败用 onerror 降级成占位，绝不留破图；
 * - 所有请求都有骨架 / 错误条 + 重试，不允许静默失败。
 */
import { computed, nextTick, onMounted, ref, watch } from "vue";
import { useRouter } from "vue-router";
import { useSettingsStore } from "@/stores/settings";
import { useSteamStore } from "@/stores/steam";
import { formatSize } from "@/utils/format";
import { capabilities } from "@/capabilities";
import {
  GAME_HERO_VT_NAME,
  activeCoverAppId,
  activeCoverUrl,
  endCoverFlight,
  runViewTransition,
} from "@/utils/gameHeroTransition";
import { translate } from "@shared/i18n";
import type { SteamAchievement } from "@shared/types";

const props = defineProps<{
  /** 路由参数（/games/:appId）；从 URL 进来时是字符串 */
  appId: string;
}>();

const router = useRouter();
const settings = useSettingsStore();
const steam = useSteamStore();
const t = (key: string) => translate(settings.lang, key);

/** 校验过的 appId；非法时为 NaN（界面直接出错误态，不发请求） */
const numericAppId = computed(() => {
  const n = Number(props.appId);
  return Number.isInteger(n) && n > 0 ? n : Number.NaN;
});

const invalidAppId = computed(() => Number.isNaN(numericAppId.value));

/** 操作栏按钮的忙碌态（启动 / 安装是异步的，防连点） */
const actionBusy = ref(false);
/** 操作结果提示（一句话，几秒后自动消失） */
const toast = ref("");
let toastTimer: number | null = null;

function notify(message: string): void {
  toast.value = message;
  if (toastTimer) window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => (toast.value = ""), 3200);
}

/**
 * 加载失败的图片集合（URL → true）。
 *
 * 只在 onerror 里写入：Steam 的图带 `?t=<时间戳>` 查询串，同一张图不同批次
 * 时间戳可能不同，所以按**完整 URL**做 key，不做归一化。
 */
const brokenImages = ref<Record<string, boolean>>({});

function markBroken(url: string | null | undefined): void {
  if (!url) return;
  brokenImages.value = { ...brokenImages.value, [url]: true };
}

function isBroken(url: string | null | undefined): boolean {
  return !!url && !!brokenImages.value[url];
}

// ---------------------------------------------------------------- 数据
const detail = computed(() => steam.detail);
const appDetails = computed(() => detail.value?.details ?? null);
const local = computed(() => detail.value?.local ?? null);
const achievements = computed(() => detail.value?.achievements ?? null);

/** 本地库里的安装信息（详情请求还没回来时先用缓存判断，操作栏不至于空着） */
const installed = computed(() => {
  if (local.value) return local.value;
  const id = numericAppId.value;
  if (Number.isNaN(id)) return null;
  return steam.installedOf(id);
});

const isInstalled = computed(() => !!installed.value);

/**
 * hero 大图。
 *
 * ## 必须是**卡片那张图**（用户明确指出）
 *
 * 卡片显示的是 Steam 的 `header.jpg`（`headerUrl`）。hero 若用商店的
 * `backgroundImage`（1920×620 的商店页大背景），两张图**内容不同** ——
 * View Transition 补间时会出现明显的「换图」跳变，看起来像动画做坏了。
 *
 * 所以优先级改为：**商店 headerImage → 网格传来的 headerUrl → backgroundImage**。
 * 前两者其实是同一张 `header.jpg`（商店接口与 CDN 拼法不同但内容一致），
 * 保证「卡片飞过来的时候，hero 上就是同一张图」。
 *
 * `backgroundImage` 退到最后仅作兜底（极少数 app 没有 header 时）。
 *
 * 任何一项都**原样使用**商店/CDN 给的 URL，不自己拼路径 ——
 * 上一版拼的 `/steam/apps/<id>/ss_1.jpg` 全部 404，正是「图片不正常」的根因。
 */
/** 网格卡片传过来的那张图（同一次过渡内有效，见 gameHeroTransition） */
const coverFromGrid = computed<string>(() => {
  const url = activeCoverUrl.value;
  return typeof url === "string" ? url : "";
});

const heroImage = computed<string>(() => {
  const fromStore = appDetails.value?.headerImage ?? "";
  // 商店数据还没回来时，先用网格里那张卡的 header 图 —— 这样补间一开始就有图，
  // 不会先补到空位再「弹」出图片。
  const fromGrid = coverFromGrid.value;
  const background = appDetails.value?.backgroundImage ?? "";
  return fromStore || fromGrid || background;
});

/** 标题：商店名 → 本地库名 → 兜底文案（未安装且商店拉不到时至少不空着） */
const title = computed(
  () => appDetails.value?.name || installed.value?.name || t("games.detail.title"),
);

const screenshots = computed<string[]>(() => appDetails.value?.screenshots ?? []);

/** 成就进度百分比（0~100，整数） */
const achievementPercent = computed(() => {
  const a = achievements.value;
  if (!a || !a.total) return 0;
  return Math.round((a.unlocked / a.total) * 100);
});

/** 成就区块只在「有成就系统」且确实有数据时出现 */
const showAchievements = computed(() => {
  const a = achievements.value;
  return !!a && a.available && a.achievements.length > 0;
});

/** 已解锁的成就（图标墙只展示它们；未解锁的按需求不显示图标） */
const unlockedAchievements = computed<SteamAchievement[]>(() =>
  (achievements.value?.achievements ?? []).filter((a) => a.unlocked),
);

/**
 * 图标墙**总共**铺几个格子（含 +N 那个）。
 *
 * 右栏宽 340px、内边距 16×2 → 可用约 308px。格子 52px + 间距 8px，
 * 5 格 = 5×52 + 4×8 = 292px，刚好一行；6 格会挤到第二行（右栏本来就窄，
 * 两行图标会把「信息」区块顶下去）。
 *
 * 所以这里按「**总格子数**」算，而不是「前 N 个已解锁 + 可能的 +N」——
 * 后者在 6 个以上已解锁时会多出一格。
 */
const ICON_WALL_TOTAL = 5;

/** 有溢出时留一格给 +N，否则全部给已解锁图标 */
const iconWallLimit = computed(() => {
  const unlocked = unlockedAchievements.value.length;
  return unlocked > ICON_WALL_TOTAL ? ICON_WALL_TOTAL - 1 : unlocked;
});

/** 图标墙上实际展示的已解锁成就 */
const iconWall = computed(() => unlockedAchievements.value.slice(0, iconWallLimit.value));
/** 收进 +N 的已解锁数（0 = 不显示 +N 方块） */
const iconOverflow = computed(() =>
  Math.max(0, unlockedAchievements.value.length - iconWallLimit.value),
);

/** 未解锁数（「锁定的成就」那行的计数） */
const lockedCount = computed(() => {
  const a = achievements.value;
  if (!a) return 0;
  return Math.max(0, a.total - a.unlocked);
});

// ---------------------------------------------------------------- 额外内容（DLC）
//
// 契约只给 dlc 的 appid 列表，名字与缩略图要再查一次 appDetails。
// 这里**按需**拉：详情回来后才发，且只在真的有 dlc 时才发 —— 没有 DLC 的游戏
// 不该为这个区块多打一次商店接口。

/** DLC 卡片数据（名字 + 缩略图都拿到才有意义） */
interface DlcCard {
  appId: number;
  name: string;
  image: string;
}

/** DLC 列表（按商店给的顺序；商店的顺序是有意义的，不要重排） */
const dlcCards = ref<DlcCard[]>([]);
/**
 * 商店给的 DLC **总数**（≠ dlcCards.length）。
 *
 * 只预取前几个的元信息，卡片数必然 ≤ 预取数，用卡片数算溢出会得到 0 ——
 * +N 就永远不出现。所以总数单独存，溢出数按 总数 − 可见行数 算。
 */
const dlcTotalCount = ref(0);
const dlcLoading = ref(false);
/** DLC 元信息是否拉过（按 appId 记，换游戏要重拉） */
let dlcLoadedFor = 0;

/**
 * 「额外内容」最多列几行（含 +N 那一行）。
 *
 * 与图标墙同理按**总行数**算：右栏是纵向列表，多一行就多占 60px，
 * 会把下面的成就与信息顶下去。需求是「最多 5 个 + N」，这里取 5 行封顶，
 * 有溢出时第 5 行是 +N、只列 4 个卡片。
 */
const DLC_MAX_TOTAL = 5;

/** 实际列出的卡片行数（有溢出时让一格给 +N） */
const dlcLimit = computed(() =>
  dlcCards.value.length > DLC_MAX_TOTAL ? DLC_MAX_TOTAL - 1 : dlcCards.value.length,
);
const visibleDlc = computed(() => dlcCards.value.slice(0, dlcLimit.value));
/**
 * 收进 +N 的数量。
 *
 * 用总数减可见行数，而不是卡片数减可见行数：卡片只预取了前几个，
 * 后面那些「没查到元信息」的 DLC 也属于「还有更多」，必须计入 +N。
 */
const dlcOverflow = computed(() => Math.max(0, dlcTotalCount.value - dlcLimit.value));

/** 有 DLC 才显示整块（没有就整块不渲染，不留「敬请期待」占位） */
const showExtra = computed(() => dlcCards.value.length > 0);

/**
 * 拉 DLC 的名字与缩略图。
 *
 * ## 为什么只查前几个
 *
 * 商店接口一次批量 appids 有长度上限，而 DLC 动辄几十个 —— 全查既慢又可能被截断。
 * 所以只查「可见的那几行」。
 *
 * ## 为什么溢出数要单独记
 *
 * 这里必须区分「查到的卡片数」与「DLC 总数」：只查了 5 个，第 6 个及以后拿不到
 * 元信息会被跳过，若用 `cards.length` 去算 +N，溢出数永远是 0（+N 方块不出现，
 * 用户就看不到「还有更多」这件事）。因此总数按**商店给的 dlc 名单**记，
 * 与查到的卡片分开存。
 */
async function loadDlc(ids: number[]): Promise<void> {
  const appId = numericAppId.value;
  if (Number.isNaN(appId)) return;
  const wanted = ids.filter((n) => Number.isFinite(n) && n > 0);
  if (!wanted.length) {
    dlcCards.value = [];
    dlcTotalCount.value = 0;
    return;
  }
  dlcLoading.value = true;
  dlcLoadedFor = appId;
  try {
    // 多查一个：第 6 个用来确认「确实还有更多」，不必把几十个全查一遍
    const prefetch = wanted.slice(0, DLC_MAX_TOTAL + 1);
    const map = await steam.fetchDetailsBatch(prefetch);
    const cards: DlcCard[] = [];
    for (const id of prefetch) {
      const meta = map[String(id)];
      // 名字拿不到的条目直接跳过：宁可少一张卡片，也不要一张没有名字的空卡
      if (!meta?.name) continue;
      cards.push({
        appId: id,
        name: meta.name,
        image: meta.headerImage || meta.capsuleImage || "",
      });
    }
    // 请求期间用户可能已经切到别的游戏，别把上一款的 DLC 写进来
    if (dlcLoadedFor === appId) {
      dlcCards.value = cards;
      dlcTotalCount.value = wanted.length;
    }
  } finally {
    dlcLoading.value = false;
  }
}

/**
 * 点 DLC 卡片 → 打开该 DLC 的**商店页**。
 *
 * 用 `openInSteam`（steam://install/<id>）而不是 `launchGame`：DLC 的「安装」
 * 在 Steam 里就是「打开商店页/加入库」，没有独立的启动语义；若 Steam 未安装
 * （steam:// 无关联）再退到系统浏览器打开网页商店，避免两个都静默失败。
 */
async function openDlc(id: number): Promise<void> {
  const res = await steam.install(id);
  if (res.ok) return;
  try {
    await capabilities.openUrl("https://store.steampowered.com/app/" + id + "/");
  } catch {
    notify(res.message || t("games.detail.actionFailed"));
  }
}

/** 查看我的成就：打开 Steam 社区该游戏的成就页（需登录，浏览器里也能看） */
async function viewAllAchievements(): Promise<void> {
  const id = numericAppId.value;
  if (Number.isNaN(id)) return;
  const steamId = steam.status.steamId;
  const url = steamId
    ? "https://steamcommunity.com/profiles/" + steamId + "/stats/" + id + "/achievements/"
    : "https://steamcommunity.com/stats/" + id + "/achievements/";
  try {
    await capabilities.openUrl(url);
  } catch {
    notify(t("games.detail.actionFailed"));
  }
}

// ---------------------------------------------------------------- 格式化
function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/** 分钟 → 总时长文案（与 GamesView 的 hoursText 同规则，避免两页说法不一致） */
function hoursText(minutes?: number | null): string {
  const m = minutes ?? 0;
  if (m <= 0) return t("games.playtimeNone");
  const hours = m / 60;
  if (hours < 1) return t("games.minutes").replace("{n}", String(Math.max(1, Math.round(m))));
  const text = hours >= 10 ? String(Math.round(hours)) : hours.toFixed(1).replace(/\.0$/, "");
  return t("games.playtimeTotal").replace("{n}", text);
}

/** 毫秒时间戳 → 相对时间（最近运行 / 成就解锁时间） */
function relativeTime(ms?: number | null): string {
  if (!ms) return "";
  const diff = Date.now() - ms;
  if (diff < 0) return t("games.justNow");
  const min = Math.floor(diff / 60_000);
  if (min < 1) return t("games.justNow");
  if (min < 60) return t("games.minutesAgo").replace("{n}", String(min));
  const hour = Math.floor(min / 60);
  if (hour < 24) return t("games.hoursAgo").replace("{n}", String(hour));
  const day = Math.floor(hour / 24);
  if (day < 30) return t("games.daysAgo").replace("{n}", String(day));
  const d = new Date(ms);
  return d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate());
}

/** 字节 → 人类可读（走公共 formatSize，不在这里另写一套单位） */
function sizeText(bytes?: number | null): string {
  if (!bytes || bytes <= 0) return "—";
  return formatSize(bytes);
}

/** 我的游玩时长：详情契约里没有时长，从 WebAPI 游戏库那条链路取 */
const playtime = computed<string>(() => {
  const id = numericAppId.value;
  if (Number.isNaN(id)) return "";
  const g = steam.games.find((x) => x.appId === id);
  return g ? hoursText(g.playtimeMinutes) : "";
});

const lastPlayed = computed<string>(() => {
  const at = installed.value?.lastPlayedAt ?? null;
  return at ? relativeTime(at) : "";
});

/** 价格：isFree 优先，其次宿主已格式化的 priceText */
const priceText = computed<string>(() => {
  const d = appDetails.value;
  if (!d) return "—";
  if (d.isFree) return t("games.free");
  return d.priceText || "—";
});

// ---------------------------------------------------------------- 动作
/**
 * 返回：走 View Transition 反放（与进入时同一条补间，方向相反）。
 *
 * 必须复用 `runViewTransition` 而不是自己调 `startViewTransition`：
 * 那个工具里做了两件这里不能省的事 —— ①给 <html> 挂 `lm-vt-running`
 * 把路由页自身的入场位移压平（否则返回时「整页滑入」会和「封面飞回」叠成斜线）；
 * ②导航后等目标页真正挂载再让浏览器拍新快照（否则拍到空网格，补间不成立）。
 *
 * 兜底：不支持 / 用户要求减少动效时，工具内部直接退化成普通导航。
 */
async function goBack(): Promise<void> {
  const id = numericAppId.value;
  /*
   * 返回时也要让网格里**这张**卡片挂上过渡名，否则「新快照」里没有同名元素，
   * 浏览器只会把 hero 淡出、不会飞回卡片位置。
   *
   * 网格页被 keep-alive 缓存着、DOM 还在，所以写 activeCoverAppId 会立刻反映到
   * 那张卡上；但要等 nextTick 让它真正写进 DOM —— 与进入时同理，不等的话
   * 新快照拍到的还是「没名字」的封面，返回就没有飞回动画。
   */
  if (!Number.isNaN(id)) {
    // 反向也把「这张卡片该显示哪张图」交还网格，确保飞回时两端是同一张图
    activeCoverAppId.value = id;
    // 一帧内同步收尾，不是等网络 —— 不会造成返回卡顿
    await nextTick();
  }
  const navigate = () => {
    // 有历史就退一步；直接进详情（无历史）时回游戏列表，避免退到空页
    if (window.history.length > 1) router.back();
    else void router.push("/games");
  };
  await runViewTransition({
    // ⚠️ 不再等 ".games-view"：等它出现会让返回整个卡住半秒。
    // 网格页被 keep-alive 缓存，DOM 一直存在，导航完成即可拍快照。
    navigate,
    cleanup: endCoverFlight,
  });
}

/** 主按钮：已安装 → 启动游戏；未安装 → 唤起 Steam 客户端去安装 */
async function primaryAction(): Promise<void> {
  const id = numericAppId.value;
  if (Number.isNaN(id) || actionBusy.value) return;
  actionBusy.value = true;
  try {
    const res = isInstalled.value ? await steam.launch(id) : await steam.install(id);
    if (!res.ok) notify(res.message || t("games.detail.actionFailed"));
    else if (res.message) notify(res.message);
  } finally {
    actionBusy.value = false;
  }
}

/** 在 Steam 客户端里打开该游戏（操作栏右侧图标按钮） */
async function openInSteam(): Promise<void> {
  const id = numericAppId.value;
  if (Number.isNaN(id)) return;
  const res = await steam.install(id);
  if (!res.ok) notify(res.message || t("games.detail.actionFailed"));
}

/** 复制文本：优先 navigator.clipboard，失败给明确提示而不是静默 */
async function copyText(text: string): Promise<void> {
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
    notify(t("games.detail.copied"));
  } catch {
    notify(t("games.detail.copyFailed"));
  }
}

/** 安装路径（可点复制）：库目录 + steamapps/common + 安装目录名 */
const installPath = computed<string>(() => {
  const g = installed.value;
  if (!g) return "";
  if (!g.installDir) return g.libraryPath;
  const sep = g.libraryPath.includes("\\") ? "\\" : "/";
  return [g.libraryPath, "steamapps", "common", g.installDir].join(sep);
});

/** 重试：详情 + 本地库一起重来（本地库失败也会让操作栏判错） */
async function retry(): Promise<void> {
  const id = numericAppId.value;
  if (Number.isNaN(id)) return;
  steam.clearDetail();
  dlcCards.value = [];
  dlcTotalCount.value = 0;
  dlcLoadedFor = 0;
  await Promise.all([steam.openDetail(id), steam.loadLocalLibrary()]);
}

// ---------------------------------------------------------------- 生命周期
async function bootstrap(): Promise<void> {
  const id = numericAppId.value;
  if (Number.isNaN(id)) return;
  // 本地库是「整机一份」，与 appId 无关，拉过就不再重复拉
  const jobs: Promise<unknown>[] = [steam.openDetail(id)];
  if (!steam.localLibrary) jobs.push(steam.loadLocalLibrary());
  await Promise.all(jobs);
}

// 详情回来后按需补 DLC 元信息：详情里给了 dlc 才发，否则这个区块根本不出现
watch(
  () => appDetails.value?.dlc,
  (ids) => {
    const appId = numericAppId.value;
    if (Number.isNaN(appId)) return;
    if (!ids?.length) {
      dlcCards.value = [];
      dlcTotalCount.value = 0;
      return;
    }
    // 同一款游戏只拉一次（重试路径会显式把 dlcLoadedFor 归零）
    if (dlcLoadedFor === appId && dlcCards.value.length) return;
    void loadDlc(ids);
  },
);

onMounted(() => {
  void bootstrap();
});

// 同一路由内换 appId 时重拉（清掉上一款的数据，避免先闪一下旧海报）
watch(
  () => props.appId,
  () => {
    steam.clearDetail();
    dlcCards.value = [];
    dlcTotalCount.value = 0;
    dlcLoadedFor = 0;
    void bootstrap();
  },
);
</script>

<template>
  <!--
    根节点带两个 CSS 变量：
    - --lm-game-hero-vt：hero 的 view-transition-name（两端必须同名，值来自 utils）；
    - --lm-game-hero-vt-duration / -easing：补间时长与缓动（改手感只改这里）。
    变量写在组件根上而不是 :root：组件根随详情页一起存活，离开即失效，
    不会把「详情页的动效参数」泄漏成全局状态。
  -->
  <div
    class="detail-view"
    :style="{
      '--lm-game-hero-vt': GAME_HERO_VT_NAME,
      '--lm-game-hero-vt-duration': 'var(--md-sys-motion-duration-spring-spatial)',
      '--lm-game-hero-vt-easing': 'var(--md-sys-motion-spring-spatial)',
    }"
  >
    <!-- 非法 appId：不发请求，直接说明 -->
    <div v-if="invalidAppId" class="bar error" role="alert">
      <span class="material-symbols-outlined">error</span>
      <span class="bar-text">{{ t("games.detail.invalidId") }}</span>
      <m3e-button variant="text" size="small" @click="goBack">
        {{ t("games.detail.back") }}
      </m3e-button>
    </div>

    <template v-else>
      <!-- ============================ 加载骨架 ============================ -->
      <div v-if="steam.detailLoading && !detail" class="hero-skeleton">
        <div class="lm-skeleton skeleton-hero"></div>
        <div class="skeleton-bar">
          <div class="lm-skeleton line wide"></div>
          <div class="lm-skeleton line"></div>
        </div>
      </div>

      <!-- ============================ 出错：错误条 + 重试 ============================ -->
      <div v-else-if="steam.detailError && !detail" class="bar error" role="alert">
        <span class="material-symbols-outlined">error</span>
        <span class="bar-text">{{ steam.detailError || t("games.detail.loadFailed") }}</span>
        <m3e-button variant="text" size="small" @click="retry">
          {{ t("games.retry") }}
        </m3e-button>
      </div>

      <template v-else>
        <!-- ============================ Hero ============================ -->
        <section class="hero">
          <!--
            `view-transition-name` 是**静态**的：它与 GamesView 里被点卡片的封面
            同名，由浏览器在两份快照之间补间，实现「卡片放大飞进详情页」。
            同一时刻只允许一个元素持有该名字，所以网格侧只在点击的那张卡上挂，
            见 utils/gameHeroTransition.ts 的长注释。
          -->
          <div class="hero-media">
            <img
              v-if="heroImage && !isBroken(heroImage)"
              :src="heroImage"
              class="hero-img"
              :alt="title"
              decoding="async"
              @error="markBroken(heroImage)"
            />
            <span v-else class="material-symbols-outlined hero-fallback">sports_esports</span>
            <div class="hero-scrim"></div>
          </div>

          <div class="hero-content">
            <m3e-icon-button class="hero-back" :title="t('games.detail.back')" @click="goBack">
              <span class="material-symbols-outlined">arrow_back</span>
            </m3e-icon-button>

            <div class="hero-text">
              <h1 class="hero-title">{{ title }}</h1>
              <div v-if="appDetails?.genres?.length" class="hero-chips">
                <m3e-assist-chip v-for="g in appDetails.genres" :key="g" class="genre-chip">
                  {{ g }}
                </m3e-assist-chip>
              </div>
            </div>
          </div>
        </section>

        <!-- ============================ 操作栏 ============================ -->
        <section class="action-bar">
          <div class="action-main">
            <m3e-button variant="filled" :disabled="actionBusy" @click="primaryAction">
              <span slot="icon" class="material-symbols-outlined">
                {{ isInstalled ? "play_arrow" : "download" }}
              </span>
              {{ isInstalled ? t("games.detail.play") : t("games.detail.install") }}
            </m3e-button>

            <template v-if="isInstalled">
              <span class="installed-tag">
                <span class="material-symbols-outlined tag-icon">check_circle</span>
                {{ t("games.detail.installed") }}
              </span>
              <span class="meta-text tabular-nums">
                {{ t("games.detail.sizeOnDisk") }} {{ sizeText(installed?.sizeOnDisk) }}
              </span>
              <button
                v-if="installPath"
                type="button"
                class="path-chip"
                :title="installPath"
                @click="copyText(installPath)"
              >
                <span class="material-symbols-outlined path-icon">folder</span>
                <span class="path-text">{{ installPath }}</span>
                <span class="material-symbols-outlined path-icon">content_copy</span>
              </button>
            </template>
          </div>

          <div class="action-side">
            <m3e-icon-button :title="t('games.detail.openInSteam')" @click="openInSteam">
              <span class="material-symbols-outlined">open_in_new</span>
            </m3e-icon-button>
            <m3e-icon-button :title="t('games.detail.copyLink')" @click="copyText(heroImage)">
              <span class="material-symbols-outlined">link</span>
            </m3e-icon-button>
          </div>
        </section>

        <div v-if="toast" class="bar info" role="status">
          <span class="material-symbols-outlined">info</span>
          <span class="bar-text">{{ toast }}</span>
        </div>

        <!-- ============================ 两栏主体 ============================ -->
        <div class="columns">
          <!-- ---- 左：正文（简介 / 截图墙）---- -->
          <main class="col-main">
            <m3e-card class="block" variant="filled">
              <div slot="content">
                <h2 class="block-title">{{ t("games.detail.about") }}</h2>
                <p v-if="appDetails?.shortDescription" class="about-text">
                  {{ appDetails.shortDescription }}
                </p>
                <p v-else class="about-text muted">{{ t("games.noDescription") }}</p>
              </div>
            </m3e-card>

            <!-- 截图墙：URL 原样使用（带 ?t= 时间戳），失败逐张降级成占位图标 -->
            <m3e-card v-if="screenshots.length" class="block" variant="filled">
              <div slot="content">
                <h2 class="block-title">{{ t("games.detail.screenshots") }}</h2>
                <div class="shot-wall">
                  <div v-for="(src, i) in screenshots" :key="src + i" class="shot">
                    <img
                      v-if="!isBroken(src)"
                      :src="src"
                      class="shot-img"
                      :alt="title"
                      loading="lazy"
                      decoding="async"
                      @error="markBroken(src)"
                    />
                    <span v-else class="material-symbols-outlined shot-fallback">image</span>
                  </div>
                </div>
              </div>
            </m3e-card>
          </main>

          <!-- ---- 右：速览（额外内容 → 成就 → 信息，与 Steam 桌面版同序）---- -->
          <aside class="col-side">
            <!-- 额外内容（DLC）：没有 dlc 时整块不渲染，不留占位 -->
            <m3e-card v-if="showExtra" class="block" variant="filled">
              <div slot="content">
                <div class="block-head">
                  <h2 class="block-title">{{ t("games.detail.extra") }}</h2>
                  <!-- 显示 DLC 总数（不是已查到元信息的卡片数），与 +N 口径一致 -->
                  <span class="block-count tabular-nums">{{ dlcTotalCount }}</span>
                </div>

                <div class="dlc-list">
                  <button
                    v-for="dlc in visibleDlc"
                    :key="dlc.appId"
                    type="button"
                    class="dlc-item"
                    :title="dlc.name"
                    @click="openDlc(dlc.appId)"
                  >
                    <span class="dlc-thumb">
                      <img
                        v-if="dlc.image && !isBroken(dlc.image)"
                        :src="dlc.image"
                        class="dlc-img"
                        :alt="dlc.name"
                        loading="lazy"
                        decoding="async"
                        @error="markBroken(dlc.image)"
                      />
                      <span v-else class="material-symbols-outlined dlc-fallback">extension</span>
                    </span>
                    <span class="dlc-name">{{ dlc.name }}</span>
                  </button>

                  <!-- 超出 5 个的部分收进 +N（点击去 Steam 看全部 DLC） -->
                  <button
                    v-if="dlcOverflow > 0"
                    type="button"
                    class="dlc-item dlc-more"
                    :title="t('games.detail.extra')"
                    @click="openInSteam"
                  >
                    <span class="dlc-thumb">
                      <span class="dlc-more-text tabular-nums"> +{{ dlcOverflow }} </span>
                    </span>
                    <span class="dlc-name">{{ t("games.detail.extra") }}</span>
                  </button>
                </div>

                <div v-if="dlcLoading" class="side-loading">
                  <m3e-loading-indicator class="inline-loading" />
                </div>
              </div>
            </m3e-card>

            <!-- 成就（仿 Steam：标题 + 查看入口 + 进度 + 已解锁图标墙） -->
            <m3e-card v-if="showAchievements" class="block" variant="filled">
              <div slot="content">
                <div class="block-head">
                  <h2 class="block-title">{{ t("games.detail.achievements") }}</h2>
                  <m3e-button variant="text" size="small" @click="viewAllAchievements">
                    {{ t("games.detail.viewAchievements") }}
                  </m3e-button>
                </div>

                <div class="ach-progress-row">
                  <!-- 显式给 max=100 与 percent 同单位：组件默认 max=1，
                       传 0.37 也能work，但两处单位不一致会让后来的人算半天 -->
                  <m3e-linear-progress-indicator
                    class="ach-bar"
                    :max="100"
                    :value="achievementPercent"
                  />
                  <span class="ach-percent tabular-nums">{{ achievementPercent }}%</span>
                </div>
                <p class="ach-count tabular-nums">
                  {{
                    t("games.detail.unlockedCount")
                      .replace("{n}", String(achievements?.unlocked ?? 0))
                      .replace("{total}", String(achievements?.total ?? 0))
                      .replace("{percent}", String(achievementPercent))
                  }}
                </p>

                <!-- 已解锁图标墙：只展示已解锁的；有溢出时最后一格是 +N（共 5 格） -->
                <div class="ach-wall">
                  <button
                    v-for="a in iconWall"
                    :key="a.apiName"
                    type="button"
                    class="ach-tile"
                    :title="a.name"
                    @click="viewAllAchievements"
                  >
                    <img
                      v-if="a.icon && !isBroken(a.icon)"
                      :src="a.icon"
                      class="ach-tile-img"
                      :alt="a.name"
                      loading="lazy"
                      decoding="async"
                      @error="markBroken(a.icon)"
                    />
                    <span v-else class="material-symbols-outlined ach-tile-fallback">
                      emoji_events
                    </span>
                  </button>

                  <!-- 第五个位置留给 +N（超出部分），点去 Steam 看完整列表 -->
                  <button
                    v-if="iconOverflow > 0"
                    type="button"
                    class="ach-tile ach-tile-more"
                    :title="t('games.detail.viewAchievements')"
                    @click="viewAllAchievements"
                  >
                    <span class="ach-more-text tabular-nums">
                      {{ t("games.detail.moreCount").replace("{n}", String(iconOverflow)) }}
                    </span>
                  </button>

                  <!-- 一个已解锁都没有：图标墙位置给灰化占位，不留空白 -->
                  <span v-if="!unlockedAchievements.length" class="ach-wall-empty">
                    <span class="material-symbols-outlined">lock</span>
                  </span>
                </div>

                <!-- 未解锁：不显示图标墙，只给一行「锁定的成就」+ 灰化占位 -->
                <div v-if="lockedCount > 0" class="ach-locked">
                  <span class="ach-locked-title">{{ t("games.detail.lockedTitle") }}</span>
                  <span class="ach-locked-count tabular-nums">×{{ lockedCount }}</span>
                  <span class="ach-locked-hint">{{ t("games.detail.lockedHint") }}</span>
                </div>
              </div>
            </m3e-card>

            <!-- 信息 -->
            <m3e-card class="block" variant="filled">
              <div slot="content">
                <h2 class="block-title">{{ t("games.detail.info") }}</h2>
                <dl class="info-list">
                  <div class="info-row">
                    <dt>{{ t("games.detail.needSpace") }}</dt>
                    <dd class="tabular-nums">
                      {{ isInstalled ? sizeText(installed?.sizeOnDisk) : "—" }}
                    </dd>
                  </div>
                  <div class="info-row">
                    <dt>{{ t("games.detail.lastPlayed") }}</dt>
                    <dd>{{ lastPlayed || t("games.neverPlayed") }}</dd>
                  </div>
                  <div class="info-row">
                    <dt>{{ t("games.detail.playtime") }}</dt>
                    <dd class="tabular-nums">{{ playtime || t("games.playtimeNone") }}</dd>
                  </div>
                  <div class="info-row">
                    <dt>{{ t("games.releaseDate") }}</dt>
                    <dd>{{ appDetails?.releaseDate || "—" }}</dd>
                  </div>
                  <div class="info-row">
                    <dt>{{ t("games.genres") }}</dt>
                    <dd>{{ appDetails?.genres?.join(" · ") || "—" }}</dd>
                  </div>
                  <div class="info-row">
                    <dt>{{ t("games.price") }}</dt>
                    <dd class="price">{{ priceText }}</dd>
                  </div>
                  <div v-if="appDetails?.developers?.length" class="info-row">
                    <dt>{{ t("games.detail.developer") }}</dt>
                    <dd>{{ appDetails.developers.join(" · ") }}</dd>
                  </div>
                  <div v-if="appDetails?.publishers?.length" class="info-row">
                    <dt>{{ t("games.detail.publisher") }}</dt>
                    <dd>{{ appDetails.publishers.join(" · ") }}</dd>
                  </div>
                </dl>
              </div>
            </m3e-card>
          </aside>
        </div>
      </template>
    </template>
  </div>
</template>
<style scoped>
.detail-view {
  max-width: 1280px;
  margin: 0 auto;
  padding-bottom: 32px;
  /* 整页淡入的过渡名；与 GamesView 的 games-grid-page 成对（进入 / 返回同一套） */
  view-transition-name: game-detail-page;
}

/* ---- 提示条（与 GamesView 同一版式）---- */
.bar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 14px;
  margin-bottom: 12px;
  border-radius: var(--md-sys-shape-corner-medium);
  font-size: var(--md-sys-typescale-body-small-size);
  line-height: 1.5;
}
.bar .material-symbols-outlined {
  font-size: 18px;
  flex-shrink: 0;
}
.bar-text {
  flex: 1;
  min-width: 0;
}
.bar.error {
  background: var(--md-sys-color-error-container);
  color: var(--md-sys-color-on-error-container);
}
.bar.info {
  background: var(--md-sys-color-secondary-container);
  color: var(--md-sys-color-on-secondary-container);
}

/* ---- 骨架 ---- */
.hero-skeleton {
  display: flex;
  flex-direction: column;
  gap: 16px;
}
.skeleton-hero {
  width: 100%;
  aspect-ratio: 21 / 9;
  border-radius: var(--md-sys-shape-corner-large);
  /*
   * 骨架屏也挂 hero 的过渡名。
   *
   * 为什么：详情页首帧渲染的是骨架屏（`detail` 还没回来），此时 .hero-media
   * 根本不存在。若不在这里挂名字，等 hero 真出现时过渡早已结束 —— 用户看到的是
   * 一次普通的淡入，**没有任何飞行动画**，而这正是这个功能存在的理由。
   *
   * 与 .hero-media 是 v-if / v-else 的两个分支，同一时刻只会有一个存在于文档里，
   * 所以不会出现「同名元素重复」而被浏览器整次忽略的情况。
   */
  view-transition-name: var(--lm-game-hero-vt);
}
.skeleton-bar {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 0 4px;
}
.line {
  height: 12px;
  border-radius: 6px;
}
.line.wide {
  width: 52%;
  height: 18px;
}
.line:not(.wide) {
  width: 30%;
}

/* ---- Hero ---- */
.hero {
  position: relative;
  margin-bottom: 16px;
  border-radius: var(--md-sys-shape-corner-extra-large);
  overflow: hidden;
  background: var(--md-sys-color-surface-container-high);
}
/*
 * hero 的 media 就是「飞行目标」：`view-transition-name` 与 GamesView 里被点卡片
 * 的封面同名，浏览器会在两份快照之间自动补间（卡片从网格位置放大飞到这里）。
 *
 * 名字用 CSS 变量承接（变量由本组件 :root 内联的那一段给出），这样 `utils/`
 * 里的常量是唯一真源；直接写字面量会有两处字符串，改一处漏一处就静默失效。
 */
.hero-media {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 100%;
  aspect-ratio: 21 / 9;
  background: var(--md-sys-color-surface-container-high);
  color: var(--md-sys-color-outline);
  view-transition-name: var(--lm-game-hero-vt);
}
.hero-img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.hero-fallback {
  font-size: 64px;
}
/* 只压暗下半部分：大图主体仍可见，标题区仍可读 */
.hero-scrim {
  position: absolute;
  inset: 0;
  background: linear-gradient(
    to bottom,
    transparent 0%,
    transparent 38%,
    var(--md-sys-color-scrim) 100%
  );
  opacity: 0.82;
  pointer-events: none;
}
.hero-content {
  position: absolute;
  inset: auto 0 0 0;
  display: flex;
  align-items: flex-end;
  gap: 12px;
  padding: 16px 20px;
}
.hero-back {
  flex-shrink: 0;
  color: var(--md-sys-color-on-surface);
}
.hero-text {
  min-width: 0;
  flex: 1;
}
.hero-title {
  margin: 0;
  font-size: var(--md-sys-typescale-headline-medium-size);
  font-weight: var(--md-sys-typescale-headline-medium-weight);
  line-height: 1.2;
  /* 标题压在图片 + 遮罩上，用反色令牌而不是 on-surface */
  color: var(--md-sys-color-inverse-on-surface);
  text-shadow: 0 1px 12px var(--md-sys-color-scrim);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.hero-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 8px;
}
.genre-chip {
  --m3e-assist-chip-container-height: 28px;
}

/* ---- 操作栏 ---- */
.action-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  flex-wrap: wrap;
  padding: 12px 16px;
  margin-bottom: 16px;
  border-radius: var(--md-sys-shape-corner-large);
  background: var(--md-sys-color-surface-container-low);
}
.action-main {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
  min-width: 0;
}
.action-side {
  display: flex;
  align-items: center;
  gap: 4px;
}
.installed-tag {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 4px 10px;
  border-radius: var(--md-sys-shape-corner-full);
  background: var(--md-sys-color-primary-container);
  color: var(--md-sys-color-on-primary-container);
  font-size: var(--md-sys-typescale-label-medium-size);
}
.tag-icon {
  font-size: 16px;
}
.meta-text {
  font-size: var(--md-sys-typescale-body-small-size);
  color: var(--md-sys-color-on-surface-variant);
}
/* 安装路径：可点复制的窄条，超长省略号 */
.path-chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  max-width: 420px;
  min-width: 0;
  padding: 6px 10px;
  border: 1px solid var(--md-sys-color-outline-variant);
  border-radius: var(--md-sys-shape-corner-small);
  background: transparent;
  color: var(--md-sys-color-on-surface-variant);
  font-family: inherit;
  font-size: var(--md-sys-typescale-body-small-size);
  cursor: pointer;
}
.path-chip:hover {
  background: var(--md-sys-color-surface-container-high);
}
.path-chip:focus-visible {
  outline: 2px solid var(--md-sys-color-primary);
  outline-offset: 2px;
}
.path-icon {
  font-size: 16px;
  flex-shrink: 0;
}
.path-text {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* ---- 两栏 ---- */
.columns {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 340px;
  gap: 16px;
  align-items: start;
}
.col-main,
.col-side {
  display: flex;
  flex-direction: column;
  gap: 16px;
  min-width: 0;
}
.block {
  border-radius: var(--md-sys-shape-corner-large);
}
.block-title {
  margin: 0 0 10px;
  font-size: var(--md-sys-typescale-title-medium-size);
  font-weight: var(--md-sys-typescale-title-medium-weight);
  color: var(--md-sys-color-on-surface);
}
.block-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 10px;
}
/* 标题与右侧动作按钮并排时，标题自身不再带下边距 */
.block-head .block-title {
  margin: 0;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.block-count {
  flex-shrink: 0;
  font-size: var(--md-sys-typescale-body-small-size);
  color: var(--md-sys-color-on-surface-variant);
}
.about-text {
  margin: 0;
  font-size: var(--md-sys-typescale-body-medium-size);
  line-height: 1.7;
  color: var(--md-sys-color-on-surface);
  /* 简介来自商店，保留原始换行 */
  white-space: pre-line;
}
.about-text.muted {
  color: var(--md-sys-color-on-surface-variant);
}

/* ---- 截图墙 ---- */
.shot-wall {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
  gap: 10px;
}
.shot {
  display: flex;
  align-items: center;
  justify-content: center;
  aspect-ratio: 16 / 9;
  border-radius: var(--md-sys-shape-corner-medium);
  background: var(--md-sys-color-surface-container-highest);
  color: var(--md-sys-color-outline);
  overflow: hidden;
}
.shot-img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.shot-fallback {
  font-size: 28px;
}

/* ---- 额外内容（DLC）---- */
.dlc-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.dlc-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 4px;
  min-width: 0;
  border: none;
  border-radius: var(--md-sys-shape-corner-medium);
  background: transparent;
  color: inherit;
  font-family: inherit;
  text-align: left;
  cursor: pointer;
}
.dlc-item:hover {
  background: var(--md-sys-color-surface-container-high);
}
.dlc-item:focus-visible {
  outline: 2px solid var(--md-sys-color-primary);
  outline-offset: 2px;
}
/* 缩略图按商店 header 的比例裁切，固定宽度避免长短标题把行高撑乱 */
.dlc-thumb {
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  width: 88px;
  aspect-ratio: 16 / 9;
  border-radius: var(--md-sys-shape-corner-small);
  background: var(--md-sys-color-surface-container-highest);
  color: var(--md-sys-color-outline);
  overflow: hidden;
}
.dlc-img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.dlc-fallback {
  font-size: 22px;
}
.dlc-name {
  min-width: 0;
  flex: 1;
  font-size: var(--md-sys-typescale-body-small-size);
  color: var(--md-sys-color-on-surface);
  /* 长标题最多两行，超出省略 */
  display: -webkit-box;
  -webkit-line-clamp: 2;
  line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
/* +N 方块：与缩略图同尺寸，颜色走 secondary-container 与图片区分 */
.dlc-more .dlc-thumb {
  background: var(--md-sys-color-secondary-container);
  color: var(--md-sys-color-on-secondary-container);
}
.dlc-more-text {
  font-size: var(--md-sys-typescale-title-small-size);
  font-weight: var(--md-sys-typescale-title-small-weight);
}
.dlc-more .dlc-name {
  color: var(--md-sys-color-on-surface-variant);
}

/* ---- 成就（右栏，仿 Steam）---- */
.ach-progress-row {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 6px;
}
.ach-bar {
  flex: 1;
  min-width: 0;
}
.ach-percent {
  flex-shrink: 0;
  font-size: var(--md-sys-typescale-label-small-size);
  color: var(--md-sys-color-on-surface-variant);
}
.ach-count {
  margin: 0 0 10px;
  font-size: var(--md-sys-typescale-body-small-size);
  color: var(--md-sys-color-on-surface-variant);
}
/* 图标墙：横向一排，最多 5 个 + 可能的 +N */
.ach-wall {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-bottom: 10px;
}
.ach-tile {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 52px;
  height: 52px;
  flex-shrink: 0;
  padding: 0;
  border: none;
  border-radius: var(--md-sys-shape-corner-small);
  background: var(--md-sys-color-surface-container-highest);
  color: var(--md-sys-color-on-surface-variant);
  cursor: pointer;
  overflow: hidden;
}
.ach-tile:focus-visible {
  outline: 2px solid var(--md-sys-color-primary);
  outline-offset: 2px;
}
.ach-tile-img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.ach-tile-fallback {
  font-size: 24px;
}
/* +N：与图标同尺寸，底色用 secondary-container 以区分「这是计数不是成就」 */
.ach-tile-more {
  background: var(--md-sys-color-secondary-container);
  color: var(--md-sys-color-on-secondary-container);
}
.ach-more-text {
  font-size: var(--md-sys-typescale-label-large-size);
  font-weight: var(--md-sys-typescale-label-large-weight);
}
/* 一个都没解锁：图标墙位置给一个灰化占位，不留空白 */
.ach-wall-empty {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 52px;
  height: 52px;
  border-radius: var(--md-sys-shape-corner-small);
  background: var(--md-sys-color-surface-container-high);
  color: var(--md-sys-color-outline-variant);
}
.ach-wall-empty .material-symbols-outlined {
  font-size: 22px;
}
/* 「锁定的成就」：不铺图标，只一行说明 + 计数 */
.ach-locked {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  padding-top: 10px;
  border-top: 1px solid var(--md-sys-color-outline-variant);
}
.ach-locked-title {
  font-size: var(--md-sys-typescale-body-small-size);
  color: var(--md-sys-color-on-surface-variant);
}
.ach-locked-count {
  font-size: var(--md-sys-typescale-label-medium-size);
  color: var(--md-sys-color-on-surface-variant);
}
.ach-locked-hint {
  flex: 1;
  min-width: 0;
  font-size: var(--md-sys-typescale-label-small-size);
  color: var(--md-sys-color-outline);
  text-align: right;
}
.side-loading {
  display: flex;
  justify-content: center;
  padding: 6px 0 2px;
}
.inline-loading {
  --m3e-loading-indicator-size: 18px;
}

/* ---- 右栏信息 ---- */
.info-list {
  display: flex;
  flex-direction: column;
  gap: 10px;
  margin: 0;
}
.info-row {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
}
.info-row dt {
  flex-shrink: 0;
  font-size: var(--md-sys-typescale-body-small-size);
  color: var(--md-sys-color-on-surface-variant);
}
.info-row dd {
  margin: 0;
  text-align: right;
  font-size: var(--md-sys-typescale-body-medium-size);
  color: var(--md-sys-color-on-surface);
  overflow: hidden;
  text-overflow: ellipsis;
}
.info-row dd.price {
  color: var(--md-sys-color-primary);
  font-weight: 600;
}

/* ---- 窄屏：单栏 ---- */
@media (max-width: 900px) {
  .columns {
    grid-template-columns: minmax(0, 1fr);
  }
  .hero-media {
    aspect-ratio: 16 / 9;
  }
  .path-chip {
    max-width: 100%;
  }
}
@media (max-width: 600px) {
  .hero-content {
    padding: 12px 14px;
  }
  .hero-title {
    font-size: var(--md-sys-typescale-title-large-size);
  }
  .shot-wall {
    grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
  }
}

/* ---- 减少动效：本页自身的过渡态一律关掉 ---- */
@media (prefers-reduced-motion: reduce) {
  .dlc-item,
  .ach-tile {
    transition: none;
  }
}
</style>
