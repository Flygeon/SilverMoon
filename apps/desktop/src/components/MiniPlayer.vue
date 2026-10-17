<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { useRouter } from "vue-router";
import { usePlayerStore } from "@/stores/player";
import { useNeteaseStore } from "@/stores/netease";
import PlayerControlIcon from "@/components/PlayerControlIcon.vue";
import { formatTime } from "@/utils/format";
import { hasPendingHero, landHeroFlight, releaseHeroFlight } from "@/utils/heroTransition";

const player = usePlayerStore();
const netease = useNeteaseStore();
const router = useRouter();

/**
 * 封面容器：hero 飞行的起飞点。
 *
 * 绑在 .cover 而不是 <img> 上：无封面时这里放的是音符图标，同样需要一个
 * 「有形状的源」。而且 .cover 自带圆角与阴影，克隆出来更像一个整体。
 */
const coverEl = ref<HTMLElement | null>(null);

/**
 * 是否要抑制自己的入场动画。
 *
 * 从播放器「返回」时，hero 会从播放器封面飞回这个迷你条；如果迷你条同时
 * 还在播 slide-up（从底部升起），两条位移叠加会变成一条诡异的抛物线。
 * 检测方式：挂载时若已有一个「待降落」的飞行，说明这次是从别处飞回来的。
 *
 * ⚠️ 必须在 **setup 阶段**（同步）就定下来，不能等 onMounted：
 * CSS animation 在元素插入文档时立刻开始播，onMounted 已经晚了一拍，
 * 那时 slide-up 早跑了几帧，再摘掉 animation 会看到一次突兀的跳位。
 * setup 在渲染之前执行，此时 pendingFlight 还在（降落方还没 release），判断可靠。
 */
const suppressEnter = ref(hasPendingHero());

onMounted(() => {
  /*
   * 反向 hero 降落：从播放器返回时，飞行层正从播放器封面飞向这里。
   * 目标取 .cover（48×48 正方形），与起飞时的形状一致，等比缩放不变形。
   * 没有待降落飞行时 releaseHeroFlight() 返回 null，landHeroFlight 直接返回。
   */
  landHeroFlight(releaseHeroFlight(), () => coverEl.value);
});

/**
 * 展开到完整播放器。
 *
 * 起飞**不在这里做**：App.vue 在 document 的 capture 阶段统一监听
 * `[data-hero-source]` 上的点击并起飞，再由 router.afterEach 交给 PlayerView。
 * 这里只负责导航 —— 保证「点卡片进播放器」与「点迷你条进播放器」走同一条时序，
 * 不会出现两套逻辑各自算一遍的情况。
 */
function expandToPlayer(): void {
  void router.push("/music/player");
}

const progress = computed(() =>
  player.duration ? (player.currentTime / player.duration) * 100 : 0,
);

const canLike = computed(
  () =>
    netease.loggedIn && player.song?.kind === "online" && Number.isFinite(Number(player.song?.id)),
);

const liked = computed(() => (player.song ? netease.isSongLiked(player.song.id) : false));

async function toggleLike() {
  if (!player.song || !canLike.value) return;
  await netease.toggleSongLiked(player.song.id);
}

function seek(e: MouseEvent) {
  const el = e.currentTarget as HTMLElement;
  const ratio = (e.clientX - el.getBoundingClientRect().left) / el.offsetWidth;
  player.seek(Math.max(0, Math.min(1, ratio)) * player.duration);
}
</script>

