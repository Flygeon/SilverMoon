//! **真嵌入任务栏**：把窗口变成 \`Shell_TrayWnd\` 的子窗口。
//!
//! ## 为什么这条路在 Electron 下不通、在这里通
//!
//! 2026-10-15 实测：Electron 的 \`BrowserWindow\` 被 \`SetParent\` 后
//! ①位置/尺寸被 Chromium 抢回（900ms 内弹回）②渲染变纯黑 ——
//! 因为它的 HWND **本身就是 Chromium 的顶层 widget**，没有中间层可拦。
//!
//! 本进程的窗口是**我们自己用 \`CreateWindowExW\` 建的**，由我们的消息循环管，
//! WebView2 只是它里面的一个**子控件**（\`wry::build_as_child\`）。
//! 结构与参考项目 TaskbarLyrics 的 \`MainWindow.xaml\` 完全同构：
//! 外层原生窗口 + 内层 WebView2。它的 WPF 版本能成功，正是同一个道理。
//!
//! ## 嵌入步骤（照抄参考项目 EmbeddedTaskbarAnchor.cs 的顺序）
//!
//! 1. \`FindWindowW("Shell_TrayWnd")\` 拿任务栏；多屏用 \`Shell_SecondaryTrayWnd\`；
//! 2. \`SetParent(hwnd, taskbar)\`；
//! 3. 改窗口样式：去掉 \`WS_POPUP\`、加上 \`WS_CHILD | WS_VISIBLE\`；
//! 4. 扩展样式去掉 \`WS_EX_TOOLWINDOW\`、加上 \`WS_EX_NOACTIVATE\`（不抢焦点）；
//! 5. **校验** \`GetAncestor(hwnd, GA_PARENT) == taskbar\` —— 不成立就算失败。
//!
//! 第 5 步是关键：\`SetParent\` 会「成功返回」但实际没生效（参考项目注释里
//! 记为 \`ReparentRejected\`）。**没有校验的嵌入是自欺欺人**。

use windows::Win32::Foundation::HWND;
use windows::Win32::UI::WindowsAndMessaging::{
    FindWindowExW, FindWindowW, GetAncestor, GetWindowLongPtrW, SetParent, SetWindowLongPtrW,
    SetWindowPos, GA_PARENT, GWL_EXSTYLE, GWL_STYLE, HWND_TOP, SWP_FRAMECHANGED, SWP_NOACTIVATE,
    SWP_NOMOVE, SWP_NOSIZE, SWP_SHOWWINDOW, WS_CHILD, WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW, WS_POPUP,
    WS_VISIBLE,
};

/// 嵌入结果。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EmbedResult {
    /// 成功成为任务栏子窗口
    Embedded,
    /// 找不到任务栏（自动隐藏 / 全屏独占 / 非标准 shell）
    NoTaskbar,
    /// \`SetParent\` 返回了但校验不通过（参考项目称之为 ReparentRejected）
    Rejected,
}

/// 找主任务栏。找不到返回 \`None\`。
///
/// 只找主任务栏：副屏任务栏是 \`Shell_SecondaryTrayWnd\`，多屏场景下
/// 应该按歌词窗口所在的显示器选 —— 那需要 \`MonitorFromWindow\` 配合，
/// 留到支持多屏时再做（当前先保证单屏正确）。
pub fn find_primary_taskbar() -> Option<HWND> {
    unsafe {
        let h = FindWindowW(windows::core::w!("Shell_TrayWnd"), None).ok()?;
        if h.0.is_null() {
            None
        } else {
            Some(h)
        }
    }
}

/// 找任务栏里那个承载任务列表的容器（\`ReBarWindow32\`，退化到 \`WorkerW\`）。
///
/// 参考项目会挤占 \`MSTaskListWClass\` 的宽度给歌词腾位置。我们**暂不做**：
/// 那会在任务栏上「抠掉」一块图标区，用户如果把歌词窗口关掉、
/// 或窗口没渲染出来，任务栏会留下一个空洞。先做「盖在上面」，
/// 视觉上够用且完全可逆。
pub fn find_taskbar_container(taskbar: HWND) -> Option<HWND> {
    unsafe {
        let rebar = FindWindowExW(
            Some(taskbar),
            None,
            windows::core::w!("ReBarWindow32"),
            None,
        )
        .ok()?;
        if !rebar.0.is_null() {
            return Some(rebar);
        }
        let worker = FindWindowExW(Some(taskbar), None, windows::core::w!("WorkerW"), None).ok()?;
        if !worker.0.is_null() {
            Some(worker)
        } else {
            None
        }
    }
}

/// 把窗口嵌进任务栏。返回结果供调用方决定是否回退到浮贴。
pub fn embed_into_taskbar(hwnd: HWND) -> EmbedResult {
    let Some(taskbar) = find_primary_taskbar() else {
        return EmbedResult::NoTaskbar;
    };
    embed_into(hwnd, taskbar)
}

