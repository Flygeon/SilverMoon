# 06 · WebView 复用架构

> 本文记录移动端**为什么**以及**如何**复用桌面端的 Vue 前端。
> 相关代码：`apps/mobile/lib/services/{web_host_service,bridge_service,bridge_commands}.dart`、
> `apps/desktop/src/mobile/*`、`apps/desktop/vite.mobile.config.ts`。

## 结论先行

音乐页签不重写。Flutter 起一个 **loopback HTTP 服务**，WebView 加载桌面端
Vue 产物的移动端入口；Vue 需要的一切宿主能力经 **JavaScript 通道**回到 Dart。
于是桌面端的曲库、歌词解析（含 QQ 音乐 QRC / 酷狗 KRC 逐字）、动态背景、
音效面板全部原样可用。

## 为什么不用自定义 scheme

Electron 里本地文件走 `asset://`。WebView 里复刻它有两个原生做法：

| 做法 | 代价 |
| --- | --- |
| Android `shouldInterceptRequest` + iOS `WKURLSchemeHandler` | 需要写 Kotlin / Swift。本项目本地**没有** MSVC 与原生工具链，只能靠 CI 验证，等于把最容易出错的一环放到最慢的反馈回路里 |
| 纯 Dart loopback HTTP 服务 | 零原生代码，本地可跑可测 |

除了「不用写原生代码」，loopback 还额外买到三件事：

1. 前端处于**正常的 http 源**下，`localStorage` / `fetch` / `Worker` / `AudioContext` 行为可预测；
2. 服务端自己实现 `Range`，音频视频**可以拖动进度**（`file://` 在 WebView 里常常不能）；
3. 可以按需注入内容 —— `index.html` 会被塞进一个 `sm-asset-base` 元信息，
   前端据此把 `asset://localhost/<path>` 改写成 loopback 地址。

## 数据流

```
┌──────────────────────────── WebView ────────────────────────────┐
│  Vue 3 (apps/desktop/src)                                       │
│    shim.ts  →  window.__SILVERMOON__                            │
│       invoke(cmd,args) / invokeBatch / call(channel,payload)    │
│       emitTo(label,event,payload)                               │
│         │  JSON over window.SMNative.postMessage                │
└─────────┼───────────────────────────────────────────────────────┘
          ▼
┌────────────────────── Flutter (Dart) ───────────────────────────┐
│  BridgeService.handleMessage                                     │
│    kind=invoke       → bridge_commands.dart（本地曲库）           │
│    kind=call         → http / fs / store / path 通道             │
│    kind=invokeBatch  → 逐条执行，逐条回包（不因单条失败中断）      │
│    kind=event        → player:state / app:ready                  │
│         │  window.__SM_REPLY__(id, json)                         │
│         ▼                                                        │
│  回包                                                             │
└──────────────────────────────────────────────────────────────────┘
```

## 协议细节

请求（JS → Dart，单条 JSON）：

```jsonc
{ "id": 12, "kind": "call", "channel": "http", "payload": { ... } }
{ "id": 13, "kind": "invoke", "cmd": "list_files", "args": { ... } }
{ "kind": "event", "event": "player:state", "payload": { ... } }   // 无 id，不需要回包
```

回包（Dart → JS，经 `window.__SM_REPLY__(id, replyJson)`）：

```jsonc
{ "ok": true,  "data": ... }
{ "ok": false, "error": "移动端尚未实现命令: xxx" }
```

### 二进制约定（重要）

JSON 过不了 `Uint8Array`。若把字节当字符串送，`ipc/bridge.ts` 的 `toBytes()`
会把它们按 UTF-8 重新编码 —— 字节数一变，封面和音频就全废。所以双向都做一层
`{ "__b64": "<base64>" }` 包装：

- **出站**（Dart → JS）：`shim.ts` 的 `decodeValue()` 递归把 `__b64` 还原成 `Uint8Array`；
- **入站**（JS → Dart）：`shim.ts` 的 `encodeValue()` 递归把 `TypedArray` / `ArrayBuffer` 打成 `__b64`。

文本响应不包装（省掉 base64 的 33% 膨胀），由 Dart 侧按 `Content-Type` 判断。

## 通道实现状态

