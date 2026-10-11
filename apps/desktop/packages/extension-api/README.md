# @silvermoon/extension-api

银月（SilverMoon）**扩展作者 SDK**：manifest 类型 + 宿主 iframe 桥客户端 + Vite 构建插件。

对应扩展框架契约 **v2**（`EXT_API_VERSION = 2.0.0`）。
源码即包：`exports` 直接指向 `src/*.ts`，用 Vite / `tsc` 的项目零配置可用。

---

## 一、一个扩展长什么样

扩展就是一个目录，宿主把它整份复制到 `<appData>/extensions/<id>/`：

```text
my-extension/
├── manifest.json          宿主安装/加载时读它（必需）
├── engine/                可选：扩展私有引擎（一个进程，宿主负责拉起）
│   └── main.py
├── web/dist/              可选：扩展前端产物（宿主在 iframe 里加载）
│   └── index.html
├── themes/                可选：皮肤（skin.json）
│   └── sakura/skin.json
└── data/                  运行时由引擎写入（宿主自动创建，不要打包）
```

三种形态可以任意组合：

| 形态   | 声明                 | 能力                                                 |
| ------ | -------------------- | ---------------------------------------------------- |
| 纯前端 | `web`                | 一个窗口，UI 里通过桥调宿主                          |
| 有引擎 | `engines`            | 一个本地 HTTP 服务，宿主把 `invoke("方法")` 转发给它 |
| 皮肤   | `contributes.themes` | 往主程序里注入一套主题（装皮肤 = 装扩展）            |

## 二、最小上手

```bash
cp -r node_modules/@silvermoon/extension-api/templates/minimal my-extension
cd my-extension && npm install && npm run build
```

`manifest.json`：

```json
{
  "id": "hello-silvermoon",
  "name": "Hello SilverMoon",
  "version": "0.1.0",
  "minHostVersion": ">=2.0.0",
  "web": { "dist": "web/dist", "defaultRoute": "main" },
  "permissions": ["ext:invoke"],
  "contributes": {
    "windows": [
      {
        "route": "main",
        "title": "Hello",
        "width": 720,
        "height": 480,
        "alwaysOnTop": false,
        "decorations": true
      }
    ]
  }
}
```

`vite.config.ts`：

```ts
import { defineConfig } from "vite";
import { silvermoonExtension } from "@silvermoon/extension-api/vite";

export default defineConfig({ plugins: [silvermoonExtension()] });
```

`src/main.ts`：

```ts
import { createExtBridge } from "@silvermoon/extension-api";

// 自动从 iframe 地址的 ?ext=<扩展 id> 认出自己是谁
const bridge = createExtBridge();

// 调扩展自己的引擎：宿主会 POST 到 http://127.0.0.1:<port>/search
const page = await bridge.invoke<{ items: string[] }>("search", { q: "关键词", limit: 20 });

// 由宿主代执行「打开文件」（需要 opener:open-path 权限）
await bridge.open("D:/media/movie.mp4", { ts: 95 });
```

把整个目录打包成 zip，「扩展」页安装即可。

## 三、清单字段（`manifest.json`）

字段一律 **camelCase**（宿主 Rust 侧 `rename_all = "camelCase"`，蛇形名会被静默忽略）。

| 字段                 | 必填 | 说明                                                                         |
| -------------------- | ---- | ---------------------------------------------------------------------------- |
| `id`                 | ✅   | 唯一标识，同时是安装目录名与桥 `source` 的一部分                             |
| `name`               | ✅   | 显示名                                                                       |
| `version`            |      | 建议 SemVer；宿主**目前只展示，不比较**                                      |
| `author` / `license` |      | 纯展示                                                                       |
| `minHostVersion`     |      | semver 区间，比的是**扩展 API 版本**（见下）                                 |
| `engines`            |      | `{ cmd, args?, supportEnv?, readyLine? }`                                    |
| `web`                |      | `{ dist?, defaultRoute? }`，`dist` 缺省 `web/dist`                           |
| `contributes`        |      | `{ windows?, hotkeys?, tray?, settings?, themes? }`                          |
| `permissions`        |      | **省略 = legacy 放行**；一旦声明就逐项严格校验                               |
| `activationEvents`   |      | `onStartup` / `onHotkey` / `onTray` / `onInvoke`；**省略 = `["onStartup"]`** |

