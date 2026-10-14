//! 任务栏几何：算出歌词窗口该贴在哪。
//!
//! 这是 `src/utils/taskbarAnchor.ts` 的 Rust 版，**语义逐条对齐**（四边停靠、
//! 三档锚点、偏移、clamp、无任务栏退化）—— 前端那份仍服务于「浮贴」模式，
//! 原生窗口这份服务于「真嵌入」，两边算出来的位置必须一致，否则切换宿主时
//! 窗口会跳一下。
//!
//! 为什么不直接复用 Electron 的 `display.bounds/workArea`：原生窗口跑在
//! **独立进程**里，拿不到 Electron 的 screen API，只能自己问 Win32 要。
//! 但两者的数据模型是同一套（整块屏幕 vs 去掉任务栏的可用区），所以下面的
//! 纯几何逻辑可以完全共用。

/// 屏幕矩形（逻辑像素 DIP）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Rect {
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
}

/// 显示器几何：`bounds` 是整块屏幕，`work_area` 是扣掉任务栏后的可用区。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Display {
    pub bounds: Rect,
    pub work_area: Rect,
}

/// 任务栏停靠边。Windows 允许停靠上/下/左/右四边。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Edge {
    Bottom,
    Top,
    Left,
    Right,
}

/// 沿任务栏长边的锚点。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Align {
    Left,
    Center,
    Right,
}

/// workArea 相对 bounds 在四边各自被「吃掉」的厚度。
fn insets(d: &Display) -> (i32, i32, i32, i32) {
    let b = d.bounds;
    let w = d.work_area;
    (
        (w.x - b.x).max(0),
        (w.y - b.y).max(0),
        (b.x + b.width - (w.x + w.width)).max(0),
        (b.y + b.height - (w.y + w.height)).max(0),
    )
}

/// 任务栏停在哪条边：取内缩量最大的那条。全为 0 时返回 `Bottom`
/// （Windows 默认底边），保证同一份输入永远得到同一结果。
pub fn resolve_edge(d: &Display) -> Edge {
    let (left, top, right, bottom) = insets(d);
    let candidates = [
        (Edge::Bottom, bottom),
        (Edge::Top, top),
        (Edge::Left, left),
        (Edge::Right, right),
    ];
    let mut edge = Edge::Bottom;
    let mut thickness = 0;
    for (candidate, value) in candidates {
        // 仅在严格更大时替换 → 平局时按下/上/左/右取先者
        if value > thickness {
            thickness = value;
            edge = candidate;
        }
    }
    edge
}

/// 任务栏矩形 = bounds 减 workArea 落在停靠边上的那条。
/// 没有任何内缩（自动隐藏 / 无任务栏）时返回零矩形，调用方据此走退化分支。
pub fn resolve_taskbar(d: &Display) -> Rect {
    let b = d.bounds;
    let (left, top, right, bottom) = insets(d);
    let thickness = left.max(top).max(right).max(bottom);
    if thickness <= 0 {
        return Rect {
            x: 0,
            y: 0,
            width: 0,
            height: 0,
        };
    }
    match resolve_edge(d) {
        Edge::Top => {
            let height = top.min(b.height);
            Rect {
                x: b.x,
                y: b.y,
                width: b.width,
                height,
            }
        }
        Edge::Left => {
            let width = left.min(b.width);
            Rect {
                x: b.x,
                y: b.y,
                width,
                height: b.height,
            }
        }
        Edge::Right => {
            let width = right.min(b.width);
            Rect {
                x: b.x + b.width - width,
                y: b.y,
                width,
                height: b.height,
            }
        }
        Edge::Bottom => {
            let height = bottom.min(b.height);
            Rect {
                x: b.x,
                y: b.y + b.height - height,
                width: b.width,
                height,
            }
        }
    }
}

/// 沿某条轴把窗口贴到 [start, start+length) 的左/中/右。
fn anchor_along(align: Align, start: i32, length: i32, window: i32) -> i32 {
    match align {
        Align::Left => start,
        Align::Center => start + (length - window) / 2,
        Align::Right => start + length - window,
    }
}

/// 把窗口尺寸与位置夹回屏幕内。窗口比屏幕还大时返回 min（保证起始角落可见）。
fn clamp(value: i32, min: i32, max: i32) -> i32 {
    value.max(min).min(max)
}