<template>
  <div
    class="mini-player lm-glass"
    :class="{ 'no-enter': suppressEnter }"
    data-lm-region="miniplayer"
  >
    <!-- 进度条置顶，点击可跳转 -->
    <div class="track" @click.stop="seek">
      <div class="fill" :style="{ width: progress + '%' }">
        <span class="knob"></span>
      </div>
    </div>

    <div class="body" data-hero-source @click="expandToPlayer">
      <!-- 起飞点：hero 飞行层从这里克隆，见 utils/heroTransition -->
      <div ref="coverEl" class="cover" data-hero-cover>
        <img v-if="player.song?.cover" :src="player.song.cover" alt="" />
        <span v-else class="material-symbols-outlined">music_note</span>
      </div>

      <div class="info">
        <div class="title">{{ player.song?.title || "—" }}</div>
        <div class="artist">{{ player.song?.artist || "未知艺术家" }}</div>
      </div>

      <div class="time tabular-nums">
        {{ formatTime(player.currentTime) }} / {{ formatTime(player.duration) }}
      </div>

      <div class="controls" @click.stop>
        <m3e-icon-button
          v-if="canLike"
          class="like"
          size="small"
          :class="{ on: liked }"
          :title="liked ? '取消喜欢' : '喜欢'"
          @click="toggleLike"
        >
          <span class="material-symbols-outlined" :class="{ filled: liked }">favorite</span>
        </m3e-icon-button>
        <m3e-icon-button size="small" title="上一首" @click="player.previous()">
          <span class="material-symbols-outlined filled">skip_previous</span>
        </m3e-icon-button>
        <m3e-icon-button
          class="play"
          variant="filled"
          size="small"
          :title="player.playing ? '暂停' : '播放'"
          @click="player.togglePlay()"
        >
          <PlayerControlIcon :name="player.playing ? 'pause' : 'play'" />
        </m3e-icon-button>
        <m3e-icon-button size="small" title="下一首" @click="player.next()">
          <span class="material-symbols-outlined filled">skip_next</span>
        </m3e-icon-button>
        <m3e-icon-button size="small" title="展开播放器" @click="expandToPlayer">
          <span class="material-symbols-outlined">expand_less</span>
        </m3e-icon-button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.mini-player {
  position: fixed;
  left: var(--lm-nav-width);
  right: 0;
  bottom: 0;
  height: var(--lm-miniplayer-height);
  z-index: 50;
  border-top: 1px solid var(--lm-hairline);
  font-family: var(--lm-player-font);
  animation: slide-up 320ms var(--md-sys-motion-spring-spatial);
}

/*
 * hero 降落时关掉自己的入场。
 *
 * 从播放器返回时，飞行层正从播放器封面飞向这个迷你条；如果迷你条同时还在播
 * slide-up（从底部升起），两条位移叠加会变成一条诡异的抛物线。这里直接跳过
 * 入场——飞行层落到终点后移除，露出的就是静止的迷你条。
 */
.mini-player.no-enter {
  animation: none;
}
@keyframes slide-up {
  from {
    transform: translateY(100%);
  }
  to {
    transform: none;
  }
}

.track {
  position: relative;
  height: 4px;
  cursor: pointer;
  background: var(--md-sys-color-surface-container-highest);
}
.track:hover .knob {
  opacity: 1;
}
.fill {
  position: relative;
  height: 100%;
  background: var(--md-sys-color-primary);
  transition: width 180ms linear;
}
.knob {
  position: absolute;
  right: -5px;
  top: 50%;
  width: 10px;
  height: 10px;
  border-radius: 50%;
  background: var(--md-sys-color-primary);
  transform: translateY(-50%);
  opacity: 0;
  transition: opacity var(--md-sys-motion-duration-short);
}

.body {
  display: flex;
  align-items: center;
  gap: 14px;
  height: calc(var(--lm-miniplayer-height) - 4px);
  padding: 0 16px;
  cursor: pointer;
}

.cover {
  flex: none;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 48px;
  height: 48px;
  border-radius: var(--md-sys-shape-corner-small);
  overflow: hidden;
  background: var(--md-sys-color-surface-container-high);
  box-shadow:
    var(--md-elevation-1),
    inset 0 0 0 1px var(--lm-hairline);
}
.cover img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.cover .material-symbols-outlined {
  font-size: 22px;
  color: var(--md-sys-color-outline);
}

.info {
  flex: 1;
  min-width: 0;
}
.title {
  font-size: var(--md-sys-typescale-body-medium-size);
  font-weight: 500;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.artist {
  font-size: var(--md-sys-typescale-body-small-size);
  color: var(--md-sys-color-on-surface-variant);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.time {
  font-size: var(--md-sys-typescale-body-small-size);
  color: var(--md-sys-color-on-surface-variant);
  white-space: nowrap;
}

.controls {
  display: flex;
  align-items: center;
  gap: 2px;
}
.controls .play {
  --m3e-icon-button-small-container-height: 44px;
  --m3e-icon-button-small-default-leading-space: 10px;
  --m3e-icon-button-small-default-trailing-space: 10px;
  --m3e-filled-icon-button-container-color: var(--md-sys-color-primary-container);
  --m3e-filled-icon-button-icon-color: var(--md-sys-color-on-primary-container);
}
.controls .play:hover {
  filter: brightness(1.08);
}
.controls .play .player-control-icon {
  width: 26px;
  height: 23px;
  filter: drop-shadow(0 0 6px rgba(0, 0, 0, 0.18));
}
/* 图标 20px 时把左右留白补到 10px，维持 40×40 正圆 */
.like {
  --m3e-icon-button-small-icon-size: 20px;
  --m3e-icon-button-small-default-leading-space: 10px;
  --m3e-icon-button-small-default-trailing-space: 10px;
}
.like.on {
  --m3e-standard-icon-button-icon-color: var(--md-sys-color-error);
}

@media (max-width: 720px) {
  .time {
    display: none;
  }
}
</style>
