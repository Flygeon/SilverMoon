#!/usr/bin/env bash
# SilverMoon 移动端 · 平台工程引导脚本
#
# 背景：本仓库的开发机没有 Flutter SDK，android/ 与 ios/ 两个平台目录不入库，
#       而是由 CI 在构建前用「当前 Flutter 版本自带的模板」现场生成，
#       再把 tool/overlay/ 下的定制文件覆盖回去。
#       这样平台工程（Gradle / AGP / Xcode 工程格式）永远与 Flutter 版本匹配，
#       不会出现"模板过期导致构建失败"的问题。
#
# 用法：cd apps/mobile && bash tool/bootstrap.sh
set -euo pipefail

# APP_DIR 优先取第一个参数（CI 会把脚本规范化后从别处执行），否则按脚本自身位置推断。
if [ "$#" -ge 1 ] && [ -n "${1:-}" ]; then
  APP_DIR="$(cd "$1" && pwd)"
else
  APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
fi
cd "$APP_DIR"

ORG="${SILVERMOON_ORG:-cn.cool}"
PROJECT_NAME="${SILVERMOON_PROJECT_NAME:-silvermoon}"

echo "[bootstrap] app dir: $APP_DIR"

if ! command -v flutter >/dev/null 2>&1; then
  echo "[bootstrap] ERROR: flutter 不在 PATH 中" >&2
  exit 1
fi

GEN_DIR="$(mktemp -d)"
trap 'rm -rf "$GEN_DIR"' EXIT

echo "[bootstrap] flutter create --org $ORG --project-name $PROJECT_NAME (模板生成中)"
flutter create \
  --org "$ORG" \
  --project-name "$PROJECT_NAME" \
  --platforms=android,ios \
  --no-pub \
  "$GEN_DIR" >/dev/null

# 只取平台目录，Dart 源码 / pubspec / 测试全部以本仓库为准
rm -rf android ios
cp -R "$GEN_DIR/android" "$APP_DIR/android"
cp -R "$GEN_DIR/ios" "$APP_DIR/ios"

# ---------- 覆盖定制文件 ----------
OVERLAY="$APP_DIR/tool/overlay"
if [ -d "$OVERLAY" ]; then
  (cd "$OVERLAY" && find . -type f -print0) | while IFS= read -r -d '' rel; do
    rel="${rel#./}"
    mkdir -p "$APP_DIR/$(dirname "$rel")"
    cp "$OVERLAY/$rel" "$APP_DIR/$rel"
    echo "[bootstrap] overlay: $rel"
  done
fi

# ---------- iOS：部署目标 + permission_handler 编译期开关 ----------
python3 - "$APP_DIR/ios/Podfile" <<'PY'
import re
import sys
import pathlib

NL = chr(10)

p = pathlib.Path(sys.argv[1])
if not p.exists():
    sys.exit(0)
s = p.read_text()

# 1) 部署目标。取 13.0，满足当前插件依赖的最低要求。
if re.search(r'^\s*#\s*platform :ios', s, re.M):
    s = re.sub(r'^\s*#\s*platform :ios.*$', "platform :ios, '13.0'", s, flags=re.M)
elif not re.search(r'^\s*platform :ios', s, re.M):
    s = s.replace("target 'Runner' do",
                  "platform :ios, '13.0'" + NL + NL + "target 'Runner' do", 1)

# 2) permission_handler 的编译期开关。
#
# permission_handler_apple 用 #if PERMISSION_XXX 把每个权限的实现整段包起来，
# 没定义这些宏时对应的处理器**根本不会被编进二进制**，运行时表现为
# "申请了但永远 denied"（不崩溃、不报错，极难排查）。所以必须在这里注入。
MACRO_BLOCK = """    target.build_configurations.each do |config|
      config.build_settings['GCC_PREPROCESSOR_DEFINITIONS'] ||= [
        '$(inherited)',
        'PERMISSION_PHOTOS=1',
        'PERMISSION_MEDIA_LIBRARY=1',
        'PERMISSION_CAMERA=1',
        'PERMISSION_MICROPHONE=1',
        'PERMISSION_NOTIFICATIONS=1',
      ]
    end"""

ANCHOR = 'flutter_additional_ios_build_settings(target)'
if 'PERMISSION_PHOTOS=1' not in s:
    if ANCHOR in s:
        s = s.replace(ANCHOR, ANCHOR + NL + MACRO_BLOCK, 1)
    else:
        sys.stderr.write('[bootstrap] 警告: Podfile 里找不到 ' + ANCHOR + chr(10))

p.write_text(s)
print('[bootstrap] Podfile -> ios 13.0 + permission_handler 宏')
PY

echo "[bootstrap] done"
