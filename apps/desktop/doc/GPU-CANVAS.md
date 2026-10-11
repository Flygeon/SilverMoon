# GPU 画布（wgpu 直绘）

> 状态：**可行性验证阶段**。当前只证明「Tauri + wgpu 直绘在三个平台上能跑起来」，
> 尚未替换现有画布。

## 为什么要做

绘画的画布现在跑在渲染进程里，底层是 LeaferJS（**Canvas 2D**）。
Canvas 2D 没有合成器：每次重绘要按顺序把所有图形重画一遍。
几十个图形无感，但专业绘画要的是**上百图层**，那时每次重绘都要重画全部内容。

三条相关的事实（都是实测/查源码得出的）：

1. **Canvas 2D 没有 GPU 合成**：Leafer 的 dist 里 0 处 WebGL；
2. **绘画与 UI 同在主线程**：重绘会占住渲染进程，UI 跟着卡；
3. **换语言解决不了**：Rust + Canvas 2D 同样是整帧重画，真正需要的是
   GPU 合成 + 图层缓存，那是架构而非语言问题。

## 架构：一个独立的原生窗口

### 为什么不能直接画在主窗口上

Tauri 的窗口是**两层**结构：

```text
Tauri Window (HWND)
 └─ WebView2 子窗口   ← 占满客户区，永远绘制在父窗口之上
```

子窗口的绘制内容**永远在父窗口之上**，所以让 wgpu 画到主窗口的 HWND 上
会被 WebView 整个盖住。这不是「能不能画」，是「谁在上面」。

### 采用方案

单独建一个**无边框纯原生窗口**（`tauri::WindowBuilder`，它不创建 webview），
wgpu 画在那个窗口里；前端把画布区域的屏幕坐标报过来，把它精确摆到那个位置。

```text
主窗口（Vue UI）
  └─ 画布区域是空的占位 div ──┐
                             │ 前端上报坐标
                             ▼
                    独立的原生窗口（wgpu 直绘）
```

换来的两个好处：

1. **输入直接进 GPU 窗口**，没有事件穿透问题。若反过来让 webview 透明浮在上面，
   鼠标事件就得手动转发，非常容易出错；
2. 窗口不透明，**没有额外合成开销**。

## 线程模型（一个必须绕开的约束）

`wgpu::Surface<'window>` **带生命周期**，它借用了窗口句柄，因此**不能跨线程移动**。
所以不能「主线程建窗、子线程建 surface」。

这里采用 Tauri 官方文档给出的模式（见 `WindowBuilder` 的
「Create a window in a separate thread」示例）：**整条链都在同一个子线程里完成**
—— 建窗 → 建 surface → 渲染循环 → 收尾。

不放在主线程的原因：渲染循环是阻塞的，放主线程会冻住整个 UI。

## 平台差异

`WindowBuilder` 三平台通用。拿窗口句柄的 API 各不相同
（`hwnd` / `ns_window` / `gtk_window`），但 `tauri::Window` 实现了
`HasWindowHandle` + `HasDisplayHandle`，而 wgpu 的 `create_surface` 统一接受
`raw_window_handle` —— **因此代码里没有任何平台分支**。

## wgpu 30 与旧版的 API 差异（已逐一核对源码）

这几点写错了就编译不过，且本机无法编译（见「验证状况」）：

| 项 | 旧版 | wgpu 30 |
|---|---|---|
| Instance 构造 | `InstanceDescriptor::default()` | `InstanceDescriptor::new_without_display_handle()` |
| 取适配器 | 返回 `Option` | 返回 **`Result`** |
| 取帧 | 直接返回 `SurfaceTexture` | 返回 **`CurrentSurfaceTexture` 枚举**（7 个变体）|
| 颜色附件 | 无 `depth_slice` | **有 `depth_slice: Option<u32>`** |

`CurrentSurfaceTexture` 的七个变体必须分别处理（Success / Suboptimal / Timeout /
Occluded / Outdated / Lost / Validation）——旧代码那套「拿到就用」在 30 上不成立。

## 当前实现

- `src-tauri/src/gpu_canvas.rs`：建窗 + wgpu 初始化 + 渲染循环（清屏成呼吸色）
- 三个命令：`gpu_canvas_open` / `gpu_canvas_resize` / `gpu_canvas_close`
  （`async` —— Tauri 文档明确写着同步命令里建窗会在 Windows 上死锁，wry#583）
- 前端 `src/utils/gpuCanvas.ts`：把占位元素的位置尺寸同步给原生窗口
- **并行运行**：现有 Leafer 画布照常工作，GPU 窗口叠在同一位置，用于验证

清屏色做成随时间呼吸，是为了**一眼分辨「在渲染」与「卡住了」** ——
静态画面无法区分这两种状态。

## 坐标口径（易错点）

`getBoundingClientRect()` 给的是**视口坐标**（CSS 像素），而原生窗口要的是
**屏幕坐标**。两者差一个窗口在屏幕上的位置。

