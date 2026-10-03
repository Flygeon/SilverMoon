import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * AmllLyricsView 接入 AMLL 官方组件时的契约测试。
 *
 * 这几条都是「写错了不会报错、但运行时会静默坏掉」的地方，组件跑起来的完整行为没法在
 * jsdom 里量（AMLL 依赖 ResizeObserver + Web Animations），所以按项目既有做法
 * （见 components/__tests__/lyricsTransition.test.ts）用源码断言把契约钉住。
 */

const SRC = readFileSync(resolve(process.cwd(), "src/components/AmllLyricsView.vue"), "utf8");
const VITE_CONFIG = readFileSync(resolve(process.cwd(), "vite.config.ts"), "utf8");

describe("AmllLyricsView 与 AMLL 的接入契约", () => {
  it("监听 AMLL 自定义的 line-click，而不是原生 click", () => {
    // AMLL 把原生 click 包装成 LyricLineMouseEvent 后以 `line-${type}` 派发；
    // 监听原生 click 会拿到没有 lineIndex 的事件，点击跳转静默失效。
    expect(SRC).toContain('addEventListener("line-click"');
    expect(SRC).toContain('removeEventListener("line-click"');
    expect(SRC).not.toContain('addEventListener("click"');
  });

  it("点击跳转走下标映射，而不是直接用 AMLL 的 lineIndex", () => {
    // 适配器丢弃了间奏三点行、又插入了和声行，两边下标不等价。
    expect(SRC).toContain("lineIndexMap[e.lineIndex]");
    expect(SRC).toContain("indexMap");
  });

  it("关掉 AMLL 自己的遮蔽：文本已在 store 里遮好了，否则二次遮蔽", () => {
    expect(SRC).toContain("MaskObsceneWordsMode.Disabled");
  });

  it("每帧推送进度并调用 update（AMLL 的 DOM 播放器不自带 rAF）", () => {
    expect(SRC).toContain("setCurrentTime(");
    expect(SRC).toContain("lp.update(delta)");
  });

  it("播放状态在挂载时同步一次（漏了会把正常播放误判成持续跳转）", () => {
    expect(SRC).toMatch(/if \(player\.playing\) lp\.resume\(\)/);
  });

  it("AMLL 样式表必须显式引入（包不做自动注入）", () => {
    expect(SRC).toContain('import "@applemusic-like-lyrics/core/style.css"');
  });
});

describe("构建配置：AMLL 样式不能被入口预加载", () => {
  it("CSS 不参与 amll-bg 手动分包", () => {
    // 入口 chunk 静态引用 amll-bg（Rollup 的 ESM 互操作助手在里面），
    // 一旦 AMLL 的 style.css 被并进 amll-bg，index.html 就会预加载它，
    // 「切到 AMLL 引擎才加载 AMLL 样式」的按需加载失效。
    expect(VITE_CONFIG).toContain('if (id.endsWith(".css")) return undefined;');
  });
});
