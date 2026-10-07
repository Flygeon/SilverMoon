# 银月 · React Native 桌面端（apps/RNdesktop）

> **当前状态：框架骨架。** 只搭了工程结构、主题、路由、宿主桥契约与 CI，
> **没有实现任何业务功能** —— 每个页面都是显式标注「功能待填充」的占位屏。

这是 `apps/desktop`（Electron + Vue 3 + Rust sidecar）的 **React Native 重构版**，
目标是用同一套 React Native 代码同时出 **Windows** 与 **macOS** 桌面端。

---

## 为什么是 React Native for Windows / macOS

| 方案 | 取舍 |
|---|---|
| **react-native-windows + react-native-macos**（本目录） | 真正的原生桌面壳：直接编译 C++/WinRT 与 Objective-C++ 应用，窗口 / 托盘 / 热键 / 系统媒体控件都能走原生。代价是原生工具链重（VS 2022 + Windows SDK / Xcode + CocoaPods） |
| react-native-web + Electron | 上手最快，但那等于「把现有 Electron 端的前端从 Vue 换成 React」，拿不到原生壳的收益 |

因此这里选原生路线，并且**先只保证 Windows 能跑通**（现有桌面端的主要平台就是
Windows + Linux，且 macOS 工程无法在 Windows 机器上验证）。macOS 的工程骨架已经按
react-native-macos 的约定留好位置，CI 里也留了手动触发的作业。

## 版本对齐（不要随手升）

`react-native-macos` 对 `react-native` 的 peer 要求是**精确版本**，两个平台包的版本线
也不完全同步。当前锁定组合：

| 包 | 版本 | 说明 |
|---|---|---|
| `react-native` | `0.83.10` | `react-native-macos@0.83.0` 的 peer 精确要求 |
| `react-native-windows` | `0.83.2` | peer 为 `^0.83.0`，与上面兼容 |
| `react` | `19.2.0` | RN 0.83 的 peer 要求 |
| `@react-native-windows/find-dotnet-tools` | `0.84.0` | **临时补丁**，见下 |

> ⚠️ `@react-native-windows/cli@0.83.2` 在 `utils/commandWithProgress.js` 里
> `require` 了 `@react-native-windows/find-dotnet-tools`，但它**没有把该包写进自己的
> dependencies**（上游打包遗漏），而且 npm 上只有 `0.84.0` / `0.85.0-preview` 两个版本线。
> 不显式补装的话，CLI 会以 `Cannot find module` 崩掉、连 `init-windows` 都注册不上。
> 因此本目录把它列为 devDependency 钉住 `0.84.0`；等上游修好或升到 0.84+ 后可删。

## 目录结构

```
apps/RNdesktop/
├── index.js                     入口：AppRegistry.registerComponent("SilverMoon", ...)
├── app.json                     组件名（必须与原生工程注册的名字一致）
├── src/
│   ├── App.tsx                  根组件：装主题 + 装路由 + 渲染桌面外壳
│   ├── bridge/                  ★ 渲染进程 ↔ 宿主 / Rust 侧车的**协议契约**
│   │   ├── types.ts             SilverMoonHostBridge 接口、宿主通道名
│   │   ├── bridge.ts            唯一出入口（invoke / call / subscribe / ping）
│   │   ├── mock.ts              内存 mock 宿主，原生桥就绪前让界面能跑
│   │   └── errors.ts            宿主不可用错误的识别与格式化
│   ├── theme/                   ★ MD3 设计令牌 + 亮暗主题
│   │   ├── tokens.ts            颜色角色 / 间距 / 圆角 / 字号 / 尺寸 / 动效时长
│   │   └── ThemeProvider.tsx    跟随系统 / 强制亮 / 强制暗
│   ├── navigation/              ★ 极简路由（侧栏常驻 + 内容区切换）
│   │   ├── routes.ts            路由表与侧栏分组
│   │   └── NavigationProvider.tsx
│   ├── components/              标题栏 / 侧栏 / 占位屏
│   ├── shell/DesktopShell.tsx   标题栏 + 侧栏 + 内容区
│   └── screens/index.tsx        路由 → 界面 的**唯一注册点**
├── __tests__/                   骨架冒烟测试 + 桥层契约测试
├── windows/                     react-native-windows 原生工程（C++/WinRT）
└── macos/                       react-native-macos 原生工程（骨架）
```

