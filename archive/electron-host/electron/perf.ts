/**
 * Chromium / V8 运行时调优开关（P3）。
 *
 * ## 为什么单独一个模块
 *
 * 这些开关是 **Chromium 启动参数**，必须在 `app ready` **之前**设置；而
 * `electron/main.ts` 的启动顺序本身有依赖关系（协议注册 → 路径解析 → ready），
 * 把 appendSwitch 混进那段容易在后续重构中被挪到错误位置、静默失效。
 * 集中在这里，`main.ts` 顶部显式调用一次，并有单测钉住取值规则。
 *
 * ## 三个开关
 *
 * | 开关 | 作用 | 默认 |
 * |---|---|---|
 * | `js-flags=--max-old-space-size=N` | 给 V8 老生代设**上限**：超限提前 GC，而不是一路涨 | **2048 MB** |
 * | `disable-features=BackForwardCache` | 关掉 Chromium 的前进后退缓存（它会把整页 DOM 钉在内存里） | **开启** |
 * | `renderer-process-limit=N` | 限制渲染进程数上限 | **关闭**（见下） |
 *
 * ## 为什么 `renderer-process-limit` 默认关闭
 *
 * 它是**唯一一个会削弱安全模型**的开关：强制渲染进程合并会绕开 Chromium 的
 * 站点隔离，可能让远程页（番剧取流 / Pixiv 登录 / 文库8 登录）与自家 `app://`
 * 前端共享同一个渲染进程。本项目刚把远程页的 IPC 收紧（见 `electron/ipc.ts` 的
 * `REMOTE_WINDOW_ALLOWED_COMMANDS`），不能再用一个开关把它抵消掉。
 * 因此只在用户显式设置环境变量时启用，且必须自己承担风险。
 *
 * 真正「收敛渲染进程数」的正确做法是**不创建多余窗口**——本项目已经做到：
 * 番剧取流窗改为按需创建（`backend/src/anime.rs` 的 `ensure_webview`），
 * 桌面歌词 / 扩展宿主都只在用户打开时才建（`electron/ipc.ts` 调用 `createChildWindow`），
 * 启动时没有任何预建的隐藏窗口。
 *
 * ## 环境变量（都可不设）
 *
 * - `SILVERMOON_JS_HEAP_MB`：V8 老生代上限（MB）。`0` = 不设置；过小值会回落到默认。
 * - `SILVERMOON_DISABLE_BFCACHE`：`0` = 保留 BFCache（不关）。
 * - `SILVERMOON_RENDERER_PROCESS_LIMIT`：正整数 = 启用进程数上限（见上面的风险）。
 */

/** V8 老生代默认上限（MB）。 */
export const DEFAULT_JS_HEAP_MB = 2048;
/** 上限的最小可用值：再小会让大媒体库页面频繁 GC / OOM。 */
export const MIN_JS_HEAP_MB = 512;

/** 解析出的开关计划（`null` 表示不设置该项）。 */
export interface PerfSwitchPlan {
  /** `js-flags` 的值 */
  jsFlags: string | null;
  /** `disable-features` 的值 */
  disableFeatures: string | null;
  /** `renderer-process-limit` 的值 */
  rendererProcessLimit: number | null;
}

/** 只依赖 `appendSwitch`，因此可注入假实现做单测（不必真的起 Electron）。 */
export interface CommandLineLike {
  appendSwitch(name: string, value?: string): void;
}

/**
 * 把环境变量解析成开关计划。**纯函数**。
 *
 * 规则：
 * - 未设 / 空串 → 用默认值；
 * - 非法值（非数字、低于下限）→ 回落到默认值，**不抛异常**（启动参数不该让应用起不来）；
 * - `SILVERMOON_JS_HEAP_MB=0` → 显式不设置（留给需要无上限的场景）。
 */
export function resolvePerfSwitches(env: Record<string, string | undefined>): PerfSwitchPlan {
  const rawHeap = env.SILVERMOON_JS_HEAP_MB;
  let jsFlags: string | null = `--max-old-space-size=${DEFAULT_JS_HEAP_MB}`;
  if (rawHeap !== undefined && rawHeap.trim() !== "") {
    const mb = Number.parseInt(rawHeap, 10);
    if (mb === 0) {
      jsFlags = null;
    } else if (Number.isFinite(mb) && mb >= MIN_JS_HEAP_MB) {
      jsFlags = `--max-old-space-size=${mb}`;
    }
    // 其余（NaN / 负数 / 过小）保持默认值
  }

  const rawBf = env.SILVERMOON_DISABLE_BFCACHE;
  const disableFeatures = rawBf === "0" ? null : "BackForwardCache";

  const rawLimit = env.SILVERMOON_RENDERER_PROCESS_LIMIT;
  let rendererProcessLimit: number | null = null;
  if (rawLimit !== undefined && rawLimit.trim() !== "") {
    const n = Number.parseInt(rawLimit, 10);
    if (Number.isFinite(n) && n >= 1) rendererProcessLimit = n;
  }

  return { jsFlags, disableFeatures, rendererProcessLimit };
}

/**
 * 应用开关。**必须在 `app.whenReady()` 之前调用**，否则 Chromium 已启动、参数无效。
 *
 * @returns 实际应用的计划（供启动日志记录，便于排查"开关到底生效没有"）
 */
export function applyPerfSwitches(
  cmd: CommandLineLike,
  env: Record<string, string | undefined>,
): PerfSwitchPlan {
  const plan = resolvePerfSwitches(env);
  if (plan.jsFlags) cmd.appendSwitch("js-flags", plan.jsFlags);
  if (plan.disableFeatures) cmd.appendSwitch("disable-features", plan.disableFeatures);
  if (plan.rendererProcessLimit !== null) {
    cmd.appendSwitch("renderer-process-limit", String(plan.rendererProcessLimit));
  }
  return plan;
}

/** 把计划格式化成一行，供启动日志使用。 */
export function describePerfSwitches(plan: PerfSwitchPlan): string {
  const parts: string[] = [];
  parts.push(plan.jsFlags ? `js-flags=${plan.jsFlags}` : "js-flags=off");
  parts.push(plan.disableFeatures ? `disable-features=${plan.disableFeatures}` : "bfcache=on");
  parts.push(
    plan.rendererProcessLimit === null
      ? "renderer-process-limit=off"
      : `renderer-process-limit=${plan.rendererProcessLimit}`,
  );
  return parts.join(" | ");
}
