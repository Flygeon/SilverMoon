// @vitest-environment jsdom
/**
 * useLazyCover 的单测。
 *
 * 这个 composable 的难点全在「何时该把 src 写进 img」这个时序上：
 * 早一帧浪费流量、晚一帧用户看到空白。所以测试直接断言 shouldLoad 的翻转时机，
 * 而不是断言 DOM 结构。
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { createApp, defineComponent, h, nextTick } from "vue";
import { DEFAULT_COVER_ROOT_MARGIN, useLazyCover } from "@/composables/useLazyCover";

/** 可控的 IntersectionObserver 桩：把回调存起来，测试里手动触发 */
class FakeIO {
  static instances: FakeIO[] = [];
  callback: IntersectionObserverCallback;
  options?: IntersectionObserverInit;
  observed: Element[] = [];
  disconnected = false;

  constructor(cb: IntersectionObserverCallback, options?: IntersectionObserverInit) {
    this.callback = cb;
    this.options = options;
    FakeIO.instances.push(this);
  }
  observe(el: Element) {
    this.observed.push(el);
  }
  unobserve(el: Element) {
    this.observed = this.observed.filter((x) => x !== el);
  }
  disconnect() {
    this.disconnected = true;
  }
  takeRecords(): IntersectionObserverEntry[] {
    return [];
  }

  /** 模拟元素进入预取范围 */
  trigger(isIntersecting = true) {
    this.callback(
      [{ isIntersecting } as IntersectionObserverEntry],
      this as unknown as IntersectionObserver,
    );
  }
}

function mountWith(composableFactory: () => ReturnType<typeof useLazyCover>) {
  let api!: ReturnType<typeof useLazyCover>;
  const Comp = defineComponent({
    setup() {
      api = composableFactory();
      return () => h("div", { ref: api.el });
    },
  });
  const host = document.createElement("div");
  document.body.appendChild(host);
  const app = createApp(Comp);
  app.mount(host);
  return { api, app, host };
}

beforeEach(() => {
  FakeIO.instances = [];
  vi.stubGlobal("IntersectionObserver", FakeIO);
});

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

describe("useLazyCover", () => {
  it("默认不加载，等 IntersectionObserver 判定进入预取范围", async () => {
    const { api, app } = mountWith(() => useLazyCover());
    await nextTick();

    expect(api.shouldLoad.value).toBe(false);
    expect(FakeIO.instances).toHaveLength(1);
    // 未相交：保持不加载
    FakeIO.instances[0].trigger(false);
    await nextTick();
    expect(api.shouldLoad.value).toBe(false);
    // 相交：开始加载，并立刻断开观察（图片只加载一次）
    FakeIO.instances[0].trigger(true);
    await nextTick();
    expect(api.shouldLoad.value).toBe(true);
    expect(FakeIO.instances[0].disconnected).toBe(true);
    app.unmount();
  });

  it("预取距离是视图外 400px（约两行），而不是浏览器默认的 1250px", () => {
    mountWith(() => useLazyCover());
    expect(FakeIO.instances[0].options?.rootMargin).toBe(DEFAULT_COVER_ROOT_MARGIN);
    expect(DEFAULT_COVER_ROOT_MARGIN).toBe("0px 0px 400px 0px");
  });

  it("eager 模式跳过观察，首屏关键图直接加载", async () => {
    const { api, app } = mountWith(() => useLazyCover({ eager: true }));
    await nextTick();
    expect(api.shouldLoad.value).toBe(true);
    expect(FakeIO.instances).toHaveLength(0);
    app.unmount();
  });

  it("没有 IntersectionObserver 时退化为直接加载（宁可多下也不要空白）", async () => {
    vi.stubGlobal("IntersectionObserver", undefined);
    const { api, app } = mountWith(() => useLazyCover());
    await nextTick();
    expect(api.shouldLoad.value).toBe(true);
    app.unmount();
  });

  it("加载失败也收起骨架屏（否则会一直闪）", async () => {
    const { api, app } = mountWith(() => useLazyCover({ eager: true }));
    await nextTick();
    expect(api.loaded.value).toBe(false);
    api.onError();
    expect(api.failed.value).toBe(true);
    expect(api.loaded.value).toBe(true);
    app.unmount();
  });

  it("卸载时断开观察，避免泄漏", async () => {
    const { app } = mountWith(() => useLazyCover());
    await nextTick();
    const io = FakeIO.instances[0];
    app.unmount();
    expect(io.disconnected).toBe(true);
  });
});
