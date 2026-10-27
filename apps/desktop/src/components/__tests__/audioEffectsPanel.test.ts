// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createApp, h, nextTick, type App } from "vue";
import AudioEffectsPanel from "../AudioEffectsPanel.vue";

const effects = vi.hoisted(() => ({
  config: { enabled: true, presetId: "user", eqBands: [], bassBoost: 0, reverb: 0, stereoWidth: 0 },
  builtinPresets: [],
  userPresets: [{ id: "user", name: "测试预设" }],
  saveUserPreset: vi.fn(),
  importUserPreset: vi.fn(() => true),
  exportUserPreset: vi.fn(() => ["示例码", "LLFX3:example"]),
}));
vi.mock("@/stores/audioEffects", () => ({ useAudioEffectsStore: () => effects }));
vi.mock("@/stores/settings", () => ({ useSettingsStore: () => ({ lang: "en" }) }));
vi.mock("@/capabilities", () => ({ capabilities: { openUrl: vi.fn() }, isDesktop: false }));
vi.mock("@/ipc/dialog", () => ({ save: vi.fn() }));
vi.mock("@/ipc/fs", () => ({ writeTextFile: vi.fn() }));

let app: App;
let host: HTMLElement;
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    callback(0);
    return 1;
  });
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
  host = document.createElement("div");
  host.id = "app";
  document.body.append(host);
  app = createApp({ render: () => h(AudioEffectsPanel) });
  app.mount(host);
});
afterEach(() => {
  app.unmount();
  host.remove();
  vi.unstubAllGlobals();
});

it("输入法确认不保存预设，正常 Enter 只保存一次并清空名称", async () => {
  const input = host.querySelector<HTMLInputElement>(".save-preset input")!;
  input.value = "新预设";
  input.dispatchEvent(new Event("input", { bubbles: true }));
  await nextTick();
  input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", isComposing: true }));
  expect(effects.saveUserPreset).not.toHaveBeenCalled();
  input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
  await nextTick();
  expect(effects.saveUserPreset).toHaveBeenCalledExactlyOnceWith("新预设");
  expect(input.value).toBe("");
});

it("官方导入字段保留分享码并只导入一次", async () => {
  const input = host.querySelector<HTMLInputElement>(".import-preset m3e-form-field input")!;
  input.value = "LLFX3:example";
  input.dispatchEvent(new Event("input", { bubbles: true }));
  await nextTick();
  input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
  await nextTick();
  expect(effects.importUserPreset).toHaveBeenCalledExactlyOnceWith("LLFX3:example");
  expect(input.value).toBe("");
});

it("分享切换上传保留同一弹层，Escape 关闭后恢复背景与原触发器", async () => {
  const trigger = host.querySelector<HTMLElement>(".preset-action")!;
  trigger.tabIndex = 0;
  trigger.focus();
  trigger.click();
  await nextTick();
  const surface = document.querySelector<HTMLElement>('.popup-card[role="dialog"]')!;
  expect(surface).not.toBeNull();
  expect(host.inert).toBe(true);
  expect(document.body.style.overflow).toBe("hidden");
  surface.querySelectorAll<HTMLElement>(".popup-actions m3e-button")[1].click();
  await nextTick();
  expect(document.querySelector(".popup-card")).toBe(surface);
  expect(document.activeElement).toBe(surface);
  expect(surface.querySelectorAll("m3e-form-field")).toHaveLength(3);
  expect(surface.querySelector(".popup-close")?.getAttribute("aria-label")).toBe("Close");
  surface.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  await nextTick();
  expect(document.querySelector(".popup-card")).toBeNull();
  expect(host.inert).toBe(false);
  expect(document.body.style.overflow).toBe("");
  expect(document.activeElement).toBe(trigger);
});