| 通道 | 状态 | 说明 |
| --- | --- | --- |
| `http` | ✅ | `package:http` 发起，绕开 CORS。**在线音源与歌词全靠它** |
| `fs` | ✅ | readFile / readFileBase64 / writeFile / writeFileBase64 / readTextFile / writeTextFile / exists / mkdir / remove / copyFile / rename / stat / readDir |
| `store` | ✅ | 按文件名的整文件 JSON 存储，`set` 后需 `save` 落盘，语义与桌面端一致 |
| `path` | ✅ | appDataDir / appCacheDir / tempDir / join / normalize / dirname / basename / extname |
| `app` | ✅ | version / name / hostVersion |
| `window` | ⚪ | 移动端无窗口概念，返回 null（`useWindowDrag` 因此安全空转） |
| `dialog` | ⚪ | 返回「用户取消」，调用方本就按取消分支处理 |
| `opener` | ⚪ | 暂未接 `url_launcher` |

## 命令实现状态

已实现（`bridge_commands.dart`）：`scan_start` / `scan_status` / `scan_cancel`、
`list_files` / `count_files` / `library_counts`、`get_metadata` / `get_song` / `get_thumbnail`、
`list_favorites` / `toggle_favorite`、`list_history` / `record_play`、
`start_play_session` / `end_play_session`、`get_listen_stats` / `list_listen_stats` /
`listen_source_breakdown`、`app_log` / `is_safe_mode` / `thumbnail_cache_path` / `clear_thumbnail_cache`。

**未实现**的命令统一抛 `移动端尚未实现命令: <cmd>`，并由 `BridgeService.lastUnimplemented`
记录最近一条，方便在设置页做诊断 —— 不会静默返回空值让 UI 卡死。

### 尚未实现的关键命令

- **账号登录**：`netease_login_qr_key` / `netease_login_qr_check` / `netease_login_cellphone` /
  `kugou_login_*`。桌面端把凭据留在 Rust 侧不进 WebView，移动端需要自己实现等价的
  cookie 保管（建议存 `flutter_secure_storage`），否则登录态无法持久化。
- **在线直连接口**：`netease_*` / `kugou_*` 系列。桌面端走 Rust 是为了绕 CORS 和
  统一处理签名；移动端**可以**改用 `http` 通道在前端直接发请求，
  这是后续最高性价比的一步（见 `03-online-api.md`）。
- 皮肤 `skin_*`、WebDAV、文库等非音乐命令。

## 曲库扫描的实现取舍

- 元数据与内嵌封面抽取在 **isolate** 里批量完成（`scanAudioBatchInIsolate`，每批 120 个），
  否则几万次同步文件 IO 会把 UI 冻住。
- isolate **会跳过解析失败的文件**，所以结果必须按 `filePath` 对齐，
  **不能按下标对齐** —— 这是一个已经踩过的坑。
- 封面在扫描阶段就写成缩略图文件（`<appSupport>/silvermoon/thumbs/<md5(path)>.jpg`），
  列表页因此能直接显示专辑图。扩展名统一写 `.jpg`：`<img>` 会嗅探真实格式。
- 条目 id 用 `md5(path)`。桌面端用 `xxh3(path)`，两者不需要一致 —— id 对前端是
  不透明主键，只要生成方与解析方是同一套即可。

## 已知缺口

1. **播放引擎仍在 WebView 里**（`<audio>` + Web Audio）。因此息屏后播放的可靠性
   依赖 WebView 的后台策略，且**拿不到系统媒体通知与耳机线控**。
   推荐方案：WebView 只做 UI，引擎换成原生 `just_audio`，
   用 `window.Audio` 的虚拟替身把 play/pause/seek 转发给原生，再回灌
   `timeupdate` / `ended` / `loadedmetadata`。
   注意桌面端用了 `createMediaElementSource` 接 `AudioContext`，
   这条路径需要一并替换成原生 EQ 透传。
2. **原生迷你播放器只显示在线封面**。本地曲目的封面是 dataURL，
   每次状态心跳都送过去不划算，目前显示占位图。
3. 未做**移动端适配**：桌面端的布局是按鼠标 + 宽屏设计的，
   小屏下需要一轮 `@media` 与触控热区调整。
