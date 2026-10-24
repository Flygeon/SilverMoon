<script setup lang="ts">
/**
 * 游戏详情（游戏 → 点卡片）。
 *
 * 排版参考 Steam 商店的游戏详情页，但**配色与形状全部走 MD3**：
 * 顶部大 hero（商店背景大图 + 渐变遮罩）→ 操作栏（安装 / 开始游戏）→
 * 左主栏（简介 / 截图墙 / 成就）+ 右信息栏（空间 / 最近运行 / 时长 / 发售日 / 类型 / 价格）。
 *
 * 链路：本视图 → stores/steam.ts 的 openDetail() → capabilities.steam({ op: "gameDetail" })
 *       → 宿主一次返回 { details, local, achievements }，**本页只发这一个请求**。
 *       商店元信息（store.steampowered.com/api/appdetails）需要联网；
 *       本地安装信息来自本机 libraryfolders.vdf / appmanifest_*.acf，**不需要登录** ——
 *       两者互不阻塞：联网失败时仍能显示「已安装 / 占用空间 / 安装路径」。
 *
 * 约定（与 GamesView 一致）：
 * - 颜色只用 M3 令牌，不写死 Steam 的深蓝 / 绿色；
 * - 图标一律 Material Symbols Rounded，不用 emoji；
 * - 图片一律 loading="lazy"，失败换图标占位；
 * - 所有请求都有骨架 / 错误条 + 重试，不允许静默失败。
 */
import { computed, onMounted, ref, watch } from "vue";
import { useRouter } from "vue-router";
import { useSettingsStore } from "@/stores/settings";
import { useSteamStore } from "@/stores/steam";
import { formatSize } from "@/utils/format";
import { translate } from "@shared/i18n";

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

/** 头图 / 截图加载失败的集合（URL → true），失败后换占位图标 */
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

