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
 * 两种卡片形态（产品约定）：
 * - 图片 / 视频：纯封面墙，meta=false，不渲染任何可见文字；
 * - 动漫 / B站 / 音乐 / 书籍等：封面 + 标题（+ 副标题），官方 m3e-card 托底。
 * 这两条断言就是该约定的守卫。
 */
it.each(["image", "video"] as const)(
  "renders %s cards as cover-only without visible text",
  async (type) => {
    const item = {
      id: type,
      name: "Hidden name",
      type,
      durationMs: 60000,
      width: 1920,
      height: 1080,
    } as MediaEntry;
    const root = mount({ items: [item], masonry: true, meta: false });
    await nextTick();

    expect(root.querySelector(".meta")).toBeNull();
    expect(root.querySelector(".title")).toBeNull();
    // 语义信息仍保留在无障碍属性上
    expect(root.querySelector("m3e-card")?.getAttribute("aria-label")).toBe(item.name);
    expect(root.querySelector(".thumb")).not.toBeNull();
  },
);

it.each(["audio", "book"] as const)(
  "renders %s cards with a title and subtitle inside m3e-card",
  async (type) => {
    const item = {
      id: type,
      name: "Visible name",
      type,
      artist: "Some Artist",
    } as MediaEntry;
    const root = mount({ items: [item], subtitle: "artist" });
    await nextTick();

    // 文字区存在，且挂在官方卡片的 content 槽上
    const meta = root.querySelector(".meta");
    expect(meta).not.toBeNull();
    expect(meta?.getAttribute("slot")).toBe("content");
    expect(meta?.querySelector(".title")?.textContent?.trim()).toBe("Visible name");
    expect(meta?.querySelector(".subtitle")?.textContent?.trim()).toBe("Some Artist");
  },
);

it("uses the official m3e-card surface instead of a hand-rolled container", async () => {
  const item = { id: "one", name: "One", type: "image" } as MediaEntry;
  const root = mount({ items: [item] });
  await nextTick();

  const card = root.querySelector("m3e-card");
  expect(card).not.toBeNull();
  expect(card?.hasAttribute("actionable")).toBe(true);
  expect(card?.getAttribute("variant")).toBe("filled");
  // 原生 button / article 容器已退出，交互由组件接管
  expect(root.querySelector("article")).toBeNull();
  expect(root.querySelector("button")).toBeNull();
  // 封面走 header 槽
  expect(root.querySelector(".thumb")?.getAttribute("slot")).toBe("header");
});