/// 嵌入到指定父窗口（拆出来是为了能在测试/调试里指定父窗口）。
pub fn embed_into(hwnd: HWND, parent: HWND) -> EmbedResult {
    unsafe {
        // 嵌入前先取消置顶：任务栏的子窗口不该带 topmost，
        // 否则切到浮贴模式时会残留置顶状态（参考项目也这么做）。
        SetWindowPos(
            hwnd,
            Some(HWND_TOP),
            0,
            0,
            0,
            0,
            SWP_NOACTIVATE | SWP_NOMOVE | SWP_NOSIZE,
        );

        // SetParent 的父窗口参数是 Option<HWND>
        SetParent(hwnd, Some(parent));

        let style = GetWindowLongPtrW(hwnd, GWL_STYLE);
        let new_style =
            (style & !(WS_POPUP.0 as isize)) | WS_CHILD.0 as isize | WS_VISIBLE.0 as isize;
        SetWindowLongPtrW(hwnd, GWL_STYLE, new_style);

        let ex = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
        let new_ex = (ex & !(WS_EX_TOOLWINDOW.0 as isize)) | WS_EX_NOACTIVATE.0 as isize;
        SetWindowLongPtrW(hwnd, GWL_EXSTYLE, new_ex);

        // 让样式变更立即生效（否则窗口要等下一次重绘才认新样式）
        SetWindowPos(
            hwnd,
            Some(HWND_TOP),
            0,
            0,
            0,
            0,
            SWP_FRAMECHANGED | SWP_NOACTIVATE | SWP_NOMOVE | SWP_NOSIZE,
        );

        // **校验**：SetParent 会「成功返回」但实际没生效，必须验证祖先。
        // 没有这一步的嵌入是自欺欺人（参考项目把它记为 ReparentRejected）。
        if GetAncestor(hwnd, GA_PARENT) == parent {
            EmbedResult::Embedded
        } else {
            EmbedResult::Rejected
        }
    }
}

/// 把窗口摆到任务栏内的指定位置（相对任务栏客户区）。
pub fn place_in_taskbar(hwnd: HWND, x: i32, y: i32, width: i32, height: i32) {
    unsafe {
        SetWindowPos(
            hwnd,
            Some(HWND_TOP),
            x,
            y,
            width,
            height,
            SWP_NOACTIVATE | SWP_SHOWWINDOW,
        );
    }
}

/// 从任务栏脱离（切回浮贴模式时用）。
///
/// 必须**恢复原始样式**：只 \`SetParent(None)\` 而留着 \`WS_CHILD\`
/// 会让窗口变成一个没有父窗口的子窗口 —— 不可见、也无法交互。
pub fn detach_from_taskbar(hwnd: HWND) {
    unsafe {
        // None = 脱离父窗口
        SetParent(hwnd, None);

        let style = GetWindowLongPtrW(hwnd, GWL_STYLE);
        let restored =
            (style & !(WS_CHILD.0 as isize)) | WS_POPUP.0 as isize | WS_VISIBLE.0 as isize;
        SetWindowLongPtrW(hwnd, GWL_STYLE, restored);

        let ex = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
        SetWindowLongPtrW(hwnd, GWL_EXSTYLE, ex | WS_EX_TOOLWINDOW.0 as isize);

        SetWindowPos(
            hwnd,
            Some(HWND_TOP),
            0,
            0,
            0,
            0,
            SWP_FRAMECHANGED | SWP_NOACTIVATE | SWP_NOMOVE | SWP_NOSIZE,
        );
    }
}

/// 诊断用：读窗口的屏幕矩形（l,t,w,h）。
pub fn window_rect(hwnd: HWND) -> Option<(i32, i32, i32, i32)> {
    use windows::Win32::Foundation::RECT;
    use windows::Win32::UI::WindowsAndMessaging::GetWindowRect;
    unsafe {
        let mut r = RECT::default();
        GetWindowRect(hwnd, &mut r).ok()?;
        Some((r.left, r.top, r.right - r.left, r.bottom - r.top))
    }
}

/// 实测任务栏客户区高度（像素）。
///
/// 不用硬编码：任务栏高度随「任务栏图标大小」设置变化（小/中/大各不相同），
/// 用户改过就对不上了。拿不到时返回 None，调用方退化到 40。
pub fn taskbar_client_height() -> Option<i32> {
    let taskbar = find_primary_taskbar()?;
    taskbar_client_size(taskbar).map(|(_, h)| h)
}

/// 任务栏客户区尺寸（**窗口客户区坐标**，与 SetWindowPos 对 WS_CHILD 子窗口
/// 使用的坐标系一致）。
///
/// ## 为什么必须用 GetClientRect（而不是 GetWindowRect 再折算）
///
/// 我们的进程是 PerMonitor DPI 感知的，任务栏属于系统进程、在自己的 DPI 上下文中。
/// 对 **WS_CHILD 子窗口**调 SetWindowPos 时，坐标与尺寸是**相对父窗口客户区**的，
/// 而父窗口（任务栏）的客户区坐标系就是 GetClientRect 给出的那一套 ——
/// 两者天然一致，不需要任何 DPI 换算。
///
/// 之前的 bug 正出在这里：我拿 GetClientRect 的值当"物理像素"用，
/// 又去和屏幕坐标混算，结果高度算成 76（真实 40）、y 算成 1746（真实应在 872 附近）。
/// 取「本窗口的父窗口（任务栏）」客户区尺寸。
/// 父窗口不是任务栏时退化到主任务栏。
pub fn taskbar_client_size_of(hwnd: HWND) -> Option<(i32, i32)> {
    use windows::Win32::UI::WindowsAndMessaging::GetParent;
    unsafe {
        let parent = GetParent(hwnd).ok()?;
        if !parent.0.is_null() {
            if let Some(size) = taskbar_client_size(parent) {
                return Some(size);
            }
        }
    }
    find_primary_taskbar().and_then(taskbar_client_size)
}

pub fn taskbar_client_size(taskbar: HWND) -> Option<(i32, i32)> {
    use windows::Win32::Foundation::RECT;
    use windows::Win32::UI::WindowsAndMessaging::GetClientRect;

    unsafe {
        let mut rect = RECT::default();
        GetClientRect(taskbar, &mut rect).ok()?;
        let w = rect.right - rect.left;
        let h = rect.bottom - rect.top;
        if w > 0 && h > 0 {
            Some((w, h))
        } else {
            None
        }
    }
}

/// 任务栏是否已存在（判断 shell 是否就绪）。
pub fn taskbar_exists() -> bool {
    find_primary_taskbar().is_some()
}
