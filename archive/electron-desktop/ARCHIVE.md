# 归档：Electron 版桌面端

这是 `apps/desktop` 在切换为 Flutter 宿主之前的**完整源码快照**，于 2026-10-01 归档。

- 原技术栈：Electron 44 + Vue 3 + Pinia + vue-router + Vite（无边框窗口 / 托盘 / 热键 /
  自定义协议 / sidecar 守护），React 侧无历史包袱
- 归档原因：Windows 版本重构为 Flutter 宿主（见
  [docs/flutter-refactor/桌面端Flutter重构方案.md](../../docs/flutter-refactor/桌面端Flutter重构方案.md)）
- 归档方式：整目录 `git mv`，文件内容一字未改，可 `git mv` 原地还原

## 没被归档、仍然在线的部分

重构方案 D3 明确「Rust 后端原样保留」，所以下面这些**留在 `apps/desktop/` 里继续使用**，
不属于本次归档范围：

| 路径 | 原因 |
|---|---|
| `apps/desktop/backend/` | Rust sidecar（161 条路由、SQLite、扫描、在线协议、SMTC），Flutter 宿主继续复用 |
| `apps/desktop/assets/` | 图标源文件（Flutter 侧继续用） |
| `apps/desktop/app-icon.png` | Windows 应用图标源（`flutter_launcher_icons` 的输入） |
| `apps/desktop/LICENSE` | GPL-3.0，换壳不改许可 |

## 被删除的生成物（未入库，可重建）

`node_modules/`（813 MB）、`dist/`、`dist-electron/` 是 `.gitignore` 覆盖的构建产物，
归档时直接删除。需要重建旧版时：

    cd archive/electron-desktop
    npm ci
    npm run build:backend     # backend 在 apps/desktop/backend，需软链或改路径
    npm run build

## 还原成可运行的旧版（如需要）

    # 1) 把归档内容搬回 apps/desktop（backend/assets/app-icon.png/LICENSE 原地未动，无需处理）
    git mv archive/electron-desktop/src apps/desktop/src
    git mv archive/electron-desktop/electron apps/desktop/electron
    # …其余条目同理，或用脚本按本文件末尾清单批量 git mv

    # 2) 安装依赖并构建
    cd apps/desktop && npm ci && npm run build

## 仍然有价值的参考资料

| 路径 | 用途 |
|---|---|
| `shared/i18n.ts` | 约 500 条 zh/en 词条的**唯一真源**，Flutter 侧按方案 §7.4 用它生成 Dart 字典 |
| `shared/types.ts` | 前端命令门面的类型定义，可用于核对 161 条命令的入参出参 |
| `src/tokens/theme.css` | M3 设计令牌（颜色 / 字阶 / 形状 / 动效）真源，Flutter 的 `lib/theme` 逐值搬自这里 |
| `src/tokens/fonts.css` | 字体分片说明（Flutter 侧后续按需转 ttf/otf） |
| `scripts/gen-spring-easings.py` | M3E 弹簧曲线生成脚本（Flutter 侧 `SM.springSpatial` 等常量同源） |
| `.github/workflows/build.yml` | 原 Electron 版 CI（lint + Rust 静态检查 + 三平台构建 + tag 发布），可对照新的 Flutter CI |

## 归档清单（26 项）

    .gitattributes            .github/                  .gitignore
    .prettierignore           .prettierrc.json          CHANGELOG.md
    CONTRIBUTORS.md           doc/                      electron/
    electron-builder.yml      eslint.config.js          example/
    index.html                miaohui-extension/        package.json
    package-lock.json         public/                   README.md
    README_zh.md              scripts/                  shared/
    src/                      tsconfig.electron.json    tsconfig.json
    tsconfig.node.json        vite.config.ts

另有开发机上的 `.vscode/`（Electron 调试配置）与 `.workbuddy/`（代理工作区）一并搬入。