/// 锚定请求。
#[derive(Debug, Clone, Copy)]
pub struct AnchorRequest {
    pub display: Display,
    pub window_width: i32,
    pub window_height: i32,
    pub align: Align,
    pub offset_x: i32,
    pub offset_y: i32,
    /// 窗口与任务栏边缘的留白
    pub margin: i32,
}

/// 算出「贴着任务栏」的窗口左上角坐标。
///
/// 任务栏在上/下边时窗口贴在长边外侧（下边贴上方、上边贴下方），align 沿 X 轴；
/// 在左/右边时同理贴在外侧、align 沿 Y 轴 —— 即 align 永远作用于任务栏的长边。
/// margin 只作用于垂直于任务栏的那条轴。
///
/// 无任务栏时退化为贴 bounds 底部居中（刻意忽略 align：退化路径只有一种行为
/// 更好预测），偏移照旧叠加，最后统一夹回 bounds。
pub fn compute_anchored_position(req: &AnchorRequest) -> (i32, i32) {
    let d = &req.display;
    let b = d.bounds;
    let taskbar = resolve_taskbar(d);
    let w = req.window_width;
    let h = req.window_height;

    let (base_x, base_y) = if taskbar.width <= 0 || taskbar.height <= 0 {
        (b.x + (b.width - w) / 2, b.y + b.height - h - req.margin)
    } else {
        match resolve_edge(d) {
            Edge::Bottom => (
                anchor_along(req.align, taskbar.x, taskbar.width, w),
                taskbar.y - h - req.margin,
            ),
            Edge::Top => (
                anchor_along(req.align, taskbar.x, taskbar.width, w),
                taskbar.y + taskbar.height + req.margin,
            ),
            Edge::Left => (
                taskbar.x + taskbar.width + req.margin,
                anchor_along(req.align, taskbar.y, taskbar.height, h),
            ),
            Edge::Right => (
                taskbar.x - w - req.margin,
                anchor_along(req.align, taskbar.y, taskbar.height, h),
            ),
        }
    };

    (
        clamp(base_x + req.offset_x, b.x, b.x + b.width - w),
        clamp(base_y + req.offset_y, b.y, b.y + b.height - h),
    )
}

