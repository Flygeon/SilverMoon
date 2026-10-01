// @vitest-environment jsdom
/**
 * B 站弹幕显示开关的回归测试。
 *
 * 背景：artplayer-plugin-danmuku 的 `visible` 选项**只在构造时读一次**，之后的
 * 显隐只能靠 `show()` / `hide()`。曾经的实现是 `visible: settings.danmakuEnabled`，
 * 而该设置默认 false —— 结果插件一构造就把自己置成隐藏，且 `load()` 不会把它改回来，
 * 表现为「弹幕功能完全不生效」。
 *
 * 这里把这层第三方行为固定下来：一旦有人把 `visible` 改回跟随设置，测试会失败。
 */
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import Artplayer from "artplayer";
import artplayerPluginDanmuku from "artplayer-plugin-danmuku";

vi.mock("@/capabilities", () => ({ isDesktop: false, capabilities: {} }));

/** 插件内部用 Worker 解压弹幕 XML；测试里给个同步假实现即可。 */
class FakeWorker {
  onmessage: ((e: { data: unknown }) => void) | null = null;
  postMessage(msg: { xml?: string; id?: number }): void {
    const re = /<d p="([^"]*)"[^>]*>([\s\S]*?)<\/d>/g;
    const danmus: { text: string; time: number; mode: number }[] = [];
    let m: RegExpExecArray | null;
    while ((m = re.exec(msg.xml ?? "")) !== null) {
      danmus.push({ text: m[2], time: Number(m[1].split(",")[0]), mode: 4 });
    }
    this.onmessage?.({ data: { danmus, id: msg.id } });
  }
  terminate(): void {
    /* noop */
  }
}

const DANMU = [
  { text: "hello", time: 1, mode: 0 as const },
  { text: "world", time: 2, mode: 0 as const },
];

const PCT = "12.5%" as const;

/** 与 BilibiliVideoView 的插件配置保持一致（除 danmuku 数据源外）。 */
function baseOptions(visible: boolean) {
  return {
    danmuku: () => Promise.resolve([] as typeof DANMU),
    speed: 5,
    opacity: 0.8,
    fontSize: 22,
    margin: [PCT, PCT] as [`${number}%`, `${number}%`],
    mode: 0 as const,
    modes: [0, 1, 2] as [0, 1, 2],
    antiOverlap: true,
    visible,
    emitter: false,
  };
}

function mount(visible: boolean): Artplayer {
  const host = document.createElement("div");
  document.body.appendChild(host);
  return new Artplayer({
    container: host,
    url: "",
    autoplay: false,
    plugins: [artplayerPluginDanmuku(baseOptions(visible))],
  });
}

type Plugin = {
  isHide: boolean;
  option: { visible: boolean };
  load: (data?: typeof DANMU) => Promise<unknown>;
  show: () => void;
  hide: () => void;
};

function pluginOf(art: Artplayer): Plugin {
  return (art as unknown as { plugins: { artplayerPluginDanmuku: Plugin } }).plugins
    .artplayerPluginDanmuku;
}

const wait = (ms = 50) => new Promise((r) => setTimeout(r, ms));

beforeAll(() => {
  // 插件构造时会 new Worker / new ResizeObserver，jsdom 里都没有
  (globalThis as unknown as { Worker: unknown }).Worker = FakeWorker;
  (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  };
});

afterEach(() => {
  document.body.innerHTML = "";
});

describe("B 站弹幕显示开关", () => {
  it("构造时 visible 传设置值(false) 会让弹幕永久隐藏 —— 这正是曾经的 bug", async () => {
    const art = mount(false);
    await wait();
    const p = pluginOf(art);

    expect(p.option.visible).toBe(false);
    // 关键：load 不会把可见性改回来
    await p.load(DANMU);
    expect(p.option.visible).toBe(false);
    art.destroy(false);
  });

  it("修复后的写法（恒 visible:true）能被 load 正常显示", async () => {
    const art = mount(true);
    await wait();
    const p = pluginOf(art);

    expect(p.option.visible).toBe(true);
    await p.load(DANMU);
    expect(p.option.visible).toBe(true);
    art.destroy(false);
  });

  it("show() / hide() 是唯一可靠的显隐手段，且与 isHide 联动", async () => {
    const art = mount(true);
    await wait();
    const p = pluginOf(art);

    p.hide();
    expect(p.option.visible).toBe(false);
    expect(p.isHide).toBe(true);

    // hide() 之后 load 仍保持隐藏（不会自己弹回来）
    await p.load(DANMU);
    expect(p.option.visible).toBe(false);

    p.show();
    expect(p.option.visible).toBe(true);
    expect(p.isHide).toBe(false);
    art.destroy(false);
  });
});