### ⚠️ `minHostVersion` 比的是扩展 API 版本

不是产品版本号（产品是 `0.1.0`，扩展 API 是 `2.0.0`）。这与 VS Code 的 `engines.vscode` 同一套思路。
所以正确写法是 `">=2.0.0"`；写 `"*"` 会被**明确拒绝**（逼作者给真实区间）；
不满足时安装当场失败（`incompatibleReason` 会说明差在哪）。

### 引擎握手

引擎由宿主用 `<扩展目录>/<cmd>` 拉起，若 `cmd` 以 `.py` 结尾则用系统 Python 解释器；
`supportEnv` 指定的环境变量会被设成扩展的 `data/` 目录。引擎必须在 stdout 打印

```text
READY <port>
```

宿主的就绪判定是**逐行扫描 + 模式匹配**：读完 stdout 的每一行（不是只读第一行 —— 引擎可以先打日志），
把 `readyLine` 与每行都按空白切段、逐段比对，`<port>` 段解析成端口号；命中即成功，20 秒超时。

`readyLine` 缺省 `"READY <port>"`，也可以自定义成 `"listening on <port>"` 之类。两个硬约束：

- **段数必须与引擎实际打印的行完全一致**（多一段/少一段都不匹配）；
- `<port>` 之外的字面量要**逐字相同**（区分大小写）。

### 懒加载（`activationEvents`）

宿主只在必要时拉起引擎，判定规则很直白：

- **省略**或空数组 → 等同 `["onStartup"]`，启动即拉起（旧包行为）；
- 声明了数组 → **只认显式的 `onStartup`**（大小写不敏感），其余情况首次被
  热键 / 托盘 / `invoke` 触达时才懒启动。

所以纯 UI 扩展（无引擎）或不常用扩展，写 `["onHotkey", "onTray", "onInvoke"]` 就能省下一份常驻内存。
本仓库自带模板的 `activationEvents` 建议按需填写。

### 贡献点要点

- `windows[]`：宿主是**单一共享窗口**，同一时刻只存在一个。`width`/`height`/`alwaysOnTop` 每次导航都会重套，
  但 **`decorations` 只在窗口首次创建时生效**。
- `hotkeys[]`：由宿主代注册（在**所有窗口**都能触发）。`action` 当前只实现了 `"toggle"`。
- `tray[]`：`action` 只有两种前缀，`"open:<route>"` 与 `"invoke:<method>"`，其他形式静默无反应。
- `settings.schema[]`：`{ key, type, label, default?, options? }`，`type` ∈ `bool | text | number | paths | enum`。
  宿主会用 `default` 给读取结果打底，见「六、设置项」。

## 四、桥（`postMessage`）

扩展 UI 在 iframe 里，**没有 Tauri IPC**，只能与宿主页通信：

```text
扩展 → 宿主: { source: "ext:<扩展 id>", type: "invoke", reqId, method, payload }
宿主 → 扩展: { source: "lumiluna-host", type: "invoke-result", reqId, ok, data, error }
```

`bridge.invoke(method, payload)` 会自动分配 `reqId`、按 `reqId` 关联 Promise、带超时
（默认 60s，比宿主的 20s 引擎冷启 + 30s 请求更宽，好让作者拿到**宿主的真实错误**而不是本地超时）。
失败抛 `ExtBridgeError`，`message` 是宿主的原因，`code` 在宿主给了 `[CODE] 消息` 时被解析出来。

### 宿主保留方法（不转发引擎）

