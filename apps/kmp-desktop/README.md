# SilverMoon · KMP 桌面端

SilverMoon（银月）的 **Kotlin Multiplatform + Compose Multiplatform** 桌面端。
当前只启用 **Windows（JVM/desktop）** 目标；UI 与数据层写在 commonMain 里，
后续接 Android / iOS 只需补 target，不用改页面代码。

> 与 [apps/desktop](../desktop/)（Tauri 2 + Vue 3）是**并行**的两套壳，
> 共用同一份业务后端：apps/desktop/src-tauri 里的 186 条命令原样复用，业务逻辑一行未改。

---

## 为什么要 KMP

| 诉求 | Tauri 版 | KMP 版 |
|---|---|---|
| 渲染 | 系统 WebView2（HTML/CSS） | Compose Multiplatform 直接绘制（Skia） |
| 启动 | 需要建 WebView2 环境 | 原生窗口，不依赖浏览器内核 |
| 分发 | 依赖系统 WebView2 运行时 | 自带运行时（jpackage 应用镜像） |
| 与后端通信 | invoke()（WebView postMessage） | 本机回环 HTTP JSON-RPC |
| 移动端复用 | 无（移动端是独立的 Flutter 实现） | commonMain 直接复用 |

## 与后端的关系（本文档最重要的一节）

**后端不重写。** apps/desktop/src-tauri 增加了一个不建窗口的入口：

```
┌──────────────────── SilverMoon.exe（Kotlin/JVM，Compose） ────────────────────┐
│  ui/  设计系统(MD3/M3E) + 外壳 + 页面     data/ 状态容器                      │
│  bridge/ JSON-RPC 客户端（命令 + SSE 事件）                                   │
└──────────────────────────────┬───────────────────────────────────────────────┘
                               │  POST http://127.0.0.1:<port>/rpc    （带令牌）
                               │  GET  http://127.0.0.1:<port>/events （SSE 事件流）
┌──────────────────────────────▼───────────────────────────────────────────────┐
│  silvermoon_bridge.exe（Rust，同一 crate 的第二个 bin，无窗口）               │
│  bridge::dispatch  ->  现有的 #[tauri::command] 函数（186 条，原样调用）      │
│  索引库 / 扫描 / 元数据 / 缩略图 / 网易云 / 酷狗 / Pixiv / B 站 / 小说 / 番剧 │
└──────────────────────────────────────────────────────────────────────────────┘
```

- 派发表 src/bridge/dispatch.generated.rs 由 apps/desktop/scripts/gen-bridge-dispatch.mjs
  从 Rust 源码**机械生成**（命令名与形参类型全部解析自源码），CI 会校验它没有漂移。
- 传输格式与 Tauri 的 invoke 完全一致：命令名 + camelCase 参数对象 -> 结果 JSON；
  失败以原始错误字符串返回。
- 事件方向：Rust 侧 app.emit(...) 经 listen_any 捕获后推给 SSE，等价于前端的 listen()。

细节见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)。

---

## 快速开始

需要 **JDK 21**；Windows 上还要能编译 Rust 后端（MSVC Build Tools）。

```bash
# 1. 先编后端桥进程
cd apps/desktop/src-tauri
cargo build --release --bin silvermoon_bridge

# 2. 跑桌面端
cd apps/kmp-desktop
./gradlew :composeApp:run

# 3. 打包（MSI + EXE）
./gradlew :composeApp:packageReleaseMsi :composeApp:packageReleaseExe
```

开发态下 Kotlin 侧会自己往上找
apps/desktop/src-tauri/target/{release,debug}/silvermoon_bridge.exe，
也可以用环境变量 SILVERMOON_BRIDGE_EXE 直接指定路径。

**播放**：用 libvlc（VLCJ）。装了 VLC 就能播；没装则自动降级为"不可用内核"，
界面照常起来，只是播放按钮无效，设置页会写明原因。

---

## CI

[.github/workflows/kmpdesktop.yml](../../.github/workflows/kmpdesktop.yml) 分三个 job：

1. **verify-generated** —— 校验桥派发表与 Rust 源码一致（ubuntu，几十秒出结果）；
2. **backend** —— 编译 silvermoon_bridge.exe（windows-latest + cargo 缓存）；
3. **app** —— JDK 21 + Gradle：编译、单测、jpackage 打 MSI/EXE，并上传免安装目录与 SHA256。

推送到 main（命中 apps/kmp-desktop/** 或 apps/desktop/src-tauri/**）即触发，
也支持 workflow_dispatch 手动跑；打 kmp-v* tag 会发 prerelease。

---

## 目录

```
composeApp/src/
  commonMain/kotlin/cn/cool/silvermoon/
    design/   MD3 + M3 Expressive 设计系统（令牌 / 主题 / Monet 动态取色）
    bridge/   JSON-RPC 客户端、握手、事件流
    data/     数据模型与状态容器（library / player / settings）
    di/       组合根
    ui/       外壳（自绘标题栏 + 导航栏 + 迷你播放器）与页面
  desktopMain/kotlin/cn/cool/silvermoon/
    Main.kt      窗口与进程引导
    bridge/      后端子进程的拉起与握手
    data/        平台实现（设置落盘 / 深色模式 / 目录选择 / libvlc 内核）
```

## 许可

GPL-3.0-only，与仓库其余部分一致。
