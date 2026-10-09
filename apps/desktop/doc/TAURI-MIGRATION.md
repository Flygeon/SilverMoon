# 桌面端宿主迁回 Tauri 2（Electron → Tauri）

> 创建：本次迁移 · 范围：`apps/desktop`（前端 + Rust 后端 + 打包 + CI）
> 结论：**「换壳不换芯」第二次** —— Vue 前端与 Rust 业务逻辑零改动，只替换宿主层。

## 0. 一句话

桌面端从 **Electron 44 宿主 + Rust sidecar 两进程** 换回 **Tauri 2 单进程**。
154 条业务命令、SQLite 库、扫描管线、在线源（网易云 / 酷狗 / Pixiv / 文库 / 番剧 / B 站 / osu!）、
SMTC、托盘、热键、皮肤与扩展框架全部保留；只有「宿主怎么提供原生能力」这一层被替换。

## 1. 为什么这次迁移代价很低

迁到 Electron 时，项目刻意做了一件事：**把宿主差异全部关进一个兼容层**。

`apps/desktop/backend/crates/silvermoon-ipc/` 逐项复刻了 Tauri 的 API：

| 兼容层 | 真 Tauri | 说明 |
|---|---|---|
| `Host` | `tauri::AppHandle` | 应用句柄 |
| `HostApi`（`manage` / `state` / `path` / `get_webview_window`） | `tauri::Manager` | 托管状态与窗口查找 |
| `Window` / `WindowBuilder` / `WindowUrl` | `WebviewWindow` / `WebviewWindowBuilder` / `WebviewUrl` | 窗口 |
| `EventEmitter`（`emit` / `emit_to`） | `tauri::Emitter` | 事件 |
| `rt::spawn_blocking` | `tauri::async_runtime::spawn_blocking` | 异步运行时 |
| `menu` / `tray` / `OpenerExt` / `GlobalShortcutExt` | 同名 Tauri API | 托盘 / 菜单 / 剪贴板 / 热键 |
| `#[command]` / `generate_handler!` / `generate_context!` / `mobile_entry_point` | 同名 Tauri 宏 | 命令注册 |

因此业务代码里 `silvermoon_ipc::` 的写法与旧 Tauri 版的 `tauri::` **一一对应**：

```
业务代码引用数（迁移前）     silvermoon_ipc::  473 处
旧 Tauri 版同位置引用数      tauri::           436 处
差异来源                     = 一年来新增的功能模块（B站 / osu! / 听歌统计 / 皮肤 v2 …）
```

于是「迁回 Tauri」在 Rust 侧退化成**一次机械映射**，而不是重写。

## 2. 实际改了什么

### 2.1 Rust 侧：删兼容层，换真 Tauri

- `backend/` → `src-tauri/`（`git mv`，保留历史）。
- 删除 `crates/silvermoon-ipc/` 与 `crates/silvermoon-ipc-macros/`（共约 3.3k 行兼容层）。
- 机械改写 24 个业务文件里的 API 调用：

  | 旧（Electron 兼容层） | 新（Tauri 2） |
  |---|---|
  | `silvermoon_ipc::Host` | `tauri::AppHandle` |
  | `silvermoon_ipc::HostApi` | `tauri::Manager` |
  | `silvermoon_ipc::WindowBuilder` | `tauri::WebviewWindowBuilder` |
  | `silvermoon_ipc::WindowUrl` | `tauri::WebviewUrl` |
  | `silvermoon_ipc::Window` | `tauri::WebviewWindow` |
  | `silvermoon_ipc::EventEmitter` | `tauri::Emitter` |
  | `silvermoon_ipc::rt` | `tauri::async_runtime` |
  | `silvermoon_ipc::{command, generate_handler, …}` | `tauri::{…}` |

- `main.rs` 从「sidecar 进程入口」改回「Tauri 主程序入口」，保留原有的 panic 落盘钩子。
- `tray.rs` 的 `Host` → `AppHandle`，托盘实体改由 Tauri 持有。

### 2.2 Rust 侧：补回 Electron 独有能力（3 个新模块）

迁移到 Electron 时，有三件事被搬到 Node 主进程实现；Tauri 没有 Node 侧，必须用 Rust 补回：