| method            | payload                  | 返回                          | 权限               |
| ----------------- | ------------------------ | ----------------------------- | ------------------ |
| `settings:get`    | —                        | `{ values }`                  | 无                 |
| `settings:set`    | `{ values }`             | `{ ok: true }`                | 无                 |
| `open` / `reveal` | `{ path, ts?, reveal? }` | `{ ok: true }`                | `opener:open-path` |
| `themes:list`     | —                        | `{ themes: ExtThemeEntry[] }` | 无                 |
| `themes:apply`    | `{ themeId, extId? }`    | `{ ok: true }`                | 无                 |
| `themes:clear`    | —                        | `{ ok: true }`                | 无                 |

SDK 把这些包成了高层方法：`bridge.open()` / `bridge.reveal()` /
`bridge.settings.get()` / `bridge.settings.set()` / `bridge.theme.list()` /
`bridge.theme.apply()` / `bridge.theme.clear()`。

`themes:apply` 缺省作用于**调用方自己**的扩展；`extId` 可显式指定，供**管理器类扩展**切别人的皮肤：

```ts
await bridge.theme.apply("sakura"); // 本扩展的皮肤
await bridge.theme.apply("sakura", "another-theme-pack"); // 管理器：应用他人的皮肤
```

`themeId` 只保证**扩展内唯一**，不同扩展可以都声明 `"sakura"`；
跨扩展应用**务必带上 `extId`**，否则会命中本扩展的同名皮肤或报「未声明皮肤」。

> 除保留方法外，`method` 会被原样拼成引擎 URL：`POST http://127.0.0.1:<port>/<method>`，
> body 就是 payload。所以方法名不要带斜杠前缀。

### 权限

| 权限               | 作用                                   |
| ------------------ | -------------------------------------- |
| `ext:invoke`       | 调用引擎任意方法（**引擎调用的总闸**） |
| `opener:open-path` | 宿主代执行 `open` / `reveal`           |

**省略整个 `permissions` 字段 = legacy 放行**（宿主会提示用户），一旦声明数组就逐项严格校验，
未声明的调用被拒（错误信息里会写明缺哪个权限）。

### 事件

宿主目前只有两条投递通道，SDK 都接了：

```ts
const off = bridge.on("index:progress", (payload) => console.log(payload));
off(); // 取消订阅
```

- `window.postMessage({ source: "lumiluna-host", type: "<事件名>", payload })`；
- `document.dispatchEvent(new CustomEvent("silvermoon:ext-bridge", { detail: { type, payload } }))`。

## 五、用扩展分发皮肤

**皮肤不再单独安装** —— 宿主设置页的皮肤入口已砍掉，装皮肤 = 装扩展。

在扩展里放皮肤文件，并在清单里声明：

```text
my-extension/
├── manifest.json
└── themes/sakura/skin.json     ← 与「皮肤包」时代的 skin.json 完全同格式
```

```json
{
  "contributes": {
    "themes": [{ "id": "sakura", "name": "樱", "path": "themes/sakura/skin.json" }]
  }
}
```

- `path` 是**扩展目录内 `skin.json` 的相对路径**（POSIX 分隔符，**不可以是绝对路径或含 `..`，宿主会拒绝**）；
- `skin.json` 的内容照旧，字段与校验规则由 `src/utils/skinSchema.ts` 负责，不用为扩展改格式；
- 皮肤目录里的素材（`assets/bg.png` 之类）照旧用相对 `skin.json` 的路径引用
  —— 宿主返回的 `files` 清单也是以**主题目录**为基准的，两边口径必须一致；
- 宿主侧 `ext_themes()` 汇总所有**已启用且兼容**的扩展的皮肤，每项含
  `{ extId, id, name, path, dir, absDir }`；`ext_theme_load(extId, themeId)` 读出
  `{ json, dir, absDir, files }`，与皮肤包时代的 `skin_load` 同形。

扩展自己的 UI 里也可以用桥操作皮肤（含管理器类扩展切别人的）：

```ts
const all = await bridge.theme.list();
const mine = all.filter((t) => t.extId === bridge.extId);
if (mine.length) await bridge.theme.apply(mine[0].id);

// 管理器类扩展：themeId 只在扩展内唯一，跨扩展必须带上 extId
const other = all.find((t) => t.extId !== bridge.extId);
if (other) await bridge.theme.apply(other.id, other.extId);
// 换回内置主题
await bridge.theme.clear();
```

