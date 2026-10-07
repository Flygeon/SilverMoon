# RN 桌面端框架说明

> 面向**要在这套骨架上继续写功能的人**。产品级说明见 [`../README.md`](../README.md)。

## 一、这一版做了什么、没做什么

**做了**（可运行、可验证）：

| 模块 | 位置 | 说明 |
|---|---|---|
| 宿主桥契约 | `src/bridge/` | 接口、错误约定、mock 宿主、存活探测 |
| 设计令牌与主题 | `src/theme/` | MD3 角色化色彩、亮/暗/跟随系统 |
| 路由 | `src/navigation/` | 侧栏分组 + 内容区切换 |
| 桌面外壳 | `src/shell/`、`src/components/` | 标题栏 + 侧栏 + 内容区 |
| 原生工程 | `windows/`、`macos/` | 由脚本从上游模板生成 |
| CI | `.github/workflows/rndesktop.yml` | lint/类型/单测 + Windows MSIX |
| 测试 | `__tests__/` | 外壳冒烟 + 桥层契约 |

**没做**（刻意留空，避免框架和功能互相污染）：

- 任何业务页面：8 个路由全部指向 `PlaceholderScreen`
- 原生桥实现：`resolveHostBridge()` 永远返回 `null`，一律走 mock
- Rust sidecar 拉起、`POST /cmd` 的真实调用
- 持久化：主题模式、窗口尺寸、侧栏宽度都只在内存里
- 无边框窗口 / 托盘 / 全局热键 / SMTC / 桌面歌词窗口

## 二、桥（bridge）：两条不能退化的约定

```ts
// 1) 业务错误 → 原始字符串 reject，不包 Error
const data = await invokeCommand<MediaItem[]>('library.list', { offset: 0 });
//   失败时 reject 的是 "  [WENKU8_LOGIN_CANCELLED] 用户取消登录"  这样的字符串
//   上层靠前缀判断协议分支，包一层 Error 会把所有分支判断打断

// 2) 批量 → 逐条独立成败
const items = await invokeBatchCommands([{ cmd: 'a' }, { cmd: 'b' }]);
//   items[0].ok / items[1].ok 各自独立；只有整条通道挂了才 reject
```

这两条都写在 `__tests__/bridge.test.ts` 里守着，改动桥层时先看那两条用例。

### 接入原生实现

只改 `src/bridge/bridge.ts` 的 `resolveHostBridge()`：

```ts
function resolveHostBridge(): SilverMoonHostBridge | null {
  const { SilverMoonHost } = require('react-native').NativeModules;
  if (!SilverMoonHost) return null;
  return {
    label: SilverMoonHost.label,
    platform: SilverMoonHost.platform,
    hostVersion: SilverMoonHost.hostVersion,
    invoke: (cmd, args) => SilverMoonHost.invoke(cmd, args),
    invokeBatch: calls => SilverMoonHost.invokeBatch(calls),
    call: (channel, payload) => SilverMoonHost.call(channel, payload),
    emitTo: (label, event, payload) => SilverMoonHost.emitTo(label, event, payload),
    subscribe: (event, listener) => {
      const sub = SilverMoonHost.addListener(event, listener);
      return () => sub.remove();
    },
  };
}
```

原生侧（Windows: C++/WinRT TurboModule；macOS: Objective-C++ TurboModule）需要实现
同名方法。通道名登记在 `src/bridge/types.ts` 的 `HostChannel`，新增通道请同时补这里。

## 三、主题：为什么用 MD3 的角色名

现有 Electron 端就是 MD3 + Monet 动态取色。RN 端沿用**同一套角色名**
（`primary` / `surfaceContainerHigh` / `onSurfaceVariant` …），
将来把 Rust 侧算好的配色灌进来时，界面层不需要做任何映射。

取值上做了桌面端适配：正文字号 14、侧栏项高 32、间距阶梯偏紧 —— 鼠标精度高、
信息密度可以比移动端更大。

## 四、路由：为什么不用 React Navigation

桌面端的导航是「侧栏常驻 + 内容区切换」，没有手势返回、没有页面栈、没有转场。
装 React Navigation 只会带进 `react-native-screens` / `react-native-gesture-handler`
两个**原生依赖**，把原生编译面平白放大一倍，却一个能力都用不上。

现在的实现（`NavigationProvider`）只有一个 state + 一个历史栈。等到真的需要
「详情页叠在列表页之上」时再换库 —— 上层只依赖 `useNavigation()`，替换面被限制在
一个文件里。

## 五、加一个新页面的步骤

1. `src/navigation/routes.ts` 的 `ROUTES` 里加一条（id / 标题 / 分组 / 说明）
2. `src/screens/index.tsx` 里把该 id 指向真实组件（不再用 `PlaceholderScreen`）
3. 组件签名是 `({ route }: { route: RouteDef }) => JSX.Element`

侧栏、路由、标题栏都不用改。

## 六、原生工程与工具链的坑

### v145 工具集（Windows）

`windows/SilverMoon/SilverMoon.vcxproj` 里 `<PlatformToolset>v145</PlatformToolset>`，
这是 **VS 2026** 的工具集。用 VS 2022 构建会报找不到 v145。
CI 因此跑在 `windows-2025-vs2026` 镜像上。

### RNW CLI 0.83.2 的两个缺陷

1. `@react-native-windows/cli@0.83.2` 在 `utils/commandWithProgress.js` 里
   `require('@react-native-windows/find-dotnet-tools')`，但**没把该包写进 dependencies**。
   不显式安装的话 CLI 直接 `Cannot find module` 崩掉。
   → 本目录把它钉成 devDependency `0.84.0`（npm 上只有 0.84/0.85 两条线）。
2. 即使装上了，CLI 在加载阶段就会探测 .NET SDK 与 `pwsh`，失败即抛。
   → 原生工程的生成改走 `scripts/generate-*.mjs`（直接复用上游模板，不加载 CLI）。

### macOS 工程

`macos/` 由 `scripts/generate-macos-project.mjs` 生成，替换规则与
`react-native-macos/local-cli/generator-macos` 一致（模板里唯一的变量就是项目名）。
**在 Windows 上只能生成、不能构建**：`pod install` 与 Xcode 构建必须在 macOS 上做。
CI 里的 macOS 作业因此是 `workflow_dispatch` 手动触发，不进门禁。

## 七、下一步的推荐顺序

1. **原生桥的最小可用版本**：先只实现 `invoke` / `call` / `ping`，让标题栏指示灯从
   「预览模式」变成「已连接」
2. **Rust sidecar 拉起**：复用 `apps/desktop/backend` 的同一份可执行文件与
   `POST /cmd` 协议（`SILVERMOON_READY {"port":N}` 的握手照搬）
3. **一个真实页面**：建议先做「设置」，因为它只需要 `store:kv` 一条通道，
   能顺带把持久化打通
4. **媒体库页面**：图片/视频/音乐三页共享扫描 + 缩略图通道，一起做更划算
5. **原生窗口能力**：无边框 + 自绘标题栏按钮、托盘、全局热键