| 新模块 | 替代 Electron 的 | 要点 |
|---|---|---|
| `src/cover.rs` | `electron/protocols.ts` 的 `app-cover://` | 注册 Tauri 自定义协议；绕 CORS + 按域伪装 Referer/UA + 256MB LRU 磁盘缓存 + 并发上限 8 + 15s 超时 + 负缓存 TTL 1h。缓存目录与文件名哈希与原实现**逐字一致**，旧缓存可直接复用 |
| `src/commands/music_tags.rs` | `electron/tags.ts` + `tag-writer.ts` + `tag-store.ts` | 用 `lofty` 重写（项目本来就用它解析元数据，**不是新依赖**），顺带甩掉 `taglib-wasm` 的 WASI wasm 胶水与 `@msgpack/msgpack` 打包麻烦。目录布局（`music-tags/index.json` / `covers/` / `lyrics/` / `local-backup/`）与 sha1 命名保持原样 |
| `src/commands/host.rs` | `electron/ipc.ts` 的 `path` / `app` / `updater` 通道 | 路径解析（必须与 Rust 侧 `app_data_dir()` 同源）、版本号、退出、封面缓存清理、内存诊断、更新器门面 |

### 2.3 前端：`src/ipc/` 在 Tauri 上重实现，**导出 API 不变**

这是「业务代码零改动」的关键：`src/ipc/` 下每个模块的**导出名与签名保持与 Electron 版一致**，
内部换成 `@tauri-apps/*`。因此 `src/capabilities/` 与所有页面、store 都不用改。

| 模块 | Electron 底层 | Tauri 底层 |
|---|---|---|
| `bridge.ts` | preload 注入的 `window.__SILVERMOON__` | `@tauri-apps/api/core` 的 `invoke` |
| `invoke.ts` | 同上 | `invoke` + `convertFileSrc` |
| `events.ts` | preload 转发的 DOM `CustomEvent` | `@tauri-apps/api/event` 的 `listen` / `emitTo` |
| `fs.ts` | 主进程 Node `fs` | `@tauri-apps/plugin-fs` |
| `dialog.ts` | 主进程 `dialog` | `@tauri-apps/plugin-dialog` |
| `store.ts` | 主进程 `JsonStore` | `@tauri-apps/plugin-store` 的 `LazyStore` |
| `opener.ts` | 主进程 `shell` | `@tauri-apps/plugin-opener` |
| `http.ts` | 主进程 undici 取回后重建 `Response` | `@tauri-apps/plugin-http` 的 `fetch` |
| `window.ts` | 主进程 `BrowserWindow` 句柄 | `@tauri-apps/api/webviewWindow` |
| `dragdrop.ts` | preload 里 `webUtils.getPathForFile` | `onDragDropEvent`（原生直接给路径） |
| `paths.ts` | 主进程 `path` | `host_path` 命令（与 Rust 侧同源） |
| `dpi.ts` | 自造几何类 | 再导出 Tauri 的 `@tauri-apps/api/dpi` 类 |

### 2.4 权限清单（按窗口）

Tauri 2 的 capability **按窗口**生效（`windows: [...]`），且插件能力默认全部关闭。
本应用有 6 类窗口，因此拆成 6 份：

| capability | 覆盖窗口 | 说明 |
|---|---|---|
| `default.json` | `main` | 主窗口，57 项权限（窗口 / 事件 / 对话框 / fs / store / opener / 热键 / http） |
| `desktop-lyrics.json` | `desktop-lyrics` | 透明置顶桌面歌词窗（含 `set-ignore-cursor-events` 鼠标穿透） |
| `extension.json` | `extension` | 扩展共享窗（fs 限制在 `**/extensions/**`） |
| `pixiv-login.json` | `pixiv-login` | Pixiv 外部登录页（`remote.urls` 放行 IPC） |
| `wenku8-login.json` | `wenku8-login` | 文库8 外部登录页（同上，注入脚本要用 `__TAURI__`） |
| `anime-webview.json` | `anime-webview` | 隐藏取流窗 |

> 这是**最容易漏**的一处：单份 `default.json` 会让其它窗口的所有 IPC 被拒 ——
> 表现为「窗口能打开，但里面的界面全部退化成 mock 行为或静默失败」。

