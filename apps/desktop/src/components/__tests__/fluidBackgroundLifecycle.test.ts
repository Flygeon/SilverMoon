// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createApp, h, nextTick, reactive, type App } from "vue";
import FluidBackground from "../FluidBackground.vue";

const settings = reactive({ playerBg: "animated" });
const player = reactive({ song: { cover: "/cover.jpg" } });
vi.mock("@/stores/settings", () => ({ useSettingsStore: () => settings }));
vi.mock("@/stores/player", () => ({ usePlayerStore: () => player }));

class FakeImage {
  width = 200;
  height = 200;
  src = "";
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  removeAttribute = vi.fn();
  constructor() {
    images.push(this);
  }
}
let images: FakeImage[];
let hidden: boolean;
let frames: Map<number, FrameRequestCallback>;
let sequence: number;
let app: App;
let host: HTMLElement;

async function settle() {
  await nextTick();
  await nextTick();
}
function frame() {
  const callbacks = [...frames.values()];
  frames.clear();
  callbacks.forEach((callback) => callback(16));
}
async function visibility(value: boolean) {
  hidden = value;
  document.dispatchEvent(new Event("visibilitychange"));
  await settle();
}
beforeEach(() => {
  images = [];
  hidden = false;
  frames = new Map();
  sequence = 0;
  settings.playerBg = "animated";
  vi.spyOn(document, "hidden", "get").mockImplementation(() => hidden);
  vi.stubGlobal("Image", FakeImage);
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    frames.set(++sequence, callback);
    return sequence;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
    drawImage: vi.fn(),
    setTransform: vi.fn(),
    clearRect: vi.fn(),
    save: vi.fn(),
    translate: vi.fn(),
    rotate: vi.fn(),
    restore: vi.fn(),
  } as unknown as CanvasRenderingContext2D);
  host = document.createElement("div");
  document.body.append(host);
});
afterEach(() => {
  app?.unmount();
  host.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("releases the canvas and frame loop when hidden, recreating only once when shown", async () => {
  app = createApp({ render: () => h(FluidBackground) });
  app.mount(host);
  await settle();
  images[0].onload?.();
  frame();
  frame();
  const canvas = host.querySelector("canvas")!;
  expect(canvas.width).toBeGreaterThan(0);
  expect(frames.size).toBe(1);
  await visibility(true);
  expect(canvas.width).toBe(0);
  expect(host.querySelector("canvas")).toBeNull();
  expect(frames.size).toBe(0);
  await visibility(false);
  expect(images).toHaveLength(2);
  images[1].onload?.();
  frame();
  frame();
  expect(frames.size).toBe(1);
  app.unmount();
  expect(frames.size).toBe(0);
});

it("does not load or render covers when mounted in the tray", async () => {
  hidden = true;
  app = createApp({ render: () => h(FluidBackground) });
  app.mount(host);
  await settle();
  expect(images).toHaveLength(0);
  expect(host.querySelector("canvas")).toBeNull();
  expect(frames.size).toBe(0);
});

it("ignores a stale image callback after hiding the window", async () => {
  app = createApp({ render: () => h(FluidBackground) });
  app.mount(host);
  await settle();
  const stale = images[0].onload!;
  await visibility(true);
  expect(images[0].onload).toBeNull();
  stale();
  frame();
  expect(frames.size).toBe(0);
  expect(host.querySelector("canvas")).toBeNull();
});

it("releases old tile backing stores on resize and repeated tray cycles", async () => {
  app = createApp({ render: () => h(FluidBackground) });
  app.mount(host);
  await settle();
  images[0].onload?.();
  frame();
  frame();
  const { contexts } = vi.mocked(HTMLCanvasElement.prototype.getContext).mock;
  const canvases = contexts as HTMLCanvasElement[];
  const oldTiles = canvases.filter((canvas) => canvas !== host.querySelector("canvas"));
  expect(oldTiles).toHaveLength(4);
  window.dispatchEvent(new Event("resize"));
  expect(oldTiles.every((tile) => tile.width === 0 && tile.height === 0)).toBe(true);
  for (let i = 0; i < 5; i++) {
    await visibility(true);
    expect(frames.size).toBe(0);
    expect(canvases.every((canvas) => canvas.width === 0 && canvas.height === 0)).toBe(true);
    await visibility(false);
    images.at(-1)!.onload?.();
    frame();
    frame();
    expect(frames.size).toBe(1);
  }
});

it("cancels pending cover loads when switching modes", async () => {
  app = createApp({ render: () => h(FluidBackground) });
  app.mount(host);
  await settle();
  const stale = images[0].onload!;
  settings.playerBg = "off";
  await settle();
  expect(images[0].onload).toBeNull();
  expect(images[0].removeAttribute).toHaveBeenCalledWith("src");
  stale();
  frame();
  expect(frames.size).toBe(0);
  expect(host.querySelector("canvas")).toBeNull();
});

it("cancels delayed startup frames when hidden before the loop starts", async () => {
  app = createApp({ render: () => h(FluidBackground) });
  app.mount(host);
  await settle();
  images[0].onload?.();
  expect(frames.size).toBe(1);
  await visibility(true);
  expect(frames.size).toBe(0);
});

it("does not start a cover request after unmount during initialization", async () => {
  app = createApp({ render: () => h(FluidBackground) });
  app.mount(host);
  app.unmount();
  await settle();
  expect(images).toHaveLength(0);
  expect(frames.size).toBe(0);
});
