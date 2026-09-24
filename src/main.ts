import { createApp } from "vue";
import { createPinia } from "pinia";
import App from "./App.vue";
import router from "./router";
// 字体声明必须先于主题令牌引入：theme.css 只声明字体栈，字形由 fonts.css 提供
import "@/tokens/fonts.css";
import "@/tokens/theme.css";
// @m3e/web 原生组件按需注册（连通按钮组 / 连通列表）
import "@/m3e";

// 全局全局错误处理：将 Vue 渲染错误、window JS 错误、未捕获 Promise 异常
// 写入 lumiluna_login_debug.log（与 wenku8 登录日志共享同一文件），
// 用于诊断“点击书籍闪退”这类在崩溃前无法打开 devtools 的场景。
function safeStringify(v: unknown): string {
  if (v instanceof Error) return v.stack || v.message || String(v);
  if (typeof v === "string") return v;
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}
async function reportError(tag: string, payload: Record<string, unknown>) {
  try {
    const { capabilities } = await import("@/capabilities");
    await capabilities.appLog(`[${tag}] ${safeStringify(payload)}`);
  } catch {
    /* 忽略——不能在错误处理路径里再抛 */
  }
}

const app = createApp(App);
app.use(createPinia());
app.use(router);

// Vue 渲染/生命周期错误
app.config.errorHandler = (err, instance, info) => {
  void reportError("vue-err", {
    err: safeStringify(err),
    info,
    component: (instance?.$options as { name?: string } | undefined)?.name ?? null,
  });
};

// 未捕获的 JS 错误（同步）
window.addEventListener("error", (e) => {
  void reportError("window-err", {
    message: e.message,
    src: `${e.filename}:${e.lineno}:${e.colno}`,
    stack: e.error instanceof Error ? e.error.stack : null,
  });
});

// 未捕获的 Promise 异常
window.addEventListener("unhandledrejection", (e) => {
  const reason = e.reason;
  // AbortError 永远是「主动取消」（路由切换 / 重复点击 / 组件卸载时浏览器或
  // hls.js 中断在途请求），属良性，不应刷屏误导用户以为崩了；直接吞掉，
  // 但仍写日志文件备查。其它异常才如实上报。
  if (reason instanceof Error && reason.name === "AbortError") {
    e.preventDefault();
    return;
  }
  // Error.cause 需要 ES2022 lib，这里用宽松类型访问，避免改动全局 tsconfig
  const cause = (reason as { cause?: unknown } | null)?.cause;
  void reportError("unhandledrejection", {
    message: reason instanceof Error ? reason.message : String(reason),
    name: reason instanceof Error ? reason.name : null,
    stack: reason instanceof Error ? (reason.stack ?? null) : null,
    cause:
      cause instanceof Error
        ? (cause.stack ?? cause.message)
        : typeof cause === "string"
          ? cause
          : null,
  });
  // 开发态直接在控制台打印，方便复现时一眼看到抛出点
  if (import.meta.env.DEV) console.error("[unhandledrejection]", reason);
});

app.mount("#app");

// 启动加载动画收尾：Vue 挂载后让 index.html 里的 splash 淡出并移除。
// transitionend 在个别 webview 里可能不触发，加超时兜底强制移除。
const splash = document.getElementById("boot-splash");
if (splash) {
  requestAnimationFrame(() => {
    splash.classList.add("boot-splash--leaving");
    splash.addEventListener("transitionend", () => splash.remove(), { once: true });
    window.setTimeout(() => splash.remove(), 1000);
  });
}