### 2.5 打包与 CI

- `electron-builder.yml` → `src-tauri/tauri.conf.json`（打包目标 `nsis` / `appimage` / `dmg`，NSIS `currentUser`）。
- 自动更新：`electron-updater` → `tauri-plugin-updater`，保留「**只提示、不自动重启**」的产品行为。
- 放弃 `splash` 原生启动器：它是为遮 Electron 冷启动写的 Windows GUI 程序（Rust + Win32）；
  Tauri 复用系统 WebView，冷启动显著更快，不再需要。
- CI（`.github/workflows/build.yml`）改成三平台矩阵（windows / ubuntu / macos），
  打包命令 `npx tauri build`；仍保留「build 作业不依赖 lint」的并行策略。
- macOS 加入打包矩阵（对应跨平台需求，旧 Electron 版只出 Windows + Linux）。

### 2.6 Electron 宿主归档

`electron/`、`splash/`、`build/`、`electron-builder.yml`、`tsconfig.electron.json`
以及仅服务它们的脚本，整体 `git mv` 到 `archive/electron-host/`（沿用仓库既有的快照惯例）。
排查行为差异时可直接对照旧实现；需要还原也可原地搬回。

## 2.7 启动耗时怎么观测

两套打点写进**同一份** `main.log`（前缀区分），可以直接对着看：

```text
[启动][宿主] 进程启动(main 进入): 0ms
[启动][宿主] run() 开始（Builder 之前）: 1ms
[启动][宿主] setup 开始: 412ms          ← Builder + 插件 init + 配置窗口创建
[启动][宿主] 打开数据库 + 建表完成: 655ms
[启动][宿主] setup 结束（即将进入事件循环）: 890ms
[启动][宿主] 页面开始加载: 902ms
[启动][宿主] 主窗口已显示(用户可见): 1180ms
[启动][渲染] 首帧内容绘制(FCP): 137ms   ← 渲染侧 t0 = 入口 chunk 开始执行
```

```powershell
# 日志在 **Local**（app_log_dir），不是 Roaming —— 找的时候别找错
Get-Content "$env:LOCALAPPDATA\cn.cool.silvermoon\logs\main.log" -Tail 30
```

> ⚠️ 两套打点的 t0 不同（宿主=进程启动；渲染=入口 chunk 开始执行），
> **不能直接相加**。「页面开始加载」可近似当作渲染 t0。
>
> ⚠️ setup() 在主线程同步执行、期间事件循环不转，所以页面加载类回调会被推迟到
> setup 之后才执行，记下的毫秒数偏大。这本身是「主线程被占住」的信号；
> 判断时以 `setup 结束` 和 `主窗口已显示` 两点为准。

## 2.8 启动画面已移除 + 图标字体子集化

这两件事都是**实测启动耗时之后**才做的（数据见 §2.7 的 `main.log`）。

### 启动画面（#boot-splash）已整体删除

它是为遮 **Electron 冷启动**写的：Electron 主窗口 `show: false`，先让原生启动器
顶上，等 `ready-to-show` 再切主窗口。Tauri 下没有启动器，而窗口本身要到
约 2 秒才出现——**再盖一层动画只会让「看见真界面」更迟**。

删除后窗口一出现就是应用本体（Vue 挂载在窗口出现后约 100ms 内完成）。

改动点：`index.html`（删样式与标记）、`src/main.ts`（删淡出逻辑）。
注意这不是把显示时机推后——显示仍用 `ContentLoading`（见 lib.rs 的 on_page_load）。

### 图标字体从 5.2 MB 降到 90 KB

原先 `material-symbols-rounded.woff2` 是官方**全量**可变字体，**5221.7 KB**。
图标要等它加载+解析完才显示，表现为「窗口出来了但图标还要等一下才齐」。

现在由 `scripts/fetch-icon-font.mjs` 生成**子集**：272 个图标 / **89.6 KB（省 98.3%）**。

收集图标名用的是「超集 + 过滤」，两条规则取并集再与官方 4301 个图标名取交集：

| 规则 | 覆盖 |
|---|---|
| 带引号的字符串字面量 | `icon: "..."`、三元表达式、查表（TYPE_ICONS / themeIconMap） |
| `<span class="material-symbols-outlined">NAME</span>` 的元素文本 | 静态图标 |

