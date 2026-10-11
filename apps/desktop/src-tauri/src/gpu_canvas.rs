//! GPU 画布：用 wgpu 直绘一个原生窗口。
//!
//! ## 为什么不用 WebView 里的 Canvas
//!
//! 绘画的画布目前在渲染进程里走 LeaferJS（底层是 **Canvas 2D**）。Canvas 2D
//! 没有合成器概念：每次重绘要按顺序把所有图形重画一遍。几十个图形时无感，
//! 但专业绘画要的是**上百图层**，那时每次重绘都要重画全部内容，必然掉帧。
//!
//! wgpu 走真正的 GPU 合成，是这条路的前提。
//!
//! ## 架构：一个独立的原生窗口，叠在 WebView 之上
//!
//! 关键约束：Tauri 的窗口是「原生窗口 + WebView2 子窗口」两层结构，
//! **子窗口永远绘制在父窗口之上**。所以不能让 wgpu 画到主窗口的 HWND 上 ——
//! WebView 会把它整个盖住。
//!
//! 因此这里用另一个办法：**单独建一个无边框的原生窗口**（`tauri::WindowBuilder`，
//! 它不创建 webview），wgpu 画在那个窗口里；前端把画布区域的屏幕坐标报过来，
//! 我们把它精确摆到那个位置。视觉上就是「画布嵌在界面里」，实际是两个窗口。
//!
//! 这个做法换来两个好处：
//! 1. **输入直接进 GPU 窗口**，没有「事件穿透」问题（若反过来让 webview 透明
//!    浮在上面，鼠标事件就得手动转发，非常容易出错）；
//! 2. 窗口不透明，**没有额外的合成开销**。
//!
//! ## 线程模型（这里有个必须绕开的约束）
//!
//! `wgpu::Surface<'window>` **带生命周期**，它借用了窗口的句柄，因此**不能跨线程
//! 移动**（wgpu 只保证 `Surface: Send + Sync`，但生命周期把它钉在创建它的作用域里）。
//!
//! 于是不能「主线程建窗、子线程建 surface」。这里采用 Tauri 官方文档给出的模式
//! （见 `WindowBuilder` 的「Create a window in a separate thread」示例）：
//! **整条链都在同一个子线程里完成** —— 建窗 → 建 surface → 渲染循环 → 收尾。
//!
//! 为什么不放主线程：渲染循环是阻塞的，放主线程会冻住整个 UI。
//!
//! ## 平台差异
//!
//! `WindowBuilder` 三平台都可用；拿窗口句柄的 API 不同（`hwnd` / `ns_window` /
//! `gtk_window`），但 wgpu 的 `create_surface` 统一接受 `raw_window_handle`，
//! 而 `tauri::Window` 已实现 `HasWindowHandle` + `HasDisplayHandle`，
//! **因此这里不需要任何平台分支**。
//!
//! ## 当前阶段
//!
//! **只做可行性验证**：建窗口、建 surface、每帧清屏。图层、笔刷、分片都在后续
//! 阶段（见 doc/GPU-CANVAS.md）。现在要证明的是「Tauri + wgpu 直绘在三平台成立」
//! —— 这是整条路线里唯一可能「此路不通」的地方，值得先单独验证。

use std::sync::{Arc, Mutex};

// Manager trait 必须显式引入：get_window / state 都是它的方法，
// 少了这行会报「no method named get_window」（这是 Rust 常见的坑）。
use tauri::{AppHandle, Manager};

/// GPU 画布窗口的 label。
pub const GPU_CANVAS_LABEL: &str = "gpu-canvas";

/// 画布会话的共享状态。
///
/// 渲染线程每帧检查 `running`；主线程通过命令改它来请求退出。
#[derive(Default)]
pub struct CanvasState {
    /// 渲染线程的退出标志（见渲染循环）。
    running: Arc<Mutex<bool>>,
    /// 「正在创建中」标志。
    ///
    /// 必需：窗口是在**子线程**里建的，从 open() 返回（乃至第一次 get_window
    /// 查询）到窗口真正出现之间有不小的空窗期。前端会因 ResizeObserver + rAF
    /// 在同一次布局里调两次 open —— 空窗期内两次都查不到窗口，于是**启动两个
    /// 渲染线程**（两个线程抢同一个 surface：表现为闪烁或崩溃）。
    /// 这个标志把并发的创建请求挡住。
    starting: Arc<std::sync::atomic::AtomicBool>,
}