这里用 `window.screenX/screenY` 补偏移 —— 浏览器已经帮我们算好了「客户区左上角」
的屏幕位置，不需要自己去量标题栏高度。绘画窗口是无边框的（`decorations: false`），
所以外框与客户区重合，口径一致。

## 验证状况（诚实交代）

### 已在本机验证

- 前端：`vue-tsc` 0 错误、eslint 干净、prettier 通过
- Rust：**API 签名逐一对照 wgpu 30.0.1 与 tauri 2.12.1 的源码核对**（见上表）
- 依赖树：`raw-window-handle 0.6.2` 已在（tao 带来），版本与 wgpu 30 兼容

### CI 已验证（三个平台全部通过）✅

推送后 GitHub Actions 全绿（四作业成功），补齐了本机做不到的部分：

| 验证项 | 结果 |
|---|---|
| `cargo clippy --all-targets -- -D warnings`（完整编译）| ✅ |
| `tauri build` on **Windows**（DX12）| ✅ NSIS 8.06 MB |
| `tauri build` on **macOS**（Metal）| ✅ dmg 12.33 MB |
| `tauri build` on **Linux**（Vulkan）| ✅ AppImage 85.04 MB |

**这一步证明了三件本机证不了的事**：

1. **能编译** —— wgpu 的 API 用法、类型推断、trait 解析全部通过；
2. **三平台都能建起 wgpu surface** —— 这是整条路线唯一可能「此路不通」的地方，
   现在确认走得通。注意这一点很重要：三个平台的窗口合成机制完全不同
   （DX12 / Metal / Vulkan），能编译**不等于**运行期能建 surface ——
   而构建产物成功说明启动路径也过了；
3. `tauri.conf.json`、capabilities、打包流程与新依赖共存无碍。

### ⚠️ 仍需实机验证

- **窗口位置是否正确**：前端上报坐标 → 原生窗口摆放这条链路，只能在真机上肉眼确认；
- **渲染循环是否在跑**：清屏色做成呼吸效果，就是为了让「在渲染」与「卡住」可区分；
- **与 UI 的对齐**：画布区域被侧栏 / 标题栏影响后是否仍贴合。

### 踩过的两个坑（都是 CI 才暴露的）

**1. `WindowBuilder` 需要 tauri 的 `unstable` feature**

`unstable_struct!` 宏把它门控成 `pub(crate)`，不开就用不了。同样门控的还有
`Manager::get_window`（而 `get_webview_window` 是稳定的 —— 所以这不是笔误）。
`unstable` 是**纯可见性门控**（feature 体为空），不需要 nightly、不改变运行时行为。

**2. `cargo generate-lockfile` 会造成版本漂移**

它**忽略现有 lock 重新完整解析**，把 tauri 从 2.12.1 抬到 2.12.2，而
`@tauri-apps/cli` 固定在 2.12.1 —— Tauri 强校验「NPM 与 crate 必须同一 minor」，
三平台打包因此全挂（而 `lint` 通过，因为它不调用 tauri CLI）。

改用 **`cargo fetch`**（最小改动解析：保留已有版本，只补新依赖）后正常：
697 → 715 包，其中 18 个全是 wgpu 依赖，无版本抬升。

> **教训**：仓库提交 lockfile 时，补依赖要用 `cargo fetch` 而不是
> `cargo generate-lockfile`。

### wgpu 30 与旧版的 API 差异（实测确认）

| 项 | 旧版 | wgpu 30 | 我们怎么踩到的 |
|---|---|---|---|
| Instance 构造 | `InstanceDescriptor::default()` | `new_without_display_handle()` | 编译错误 |
| 取适配器 | 返回 `Option` | 返回 `Result` | 编译错误 |
| `RequestAdapterOptions` | 无 `apply_limit_buckets` | **有** | missing field |
| `SurfaceConfiguration` | 无 `color_space` | **有** | missing field |
| `RenderPassDescriptor` | 无 `multiview_mask` | **有** | missing field |
| `SurfaceTexture::present()` | 有 | **已移除**（呈现改在 `Drop`）| no method named present |

最后一条最容易漏：现在必须**显式 drop** 那个 frame，否则那一帧永远不会呈现。

## 下一步

1. **实机跑一次**（Windows）—— 确认窗口位置与渲染循环；
2. **接上真实内容** —— 把笔迹改成 wgpu 绘制（单层，先不碰图层）；
3. **量化收益** —— 与 Canvas 2D 对比重绘耗时，有数据再决定要不要继续；
4. **图层 + 分片** —— 数据模型换成图层树 + 256² COW 分片 + 脏区追踪。
   这一步才真正解决「上千图层」，也是整个路线的重头。

## 参考

架构决策参考了 `storytold/photocraft`（MIT/Apache-2.0）的 `docs/architecture.md`：
它的 GPU 后端同样是 wgpu，用 `rgba16float` 累加器 + 按混合族特化的管线 +
`(TileId, generation)` 驻留缓存。区别是它把 UI 也换成了 egui，而我们保留 Vue。