/** hero 大图：背景大图优先，其次 header，最后按 appId 拼官方 CDN（与 GamesView 同源策略） */
const heroImage = computed<string>(() => {
  const id = numericAppId.value;
  return (
    appDetails.value?.backgroundImage ||
    appDetails.value?.headerImage ||
    (Number.isNaN(id) ? "" : "https://cdn.akamai.steamstatic.com/steam/apps/" + id + "/header.jpg")
  );
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
/** 返回：有历史就退一步；直接进详情（无历史）时回游戏列表，避免退到空页 */
function goBack(): void {
  if (window.history.length > 1) router.back();
  else void router.push("/games");
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

onMounted(() => {
  void bootstrap();
});

// 同一路由内换 appId 时重拉（清掉上一款的数据，避免先闪一下旧海报）
watch(
  () => props.appId,
  () => {
    steam.clearDetail();
    void bootstrap();
  },
);
</script>

<template>
  <div class="detail-view">
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
          <div class="hero-media">
            <img
              v-if="heroImage && !isBroken(heroImage)"
              :src="heroImage"
              class="hero-img"
              :alt="title"
              loading="lazy"
              decoding="async"
              @error="markBroken(heroImage)"
            />
            <span v-else class="material-symbols-outlined hero-fallback">sports_esports</span>
            <!-- 渐变遮罩：标题压在大图上仍然可读（只用 M3 令牌，不写死颜色） -->
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

            <!-- 已安装：状态 + 占用空间 + 可点复制的安装路径 -->
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

        <!-- 操作结果提示 -->
        <div v-if="toast" class="bar info" role="status">
          <span class="material-symbols-outlined">info</span>
          <span class="bar-text">{{ toast }}</span>
        </div>

        <!-- ============================ 两栏主体 ============================ -->
        <div class="columns">
          <!-- ---- 左：主内容 ---- -->
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

            <!-- 截图墙：懒加载，失败逐张降级成占位图标 -->
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

            <!-- 成就 -->
            <m3e-card v-if="showAchievements" class="block" variant="filled">
              <div slot="content">
                <div class="block-head">
                  <h2 class="block-title">{{ t("games.detail.achievements") }}</h2>
                  <span class="ach-count tabular-nums">
                    {{
                      t("games.detail.unlockedOf")
                        .replace("{n}", String(achievements?.unlocked ?? 0))
                        .replace("{total}", String(achievements?.total ?? 0))
                    }}
                  </span>
                </div>

                <div class="ach-progress">
                  <m3e-linear-progress-indicator
                    class="ach-bar"
                    :value="achievementPercent / 100"
                  />
                </div>

                <div class="ach-list">
                  <div
                    v-for="a in achievements?.achievements ?? []"
                    :key="a.apiName"
                    class="ach-item"
                    :class="{ locked: !a.unlocked }"
                  >
                    <div class="ach-icon-wrap">
                      <img
                        v-if="a.unlocked && a.icon && !isBroken(a.icon)"
                        :src="a.icon"
                        class="ach-icon"
                        alt=""
                        loading="lazy"
                        decoding="async"
                        @error="markBroken(a.icon)"
                      />
                      <span v-else class="material-symbols-outlined ach-icon-fallback">
                        {{ a.unlocked ? "emoji_events" : "lock" }}
                      </span>
                    </div>
                    <div class="ach-text">
                      <div class="ach-name">{{ a.name }}</div>
                      <div v-if="a.description" class="ach-desc">{{ a.description }}</div>
                    </div>
                    <span v-if="a.unlockTime" class="ach-time tabular-nums">
                      {{ relativeTime(a.unlockTime) }}
                    </span>
                  </div>
                </div>
              </div>
            </m3e-card>
          </main>

          <!-- ---- 右：信息栏 ---- -->
          <aside class="col-side">
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

            <!-- 额外内容：契约当前没有 DLC 字段，先给一句说明而不是画一个空区块 -->
            <m3e-card v-if="appDetails?.developers?.length" class="block" variant="filled">
              <div slot="content">
                <h2 class="block-title">{{ t("games.detail.extra") }}</h2>
                <p class="about-text muted">{{ t("games.detail.extraHint") }}</p>
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
.hero-media {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 100%;
  aspect-ratio: 21 / 9;
  background: var(--md-sys-color-surface-container-high);
  color: var(--md-sys-color-outline);
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
  grid-template-columns: minmax(0, 1fr) 320px;
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
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 10px;
}
.block-head .block-title {
  margin: 0;
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

/* ---- 成就 ---- */
.ach-count {
  font-size: var(--md-sys-typescale-body-small-size);
  color: var(--md-sys-color-on-surface-variant);
}
.ach-progress {
  margin-bottom: 12px;
}
.ach-bar {
  width: 100%;
}
.ach-list {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.ach-item {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 8px;
  border-radius: var(--md-sys-shape-corner-medium);
}
.ach-item:hover {
  background: var(--md-sys-color-surface-container-high);
}
.ach-item.locked {
  opacity: 0.6;
}
.ach-icon-wrap {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 40px;
  height: 40px;
  flex-shrink: 0;
  border-radius: var(--md-sys-shape-corner-small);
  background: var(--md-sys-color-surface-container-highest);
  overflow: hidden;
}
.ach-icon {
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.ach-icon-fallback {
  font-size: 22px;
  color: var(--md-sys-color-on-surface-variant);
}
.ach-text {
  min-width: 0;
  flex: 1;
}
.ach-name {
  font-size: var(--md-sys-typescale-body-medium-size);
  color: var(--md-sys-color-on-surface);
}
.ach-desc {
  font-size: var(--md-sys-typescale-body-small-size);
  color: var(--md-sys-color-on-surface-variant);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ach-time {
  flex-shrink: 0;
  font-size: var(--md-sys-typescale-label-small-size);
  color: var(--md-sys-color-on-surface-variant);
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
</style>
