# TaskbarLyrics 移植调研报告

> 调研对象：https://github.com/ANYNC/TaskbarLyrics （C# / MIT / 279★ / 13 fork）
> 调研日期：2026-10-13　版本：v1.7.4（2026-10-10 发布）
> 目标：评估把「Windows 任务栏歌词」能力移植进 SilverMoon（Electron 44 + Vue 3 + Rust sidecar）

---

## 一、结论先行

**可移植，但要拆成三块分别看，难度差异极大：**

| 能力块 | 移植难度 | 判断 |
| --- | --- | --- |
| ① SMTC **读取**（识别别的播放器在放什么） | 中 | 必须新做。SilverMoon 现在只有「发布」方向，没有「订阅」方向 |
| ② 歌词检索/匹配/同步 | **低** | SilverMoon 已有歌词体系，缺的是「多源检索 + 评分录用」 |
| ③ 任务栏**嵌入**（SetParent 进 Shell_TrayWnd） | **高 / 有致命风险** | 这是整个项目最值钱也最危险的部分，Electron 下大概率不可行 |

**核心风险一句话**：TaskbarLyrics 用的是 Win32 `SetParent(hwnd, taskbar)` 把窗口变成任务栏的**真子窗口**（WS_CHILD）。这招在 WPF 上成立，但在 **Chromium/Electron 上很可能直接黑屏** —— 因为 Chromium 的 DirectComposition 合成面绑定在窗口的 HWND 层级上，跨进程 re-parent 会让合成面失效。**这一条必须先做最小验证，再决定要不要投入。**

---

## 二、上游项目解剖

### 2.1 规模与结构

```
TaskbarLyrics.App        113 文件   WPF + WinForms(NotifyIcon) + WebView2 + SMTC + 音频捕获 + 原生窗口集成
TaskbarLyrics.Core        58 文件   平台无关：歌词检索/匹配/解析/缓存/本地媒体索引/持久化/策略
TaskbarLyrics.App.Tests   47 文件   xUnit
TaskbarLyrics.Core.Tests  34 文件   xUnit
tests/web                 10 文件   Vitest + jsdom
TaskbarLyrics.Diagnostics  3 文件
```
非测试 C# 共 **135 个文件**。技术栈：**.NET 8 + WPF + WebView2**，要求 Windows 11 SDK 10.0.22621。

### 2.2 架构（上游自述）

```
播放器 →[SMTC 元数据/状态/时间轴/封面]→ SmtcMusicSessionProvider → LyricSyncService
本地 LRC/QRC/KRC ┐
QQ音乐/网易云/酷狗/LRCLIB ┘→ LyricProviderRegistry →（评分录用）→ LyricSyncService
LyricSyncService → LyricsWindowHost / MainWindow →[ExecuteScriptAsync]→ WebView2 歌词界面
Windows 系统音频捕获 → SystemAudioSpectrumService →（纯音乐时顶上）
```

**工程纪律值得学**（上游 AGENTS.md 明写）：
- `Core` 不许出现 WPF / WebView2 / WinForms / 原生窗口依赖 —— 分层靠编译期约束，不靠自觉
- 歌词窗口跑在**独立 STA 线程**，跨线程只能走 `Dispatcher`
- 生产 Web UI **零框架**（原生 HTML/CSS/JS），shadcn/ui 只当设计参考不当运行时依赖
- WebView 消息用 V1 信封 `{version:1, type, payload}`，未知版本/类型/非法载荷一律**安全失败**
- 测试量：`dotnet test` 528 个 + `vitest` 80 个

---

## 三、任务栏嵌入的完整机制（重点）

这是上游最核心的技术资产。文件：`TaskbarLyrics.App/EmbeddedTaskbarAnchor.cs`（24KB）+ `TaskbarPlacementService.cs` + `TaskbarEmbeddingLayoutPolicy.cs`。

### 3.1 窗口层级定位

```csharp
var primaryTaskbar = FindWindow("Shell_TrayWnd", null);
// 多显示器：FindWindowEx(..., "Shell_SecondaryTrayWnd", ...)
var reBar     = FindWindowEx(taskbar, IntPtr.Zero, "ReBarWindow32", null);
var container = reBar != IntPtr.Zero ? reBar : FindWindowEx(taskbar, IntPtr.Zero, "WorkerW", null);
var taskList  = FindWindowEx(container, IntPtr.Zero, "MSTaskSwWClass", null);
//              或 FindWindowEx(container, IntPtr.Zero, "MSTaskListWClass", null);
```

### 3.2 嵌入动作

