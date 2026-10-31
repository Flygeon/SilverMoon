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

it.each([false, true])(
  "applies masonry styling and image proportions only when enabled (%s)",
  async (masonry) => {
    host = document.createElement("div");
    document.body.append(host);
    const item = {
      id: "portrait",
      name: "Portrait",
      type: "image",
      width: 600,
      height: 1200,
    } as MediaEntry;
    app = createApp({ render: () => h(MediaGrid, { items: [item], masonry, aspect: "1" }) });
    app.mount(host);
    await nextTick();
    expect(host.querySelector(".virtual-root")?.classList.contains("mixed-grid")).toBe(masonry);
    const [width, height = 1] = host
      .querySelector<HTMLElement>(".thumb")!
      .style.aspectRatio.split("/")
      .map(Number);
    expect(width / height).toBe(masonry ? 0.5 : 1);
    expect(host.querySelector(".meta")).not.toBeNull();
    expect(host.querySelector(".type-badge")).toBeNull();
  },
);

it.each(["image", "video", "audio", "book"] as const)(
  "shows only the cover and category badge for %s",
  async (type) => {
    host = document.createElement("div");
    document.body.append(host);
    const item = { id: type, name: "Hidden name", type, durationMs: 60000 } as MediaEntry;
    app = createApp({
      render: () => h(MediaGrid, { items: [item], masonry: true, coverOnly: true }),
    });
    app.mount(host);
    await nextTick();
    expect(host.querySelector(".meta")).toBeNull();
    expect(host.querySelector(".badge")).toBeNull();
    expect(host.querySelector(".type-badge")?.textContent?.trim()).toBeTruthy();
    expect(host.querySelector(".virtual-root")?.classList.contains("cover-only")).toBe(true);
    expect(host.querySelector("article")?.getAttribute("aria-label")).toBe(item.name);
  },
);
