#!/usr/bin/env python3
"""图标生成器 —— 从单张源图产出全平台图标资产。

用法（Windows 上 Python 不在 PATH，故用 py 启动器；其他平台换 python3）：

    py -3 scripts/gen_icons.py [源图路径]
    python3 scripts/gen_icons.py [源图路径]

源图路径默认为 `assets/icon-source.png`。依赖 Pillow（numpy 非必需）。

产物：
    app-icon.png                   1024  开发期窗口/托盘降级图标
    backend/icons/icon.png         1024  Linux 打包图标 + 打包后 resources/icon.png
    backend/icons/icon.ico                Windows 打包图标（16→256 多尺寸）
    backend/icons/icon.icns               macOS 打包图标（32→1024 多尺寸）
    backend/icons/{32,64,128,128@2x}.png
    backend/icons/Square*Logo.png         Windows Store 磁贴（Tauri 模板遗留，一并刷新）
    backend/icons/android/**              自适应图标（同上）

构图：**圆角方形 + 保留原图背景**。源图是方形插画，四角被圆角切掉后露出透明，
任务栏 / Dock 上是一个干净的圆角方块。

两处实现细节值得记一笔：

1. **先缩放、后裁圆角**。反过来（先裁再缩）会让重采样把已透明区域的颜色混进
   边缘像素——原图背景是深灰，混出来就是一圈暗边。源图本身不透明，
   所以对整块方形做 LANCZOS 是安全的。

2. **遮罩超采样 4×再降采样**。圆角边缘直接按像素判定会产生硬锯齿，
   在 16px 的托盘图标上尤其明显。
"""

from __future__ import annotations

import struct
import sys
from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
ICONS = ROOT / "backend" / "icons"
SOURCE = Path(sys.argv[1]).resolve() if len(sys.argv) > 1 else ROOT / "assets" / "icon-source.png"

# 圆角半径占边长的比例。0.18 接近 macOS 原生图标，也贴合 Material 的 squircle 观感。
CORNER_RATIO = 0.18

# 边缘抗锯齿的超采样倍数
SUPERSAMPLE = 4

# 自适应图标前景的有效区是画布的 72/108，内容画满会被各家厂商的遮罩裁掉边缘。
# 按 72/108 缩放居中，让整块圆角方形落在安全区内。
ANDROID_SAFE_RATIO = 72 / 108


def rounded_mask(size: int, rounded: bool = True) -> Image.Image:
    """圆角方形（或圆形）遮罩，边缘经超采样抗锯齿。

    `rounded=False` 时把半径拉到半边长——圆形正是圆角方形的极限，不必另走一条路径。
    """
    radius = CORNER_RATIO * size if rounded else size / 2
    big = size * SUPERSAMPLE
    mask = Image.new("L", (big, big), 0)
    ImageDraw.Draw(mask).rounded_rectangle(
        (0, 0, big - 1, big - 1),
        radius=radius * SUPERSAMPLE,
        fill=255,
    )
    return mask.resize((size, size), Image.LANCZOS)


def render(size: int, rounded: bool = True) -> Image.Image:
    """源图 → 目标尺寸的圆角方形 RGBA。每次都从源图重采样，避免二次缩放累积损失。"""
    art = SOURCE_IMAGE.resize((size, size), Image.LANCZOS).convert("RGBA")
    art.putalpha(rounded_mask(size, rounded))
    return art


def render_padded(canvas: int, inner: int) -> Image.Image:
    """源图缩到 `inner` 贴进 `canvas` 见方的透明画布中央（Android 自适应前景用）。"""
    art = render(inner)
    out = Image.new("RGBA", (canvas, canvas), (0, 0, 0, 0))
    offset = (canvas - inner) // 2
    out.paste(art, (offset, offset), art)
    return out