/// 画布区域（逻辑像素），由前端上报。
#[derive(Clone, Copy, Debug)]
pub struct CanvasRect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

/// 创建（或复用）GPU 画布窗口，并启动渲染线程。
///
/// 参数是**逻辑像素**的画布区域，前端从占位 div 的
/// `getBoundingClientRect()` 拿到屏幕坐标后传进来。
pub fn open(app: &AppHandle, rect: CanvasRect) -> Result<(), String> {
    use std::sync::atomic::Ordering;

    let state = app.state::<CanvasState>();
    let running = Arc::clone(&state.running);
    let starting = Arc::clone(&state.starting);

    // 入口打点：这条是**最先**该出现的日志。它的有无能区分两种完全不同的故障：
    //   有 → 命令确实进来了，问题在后端；
    //   无 → 前端根本没调到（capability 未放行 / 命令名拼错 / 前端异常）。
    crate::boot_log::record(&format!(
        "[gpu-canvas] open 请求 x={:.0} y={:.0} {}x{}",
        rect.x, rect.y, rect.width, rect.height
    ));

    // 已经开着：只更新位置与尺寸，不重复建窗（否则会有两个画布窗口）
    if let Some(_existing) = app.get_window(GPU_CANVAS_LABEL) {
        crate::boot_log::record("[gpu-canvas] 窗口已存在，仅更新位置尺寸");
        return resize(app, rect);
    }

    // 有人正在建：不重复发起（原因见 CanvasState::starting 的注释）。
    // compare_exchange 保证只有一个调用能拿到「创建权」。
    if starting
        .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
        .is_err()
    {
        return Ok(());
    }

    {
        let mut r = running.lock().map_err(|e| e.to_string())?;
        *r = true;
    }

    // 整条链必须在同一个线程里完成 —— 原因见模块头「线程模型」。
    // 用 Tauri 官方文档给出的「子线程里建窗」模式。
    let handle = app.clone();
    let running_bg = Arc::clone(&running);
    let starting_bg = Arc::clone(&starting);
    std::thread::spawn(move || {
        // ⚠️ 用 boot_log 而不是 eprintln!：release 构建是
        // `windows_subsystem = "windows"`（**没有控制台**），eprintln 的输出
        // 会直接丢掉 —— 排查闪退时等于没有日志。
        let result = run_canvas(handle, rect, running_bg);
        // 无论成功失败都要放开「正在创建」标志，否则后续 open 会被永久挡住
        // （窗口建失败就再也打不开了）。
        starting_bg.store(false, Ordering::Release);
        if let Err(e) = result {
            crate::boot_log::record(&format!("[gpu-canvas] 画布线程退出：{e}"));
        }
    });

    Ok(())
}