```csharp
_ = SetParent(hwnd, parent);                       // 变成任务栏子窗口
var style = GetWindowLongPtr(hwnd, GWL_STYLE);
SetWindowLongPtr(hwnd, GWL_STYLE,
    (style & ~WS_POPUP) | WS_CHILD | WS_VISIBLE);  // 去掉 WS_POPUP、加上 WS_CHILD
var ex = GetWindowLongPtr(hwnd, GWL_EXSTYLE);
SetWindowLongPtr(hwnd, GWL_EXSTYLE,
    (ex & ~WS_EX_TOOLWINDOW) | WS_EX_NOACTIVATE);  // 不抢焦点
// 再校验：GetAncestor(hwnd, GA_PARENT) != parent → 判为 ReparentRejected
```

同时它还会**挤占任务列表**：记录 `MSTaskListWClass` 的原始 bounds，给歌词腾出位置（`_taskListSqueezed`）。

### 3.3 三个已踩过的坑（上游代码里写死了结论）

1. **换显示器不能 re-parent 原地复用** —— 注释原文：
   > "A re-parent of an established embedding to another taskbar cannot revive the invalidated DWM composition surface of the same HWND (verified with native probes), so the host must replace the window instead of re-parenting in place."

   → 即：**DWM 合成面一旦因 re-parent 失效，同一个 HWND 救不回来，必须销毁重建窗口。** 这条对我们是最强的预警信号。
2. **任务栏重启要重挂** —— 监听 `RegisterWindowMessage("TaskbarCreated")` 与 `WM_SHOWWINDOW`，命中就重新 Attach。
3. **DPI/物理像素不能混** —— WPF 设备无关单位 vs Win32 物理像素，必须 `AlignPhysicalPixel(value * pixelsPerDip)`。

### 3.4 不嵌入时的退路：SmartTopmost

`SmartTopmostPolicy` 的思路很巧：当检测到**有前台窗口铺满目标显示器**（全屏应用/游戏）时，**主动放弃置顶**；否则才置顶，并用 `WindowToPlaceAfter` 排序。

> 这个策略比「无脑 alwaysOnTop」体验好得多，**且与嵌入无关、可以独立移植**。

---

## 四、SilverMoon 现状盘点

### 4.1 已经有的（可直接复用）

| 能力 | 位置 | 说明 |
| --- | --- | --- |
| 桌面歌词窗口 | `src/utils/desktopLyrics.ts` | label=`desktop-lyrics`，transparent + decorations:false + alwaysOnTop + skipTaskbar，已有 state/ready/control/bounds 四套事件 |
| 窗口创建能力 | `electron/windows.ts` `createChildWindow` | 已支持 `transparent/alwaysOnTop/skipTaskbar/frame` |
| 歌词渲染 | `@applemusic-like-lyrics/core` | 已有 AMLL 引擎（native/amll 双引擎），逐字歌词 |
| 歌词数据结构 | `DesktopLyricLine` | 已含 `text/translation/romaji/bg`（背景和声） |
| 原生能力通道 | `electron/sidecar.ts` | 渲染进程 →主进程 →HTTP POST /cmd→ Rust 侧车；事件走 SSE |
| SMTC **发布** | `backend/src/commands/smtc.rs` | 用 `smtc-tokio` 把本应用注册成系统媒体会话 |

### 4.2 缺的（移植要补）

1. **SMTC 客户端（读别人的会话）** —— 现在 `smtc-tokio` 只做「发布」。要读 QQ音乐/网易云/酷狗/Spotify 在放什么，需要 `GlobalSystemMediaTransportControlsSessionManager`，**这是 .NET/WinRT 的 API，Rust 侧要换 `windows` crate 的对应接口**。
2. **多源歌词检索 + 评分录用** —— SilverMoon 有歌词获取，但没有「多个源各自打分、择优录用、跨源回退」这套。
3. **任务栏嵌入** —— 完全没有。
4. **系统音频频谱** —— 完全没有（上游用 Windows loopback 捕获）。

---

## 五、移植方案与取舍

### 方案 A：完整移植（含任务栏嵌入）—— **不建议直接上**

依赖 Electron 窗口能被 `SetParent` 进 `Shell_TrayWnd`。**风险点**：
- Chromium 的 GPU 合成走 DirectComposition，合成面与 HWND 的**顶层**身份绑定；被降级成 WS_CHILD 后，合成面极可能失效 → 黑屏/空白
- 上游自己在 WPF 上都遇到「re-parent 后 DWM 合成面失效」，说明这是 Win32/DWM 层面的通用问题，Chromium 只会更敏感
- Electron **没有**任何官方 API 支持把窗口嵌入别的进程窗口

