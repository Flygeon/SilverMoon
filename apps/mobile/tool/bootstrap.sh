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

# ---------- iOS 部署目标 ----------
python3 - "$APP_DIR/ios/Podfile" <<'PY'
import re, sys, pathlib
p = pathlib.Path(sys.argv[1])
if not p.exists():
    sys.exit(0)
s = p.read_text()
if re.search(r'^\s*#\s*platform :ios', s, re.M):
    s = re.sub(r'^\s*#\s*platform :ios.*$', "platform :ios, '13.0'", s, flags=re.M)
elif not re.search(r'^\s*platform :ios', s, re.M):
    s = s.replace("target 'Runner' do", "platform :ios, '13.0'\n\ntarget 'Runner' do", 1)
p.write_text(s)
print('[bootstrap] Podfile platform -> ios 13.0')
PY

echo "[bootstrap] done"