> ⚠️ **第二条规则绝不能省**：实测有 **59 个图标只以元素文本形式出现**
> （`arrow_back` / `chevron_left` / `sync` / `delete_sweep` / `input` / `logout` …）。
> 我第一版只认引号，这 59 个会全部漏掉——**漏一个就是界面上缺一个图标**。

可变轴按项目实际取值钉死（全轴子集仍有 196 KB）：
`opsz 24` / `wght 300..500` / `FILL 0..1` / `GRAD 0`。
对应的 `@font-face` 里 `font-weight` 也从 `100 700` 收窄为 `300 500`。

**新增或改用图标后必须重跑** `npm run fetch:icon-font`；
CI 里有 `npm run check:icon-font`（**离线**，只比对 manifest 与源码）会拦住漏跑。

## 2.9 启动动画回归 + 首屏两项优化

> 这一节是**实测之后**才做的：日志显示主窗口在 2.1s 出现，但前 2.1 秒屏幕全黑；
> 而前身 Tauri 版之所以"看起来快"，靠的是当时那个独立启动器（见 §2.7）。

### 启动动画（splash）回来了，但换了个启动方向

旧版是**启动器当父进程**（快捷方式指向启动器，它再拉起应用），那样必须改 NSIS
的快捷方式指向；归档里的 `splash/src/pathfind.rs` 就是为这类「发布版才暴露」的
布局缺陷写的。

现在反过来：**快捷方式仍然指向主程序，主程序在 `run()` 一开始就把启动器 spawn 出去**。

| | 旧版 | 现在 |
|---|---|---|
| 谁是入口 | 启动器 | **主程序** |
| 谁 spawn 谁 | 启动器 → 应用 | **应用 → 启动器** |
| 管道角色 | 启动器=服务端，应用=客户端 | 不变 |
| 打包改动 | 要改快捷方式指向 | **不需要** |
| 启动器缺失时 | 应用打不开 | **完全不受影响** |

时间线：

```text
0ms      主程序启动 → 立刻 spawn 启动器（独立原生进程，毫秒级出画面）
~200ms   启动器画出 MD3 动画
~2.1s    前端报「首屏就绪」→ 应用写 READY → 启动器回 FADING:220 → 互相对齐
~2.3s    启动器淡出完毕，主窗口显示（两端交叠，不会先黑一下再亮）
```

三道兜底，缺一不可（都是实测踩出来的）：
- 前端 `armAppReadyFallback`：前端出错也会发就绪信号；
- 宿主 10 秒看门狗：强制 `splash::reveal()`；
- 启动器内置 CONNECT_TIMEOUT(15s) / READY_TIMEOUT(30s)：应用异常时启动器自己收场。

### 显示时机：改成「首屏画好再显示」

原来是「ContentLoading 即显示」，用户看到的是中间态（空白网格 + 未换肤配色）。
现在统一由 `splash::reveal()` 一个入口负责，触发源是前端就绪信号。

### 首屏两项优化

| 优化 | 做法 | 收益 |
|---|---|---|
| 首屏数据缓存 | `utils/firstScreenCache.ts`：把首屏那一页存进 **localStorage**，启动时**同步**读回 | 网格首帧就有真实内容，省掉两次 IPC 往返（实测 ~600ms） |
| 皮肤延后 | `App.vue` 不再 `await skins.load()`，先出界面再换肤 | 省约 420ms（实测 设置 785ms → 皮肤 1204ms） |

> 用 localStorage 而不是 IndexedDB，是因为后者是异步的——读出来至少等一个事务
> 往返，首帧根本用不上。数据量很小（一页 PAGE_SIZE 条），同步读可接受。
> 应用其它缓存仍走 IndexedDB。
>
> 代价：皮肤会带来**一次配色切换**（默认动态色 → 皮肤色）。这是有意的取舍；
> 要消除它就得把皮肤挡回首屏前，那 420ms 也就回来了。

## 3. 行为差异清单（有意为之）

