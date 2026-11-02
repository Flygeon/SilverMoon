// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp, h, nextTick, ref, type App } from "vue";
import MediaCardShell from "../MediaCardShell.vue";
import AnimeCard from "../AnimeCard.vue";
import NovelCard from "../NovelCard.vue";
import NovelSearchBar from "../NovelSearchBar.vue";
import ModalSurface from "../ModalSurface.vue";
import SelectField from "../SelectField.vue";

vi.mock("@/stores/settings", () => ({ useSettingsStore: () => ({ lang: "zh" }) }));
const mounts: { app: App; host: HTMLElement }[] = [];
let background: HTMLElement;

function mount(render: () => ReturnType<typeof h>) {
  const host = document.createElement("div");
  document.body.append(host);
  const app = createApp({ render });
  app.mount(host);
  mounts.push({ app, host });
  return host;
}

beforeEach(() => {
  background = document.createElement("div");
  background.id = "app";
  document.body.append(background);
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    callback(0);
    return 1;
  });
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
});
afterEach(() => {
  for (const { app, host } of mounts.splice(0).reverse()) {
    app.unmount();
    host.remove();
  }
  background.remove();
  document.body.style.overflow = "";
  vi.unstubAllGlobals();
});

describe("共享下拉字段", () => {
  it("选项克隆后保留业务值，变更回传选项值而非显示标签", async () => {
    // 模拟库中不反射到 attribute 的 value 属性；原来的 prop 绑定会在 cloneNode 后丢失。
    if (!customElements.get("m3e-option")) {
      customElements.define(
        "m3e-option",
        class extends HTMLElement {
          value = "";
        },
      );
    }
    const selected = ref("first");
    const host = mount(() =>
      h(SelectField, {
        modelValue: selected.value,
        label: "选择分段",
        options: [
          { value: "first", label: "推荐" },
          { value: "second", label: "搜索" },
        ],
        "onUpdate:modelValue": (value: string) => (selected.value = value),
      }),
    );
    const option = host.querySelectorAll("m3e-option")[1];
    expect((option.cloneNode(true) as HTMLElement).getAttribute("value")).toBe("second");
    const control = host.querySelector("m3e-select") as HTMLElement & { value: string };
    control.value = "second";
    control.dispatchEvent(new Event("change"));
    await nextTick();
    expect(selected.value).toBe("second");
  });
});

/*
 * 媒体卡片契约（2026-11 改版后）：
 * - 容器是官方 m3e-card（actionable），不再是原生 <button>；
 *   键盘激活、焦点环、状态层由组件提供，所以这里不再断言 button.type。
 * - 默认渲染「封面 + 标题 + 副标题」；图片 / 视频这类纯封面卡片传 meta=false。
 */