/// 调整画布窗口的位置与尺寸（前端布局变化时调用）。
pub fn resize(app: &AppHandle, rect: CanvasRect) -> Result<(), String> {
    let Some(win) = app.get_window(GPU_CANVAS_LABEL) else {
        return Err("GPU 画布窗口未打开".into());
    };
    // 位置与尺寸都用**逻辑**坐标：Tauri 会按显示器缩放比换算成物理像素，
    // 而前端的 getBoundingClientRect() 正是 CSS（逻辑）像素，口径一致。
    win.set_position(tauri::LogicalPosition::new(rect.x, rect.y))
        .map_err(|e| e.to_string())?;
    win.set_size(tauri::LogicalSize::new(rect.width, rect.height))
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// 关闭画布窗口并停止渲染线程。
pub fn close(app: &AppHandle) -> Result<(), String> {
    use std::sync::atomic::Ordering;

    let state = app.state::<CanvasState>();
    if let Ok(mut r) = state.running.lock() {
        *r = false;
    }
    // 同时放开创建标志：下次 open 才能重新建窗
    state.starting.store(false, Ordering::Release);
    if let Some(win) = app.get_window(GPU_CANVAS_LABEL) {
        win.close().map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// 画布线程：建窗 → 建 wgpu → 渲染循环 → 收尾。
fn run_canvas(app: AppHandle, rect: CanvasRect, running: Arc<Mutex<bool>>) -> Result<(), String> {
    // ---- 1) 建一个纯原生窗口（WindowBuilder 不创建 webview）----
    //
    // 为什么是 WindowBuilder 而不是 WebviewWindowBuilder：后者会再套一个
    // WebView2 子窗口，那正是我们要避开的（它会盖住 wgpu 的输出）。
    crate::boot_log::record("[gpu-canvas] 开始建窗");
    let window = tauri::window::WindowBuilder::new(&app, GPU_CANVAS_LABEL)
        .title("SilverMoon GPU Canvas")
        .inner_size(rect.width, rect.height)
        .position(rect.x, rect.y)
        .decorations(false)
        .resizable(false)
        .skip_taskbar(true)
        .shadow(false)
        .visible(true)
        .build()
        .map_err(|e| format!("创建 GPU 画布窗口失败：{e}"))?;

    crate::boot_log::record("[gpu-canvas] 窗口已建，开始 wgpu 初始化");

    // ---- 2) wgpu 初始化 ----
    //
    // 这一串在 wgpu 30 与旧版有差异（已对照 30.0.1 源码逐一核对）：
    //   - InstanceDescriptor 用 new_without_display_handle()（旧版是 ..Default::default()）
    //   - request_adapter 返回 Result（旧版是 Option）
    //   - RenderPassColorAttachment 有 depth_slice 字段（旧版没有）
    // 后端选择：默认让 wgpu 自己挑（Backends::all()），
    // 但允许用环境变量 SILVERMOON_GPU_BACKEND 强制指定，便于在崩溃环境上逐个试：
    //   dx12 / vulkan / gl / metal / all
    // 这是排查「某后端不可用导致原生崩溃」的关键手段。
    let mut desc = wgpu::InstanceDescriptor::new_without_display_handle();
    if let Ok(want) = std::env::var("SILVERMOON_GPU_BACKEND") {
        let b = match want.to_ascii_lowercase().as_str() {
            "dx12" | "d3d12" => wgpu::Backends::DX12,
            "vulkan" | "vk" => wgpu::Backends::VULKAN,
            "gl" | "gles" | "opengl" => wgpu::Backends::GL,
            "metal" => wgpu::Backends::METAL,
            _ => wgpu::Backends::all(),
        };
        crate::boot_log::record(&format!("[gpu-canvas] 后端被指定为 {b:?}（来自环境变量）"));
        desc.backends = b;
    }
    crate::boot_log::record(&format!(
        "[gpu-canvas] 准备创建 Instance，后端={:?}",
        desc.backends
    ));
    let instance = wgpu::Instance::new(desc);

    // create_surface 接受 impl Into<SurfaceTarget>；
    // tauri::Window 实现了 HasWindowHandle + HasDisplayHandle，
    // 因此可直接传入，无需平台分支。
    crate::boot_log::record("[gpu-canvas] Instance 已建，创建 surface");
    let surface = instance
        .create_surface(window.clone())
        .map_err(|e| format!("创建 wgpu surface 失败：{e}"))?;
    crate::boot_log::record("[gpu-canvas] surface 已建，请求 adapter");

    let adapter = pollster::block_on(instance.request_adapter(&wgpu::RequestAdapterOptions {
        power_preference: wgpu::PowerPreference::HighPerformance,
        compatible_surface: Some(&surface),
        force_fallback_adapter: false,
        // wgpu 30 新增字段（旧版没有）。false = 不按适配器能力分桶限制，
        // 语义是「按 required_limits 精确要」，这里保持默认的宽松行为。
        apply_limit_buckets: false,
    }))
    .map_err(|e| format!("找不到可用的 GPU 适配器：{e}"))?;

    crate::boot_log::record("[gpu-canvas] adapter 已取得，请求 device");
    let (device, queue) = pollster::block_on(adapter.request_device(&wgpu::DeviceDescriptor {
        label: Some("silvermoon-gpu-canvas"),
        required_features: wgpu::Features::empty(),
        // 默认限制即可：当前只做清屏，后续画布合成再按需上调。
        required_limits: wgpu::Limits::default(),
        ..Default::default()
    }))
    .map_err(|e| format!("请求 GPU 设备失败：{e}"))?;

    crate::boot_log::record("[gpu-canvas] device 已取得，配置 surface");

    // ---- 3) surface 配置 ----
    let size = window
        .inner_size()
        .map_err(|e| format!("读取窗口尺寸失败：{e}"))?;
    let width = size.width.max(1);
    let height = size.height.max(1);

    let caps = surface.get_capabilities(&adapter);
    // ⚠️ 这里**不能**用 `caps.formats[0]` 直接索引：列表为空时索引会 panic，
    // 而本项目 release profile 是 `panic = "abort"` —— panic 会**直接杀掉整个进程**
    // （用户看到的就是「点一下就闪退」）。凡是外部数据都返回错误，不 panic。
    // 优先 sRGB：画布颜色要与 UI 一致，选错会出现整体偏色。
    let format = caps
        .formats
        .iter()
        .copied()
        .find(|f| f.is_srgb())
        .or_else(|| caps.formats.first().copied())
        .ok_or_else(|| "该 surface 没有可用的纹理格式".to_string())?;

    // 同理：alpha_modes 为空时不能索引
    let alpha_mode = caps
        .alpha_modes
        .first()
        .copied()
        .ok_or_else(|| "该 surface 没有可用的 alpha 模式".to_string())?;

    // ⚠️ 必须是 mut：窗口尺寸变化时要就地更新宽高并重新 configure（见渲染循环）。
    let mut config = wgpu::SurfaceConfiguration {
        usage: wgpu::TextureUsages::RENDER_ATTACHMENT,
        format,
        // wgpu 30 新增字段（旧版没有）。Auto = 由呈现引擎按格式自行选择色彩空间，
        // 这正是我们要的（不干预系统的色彩管理）。
        color_space: wgpu::SurfaceColorSpace::Auto,
        width,
        height,
        present_mode: wgpu::PresentMode::Fifo,
        alpha_mode,
        view_formats: vec![],
        desired_maximum_frame_latency: 2,
    };
    surface.configure(&device, &config);
    crate::boot_log::record("[gpu-canvas] surface 已配置，即将进入渲染循环");

    let info = adapter.get_info();
    crate::boot_log::record(&format!(
        "[gpu-canvas] 就绪 {width}x{height} {format:?} backend={:?} adapter={}",
        info.backend, info.name
    ));

    // ---- 4) 渲染循环 ----
    //
    // 目前只清屏成随时间变化的颜色，用来验证「窗口 + surface + 每帧呈现」整条链路；
    // 一眼能看出循环在跑（静态画面无法区分「在渲染」和「卡住了」）。
    let start = std::time::Instant::now();
    // 帧计数：仅用于打点节流（每 300 帧写一次，避免日志被刷爆）
    let mut frame_no: u64 = 0;
    crate::boot_log::record("[gpu-canvas] 渲染循环开始");
    loop {
        // 窗口被用户关掉时，Tauri 会把窗口销毁；这里靠 running 标志退出
        if !*running.lock().map_err(|e| e.to_string())? {
            break;
        }

        // 打点：前 3 帧 + 之后每 300 帧一次。
        // 目的是定位「跑几秒后闪退」发生在哪一步 —— 若日志停在
        // 「开始第 N 帧」而后面没有「第 N 帧完成」，就说明崩在中间。
        if frame_no < 3 || frame_no % 300 == 0 {
            crate::boot_log::record(&format!("[gpu-canvas] 第 {frame_no} 帧开始"));
        }

        // ---- 尺寸同步：窗口变了就重配 surface ----
        //
        // ⚠️ 这一步是**必需的**，不是优化。
        //
        // 窗口被改尺寸后，surface 仍按**旧尺寸**配置着。此时继续 present 一张不匹配
        // 的缓冲是**未定义行为**（DXGI 的 ResizeBuffers 从未被调用）：轻则画面拉伸，
        // 重则驱动访问违例 —— 而且是**原生崩溃**，不触发 Rust 的 panic hook，
        // 所以日志里什么都看不到，表现就是「跑几秒突然没了」。
        //
        // 前端每次布局变化都会调 gpu_canvas_resize（ResizeObserver），
        // 因此这里必须在每帧开头把尺寸对齐回来。
        // 顺便用它判断窗口是否还在：读不到尺寸说明窗口已被销毁，
        // 此时必须退出循环 —— 否则会一直对着一个死 surface 空转。
        match window.inner_size() {
            Ok(now) => {
                let (w, h) = (now.width.max(1), now.height.max(1));
                if w != config.width || h != config.height {
                    crate::boot_log::record(&format!(
                        "[gpu-canvas] surface 重配 {}x{} → {w}x{h}",
                        config.width, config.height
                    ));
                    config.width = w;
                    config.height = h;
                    surface.configure(&device, &config);
                }
            }
            Err(_) => {
                crate::boot_log::record("[gpu-canvas] 窗口已销毁，退出渲染循环");
                break;
            }
        }

        let frame = match surface.get_current_texture() {
            // 可正常用的两种：Suboptimal 只是提示「建议重配」，当前尺寸未变，照常呈现
            wgpu::CurrentSurfaceTexture::Success(f)
            | wgpu::CurrentSurfaceTexture::Suboptimal(f) => f,
            // 超时 / 被遮挡：跳过这一帧即可，不是错误
            wgpu::CurrentSurfaceTexture::Timeout | wgpu::CurrentSurfaceTexture::Occluded => {
                std::thread::sleep(std::time::Duration::from_millis(16));
                continue;
            }
            // Outdated：surface 与窗口已不兼容，**必须重配**才能恢复。
            // （不能像上面那样单纯跳过 —— 那样会一直拿到 Outdated 空转。）
            wgpu::CurrentSurfaceTexture::Outdated => {
                crate::boot_log::record("[gpu-canvas] surface 已过期，重新配置");
                surface.configure(&device, &config);
                continue;
            }
            // Lost：surface 丢失，重配后重试
            wgpu::CurrentSurfaceTexture::Lost => {
                crate::boot_log::record("[gpu-canvas] surface 丢失，重新配置");
                surface.configure(&device, &config);
                continue;
            }
            wgpu::CurrentSurfaceTexture::Validation => {
                return Err("surface 校验失败（见上文 wgpu 校验错误）".into());
            }
        };

        let view = frame
            .texture
            .create_view(&wgpu::TextureViewDescriptor::default());

        // 清屏色随时间缓慢呼吸：证明每帧都有新内容被呈现
        let t = start.elapsed().as_secs_f32();
        let phase = ((t * 0.5).sin() * 0.5 + 0.5) as f64;
        let clear = wgpu::Color {
            r: 0.10 + 0.06 * phase,
            g: 0.11,
            b: 0.16 + 0.06 * (1.0 - phase),
            a: 1.0,
        };

        let mut encoder = device.create_command_encoder(&wgpu::CommandEncoderDescriptor {
            label: Some("gpu-canvas-frame"),
        });
        {
            // begin_render_pass 返回的 guard 必须先 drop 再 finish encoder，
            // 因此这里显式放进一个块里。
            let _pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("gpu-canvas-pass"),
                color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                    view: &view,
                    depth_slice: None,
                    resolve_target: None,
                    ops: wgpu::Operations {
                        load: wgpu::LoadOp::Clear(clear),
                        store: wgpu::StoreOp::Store,
                    },
                })],
                depth_stencil_attachment: None,
                timestamp_writes: None,
                occlusion_query_set: None,
                // wgpu 30 新增字段（旧版没有）。None = 不用 multiview，
                // 这是单目标渲染的正确取值。
                multiview_mask: None,
            });
        }
        queue.submit(std::iter::once(encoder.finish()));
        // ⚠️ wgpu 30 移除了 `SurfaceTexture::present()`：
        // 现在**呈现发生在 SurfaceTexture 被 drop 时**（见 wgpu 的 surface_texture.rs：
        // `impl Drop for SurfaceTexture` 里会 texture_present 或 texture_discard）。
        // 因此这里显式 drop 是必要的 —— 如果不 drop（例如把它留在作用域里循环复用），
        // 那一帧永远不会被呈现，画面会停在第一帧。
        drop(frame);

        if frame_no < 3 || frame_no % 300 == 0 {
            crate::boot_log::record(&format!("[gpu-canvas] 第 {frame_no} 帧完成"));
        }
        frame_no += 1;

        // 约 60fps。后续接入真实画布内容时再改成按需重绘。
        std::thread::sleep(std::time::Duration::from_millis(16));
    }

    crate::boot_log::record(&format!("[gpu-canvas] 渲染循环已停止（共 {frame_no} 帧）"));
    // 窗口对象在这里 drop；实际窗口已由 close() 销毁，重复销毁是安全的。
    Ok(())
}