| 项 | Electron 版 | Tauri 版 | 影响 |
|---|---|---|---|
| 进程模型 | 主进程 + Rust sidecar，HTTP+SSE | 单进程 | 启动更快、内存更低；`/cmd` 与 `/_host` 两条 HTTP 通道整体消失 |
| `app://` 协议 | 需要（`file://` 下 IndexedDB 被禁） | 由 Tauri 的 `tauri://localhost` 提供，同样是安全源 | 无；IndexedDB 正常 |
| `asset://` | 自实现（含 Range） | Tauri `asset:` 协议（原生支持 Range） | 无 |
| `app-cover://` | Electron 协议处理器 | Tauri 自定义 URI scheme | 无；缓存布局一致 |
| 内存诊断 `metrics` | 按 Chromium 进程列快照 | 只有本进程 RSS（系统 WebView 内存不暴露） | **口径变化**，返回值里带 `note` 显式标注；`bench` 退化为空报告 |
| 窗口导航拦截 | 「先放行、判定为否再回退」 | Tauri `on_navigation` 可**同步**返回 `false` | 行为等价且更直接（Pixiv 登录回调） |
| 托盘可见性 | 无 API，`set_visible` 退化为空操作 | `set_visible` 真实生效 | 无（业务只调用过 `true`） |
| panic 策略 | `panic` 保留 unwind（sidecar 常驻） | `panic = "abort"`（与 UI 同命运） | 单个命令 panic 会带崩进程；恢复旧 Tauri 版策略 |
| 音乐标签写入 | `taglib-wasm`（Node / WASI） | `lofty`（原生 Rust） | 格式覆盖略有差异；空串即清空的语义保持一致 |

## 4. 验证状况（诚实交代）

本机**没有任何 MSVC 链接器**（`link.exe` 不存在；Windows SDK 只装了 UnionMetadata 元数据），
因此 `cargo check / build / test` **无法在本机运行**——连 proc-macro 与 build script 都链接不过。
本次迁移在本机能做到的验证与做不到的验证如下：

### 已在本机验证 ✅

| 项 | 命令 | 结果 |
|---|---|---|
| 前端类型检查 | `npx vue-tsc --noEmit` | **通过（0 错误）** |
| 前端单测 | `npx vitest run --no-file-parallelism` | **63 文件 / 800 用例全部通过**① |
| 前端生产构建 | `npx vite build` | 通过（938 模块） |
| **Rust 纯逻辑（真实执行）** | `npm run verify:rust-pure` | **27/27 断言通过** —— 详见下节 |
| **Rust 依赖解析** | `cargo generate-lockfile` + `cargo fetch` | **696 个包解析成功**（含 git 依赖与全部 Tauri 插件） |
| Rust 语法 / 格式 | `cargo fmt --check`（主 crate + bili crate，含 3 个新模块） | 通过（rustfmt 必须解析全部源码，语法错误会直接报出） |
| Tauri 配置合法性 | 对照官方 `@tauri-apps/cli/config.schema.json` 校验 | **0 错误** |
| ACL 权限标识 | 31 个 `core:*` + 26 个插件标识逐条比对 tauri / 插件源码里的权限表 | **全部合法**（错一个 `tauri build` 就会失败） |
| Rust API 逐个核对 | 对照 registry 里 **tauri 2.12.1 / 各插件 / lofty 0.20.1** 源码 | 见下节 |
| 版本号一致性 | `npm run check:version` | 通过（6 处一致） |
| mock / 路由表漂移 | `npm run verify:mock-coverage` | 通过（无死分支） |

① 默认并行跑时 `autoMixAlgo` 的 1 条会偶发失败：它是 CPU 密集的 FFT/BPM 用例，
多 worker 抢核时超时；单独跑 14/14 通过、`--no-file-parallelism` 下 800/800 通过。
这是**本机算力**导致的既有 flake（该文件未被本次迁移改动），不是回归。

### Rust 侧证据是怎么来的（无链接器条件下）

本机没有 MSVC，`cargo check` 连 build script 都过不去。为了**不把 Rust 改动只交给 CI**，
这里做了三件事，都在本机可复跑：

1. **依赖图解析**：`cargo generate-lockfile` / `cargo fetch` 不需要链接器。
   696 个包（含 `UniDesktop/SDK` git 依赖与 8 个 Tauri 插件）全部解析并通过版本兼容性检查 ——
   证明 `Cargo.toml` 与声明的插件组合是自洽的。
