// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createApp, h, nextTick, reactive, type App } from "vue";
import BookReader from "../BookReader.vue";

const settings = reactive({
  readerTheme: "sepia",
  readerFont: "system",
  readerFontPct: 100,
  readerLineHeight: 1.8,
  readerParaSpacing: 0,
  pdfReadMode: "single",
  wenku8Node: "cc",
  novelCharset: "gbk",
});
vi.mock("@/stores/settings", () => ({ useSettingsStore: () => settings }));
vi.mock("@/utils/novelCache", () => ({
  novelCatalogueCached: vi.fn(async () => []),
  bqgCatalogueCached: vi.fn(async () => []),
}));
vi.mock("@/capabilities", () => ({
  isDesktop: false,
  capabilities: { novelProgressGet: vi.fn(async () => null) },
}));

let app: App;
let host: HTMLElement;
const close = vi.fn();
beforeEach(async () => {
  vi.clearAllMocks();
  settings.readerTheme = "sepia";
  settings.readerFont = "system";
  settings.readerFontPct = 100;
  host = document.createElement("div");
  document.body.append(host);
  app = createApp({
    render: () =>
      h(BookReader, { novelSource: { aid: "demo", title: "Reader preview" }, onClose: close }),
  });
  app.mount(host);
  await nextTick();
  await Promise.resolve();
  await nextTick();
});
afterEach(() => {
  app.unmount();
  host.remove();
});

function control(label: string) {
  return host.querySelector<HTMLElement>(`m3e-icon-button[aria-label="${label}"]`)!;
}

it("官方缩放操作保持文本字号规则，纸色选择仍使用独立阅读主题", async () => {
  control("放大").click();
  expect(settings.readerFontPct).toBe(104);
  control("缩小").click();
  expect(settings.readerFontPct).toBe(100);
  const swatch = host.querySelector<HTMLButtonElement>('.swatch[aria-label="护眼绿"]')!;
  swatch.click();
  await nextTick();
  expect(settings.readerTheme).toBe("green");
  expect(swatch.getAttribute("aria-pressed")).toBe("true");
  expect(host.querySelector<HTMLElement>(".reader")!.style.getPropertyValue("--reader-bg")).toBe(
    "#d6e3d2",
  );
});

it("字体使用受控 Chip，Escape 先收设置再关闭阅读器", async () => {
  const toggle = control("阅读设置");
  toggle.click();
  await nextTick();
  expect(toggle.getAttribute("aria-expanded")).toBe("true");
  const font = [...host.querySelectorAll<HTMLElement>(".set-chips m3e-filter-chip")].find(
    (chip) => chip.textContent?.trim() === "宋体",
  )!;
  font.click();
  font.click();
  await nextTick();
  expect(settings.readerFont).toBe("serif");
  expect(font.getAttribute("selected")).toBe("true");
  window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
  await nextTick();
  await vi.waitFor(() => expect(host.querySelector(".reader-settings")).toBeNull());
  expect(close).not.toHaveBeenCalled();
  window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
  expect(close).toHaveBeenCalledTimes(1);
});

it("目录保留独立展开态，工具栏关闭仍触发原事件", async () => {
  const toc = control("目录");
  toc.click();
  await nextTick();
  expect(toc.getAttribute("aria-expanded")).toBe("true");
  window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
  await nextTick();
  await vi.waitFor(() => expect(host.querySelector(".toc-panel")).toBeNull());
  expect(close).not.toHaveBeenCalled();
  control("关闭").click();
  expect(close).toHaveBeenCalledTimes(1);
});