def save_png(image: Image.Image, path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    image.save(path, "PNG", optimize=True)
    print(f"  {path.relative_to(ROOT).as_posix()}  {path.stat().st_size} B")


# ICO 里，256×256 必须在目录项里存成 0（单字节放不下 256）。
ICO_SIZES = [16, 24, 32, 48, 64, 128, 256]

# ICNS 类型码 → 像素边长。ic10 是 512@2x，即 1024。
ICNS_TYPES = [
    ("ic11", 32),  # 16@2x
    ("ic12", 64),  # 32@2x
    ("ic07", 128),
    ("ic08", 256),
    ("ic13", 256),  # 128@2x
    ("ic09", 512),
    ("ic14", 512),  # 256@2x
    ("ic10", 1024),  # 512@2x
]


def save_ico(path: Path) -> None:
    """多尺寸 ICO。Pillow 的 ICO 写入器负责尺寸降级与 BMP/PNG 条目选择。"""
    path.parent.mkdir(parents=True, exist_ok=True)
    # sizes 必须显式给：默认只写一个尺寸
    render(256).save(path, "ICO", sizes=[(s, s) for s in ICO_SIZES])
    print(f"  {path.relative_to(ROOT).as_posix()}  {path.stat().st_size} B")


def save_icns(path: Path) -> None:
    """多尺寸 ICNS。

    手写而不是交给 Pillow 的 ICNS 写入器：后者对小尺寸会退化成不带 alpha 的
    `is32`/`il32` 原始位图，圆角外的透明就丢了。这里所有尺寸统一用 PNG 载荷
    （类型码 ic07 及以上都接受 PNG），容器本身只是一个带类型码的块序列。
    """
    import io

    chunks: list[bytes] = []
    for type_code, size in ICNS_TYPES:
        buf = io.BytesIO()
        render(size).save(buf, "PNG", optimize=True)
        data = buf.getvalue()
        # 块长度含自身的 8 字节头
        chunks.append(type_code.encode("ascii") + struct.pack(">I", len(data) + 8) + data)

    body = b"".join(chunks)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(b"icns" + struct.pack(">I", len(body) + 8) + body)
    print(f"  {path.relative_to(ROOT).as_posix()}  {path.stat().st_size} B")


# (仓库相对路径, 边长)。直接替换，不做缩放兜底——尺寸写错就该当场看见。
PNG_TARGETS = [
    ("app-icon.png", 1024),
    ("backend/icons/icon.png", 1024),
    ("backend/icons/32x32.png", 32),
    ("backend/icons/64x64.png", 64),
    ("backend/icons/128x128.png", 128),
    ("backend/icons/128x128@2x.png", 256),
    ("backend/icons/StoreLogo.png", 50),
    ("backend/icons/Square30x30Logo.png", 30),
    ("backend/icons/Square44x44Logo.png", 44),
    ("backend/icons/Square71x71Logo.png", 71),
    ("backend/icons/Square89x89Logo.png", 89),
    ("backend/icons/Square107x107Logo.png", 107),
    ("backend/icons/Square142x142Logo.png", 142),
    ("backend/icons/Square150x150Logo.png", 150),
    ("backend/icons/Square284x284Logo.png", 284),
    ("backend/icons/Square310x310Logo.png", 310),
]

# (密度, launcher 边长, 自适应画布边长)
ANDROID_DENSITIES = [
    ("mdpi", 48, 108),
    ("hdpi", 72, 162),
    ("xhdpi", 96, 216),
    ("xxhdpi", 144, 324),
    ("xxxhdpi", 192, 432),
]


def main() -> None:
    global SOURCE_IMAGE
    if not SOURCE.exists():
        raise SystemExit(f"源图不存在：{SOURCE}")

    SOURCE_IMAGE = Image.open(SOURCE)
    if SOURCE_IMAGE.width != SOURCE_IMAGE.height:
        raise SystemExit(
            f"源图必须是正方形，实际 {SOURCE_IMAGE.width}×{SOURCE_IMAGE.height}"
            "（圆角遮罩按正方形推导）"
        )
    print(f"源图 {SOURCE.relative_to(ROOT).as_posix()} {SOURCE_IMAGE.width}×{SOURCE_IMAGE.height}")

    print("PNG：")
    for rel, size in PNG_TARGETS:
        save_png(render(size), ROOT / rel)

    print("Windows ICO：")
    save_ico(ICONS / "icon.ico")

    print("macOS ICNS：")
    save_icns(ICONS / "icon.icns")

    print("Android：")
    for density, launcher, canvas in ANDROID_DENSITIES:
        out = ICONS / "android" / f"mipmap-{density}"
        save_png(render(launcher), out / "ic_launcher.png")
        save_png(render(launcher, rounded=False), out / "ic_launcher_round.png")
        save_png(render_padded(canvas, round(canvas * ANDROID_SAFE_RATIO)), out / "ic_launcher_foreground.png")

    # 自适应图标背景层取原图左上角的主色，前景透明区透出来的就是它
    r, g, b = SOURCE_IMAGE.convert("RGB").getpixel((0, 0))
    bg = f"#{r:02x}{g:02x}{b:02x}"
    xml = ICONS / "android" / "values" / "ic_launcher_background.xml"
    xml.parent.mkdir(parents=True, exist_ok=True)
    xml.write_text(
        '<?xml version="1.0" encoding="utf-8"?>\n'
        "<resources>\n"
        f'  <color name="ic_launcher_background">{bg}</color>\n'
        "</resources>\n",
        encoding="utf-8",
    )
    print(f"自适应图标背景色 {bg}")


if __name__ == "__main__":
    main()
