/**
 * 最小扩展的前端入口：跑在宿主窗口的 iframe 里。
 *
 * 这个模板故意做成**纯前端扩展**（manifest 里没有 engines）—— 它演示的是：
 * 1. 怎么建桥、怎么知道自己是谁（`bridge.extId` / `__EXT_ID__`）；
 * 2. 怎么读宿主从 iframe 地址带进来的路由（`?route=`）；
 * 3. 怎么把扩展目录里的图片变成可用的 URL（`toAssetHtmlUrl`，走 `ext:` 协议）；
 * 4. 怎么调宿主保留方法（设置项读写）。
 *
 * 想做「有引擎」的扩展，在 manifest.json 里加一段：
 * ```json
 * "engines": { "cmd": "engine/main.py", "args": ["--service"], "supportEnv": "HELLO_DATA_DIR" }
 * ```
 * 然后引擎只需在 stdout 打印 `READY <port>`，桥上的 `invoke("任意方法", payload)`
 * 就会被宿主转发到 `http://127.0.0.1:<port>/任意方法`（POST，body 为 payload）。
 */
import { createExtBridge, readRouteFromLocation, toAssetHtmlUrl } from "@silvermoon/extension-api";

const bridge = createExtBridge();
const route = readRouteFromLocation() ?? "main";

/** 编译期注入的常量（由 silvermoonExtension() 插件写入）；未接插件时为 undefined。 */
const injectedId = typeof __EXT_ID__ !== "undefined" ? __EXT_ID__ : "（未注入，检查 vite 插件）";

const app = document.querySelector<HTMLDivElement>("#app")!;
app.innerHTML = `
  <h1>Hello SilverMoon</h1>
  <p>扩展 id：<code>${bridge.extId}</code>（编译期注入：<code>${injectedId}</code>）</p>
  <p>当前路由：<code>${route}</code></p>
  <p>宿主可达：<code>${bridge.isHostAvailable()}</code></p>
  <button id="save-roots">写一条设置</button>
  <p id="log"></p>
`;

const log = document.querySelector<HTMLParagraphElement>("#log")!;

/**
 * 把扩展目录内的文件转成可加载的 URL。
 *
 * 扩展 UI 走独立自定义协议 `ext:`（不是 `asset:`），所以 **不要**自己拼
 * `asset://localhost/...` —— 那样会掉进与任意 asset 文件同源的旧问题，
 * 新版宿主也会直接拒绝。这里的 `path` 用扩展目录内的相对路径即可。
 */
const iconUrl = toAssetHtmlUrl("assets/icon.png");
void iconUrl; // 模板里没有这个文件，仅作演示；替换成你自己的资源路径

/**
 * 桥上的调用统一是 async 的：宿主 → Rust `ext_invoke` → 扩展引擎（或宿主保留方法）。
 * 失败时抛 `ExtBridgeError`，`code` 与 `message` 都是宿主给的原因。
 */
document.querySelector<HTMLButtonElement>("#save-roots")!.addEventListener("click", async () => {
  log.textContent = "调用中…";
  try {
    // settings:get / settings:set 是宿主保留方法，由宿主就地处理，不转发引擎。
    // 宿主会用 manifest 里 settings.schema[].default 打底，再覆盖已存值。
    await bridge.settings.set({ roots: ["D:/media"] });
    const values = await bridge.settings.get<{ roots?: string[] }>();
    log.textContent = `已保存，当前值：${JSON.stringify(values)}`;
  } catch (e) {
    log.textContent = `调用失败：${(e as Error).message}`;
  }
});

// 宿主若推事件（`{ source: "lumiluna-host", type: "hello:ping", payload }`）会走这里。
const offPing = bridge.on("hello:ping", (payload) => {
  log.textContent = `收到宿主事件：${JSON.stringify(payload)}`;
});

// 开发期热重载时避免监听器堆积
if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    offPing();
    bridge.dispose("热重载");
  });
}