2. **真实执行纯逻辑**：`wasm32-unknown-unknown` 目标用 rustup 自带的 `rust-lld` 链接，
   **不需要 MSVC**。于是把项目里不带依赖的纯函数**从源文件原文抽出来**编成 wasm，
   在 Node 里真的跑断言（`npm run verify:rust-pure`，27 条）。
   抽取是「按函数名 + 花括号配平」从 `src-tauri/src` 读原文，函数改名会直接报错，
   不会静默失效。覆盖：
   - `cover.rs` 的 `referer_for`：防盗链 Referer 分流（含 `kglink.com.evil.net` 这类**误伤防护**）；
   - `host.rs` 的 `normalize_str`：路径规范化（对齐 Node `path.normalize`）；
   - `music_tags.rs` 的 `cover_ext`：封面扩展名推断（mime 优先 / dataURL 前缀兜底）。
   该步骤已加进 CI，本地与 CI 跑的是同一份断言。
   > 边界：**只覆盖无依赖的纯逻辑**。任何带 build script 的 crate（被 `serde`/`generic-array`
   > 等传递依赖拖进来）仍要用宿主链接器，因此网络 / 数据库 / Tauri API 路径不在其中。
3. **API 逐个核对**：把 `cargo fetch` 下来的 **tauri 2.12.1、8 个插件、lofty 0.20.1** 源码
   当作权威，逐条核对了本项目用到的签名。这一步**查出并修掉了 2 个真实的编译错误**（见下）。

迁移过程中顺带修掉两个**存量缺陷**（均已验证）：

1. **`src/utils/__tests__/chipClick.test.ts` 在 Windows 上永远失败**：用例用
   `new URL("../../", import.meta.url).pathname` 取路径，Windows 上得到 `/C:/...`，
   拼成 `C:\C:\blog\...` 而 ENOENT。改用 `fileURLToPath` 后该用例在 Windows 本地
   也真正开始断言（此前这条静态守卫等于没跑）。
2. **桌面歌词窗口会操作错窗口**：窗口 label 若用固定的 `"main"` 兜底，`desktop-lyrics`
   窗口里的 `getCurrentWindow()` 会去操作主窗口。现改为读 Tauri 的
   `__TAURI_INTERNALS__.metadata.currentWindow.label`。

`electron/__tests__/splashContract.test.ts`（10 项）随 splash 启动器一起归档，不再运行。

### 核对源码时查出并修掉的 2 个真实编译错误

这两处如果不查，本机看不出任何异常，只会在 CI 第一次编译时炸：

1. **自定义协议注册在了错误的类型上**：`register_asynchronous_uri_scheme_protocol`
   只存在于 `tauri::Builder`（消费 `self` 并返回新 `Builder`），
   `AppHandle` **没有**这个方法。原先在 `setup` 里写 `app.register_...("app-cover", …)`
   无法编译。已改为在 `Builder` 链上注册（`lib.rs`），
   并把回调拆成 `cover::handle_request(ctx, request, responder)` ——
   同时避开了「`UriSchemeContext` 的借用不能跨越 `await`」这个生命周期问题
   （回调是 `Fn` 可重入，捕获上下文必须 `Send + Sync + 'static`）。
2. **`sha1` 依赖没声明**：`commands/music_tags.rs` 里 `use sha1::{Digest, Sha1}`，
   但 `Cargo.toml` 只声明了 `sha2`。Rust 2018+ 不允许隐式使用传递依赖，
   这行会直接报 unresolved import。已补 `sha1 = "0.10"`（解析到 0.10.7），
   并注明「必须与 Electron 版同款哈希，否则旧缓存文件名对不上」。

另外顺手修掉一处「本地看着正常、远程页面会静默失效」的问题：

3. **文库8 登录注入脚本用的是 Electron 时代的桥**：脚本里 `window.__SILVERMOON_HOST__.invoke(…)`
   在 Tauri 下永远不存在，登录会静默失败。已改回 Tauri 的
   `window.__TAURI__.core.invoke(…)`（`tauri.conf.json` 的 `withGlobalTauri: true` 已开），
   并抽了一个 `hostInvoke()` 兜底，未注入时给出可读报错而不是静默吞掉。