## 与现有 Electron 端的架构对应

重构不打算推翻现有架构，只换**渲染层技术栈**：

| 现有 Electron 端 | RN 桌面端 | 状态 |
|---|---|---|
| 渲染进程 Vue 3 组件 | React Native 组件 | 骨架（占位屏） |
| `window.__SILVERMOON__`（contextBridge） | `SilverMoonHostBridge`（TurboModule） | **接口已定，原生实现待补** |
| `ipcRenderer.invoke` → `POST /cmd` | `invoke(cmd, args)` → 同一张命令表 | 契约已定 |
| SSE `GET /events` | `subscribe(event, listener)` | 契约已定 |
| 主进程能力（窗口 / 对话框 / 存储） | `call(channel, payload)` | 通道名已登记 |
| Rust sidecar 进程 | **不变**，仍是独立进程 | — |

桥的两条铁律（从现有实现继承，测试里守着）：

1. **业务错误不做成 rejected promise**，而是返回 `{ ok: false, error }`，
   由桥层转成 `Promise.reject(error)`，保证 reject 值就是**原始字符串**
   （`[WENKU8_LOGIN_CANCELLED] ...` 这类靠前缀判断的协议依赖它）。
2. **批量命令逐条独立成败**，只有整条通道失败才 reject。

## 环境要求

**Windows 开发 / 构建**：

- Node.js 20+（CI 用 22）
- **Visual Studio 2026**，勾选 **Desktop development with C++** 与
  **Universal Windows Platform development**，并装上 **Windows SDK 10.0.26100**
- .NET SDK 8.0+（RNW 的原生构建链走 dotnet / NuGet）
- 开发者模式（设置 → 系统 → 开发者选项），否则无法部署 MSIX

