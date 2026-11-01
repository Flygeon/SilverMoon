// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { createApp, h, nextTick, type App } from "vue";
import MediaGrid from "../MediaGrid.vue";
import type { MediaEntry } from "@shared/types";

vi.mock("@/stores/library", () => ({
  useLibraryStore: () => ({ getThumb: () => undefined, loadThumbnails: vi.fn() }),
}));
vi.mock("@/stores/settings", () => ({ useSettingsStore: () => ({ lang: "en" }) }));
vi.mock("@/stores/desktop", () => ({ useDesktopStore: () => ({}) }));
vi.mock("@/capabilities", () => ({ capabilities: {} }));
vi.mock("@/composables/useContextMenu", () => ({ openContextMenu: vi.fn() }));
vi.mock("@/composables/useMusicTagDialog", () => ({
  localTagTarget: vi.fn(),
  openMusicTagDialog: vi.fn(),
}));

let app: App | undefined;
let host: HTMLElement | undefined;
afterEach(() => {
  app?.unmount();
  host?.remove();
});

type GridProps = InstanceType<typeof MediaGrid>["$props"];

function mount(props: GridProps) {
  host = document.createElement("div");
  document.body.append(host);
  app = createApp({ render: () => h(MediaGrid, props) });
  app.mount(host);
  return host;
}

it.each([false, true])(
  "applies masonry styling and image proportions only when enabled (%s)",
  async (masonry) => {
    const item = {
      id: "portrait",
      name: "Portrait",
      type: "image",
      width: 600,
      height: 1200,
    } as MediaEntry;
    const root = mount({ items: [item], masonry, aspect: "1" });
    await nextTick();
    expect(root.querySelector(".virtual-root")?.classList.contains("mixed-grid")).toBe(masonry);
    const [width, height = 1] = root
      .querySelector<HTMLElement>(".thumb")!
      .style.aspectRatio.split("/")
      .map(Number);
    expect(width / height).toBe(masonry ? 0.5 : 1);
  },
);

/**
 * 媒体卡片的新契约：只有封面，没有可见文字。
 *
 * 此前卡片在封面下渲染文件名 + 分辨率（.meta / .subtitle），并按类型渲染角标。
 * 现在这几块整体移除，标题只保留在 aria-label 上供读屏使用 ——
 * 这是产品决定，不是回归，所以断言方向与旧版相反。
 */
it.each(["image", "video", "audio", "book"] as const)(
  "renders %s cards as cover-only without any visible text",
  async (type) => {
    const item = {
      id: type,
      name: "Hidden name",
      type,
      durationMs: 60000,
      width: 1920,
      height: 1080,
    } as MediaEntry;
    const root = mount({ items: [item], masonry: true });
    await nextTick();

    // 文字区整体消失：文件名、分辨率、时长角标、类型角标都不再渲染
    expect(root.querySelector(".meta")).toBeNull();
    expect(root.querySelector(".subtitle")).toBeNull();
    expect(root.querySelector(".badge")).toBeNull();
    expect(root.querySelector(".type-badge")).toBeNull();

    // 封面仍在，并且语义信息转移到无障碍属性上
    expect(root.querySelector(".thumb")).not.toBeNull();
    expect(root.querySelector("m3e-card")?.getAttribute("aria-label")).toBe(item.name);
  },
);

it("uses the official m3e-card surface instead of a hand-rolled container", async () => {
  const item = { id: "one", name: "One", type: "image" } as MediaEntry;
  const root = mount({ items: [item] });
  await nextTick();

  const card = root.querySelector("m3e-card");
  expect(card).not.toBeNull();
  // 可交互卡片由组件自己提供状态层 / 焦点环 / 键盘激活
  expect(card?.hasAttribute("actionable")).toBe(true);
  expect(card?.getAttribute("variant")).toBe("filled");
  // 原生 button / article 容器已退出
  expect(root.querySelector("article")).toBeNull();
  expect(root.querySelector("button")).toBeNull();
});