> 注意：`SetWindowLongPtr(GWLP_HWNDPARENT)` 设的是**属主(owner)** 不是**父窗口(child)** —— 它不会让窗口变成任务栏的子窗口，解决不了这个需求。二者不能混用（[A window can have a parent or an owner but not both](https://devblogs.microsoft.com/oldnewthing/20100315-00/?p=14613)）。

### 方案 B：悬浮式任务栏歌词（**推荐先做**）

放弃「嵌入」，改成「**贴着任务栏的置顶无边框窗口**」：
- 复用 SilverMoon **现有的** `desktopLyrics` 窗口能力，几乎零新基础设施
- 移植上游的 `SmartTopmostPolicy`（全屏时自动让位）—— 这是纯策略，几十行
- 移植 `TaskbarPlacementService` 的定位算法（`ResolveTaskbarBounds` + 三档水平锚点 Left/Center/Right + 偏移钳制）
- 用 `SHAppBarMessage`/`GetMonitorInfo` 拿任务栏实际矩形，把窗口贴上去

**代价**：视觉上不是「真嵌进任务栏」，是「盖在任务栏上」。但配合任务栏自动隐藏/全屏让位，日常观感接近。

### 方案 C：原生子窗口 + 独立渲染（折中，成本高）

Rust 侧车建一个原生子窗口嵌进任务栏，歌词由**原生绘制**（不是 Electron 渲染）。能拿到真嵌入，但要放弃 AMLL/Web 渲染栈，等于重写歌词呈现层 —— 不划算。

---

## 六、建议的推进顺序

**第 0 步（先做，决定后续一切）**：最小验证 Electron 能否被 re-parent。
写个一次性 Electron 窗口，`SetParent` 到 `Shell_TrayWnd`，看是否黑屏。
- 能渲染 → 方案 A 可行，值得投入
- 黑屏 → 立刻转方案 B，别在 A 上耗时间

**第 1 步**：Rust 侧车补 **SMTC 客户端**（读会话），把「当前在放什么」暴露给前端。
这是所有方案的前置，也是**独立价值最高**的一块（任务栏媒体浮层、跨播放器识别都能用）。

**第 2 步**：移植 `SmartTopmostPolicy` + 任务栏定位算法，做方案 B 的悬浮歌词。

**第 3 步**（可选）：多源歌词检索 + 评分录用（移植 `LyricResolutionCoordinator` 的思路，但用 TS 重写更合 SilverMoon 的技术栈）。

**不建议移植的**：
- 内嵌 33MB 的思源黑体（SilverMoon 已有字体方案，且磁盘紧张）
- 上游的 WPF/WebView2 宿主层（SilverMoon 是 Electron）
- 上游零框架 Web UI 的写法（SilverMoon 用 Vue + AMLL，没必要倒退）

---

## 七、上游值得单独借鉴的点

1. **`SmartTopmostPolicy`** —— 「全屏时主动让位」的思路，比无脑置顶专业
2. **任务栏尺寸/DPI 的钳制与像素对齐** —— 多显示器 + 高 DPI 下不出错的关键
3. **`TaskbarCreated` 消息监听** —— 任务栏崩溃重启后自动重挂，健壮性细节
4. **歌词录用的「评分」而非「先到先得」** —— 上游有 `LyricIdentityEvaluator` / `LyricMatchingPolicy` 一套打分，且要求「缓存格式必须版本化、模糊匹配不许变成持久结果」
5. **`Core` 层的编译期依赖禁令** —— 分层靠 csproj 约束而非文档，值得 SilverMoon 的 `verify:rust-pure` 参考

---

## 附：调研依据

- 仓库元数据与文件树：GitHub API（`repos/ANYNC/TaskbarLyrics`，312 文件）
- 关键源码：`EmbeddedTaskbarAnchor.cs`(24KB)、`TaskbarEmbeddingLayoutPolicy.cs`(18KB)、`TaskbarPlacementService.cs`(13.6KB)、`LyricsWindowHost.cs`(14.6KB)、`SmartTopmostPolicy.cs`、`AppSettings.cs`、`SmtcMusicSessionProvider.cs`(52KB)
- 上游文档：`AGENTS.md`、`docs/功能与技术说明.md`(35KB)、`docs/歌词呈现引擎.md`(12KB)
- 嵌入机制的相关 Win32 语义：[SetParent](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-setparent)、[parent vs owner](https://devblogs.microsoft.com/oldnewthing/20100315-00/?p=14613)