describe("共享媒体卡片", () => {
  it("失败封面显示占位，新 URL 可以重新加载；卡片继续响应打开", async () => {
    const cover = ref("first.png");
    const open = vi.fn();
    const host = mount(() =>
      h(MediaCardShell, { title: "封面", cover: cover.value, icon: "image", onOpen: open }),
    );
    host.querySelector("img")!.dispatchEvent(new Event("error"));
    await nextTick();
    expect(host.querySelector("img")).toBeNull();
    // 失败后退回图标占位
    expect(host.textContent).toContain("image");
    cover.value = "second.png";
    await nextTick();
    expect(host.querySelector("img")!.getAttribute("src")).toBe("second.png");

    const card = host.querySelector("m3e-card")!;
    card.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(open).toHaveBeenCalledTimes(1);
    // 可交互性由 m3e-card 的 actionable 属性驱动，组件自己管理 tabindex / 键盘激活
    expect(card.hasAttribute("actionable")).toBe(true);
    expect(card.getAttribute("variant")).toBe("filled");
  });

  it("番剧保留条目锚点、Referer 策略和 MouseEvent", () => {
    const open = vi.fn();
    const host = mount(() =>
      h(AnimeCard, { item: { src: "show/1", title: "番剧", cover: "cover.png" }, onOpen: open }),
    );
    const card = host.querySelector("m3e-card")!;
    // data-anime-id 是 AnimeCard 自己透传的选择器锚点，改版后仍须保留
    expect(card.dataset.animeId).toBe("show/1");
    expect(host.querySelector("img")!.getAttribute("referrerpolicy")).toBe("no-referrer");
    card.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(open.mock.calls[0][0]).toBeInstanceOf(MouseEvent);
  });

  it("小说卡片渲染书名与作者，挂在 m3e-card 的 content 槽上", () => {
    const host = mount(() =>
      h(NovelCard, { item: { aid: "1", title: "小说", imageUrl: "", author: "作者" } }),
    );
    const card = host.querySelector("m3e-card")!;
    // 无障碍标签仍然是书名
    expect(card.getAttribute("aria-label")).toBe("小说");
    // 文字区真实存在于 content 槽（书籍需要文字才分得清是哪一本）
    const meta = host.querySelector(".meta")!;
    expect(meta.getAttribute("slot")).toBe("content");
    expect(host.textContent).toContain("小说");
    expect(host.textContent).toContain("作者");
    expect(host.querySelector("img")).toBeNull();
  });

  it("纯封面卡片（meta=false）不渲染任何可见文字", () => {
    const host = mount(() => h(MediaCardShell, { title: "图片标题", meta: false, icon: "image" }));
    expect(host.querySelector(".meta")).toBeNull();
    expect(host.textContent).not.toContain("图片标题");
    // 语义信息仍保留在无障碍属性上
    expect(host.querySelector("m3e-card")!.getAttribute("aria-label")).toBe("图片标题");
  });
});

describe("共享弹层生命周期", () => {
  it("关闭最上层前保留滚动锁，最后关闭还原 overflow、inert 和触发焦点", () => {
    document.body.style.overflow = "scroll";
    background.inert = false;
    const trigger = document.createElement("button");
    background.append(trigger);
    trigger.focus();
    mount(() => h(ModalSurface, { label: "第一层" }, () => h("button", "A")));
    const first = document.activeElement;
    mount(() => h(ModalSurface, { label: "第二层" }, () => h("button", "B")));
    expect(document.body.style.overflow).toBe("hidden");
    expect(background.inert).toBe(true);
    const second = mounts.pop()!;
    second.app.unmount();
    second.host.remove();
    expect(document.body.style.overflow).toBe("hidden");
    expect(document.activeElement).toBe(first);
    const firstMount = mounts.pop()!;
    firstMount.app.unmount();
    firstMount.host.remove();
    expect(document.body.style.overflow).toBe("scroll");
    expect(background.inert).toBe(false);
    expect(document.activeElement).toBe(trigger);
  });
  it("Escape 仅关闭最上层，不消费输入法组合键", () => {
    const closeA = vi.fn();
    const closeB = vi.fn();
    const a = mount(() => h(ModalSurface, { label: "A", onClose: closeA }));
    const b = mount(() => h(ModalSurface, { label: "B", onClose: closeB }));
    a.firstElementChild!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(closeA).not.toHaveBeenCalled();
    b.firstElementChild!.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", isComposing: true }),
    );
    expect(closeB).not.toHaveBeenCalled();
    b.firstElementChild!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(closeB).toHaveBeenCalledTimes(1);
  });
});

describe("在线小说搜索适配", () => {
  it("确认输入法不提交，正常 Enter 只提交一次并裁剪空白；忙碌时不提交", async () => {
    const busy = ref(false);
    const search = vi.fn();
    const host = mount(() => h(NovelSearchBar, { busy: busy.value, onSearch: search }));
    const input = host.querySelector("input")!;
    input.value = "  银月  ";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await nextTick();
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", isComposing: true }));
    expect(search).not.toHaveBeenCalled();
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
    expect(search).toHaveBeenCalledExactlyOnceWith("银月");
    busy.value = true;
    await nextTick();
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
    expect(search).toHaveBeenCalledTimes(1);
  });
});
