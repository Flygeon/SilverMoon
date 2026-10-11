# 架构

## 进程模型

两个进程，一条回环 HTTP 通道：

| 进程 | 语言 | 职责 |
|---|---|---|
| SilverMoon.exe | Kotlin/JVM + Compose Multiplatform | 窗口、UI、播放输出、本地文件对话框、设置落盘 |
| silvermoon_bridge.exe | Rust（复用 silvermoon_lib） | 索引库、扫描、元数据、缩略图、在线源协议、扩展框架、SMTC |

这样切分的理由：**业务后端已经写完并经过验证**，Tauri 的 command 层与框架耦合很浅
（形参就是 AppHandle + State + 普通值），把它的派发逻辑重新展开一次的成本远低于重写。
UI 侧则彻底脱离 WebView2。

## 桥协议（协议版本 1）

### 握手

后端启动后把端口与令牌写到 SILVERMOON_BRIDGE_HANDSHAKE 指定的文件（同一份 JSON
也会以一行 `SILVERMOON-BRIDGE-READY {...}» 打到 stdout，作为兜底通道）：

```json
{ "protocol": 1, "port": 52831, "token": "…48 位十六进制…", "pid": 24180, "commands": 186 }
```

令牌是每次启动随机生成的，只在本机回环上有效；除 /health 外所有端点都要求
请求头 `X-SilverMoon-Token» 匹配。

### 端点

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | /rpc | 请求体 `{ "cmd": "...", "args": { camelCase: ... } }»，返回 `{ "ok": true, "data": ... }» 或 `{ "ok": false, "error": "..." }» |
| GET | /events?events=a,b | SSE。每帧 `data: {"type":"event","event":"scan:progress","payload":{...}}»，15 秒无事件发一次心跳注释帧 |
| GET | /health | 无需令牌。返回协议版本、命令数、pid |

失败一律是 HTTP 200 + `ok:false»（业务错误不该伪装成传输错误）；令牌错误才是 401。

### 派发表怎么来的

Tauri 的 IPC 派发由 generate_handler! 宏生成，没有公开的编程式入口，
而 Invoke / InvokeResolver 的构造函数是 crate 私有的（tauri 2.12.1 已确认）。
所以做了一件等价的事：解析源码，生成同构的 match 表。

apps/desktop/scripts/gen-bridge-dispatch.mjs 会：

1. 从 lib.rs 里取出 generate_handler![...] 的命令清单（186 条）；
2. 按模块路径定位源文件，用 /#\[tauri::command/ + fn 名匹配函数定义；
3. 解析形参：AppHandle -> app.clone()，State<'_, T> -> app.state::<T>()，
   其余按 camelCase 键从参数对象反序列化（heck 的 to_lower_camel_case 等价实现，
   与 tauri-macros 的默认行为一致）；
4. 生成 src/bridge/dispatch.generated.rs。

异步命令用 tauri::async_runtime::block_on 包住调用（桥的请求处理跑在自己的线程上，
不在 tokio worker 里，block_on 是安全的）。

CI 里有一个 ubuntu job 专门跑 `node scripts/gen-bridge-dispatch.mjs --check»，
源码改了但忘了重新生成会直接红。

### 事件

Rust 侧用 app.emit(...) 发出的事件挂在 EventTarget::Any 上，桥通过
app.listen_any 捕获后广播给所有 SSE 客户端。当前转发的默认事件名与 web 端
src/ipc/events.ts 里 listen 的名字一致：scan:progress / smtc:command /
app:player-command / osu:progress / ext:navigate / updater:status。

已知缺口：extension.rs 里有两处 app.emit_to("extension", ...) 是定向发到窗口的，
没有窗口时不会到达 listen_any。扩展宿主窗口接进来时需要在
bridge 里补一个 relay（记在 ROADMAP 里，不影响当前功能）。

## Kotlin 侧分层

```
composeApp/src/commonMain/kotlin/cn/cool/silvermoon/
  design/     Tokens.kt（尺寸/圆角/动效，逐条对应 web 端 theme.css 的 CSS 变量）
              Theme.kt（MaterialExpressiveTheme + Monet 动态取色，三态主题）
  bridge/     BackendBridge（JSON-RPC + SSE）、BackendProcess（expect）
  data/       模型（与 Rust struct 一一对应）、LibraryStore / PlayerStore / SettingsStore
              MediaEngine（expect）、Platform（expect：设置落盘 / 深色模式 / 目录选择）
  di/         AppContainer（手写组合根）
  ui/         nav/Destination、shell/（标题栏 / 导航栏 / 迷你播放器）、screens/
```

平台相关的一切都在 expect/actual 边界上：commonMain 不出现 java.* / Windows API。

## 播放内核

MediaEngine 是一个 8 方法的窄接口，桌面端用 VLCJ（libvlc）实现：

- 选它而不是自己接 FFmpeg：mp3/flac/m4a/mp4/mkv/hls 一套全包，与 web 端实际依赖的
  解码栈行为一致；
- libvlc 缺失（没装 VLC / 位数不匹配）时构造失败会被捕获，降级成 UnavailableMediaEngine，
  界面照常起来，只是播放无效 —— 避免"一个解码器把整个应用拖崩"；
- 当前只接音频链路，视频画面需要把 libvlc 的 video surface 挂到 AWT Canvas 再经
  Compose 的 SwingPanel 嵌入（见 PARITY.md 的待办）。

## 版本矩阵

| 组件 | 版本 | 备注 |
|---|---|---|
| Kotlin | 2.4.21 | 与 Compose 编译器插件同版本 |
| Compose Multiplatform | 1.12.1 | material3 提供 MaterialExpressiveTheme |
| Gradle | 8.14.4 | wrapper 固定，包在仓库里 |
| JDK | 21 | jvmToolchain(21)，CI 用 temurin 21 |
| Ktor | 3.6.0 | 客户端；桌面端 CIO 引擎 |
| materialKolor | 5.0.1 | Monet 动态取色（material-color-utilities 的 KMP 移植） |
| Coil | 3.6.3 | 缩略图 / 封面加载 |
| VLCJ | 4.12.1 | libvlc 绑定 |
| JNA | 5.19.1 | Win32 / DWM / 托盘（当前仅窗口控制用到） |

## 为什么不用 navigation-compose / Koin

路由表只有 10 个页面、桌面端没有系统返回栈，一个 `Destination» 枚举就够了；
对象图只有 6 个对象，手写构造函数的可读性更高。两者都没有被排除，
版本目录里已经给 navigation 留了位置，页面数量上来（尤其需要按路由构造
ViewModel）时替换成本很低。
