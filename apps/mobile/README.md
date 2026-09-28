# SilverMoon Mobile（银月 · 移动端）

Electron 桌面版 SilverMoon 的 Flutter 移动端实现（Android / iOS），当前阶段只做**音乐播放器**。

## 为什么仓库里没有 android/ 和 ios/

开发机没有 Flutter SDK，也没有 MSVC/Android SDK，无法本地编译。
因此平台工程目录**不入库**，由 CI 在构建前用当前 Flutter 版本自带的模板现场生成，
再覆盖 `tool/overlay/` 里的定制文件（AndroidManifest / Info.plist 等）。

这样平台工程（Gradle、AGP、Xcode 工程格式）永远和 Flutter 版本对齐。

## 本地开发

```bash
cd apps/mobile
bash tool/bootstrap.sh      # 生成 android/ 与 ios/
flutter pub get
dart run flutter_launcher_icons
flutter run
```

## CI 构建

`.github/workflows/mobile.yml`：push 到 main 自动构建
- Android：`flutter build apk --release --split-per-abi`
- iOS：`flutter build ios --release --no-codesign` → 打成未签名 `.ipa`（可用 Sideloadly / AltStore 自签安装）
