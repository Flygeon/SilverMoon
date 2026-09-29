#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""SilverMoon 图标生成器（桌面端 + 移动端）。

从一张正方形源图生成全套图标，统一裁圆角：

  Windows / macOS 桌面端
    apps/desktop/backend/icons/icon.ico / icon.icns / icon.png
    apps/desktop/backend/icons/*.png（含 Square* / StoreLogo 磁贴）
    apps/desktop/app-icon.png
  移动端
    apps/mobile/assets/icon/app_icon.png            不透明、满幅（iOS 用）
    apps/mobile/assets/icon/app_icon_foreground.png Android 自适应前景

为什么两端要出不同的图：
  * iOS 的系统会给图标套自己的超椭圆蒙版，源图必须**满幅且不带 alpha**，
    否则 flutter_launcher_icons 的 remove_alpha_ios 会把圆角处压成黑色。
  * Windows 任务栏/开始菜单**不做任何圆角**，圆角必须烘进图片里。
  * Android 自适应图标要一层前景（内容缩到 72% 留安全区）+ 一层纯色背景。

用法：
    python tools/make-icons.py [源图路径]
不传参时用 tools/app-icon-source.png。
"""
import os
import re
import sys

from PIL import Image, ImageDraw

try:
    RESAMPLE = Image.Resampling.LANCZOS
except AttributeError:  # Pillow < 9.1
    RESAMPLE = Image.LANCZOS

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC_DEFAULT = os.path.join(ROOT, "tools", "app-icon-source.png")
DESKTOP_ICONS = os.path.join(ROOT, "apps", "desktop", "backend", "icons")
DESKTOP_ROOT = os.path.join(ROOT, "apps", "desktop")
MOBILE_ICONS = os.path.join(ROOT, "apps", "mobile", "assets", "icon")

# 圆角半径占边长的比例。0.2237 接近 iOS 超椭圆的观感。
CORNER_RATIO = 0.2237
# Android 自适应图标前景的安全区：内容缩到 72%，四周留透明边。
ADAPTIVE_INSET = 0.72
# iOS 满幅图的兜底底色（源图带透明时才用得到）。
IOS_BACKDROP = (11, 13, 18, 255)


def load_square(src, size):
    """读源图 -> 居中裁成正方形 -> 缩放到 size。"""
    im = Image.open(src)
    if im.mode != "RGBA":
        im = im.convert("RGBA")
    w, h = im.size
    side = min(w, h)
    left = (w - side) // 2
    top = (h - side) // 2
    im = im.crop((left, top, left + side, top + side))
    return im.resize((size, size), RESAMPLE)


def rounded(im):
    """按比例切圆角，返回带 alpha 的图。"""
    size = im.size[0]
    radius = max(1, int(round(size * CORNER_RATIO)))
    mask = Image.new("L", (size, size), 0)
    ImageDraw.Draw(mask).rounded_rectangle(
        (0, 0, size - 1, size - 1), radius=radius, fill=255
    )
    out = im.copy()
    out.putalpha(mask)
    return out


def opaque(im, bg=IOS_BACKDROP):
    """铺到不透明底色上，返回 RGB 图（iOS 图标不能带 alpha）。"""
    base = Image.new("RGBA", im.size, bg)
    base.alpha_composite(im)
    return base.convert("RGB")


def inset(im, ratio):
    """内容缩到 ratio 并居中放到透明画布上（Android 自适应前景）。"""
    size = im.size[0]
    inner = max(1, int(round(size * ratio)))
    small = im.resize((inner, inner), RESAMPLE)
    canvas = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    off = (size - inner) // 2
    canvas.alpha_composite(small, (off, off))
    return canvas


def scaled(base, size):
    return base.resize((size, size), RESAMPLE)


def save(im, path, **kw):
    folder = os.path.dirname(path)
    if folder:
        os.makedirs(folder, exist_ok=True)
    im.save(path, **kw)
    print("  %-56s %sx%s" % (os.path.relpath(path, ROOT), im.size[0], im.size[1]))


def main():
    src = sys.argv[1] if len(sys.argv) > 1 else SRC_DEFAULT
    if not os.path.isfile(src):
        sys.stderr.write("源图不存在: %s\n" % src)
        return 1
    print("[icons] 源图: %s" % src)

    base = load_square(src, 1024)

    print("[icons] 移动端")
    # iOS：满幅、不带 alpha。系统自己套超椭圆蒙版；若这里带圆角 alpha，
    #       flutter_launcher_icons 的 remove_alpha_ios 会把四个角压成黑色。
    save(opaque(base), os.path.join(MOBILE_ICONS, "app_icon.png"))
    # Android：圆角烘进图片。Android 不会给传统图标套蒙版，圆角必须自己带。
    save(rounded(base), os.path.join(MOBILE_ICONS, "app_icon_rounded.png"))

    print("[icons] 桌面端 · Windows / macOS")
    save(rounded(base), os.path.join(DESKTOP_ICONS, "icon.png"))
    save(rounded(base), os.path.join(DESKTOP_ROOT, "app-icon.png"))

    ico_path = os.path.join(DESKTOP_ICONS, "icon.ico")
    rounded(base).save(ico_path, format="ICO",
                       sizes=[(16, 16), (24, 24), (32, 32), (48, 48),
                              (64, 64), (128, 128), (256, 256)])
    print("  %-56s 7 种尺寸" % os.path.relpath(ico_path, ROOT))

    try:
        rounded(base).save(os.path.join(DESKTOP_ICONS, "icon.icns"), format="ICNS")
        print("  %-56s icns" % os.path.relpath(
            os.path.join(DESKTOP_ICONS, "icon.icns"), ROOT))
    except Exception as exc:  # Pillow 写 ICNS 依赖平台，失败不影响其它产物
        print("  icon.icns 跳过: %s" % exc)

    tiles = (
        ("32x32.png", 32), ("64x64.png", 64),
        ("128x128.png", 128), ("128x128@2x.png", 256),
        ("Square30x30Logo.png", 30), ("Square44x44Logo.png", 44),
        ("Square71x71Logo.png", 71), ("Square89x89Logo.png", 89),
        ("Square107x107Logo.png", 107), ("Square142x142Logo.png", 142),
        ("Square150x150Logo.png", 150), ("Square284x284Logo.png", 284),
        ("Square310x310Logo.png", 310), ("StoreLogo.png", 50),
    )
    for name, size in tiles:
        save(rounded(scaled(base, size)), os.path.join(DESKTOP_ICONS, name))

    print("[icons] 桌面端 · Tauri 时代的 android/ios 子集（保持与主图标一致）")
    for folder, size in (("mdpi", 48), ("hdpi", 72), ("xhdpi", 96),
                         ("xxhdpi", 144), ("xxxhdpi", 192)):
        d = os.path.join(DESKTOP_ICONS, "android", "mipmap-" + folder)
        save(rounded(scaled(base, size)), os.path.join(d, "ic_launcher.png"))
        save(rounded(scaled(base, size)), os.path.join(d, "ic_launcher_round.png"))
        save(scaled(inset(base, ADAPTIVE_INSET), size),
             os.path.join(d, "ic_launcher_foreground.png"))

    ios_dir = os.path.join(DESKTOP_ICONS, "ios")
    if os.path.isdir(ios_dir):
        for name in sorted(os.listdir(ios_dir)):
            m = re.match(r"AppIcon-([0-9.]+)(?:x[0-9.]+)?@([0-9])x(?:-1)?\.png$", name)
            if not m:
                continue
            size = int(round(float(m.group(1)) * int(m.group(2))))
            save(opaque(scaled(base, size)), os.path.join(ios_dir, name))

    print("[icons] 完成")
    return 0


if __name__ == "__main__":
    sys.exit(main())