### 已知的验证覆盖缺口（本次未补，建议跟进）

1. **逐字歌词的「真实落盘」验证还在测旧实现**：`npm run verify:word-lyrics` 的第 3 步
   （把逐字歌词写进 WAV/MP3 再读回，断言词级标记完好）走的是 **`taglib-wasm`（Node 侧）**，
   而本迁移之后**生产写入路径已经是 Rust 的 `lofty`**。也就是说这条链路目前的
   「落盘正确性」证据指向的是已归档的实现，**不覆盖 `lofty` 的实际写盘行为**。
   建议：改用 Rust 单测（`cargo test`）覆盖 `music_tags.rs` 的 `write_local_tags` /
   `read_local_tags`，或在 CI 里加一条「写标签 → 重新解析 → 断言」的集成用例。
2. **`taglib-wasm` 依赖因此暂时保留**（`verify-word-lyrics.mjs` 仍用它）。
   等上一条补好、该脚本改走 Rust 后即可连同 `@msgpack/msgpack` 的打包特例一起移除。
3. **`musicTags` 的 12 个 op 没有 Rust 侧单测**：本次只做了 API 签名核对与
   （纯函数层面的）执行验证，没有覆盖写盘 / 备份 / 在线索引这些带 IO 的分支。

### CI 已全部通过 ✅

推送后 GitHub Actions 运行 **37816278716** 全绿（`completed / success`），
补齐了本机无法覆盖的部分：

| 作业 | 内容 | 结果 |
|---|---|---|
| `lint` | eslint / prettier / vue-tsc / vitest(800) / mock-coverage / **wasm Rust 纯逻辑** / rustfmt×2 / **clippy -D warnings**（=完整编译） / **cargo test**（lib + bili） | ✅ |
| `build (windows)` | `tauri build --bundles nsis` → NSIS 安装包 13.1 MB | ✅ |
| `build (linux)` | `tauri build --bundles appimage` → AppImage 90.0 MB | ✅ |
| `build (macos)` | `tauri build --bundles dmg` → dmg 17.4 MB | ✅ |

**这一步同时证明了三件本机证不了的事**：
1. `cargo clippy --all-targets -- -D warnings` 通过 = 全部 Tauri API 用法、类型推断、
   借用检查、trait 解析与 3 个新模块**真实编译通过且无警告**；
2. `cargo test` 通过 = Rust 侧单元测试（含 B 站协议层）全绿；
3. 三平台 `tauri build` 通过 = `tauri.conf.json`、6 份 capabilities 的权限标识、
   打包目标、图标、`beforeBuildCommand` 全部被**真实构建**验证（错一个标识构建即失败）。

> 首次 CI 跑出的 2 个真实编译错误（unused import、emit 载荷缺 `Clone`）已在
> 后续提交 `b2e712d` 修复并复跑通过 —— 这正是把 Rust 交给 CI 的价值。

### 仍需人工回归的行为 ⚠️

编译与打包已全绿，但**运行期行为**（自动化测不到的部分）建议按 §3 的差异清单人工过一遍，
重点四项：

1. **封面显示** —— `app-cover:` 协议 + 防盗链 Referer 伪装 + 磁盘缓存；
2. **音乐标签写入** —— `lofty` 实际写盘 / 读回（见上节「验证覆盖缺口」第 1 条）；
3. **桌面歌词窗口** —— 按窗口的 capability + label 判定 + 鼠标穿透；
4. **文库8 登录** —— 注入脚本走 `__TAURI__` 回宿主机。


> 建议：首次 CI 跑通后，按 §3 的差异清单做一次人工回归，重点四项：
> **封面显示**（`app-cover:` 协议 + Referer 伪装）、**音乐标签写入**（lofty）、
> **桌面歌词窗口**（按窗口的 capabilities + label 判定）、**文库8 登录**（`__TAURI__` 注入）。

## 5. 回滚

Electron 宿主完整保存在 `archive/electron-host/`；`git log` 中迁移前的提交同样可用。
若需回滚，把该目录内容按原路径 `git mv` 回 `apps/desktop/`，并把 `src-tauri/` 改回 `backend/` 即可
（前端 `src/ipc/` 与 Rust 侧 API 需要一并回退，见对应提交）。