/// 任务栏自动隐藏 / 全屏独占时没有任务栏可用。
pub fn has_taskbar(d: &Display) -> bool {
    let t = resolve_taskbar(d);
    t.width > 0 && t.height > 0
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 1920x1080，底部任务栏 48px
    fn bottom_taskbar() -> Display {
        Display {
            bounds: Rect {
                x: 0,
                y: 0,
                width: 1920,
                height: 1080,
            },
            work_area: Rect {
                x: 0,
                y: 0,
                width: 1920,
                height: 1032,
            },
        }
    }

    fn no_taskbar() -> Display {
        Display {
            bounds: Rect {
                x: 0,
                y: 0,
                width: 1920,
                height: 1080,
            },
            work_area: Rect {
                x: 0,
                y: 0,
                width: 1920,
                height: 1080,
            },
        }
    }

    #[test]
    fn detects_bottom_taskbar() {
        let d = bottom_taskbar();
        assert_eq!(resolve_edge(&d), Edge::Bottom);
        let t = resolve_taskbar(&d);
        assert_eq!(t.y, 1032);
        assert_eq!(t.height, 48);
        assert_eq!(t.width, 1920);
    }

    #[test]
    fn detects_all_four_edges() {
        let top = Display {
            bounds: Rect {
                x: 0,
                y: 0,
                width: 1920,
                height: 1080,
            },
            work_area: Rect {
                x: 0,
                y: 40,
                width: 1920,
                height: 1040,
            },
        };
        assert_eq!(resolve_edge(&top), Edge::Top);

        let left = Display {
            bounds: Rect {
                x: 0,
                y: 0,
                width: 1920,
                height: 1080,
            },
            work_area: Rect {
                x: 60,
                y: 0,
                width: 1860,
                height: 1080,
            },
        };
        assert_eq!(resolve_edge(&left), Edge::Left);

        let right = Display {
            bounds: Rect {
                x: 0,
                y: 0,
                width: 1920,
                height: 1080,
            },
            work_area: Rect {
                x: 0,
                y: 0,
                width: 1860,
                height: 1080,
            },
        };
        assert_eq!(resolve_edge(&right), Edge::Right);
    }

    #[test]
    fn anchors_above_bottom_taskbar() {
        let req = AnchorRequest {
            display: bottom_taskbar(),
            window_width: 420,
            window_height: 120,
            align: Align::Center,
            offset_x: 0,
            offset_y: 0,
            margin: 0,
        };
        // 居中：(1920-420)/2 = 750；贴任务栏上方：1032-120 = 912
        assert_eq!(compute_anchored_position(&req), (750, 912));
    }

    #[test]
    fn aligns_left_and_right() {
        let mut req = AnchorRequest {
            display: bottom_taskbar(),
            window_width: 420,
            window_height: 120,
            align: Align::Left,
            offset_x: 0,
            offset_y: 0,
            margin: 0,
        };
        assert_eq!(compute_anchored_position(&req).0, 0);
        req.align = Align::Right;
        assert_eq!(compute_anchored_position(&req).0, 1920 - 420);
    }

    #[test]
    fn applies_offsets() {
        let req = AnchorRequest {
            display: bottom_taskbar(),
            window_width: 420,
            window_height: 120,
            align: Align::Center,
            offset_x: 100,
            offset_y: -10,
            margin: 0,
        };
        assert_eq!(compute_anchored_position(&req), (850, 902));
    }

    #[test]
    fn clamps_offsets_into_screen() {
        // 极大偏移必须被夹回屏幕内，否则窗口会跑到看不见的地方
        let req = AnchorRequest {
            display: bottom_taskbar(),
            window_width: 420,
            window_height: 120,
            align: Align::Center,
            offset_x: 99999,
            offset_y: 99999,
            margin: 0,
        };
        let (x, y) = compute_anchored_position(&req);
        assert_eq!(x, 1920 - 420);
        assert_eq!(y, 1080 - 120);
    }

    #[test]
    fn falls_back_to_bottom_center_without_taskbar() {
        let req = AnchorRequest {
            display: no_taskbar(),
            window_width: 420,
            window_height: 120,
            align: Align::Left, // 退化时刻意忽略 align
            offset_x: 0,
            offset_y: 0,
            margin: 0,
        };
        assert!(!has_taskbar(&no_taskbar()));
        assert_eq!(compute_anchored_position(&req), (750, 960));
    }

    #[test]
    fn honors_margin() {
        let req = AnchorRequest {
            display: bottom_taskbar(),
            window_width: 420,
            window_height: 120,
            align: Align::Center,
            offset_x: 0,
            offset_y: 0,
            margin: 8,
        };
        // 距任务栏 8px 留白
        assert_eq!(compute_anchored_position(&req).1, 1032 - 120 - 8);
    }

    #[test]
    fn vertical_taskbar_anchors_beside_it() {
        let d = Display {
            bounds: Rect {
                x: 0,
                y: 0,
                width: 1920,
                height: 1080,
            },
            work_area: Rect {
                x: 60,
                y: 0,
                width: 1860,
                height: 1080,
            },
        };
        let req = AnchorRequest {
            display: d,
            window_width: 420,
            window_height: 120,
            align: Align::Center,
            offset_x: 0,
            offset_y: 0,
            margin: 0,
        };
        // 左任务栏：窗口贴它右侧；align 沿 Y 轴居中：(1080-120)/2 = 480
        assert_eq!(compute_anchored_position(&req), (60, 480));
    }

    #[test]
    fn handles_negative_origin_secondary_display() {
        // 副屏在主屏左侧时坐标是负的
        let d = Display {
            bounds: Rect {
                x: -1920,
                y: 0,
                width: 1920,
                height: 1080,
            },
            work_area: Rect {
                x: -1920,
                y: 0,
                width: 1920,
                height: 1032,
            },
        };
        let req = AnchorRequest {
            display: d,
            window_width: 420,
            window_height: 120,
            align: Align::Center,
            offset_x: 0,
            offset_y: 0,
            margin: 0,
        };
        assert_eq!(compute_anchored_position(&req), (-1920 + 750, 912));
    }
}
