# SilverMoon 桌面端（Flutter 宿主）

Electron 44 宿主 → Flutter 宿主的重构产物。**当前处于 P0「界面框架」阶段**。

- 后端：Rust sidecar 原样保留在 [backend](./backend)（161 条路由零改动，本次未触碰）
- 播放层：PlayerView / MusicView / MiniPlayer 继续复用 Vue 产物（经中间层内嵌），后续阶段接入
- 重构方案与逐项映射：[docs/flutter-refactor/桌面端Flutter重构方案.md](../../docs/flutter-refactor/桌面端Flutter重构方案.md)
- 被归档的 Electron 版：[archive/electron-desktop](../../archive/electron-desktop)

## 当前阶段（P0）做了什么

| 能力 | 状态 |
|---|---|
| 无边框窗口 + 自定义标题栏（拖拽 / 双击最大化 / 最小化 / 最大化还原 / 关闭） | 已完成 |
| 左侧导航 Rail（图片 / 视频 / 音乐 / 书籍 / 百宝箱 + 设置） | 已完成 |
| 底部迷你播放条 | 占位（禁用态，未接 player:state） |
| M3 主题：浅色 / 深色 / 跟随系统，令牌逐值搬自 `archive/electron-desktop/src/tokens/theme.css` | 已完成 |
| i18n：zh / en 切换（外壳与占位页词条） | 已完成（词条表待 P4 阶段由 i18n.ts 生成替换） |
| 路由：19 条，1:1 对齐 Electron 版 `src/router.ts` | 已完成（页面均为占位） |
| 命令通道 / 事件总线 / Rust sidecar / WebView 播放层 / 持久化设置 | **未接入** |

## 目录结构

    lib/
      main.dart              窗口引导（window_manager：无边框 + 尺寸 + 显示时机）
      app.dart               MaterialApp.router + 主题 + 语言
      router/app_router.dart 19 条路由（播放页/桌面歌词/扩展宿主不走应用外壳）
      shell/                 应用外壳：标题栏、窗口按钮、标题栏菜单、导航 Rail、
                             迷你播放条、占位页
      theme/                 设计令牌 / M3 取色表 / ThemeData
      state/                 AppState（主题、语言；持久化留待后续阶段）
      i18n/                  外壳词条表（zh / en）
      features/              逐路由的功能模块（当前每个都是一个占位页）
    tool/bootstrap.ps1       CI 现场生成 windows/ 平台工程
    test/route_table_test.dart  路由表与词条的回归测试

## 本地开发

本仓库的开发机**没有 Flutter SDK**，所有 Flutter 侧验证一律通过 GitHub Actions：

- `.github/workflows/desktop.yml` → `analyze` 作业在 ubuntu 上跑 `flutter pub get` /
  `flutter analyze` / `flutter test`（快速门禁）
- `windows` 作业在 windows-latest 上生成平台工程 → 构建 → 打包 zip → 上传 artifact
- `release` 作业把 zip 挂到 `desktop-v<run_number>` 的 prerelease 上

本地如果有 Flutter SDK，正常流程即可：

    pwsh -NoProfile -ExecutionPolicy Bypass -File tool/bootstrap.ps1
    flutter pub get
    flutter test
    flutter run -d windows

## 平台工程为什么不入库

`windows/` 不入库（见 [.gitignore](./.gitignore)），由 [tool/bootstrap.ps1](./tool/bootstrap.ps1)
在构建前用当前 Flutter 版本自带的模板现场生成。这与 `apps/mobile` 对 `android/` `ios/`
的处理方式是同一策略：平台工程永远与 Flutter 版本匹配，不会出现模板过期导致的构建失败。

需要改动平台工程时，把定制文件放进 `tool/overlay/`，镜像路径覆盖即可
（例如 `tool/overlay/windows/runner/Runner.rc`）。

## 下一步（待界面框架确认后）

1. 命令通道：Dart 侧 `POST /cmd` + `GET /events`(SSE) 客户端，对齐 161 条路由
2. Rust sidecar 的拉起、握手与退出回收
3. JsonStore：复用 Electron 版的 settings.json 数据目录与 JSON 结构（82 项设置）
4. i18n 生成脚本：从 `archive/electron-desktop/shared/i18n.ts` 生成 Dart 字典
5. 本地 HTTP 中间层 + WebView2，把 Vue 播放层接回来
6. 逐页把 `lib/features/*` 的占位页替换为真实视图