> ⚠️ **必须是 VS 2026，不是 VS 2022。** RNW 0.83 的模板把 `PlatformToolset` 写成了
> **v145**（MSVC 14.5x），只有 VS 2026 才有这个工具集；用 VS 2022（v143）构建会在
> MSBuild 阶段直接报找不到 v145。这也是 CI 里 Windows 作业必须跑在
> `windows-2025-vs2026` 镜像上的原因（`windows-2022` / `windows-2025` 只有 VS 2022）。
>
> 上游背景：RNW 在 0.83 周期升级到了 VS 2026（[#16170](https://github.com/microsoft/react-native-windows/pull/16170)、
> [0.83 合并提交](https://github.com/microsoft/react-native-windows/commit/347fbce993485e177879dc49ffdea25ada036aa8)），
> 但 [依赖文档](https://microsoft.github.io/react-native-windows/docs/rnw-dependencies) 一度还写着 VS 2022
> （[#16275](https://github.com/microsoft/react-native-windows/issues/16275)）。**以模板里的 v145 为准。**

> ℹ️ **没装 .NET SDK 的机器上，`windows` 平台不会被注册。** RNW CLI 在加载阶段探测
> .NET / pwsh，失败即抛，于是 `npx react-native bundle --platform windows` 会报
> `Invalid platform "windows" selected`（可用平台只剩 ios / android / macos）。
> 这不是工程配置坏了 —— 装上 .NET SDK 8+ 后 `run-windows` 等命令会自己出现。
> 只想验证 JS 侧是否正常时，可以用 `--platform macos` 跑一次 bundle（不需要原生工具链）。

**macOS 开发 / 构建**：macOS 14+、Xcode 15+、CocoaPods。macOS 工程由
`scripts/generate-macos-project.mjs` 从 `react-native-macos` 的模板生成，
生成过程本身不需要 macOS，但**构建必须在 macOS 上做**。

## 快速开始

```bash
cd apps/RNdesktop
npm install

# 只跑 JS/TS（不需要原生工具链）—— 骨架阶段主要靠这条
npm run typecheck
npm run lint
npm test

# 起 Metro
npm start

# 另开一个终端：编译并启动 Windows 应用（首次约 10~20 分钟）
npm run windows
```

### 原生工程是**生成**出来的，不是手写的

`windows/` 与 `macos/` 都来自上游模板，改之前先看清楚来源：

```bash
# 从 react-native-windows 的 templates/cpp-app 生成 windows/
node scripts/generate-windows-project.mjs

# 从 react-native-macos 的 local-cli/generator-macos 生成 macos/
node scripts/generate-macos-project.mjs
```

**为什么不用官方的 `npx react-native init-windows` / `react-native-macos-init`**：

- RNW 的 CLI 在**加载配置阶段**就会去探测 .NET SDK 与 pwsh（`find-dotnet-tools`），
  探测失败会让整个 CLI 崩掉、连 `init-windows` 都注册不上 —— 在没装 VS/.NET 的
  机器上必然如此。我们的脚本直接复用同一份模板与同一套替换规则，产出等价，
  且只依赖 `mustache` / `glob` / `username` 三个包。
- 顺带避开了 RNW CLI 0.83.2 的一个打包缺陷（`find-dotnet-tools` 没写进
  dependencies，见上文版本表）。

生成器是**幂等**的：仓库里已经提交了一份产物，重复执行会用同样的内容覆盖，
因此升级 `react-native-windows` / `react-native-macos` 后重跑一次即可同步工程文件。

> 没有原生工程时 `npm start` + 浏览器/其他平台看不了这个应用 —— 它是一个真正的
> RN 应用，不是 Web 应用。想看界面只能走 `npm run windows`。
>
> **原生桥未实现时，界面会自动退回 mock 宿主**（标题栏显示「预览模式」），
> 所以外壳、主题、路由都能正常渲染，只有涉及真实数据的功能不可用。

## 原生桥接入点

等 Windows / macOS 的 TurboModule 落地后，只需改
[`src/bridge/bridge.ts`](src/bridge/bridge.ts) 里的 `resolveHostBridge()`：
把 `NativeModules.SilverMoonHost` 适配成 `SilverMoonHostBridge` 即可，
**上层一行都不用改**。

原生侧需要提供的方法：`invoke` / `invokeBatch` / `call` / `emitTo` /
`subscribe`，以及 `label` / `platform` / `hostVersion` 三个只读属性。

## CI

[`.github/workflows/rndesktop.yml`](../../.github/workflows/rndesktop.yml)：

| 作业 | 触发 | 内容 |
|---|---|---|
| `lint` | push / PR（仅 `apps/RNdesktop/**` 或本 workflow 变更） | ESLint + Prettier + tsc + Jest |
| `windows` | 同上 | `windows-2022` + .NET 8 + `run-windows --release`，产出 MSIX |
| `macos` | **手动触发**（勾选 `build_macos`） | `macos-15` + `pod install` + Release 构建 |
| `release` | tag `rndesktop-v*` | 汇总 MSIX 发 prerelease |

macOS 作业默认不跑，是因为它**无法在 Windows 上验证**：与其塞一个可能常年红的门禁，
不如留成手动触发，等有 macOS 环境时再固化成必过项。

## 下一步（尚未实现）

1. **原生桥**：Windows C++/WinRT TurboModule + macOS Objective-C++ TurboModule
2. **Rust sidecar 拉起**：复用 `apps/desktop/backend` 的同一份可执行文件与 `POST /cmd` 协议
3. **各功能页**：按 `src/screens/index.tsx` 的注册表逐个替换占位屏
4. **无边框窗口与自绘标题栏**：窗口按钮走 `window:control` 通道
5. **托盘 / 全局热键 / SMTC / 桌面歌词窗口**：原生侧能力，逐个补通道

## 许可

与主仓库一致：**GPL-3.0-only**（见 [`apps/desktop/LICENSE`](../desktop/LICENSE)）。
