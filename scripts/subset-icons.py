#!/usr/bin/env python3
"""按 icons.txt 裁剪 material-symbols-rounded.woff2，并回读校验裁剪结果。

依赖（CI 由 actions/setup-python 提供 Python）：
    pip install fonttools brotli

用法（项目根目录）：
    python scripts/subset-icons.py

为什么必须校验：
    图标靠 GSUB 连字产出，样式靠可变轴。裁剪时若丢掉连字特性或 4 条可变轴，
    界面会「静默」降级——图标显示成字面文本、.filled 的 FILL 轴失效——而 CI 的
    构建、类型检查、单元测试全都发现不了。所以这里裁剪完立刻回读断言，不通过
    就报错退出，绝不覆盖原字体。

保留 4 条可变轴（FILL / wght / GRAD / opsz）：theme.css 里
.material-symbols-outlined 与 .filled 都用 font-variation-settings 指定这四条，
缺哪条对应样式就失效。因此**不要**给 pyftsubset 传 --instance（那会把可变字体
实例化成静态字体）。
"""
import os
import shutil
import sys
import tempfile

from fontTools import subset
from fontTools.ttLib import TTFont

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FONT_DIR = os.path.join(ROOT, "src", "assets", "fonts")
FONT = os.path.join(FONT_DIR, "material-symbols-rounded.woff2")
SUBSET_LIST = os.path.join(FONT_DIR, "icons.txt")
VERIFY_LIST = os.path.join(FONT_DIR, "icons-verify.txt")
REQUIRED_AXES = {"FILL", "wght", "GRAD", "opsz"}


def read_list(path):
    with open(path, "r", encoding="utf-8") as fh:
        return [s.strip() for s in fh if s.strip() and not s.startswith("#")]


def ligature_strings(font):
    """回读 GSUB，收集所有连字能产出的文本（例如 play_arrow）。"""
    if "GSUB" not in font:
        return set()
    rev = {}
    for code, name in font.getBestCmap().items():
        rev.setdefault(name, chr(code))
    out = set()
    for lookup in font["GSUB"].table.LookupList.Lookup:
        for sub in lookup.SubTable:
            # 扩展查找（Type 7）把真正的子表包在 ExtSubTable 里
            inner = getattr(sub, "ExtSubTable", sub)
            ligatures = getattr(inner, "ligatures", None)
            if not ligatures:
                continue
            for first, ligset in ligatures.items():
                for lig in ligset:
                    text = rev.get(first, "")
                    for comp in lig.Component:
                        text += rev.get(comp, "")
                    if text:
                        out.add(text)
    return out


def main():
    if not os.path.exists(FONT):
        print("找不到字体：" + FONT, file=sys.stderr)
        return 1

    subset_names = read_list(SUBSET_LIST)
    verify_names = read_list(VERIFY_LIST)
    before = os.path.getsize(FONT)
    print(
        "裁剪前 %.2f MB；超集 %d 个名字，待校验图标 %d 个"
        % (before / 1048576.0, len(subset_names), len(verify_names))
    )

    fd, tmp = tempfile.mkstemp(suffix=".woff2")
    os.close(fd)
    args = [
        FONT,
        "--text-file=" + SUBSET_LIST,
        "--output-file=" + tmp,
        "--flavor=woff2",
        # 图标全靠连字产出，必须保留全部布局特性（liga / rlig / ccmp ...）
        "--layout-features=*",
        "--notdef-glyph",
        "--notdef-outline",
        "--recommended-glyphs",
        "--name-IDs=*",
    ]
    subset.main(args)

    out = TTFont(tmp)
    axes = {a.axisTag for a in out["fvar"].axes} if "fvar" in out else set()
    ligs = ligature_strings(out)
    missing_axes = sorted(REQUIRED_AXES - axes)
    missing_names = [n for n in verify_names if n not in ligs]
    after = os.path.getsize(tmp)
    print(
        "裁剪后 %.2f MB（%.1f%%）；保留轴 %s，连字 %d 条"
        % (after / 1048576.0, after * 100.0 / before, sorted(axes), len(ligs))
    )

    failed = False
    if missing_axes:
        print("缺少可变轴：" + ", ".join(missing_axes), file=sys.stderr)
        failed = True
    if missing_names:
        print(
            "以下图标裁剪后无法由连字产出（界面会显示成字面文本）："
            + ", ".join(missing_names[:40]),
            file=sys.stderr,
        )
        failed = True
    if after >= before:
        print("裁剪后没有变小，拒绝覆盖", file=sys.stderr)
        failed = True
    if failed:
        os.remove(tmp)
        return 1

    shutil.move(tmp, FONT)
    print("已覆盖 " + os.path.relpath(FONT, ROOT))
    return 0


if __name__ == "__main__":
    sys.exit(main())
