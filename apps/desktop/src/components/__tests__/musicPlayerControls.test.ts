// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createApp, nextTick, reactive, type App } from "vue";
import PlayerView from "@/views/PlayerView.vue";
import MiniPlayer from "../MiniPlayer.vue";

const actions = vi.hoisted(() => ({
  previous: vi.fn(),
  next: vi.fn(),
  togglePlay: vi.fn(),
  cycleRepeat: vi.fn(),
  toggleShuffle: vi.fn(),
  setPlaybackRate: vi.fn(),
  initAudio: vi.fn(),
  detachAudio: vi.fn(),
  push: vi.fn(),
  back: vi.fn(),
}));
const player = reactive({
  ...actions,
  playing: false,
  shuffleMode: false,
  repeatMode: "off",
  song: null,
  lyrics: [],
  queue: [],
  currentTime: 0,
  duration: 0,
});
vi.mock("@/stores/player", () => ({ usePlayerStore: () => player }));
vi.mock("@/stores/settings", () => ({
  useSettingsStore: () => ({ lang: "zh", lyricEngine: "native", preciseLyrics: false }),
}));
vi.mock("@/stores/netease", () => ({ useNeteaseStore: () => ({ loggedIn: false }) }));
vi.mock("vue-router", () => ({ useRouter: () => ({ push: actions.push, back: actions.back }) }));
vi.mock("@/utils/heroTransition", () => ({
  hasPendingHero: () => false,
  holdHeroFlight: vi.fn(),
  landHeroFlight: vi.fn(),
  releaseHeroFlight: () => null,
  startHeroFlight: () => null,
}));
vi.mock("@/components/FluidBackground.vue", () => ({ default: { render: () => null } }));
vi.mock("@/components/LyricsView.vue", () => ({ default: { render: () => null } }));
vi.mock("@/components/AudioEffectsPanel.vue", () => ({ default: { render: () => null } }));
vi.mock("@/components/CommentsPanel.vue", () => ({ default: { render: () => null } }));

let app: App;
let host: HTMLElement;
function button(selector: string): HTMLElement {
  return host.querySelector<HTMLElement>(selector)!;
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  Object.assign(player, { playing: false, shuffleMode: false, repeatMode: "off" });
  host = document.createElement("div");
  document.body.append(host);
  app = createApp(PlayerView);
  app.mount(host);
});
afterEach(() => {
  app.unmount();
  host.remove();
  vi.clearAllTimers();
  vi.useRealTimers();
});

it("主控采用官方宽版方形与圆形按钮，保留原播放动作", async () => {
  expect(host.querySelectorAll(".controls m3e-icon-button")).toHaveLength(7);
  expect(host.querySelector(".controls button, .controls svg")).toBeNull();
  const main = button(".main-btn");
  expect(main.getAttribute("shape")).toBe("square");
  expect(main.getAttribute("width")).toBe("wide");
  expect(main.getAttribute("aria-label")).toBe("播放");
  main.click();
  const skips = host.querySelectorAll<HTMLElement>(".skip-btn");
  skips[0].click();
  skips[1].click();
  expect(actions.togglePlay).toHaveBeenCalledTimes(1);
  expect(actions.previous).toHaveBeenCalledTimes(1);
  expect(actions.next).toHaveBeenCalledTimes(1);
  player.playing = true;
  await nextTick();
  expect(main.getAttribute("aria-label")).toBe("暂停");
  expect(main.textContent?.trim()).toBe("pause");
});

it("随机与循环显示受控状态，并保留单曲循环图标", async () => {
  const modes = host.querySelectorAll<HTMLElement>(".ctrl-group.left m3e-icon-button");
  modes[0].click();
  modes[1].click();
  expect(actions.toggleShuffle).toHaveBeenCalledTimes(1);
  expect(actions.cycleRepeat).toHaveBeenCalledTimes(1);
  player.shuffleMode = true;
  player.repeatMode = "one";
  await nextTick();
  expect(modes[0].getAttribute("aria-pressed")).toBe("true");
  expect(modes[1].getAttribute("aria-pressed")).toBe("true");
  expect(modes[1].textContent?.trim()).toBe("repeat_one");
  player.shuffleMode = false;
  player.repeatMode = "off";
  await nextTick();
  expect(modes[0].classList.contains("active")).toBe(false);
  expect(modes[1].getAttribute("aria-pressed")).toBe("false");
});

it("倍速按钮保留完整循环并更新无障碍标签", async () => {
  actions.setPlaybackRate.mockClear();
  const speed = button(".speed");
  for (const rate of [1.5, 2, 0.5, 0.75, 1]) {
    speed.click();
    await nextTick();
    expect(actions.setPlaybackRate).toHaveBeenLastCalledWith(rate);
    expect(speed.textContent?.trim()).toBe(`${rate}x`);
    expect(speed.getAttribute("aria-label")).toBe(`倍速 ${rate}x`);
  }
});

it("工具面板保留队列入口、Escape 与外部点击关闭", async () => {
  const toggle = button(".panel-toggle");
  toggle.click();
  await nextTick();
  expect(toggle.getAttribute("aria-expanded")).toBe("true");
  expect(host.querySelector("#player-tools-panel")).not.toBeNull();
  host.querySelectorAll<HTMLElement>(".seg-btn")[1].click();
  await nextTick();
  expect(host.querySelector(".queue-empty")).not.toBeNull();
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
  await nextTick();
  expect(toggle.getAttribute("aria-expanded")).toBe("false");
  toggle.click();
  await nextTick();
  document.body.dispatchEvent(new Event("pointerdown", { bubbles: true }));
  await nextTick();
  expect(toggle.getAttribute("aria-expanded")).toBe("false");
});

it("迷你播放器保持控制点击隔离，展开按钮仍导航到播放页", async () => {
  app.unmount();
  app = createApp(MiniPlayer);
  app.mount(host);
  const main = button(".play");
  expect(main.getAttribute("shape")).toBe("square");
  expect(main.getAttribute("width")).toBe("wide");
  main.click();
  const skips = host.querySelectorAll<HTMLElement>(".skip");
  skips[0].click();
  skips[1].click();
  expect(actions.togglePlay).toHaveBeenCalledTimes(1);
  expect(actions.previous).toHaveBeenCalledTimes(1);
  expect(actions.next).toHaveBeenCalledTimes(1);
  expect(actions.push).not.toHaveBeenCalled();
  player.playing = true;
  await nextTick();
  expect(main.getAttribute("aria-label")).toBe("暂停");
  button('[title="展开播放器"]').click();
  expect(actions.push).toHaveBeenCalledExactlyOnceWith("/music/player");
});