## 六、设置项

```json
{
  "contributes": {
    "settings": {
      "schema": [
        { "key": "roots", "type": "paths", "label": "索引目录" },
        { "key": "sensitive", "type": "bool", "label": "敏感目录保护", "default": true },
        {
          "key": "mode",
          "type": "enum",
          "label": "模式",
          "options": ["fast", "deep"],
          "default": "fast"
        }
      ]
    }
  }
}
```

```ts
const { roots } = await bridge.settings.get<{ roots?: string[] }>();
await bridge.settings.set({ roots: ["D:/media"] }); // 部分更新：只覆盖传入的键
const sensitive = await bridge.settings.getOne("sensitive", true); // 带回退值
```

宿主把每个扩展的设置独立存在 `<appData>/ext-settings.json`（键名 = 扩展 id），
不污染主设置，卸载扩展时整键清除。

读取时宿主会先用 `schema[].default` 打底、再用已存值覆盖，所以**升级后新增的设置项会立刻带上默认值**。
但 schema 里没写 `default` 的键仍不会出现在返回值里 —— 关键项请给默认值。

## 七、构建产物与加载方式

- 扩展 UI **不再走 `asset:`**，改用独立自定义协议 `ext:`
  （等价于 `convertFileSrc(path, "ext")`，Windows 上产物 URL 形如 `http://ext.localhost/<abs-encoded>`）。
  它**与 `asset.localhost` 不同源**，扩展拿不到任意 `asset:` 文件的读取权。
- 因此 `vite.config` 的 `base` 必须是 `"./"`（插件默认帮你设好）：
  绝对路径 `/assets/…` 在扩展窗口里会 404。
- 产物目录由 `web.dist` 决定（插件把它写进 `build.outDir`），缺省 `web/dist`。

## 八、类型

```ts
import type {
  ExtManifest,
  ExtContributes,
  ExtWindowContrib,
  ExtThemeContrib,
  SettingField,
} from "@silvermoon/extension-api";
import { EXT_API_VERSION, PERM_INVOKE, PERM_OPEN, defineManifest } from "@silvermoon/extension-api";
```

构建期可用 `__EXT_ID__` / `__EXT_API_VERSION__` 两个编译期常量（由插件 `define` 注入，定义见 `src/env.d.ts`）。

## 九、作者常踩的坑

1. **字段写成 snake_case** —— 静默忽略，症状是「这个字段明明写了却没生效」。
2. **`minHostVersion` 写产品版本号** —— 写 `">=0.1.0"` 会被判为不兼容（比的是 API 版本 2.0.0）。
3. **产物目录不是 `web/dist`** 且没在 `web.dist` 里声明 —— 宿主找不到 `index.html`，白屏。
4. **没有引擎却调用非保留方法** —— 失败信息是「扩展引擎未就绪」。
5. **忘了 `opener:open-path`** —— `open` / `reveal` 被拒。
6. **桥构造时拿不到扩展 id** —— 宿主一定会在地址上带 `?ext=`；自己起的 dev server 上没有，
   所以开发期要 `createExtBridge({ extId: "my-extension" })` 显式兜底（或先用浏览器调 UI、后接宿主）。
7. **皮肤 `path` 写成绝对路径或 `../`** —— `ext_theme_load` 会以「皮肤路径不合法」拒绝。
8. **一个扩展里放多款皮肤** —— 可以，但 `themeId` 只在扩展内唯一；
   跨扩展同名由 `extId` 区分，管理器类扩展调 `themes:apply` 时**必须带上 `extId`**，
   否则会命中本扩展的同名皮肤、或报「未声明皮肤」。
9. **`readyLine` 与引擎实际打印的行对不上** —— 按空白切段逐段比对，段数或字面量差一点都不会命中，
   症状是「引擎明明起来了，宿主却等 20 秒然后报就绪超时」。
