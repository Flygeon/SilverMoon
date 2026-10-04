# 启动动画（原生启动器 / MD3 Splash）

## 1. 为什么需要一个独立进程

用户感知的「启动等待」发生在 **Electron 主进程起来之前**：从双击图标到第一个
窗口可绘制之间，没有任何进程能画东西。Electron 内的 splash 页解决不了这段
（要等 Electron 自己启动完），所以用一个原生小进程**先出画面**盖住空窗期。

流程：

```text
双击快捷方式
  ↓
silvermoon-splash.exe   ← 原生，毫秒级出窗口（MD3 自绘动画）
  ├─ 建命名管道 \\.\pipe\silvermoon-splash-<pid>-<tick>
  ├─ 显示 splash（无边框 / 圆角 / 居中 / 分层窗口淡入）
  └─ 拉起 SilverMoon.exe --splash-pipe=<name>（Electron 窗口先隐藏）
        ↓
      Electron 就绪 → 管道发 READY
        ↓
      splash 回 FADING:220 并开始淡出
        ↓
      Electron 收到后等 220ms → show 主窗口（与淡出交叠，无黑屏）
```

## 2. 为什么用 Rust + windows-rs（而不是 C# WinForms）

实测对比（本机构建，非估算）：

| 方案 | 产物体积 | 可行性 |
| --- | --- | --- |
| C# WinForms 自包含 | **153 MB** | 可编译，但太重 |
| C# WinForms 压缩单文件 | **64.7 MB** | 首次运行需解压，**反而拖慢启动** |
| C# WinForms + 裁剪 | ❌ | `NETSDK1175: 启用剪裁时，不支持 Windows 窗体` |
| C# WinForms + NativeAOT | ❌ | AOT 内部启用裁剪，撞同一条限制 |
| **Rust + windows-rs** | **0.33 MB** | ✅ 已验证为合法 Windows GUI PE |

结论：WinForms 无法 AOT（.NET 硬限制），只能选 153MB 或 65MB；而压缩单文件的
首次解压开销**正好抵消它要盖住的那段等待**，自相矛盾。Rust 静态链接、双击即出画面，
且仓库已有 Rust 工具链与 CI 缓存，零新增基建。

## 3. 握手协议

一行一条、`\n` 结尾：

| 方向 | 消息 | 含义 |
| --- | --- | --- |
| Electron → 启动器 | `READY` | 主窗口已可显示，可以淡出 |
| 启动器 → Electron | `FADING:<ms>` | 我开始淡出，`<ms>` 后消失 |

**`FADE_MS` 是两端共享的时序常数**，定义在 `splash/src/handshake.rs`。
Electron 侧不硬编码它（由 `FADING:<ms>` 告知），改一处即同时生效。

## 4. 失败降级（每条都必须让用户能进应用）

| 故障 | 行为 |
| --- | --- |
| 没有 `--splash-pipe`（开发态 `electron .`） | Electron 走原生 `ready-to-show` 直接显示 |
| 管道建不起来 | 启动器直接拉起 Electron 后退出 |
| 拉起 Electron 失败 | 启动器立刻收起 splash |
| Electron 一直不发 READY | `CONNECT_TIMEOUT`（45s）硬兜底触发淡出 |
| 启动器不回 `FADING` | Electron 3s 超时后直接 show 主窗口 |

> 踩坑记录：`ConnectNamedPipe` 是**无限期**阻塞的。最初直接用它在异步线程里等，
> 导致 Electron 异常时 splash 永远转圈、用户无法进入应用。现改为「连接放独立线程
> + 主流程带超时轮询」，并额外加了 `CONNECT_TIMEOUT` 作为与握手无关的硬保险。

## 5. 构建与打包

```bash
# 构建启动器（Windows 目标；Linux 上可用 windows-gnu 做编译验证）
npm run build:splash

# 语法自检（跨平台，Linux 也能跑）
npm run verify:nsis
```

打包接线（`electron-builder.yml`）：

- `win.extraResources` 把 `splash/target/release/silvermoon-splash.exe` 打进包，
  实际落点是 **`<安装目录>\resources\silvermoon-splash.exe`**（见下）；
- `nsis.include: build/installer.nsh` 让**快捷方式与「安装后立即运行」都指向启动器**。
  不改这一点，用户点快捷方式仍直接拉 Electron，splash 永远不会执行。

### 安装后的真实布局（踩坑点）

```text
<安装目录>\SilverMoon.exe                      ← Electron 本体
<安装目录>\resources\silvermoon-splash.exe    ← 启动器（不是同级！）
<安装目录>\resources\bin\silvermoon-server.exe
```

**`extraResources` 的 `to` 是纯文件名，所以会被放进 `resources\`**，而不是安装根目录。
最初两侧代码都按「启动器与 SilverMoon.exe 同级」写，导致发布版里启动器找不到
Electron —— 快捷方式会指向一个什么都不做的程序，**应用直接打不开**。

而这个缺陷 CI 无法发现：CI 只校验 `splash/target/release/*.exe` 构建产物存在，
**从不解包安装包检查布局**。是解包真实 NSIS 产物（`7z x setup.exe` →
`$PLUGINSDIR/app-64.7z`）才看出来的。

因此现在两边都做**候选探测**，而不是写死单一位置：

- Rust：`locate_electron()` 依次试「启动器同目录」→「上一级目录」，逐个 `is_file()`；
- NSIS：先 `$INSTDIR\resources\silvermoon-splash.exe`，不存在再回退 `$INSTDIR\`。

### 怎么在 Linux/CI 上验证一个 Windows 程序的行为

启动器是 Windows GUI 程序，跑不起来；NSIS 脚本数据是压缩的，`strings` 也搜不到。
为了不靠「人眼审阅」，把路径判断抽成 **`splash/src/pathfind.rs`：只有 `std::path`、
无任何 Win32 依赖的纯函数**。于是可以绕过平台限制，用 `rustc --test` 直接编译执行
**二进制里同一份代码**：

```bash
npm run verify:splash-paths   # 6 例，真实 Rust 代码
```

> 为什么不用 Node 复刻一份同样的逻辑：复刻只能证明「我以为的逻辑对」，
> 源码改了、复刻没跟着改就完全失效。跑真实代码没有这个缝隙。

回归防线共三层：

1. `pathfind.rs` 的 Rust 单测（真实代码，含「发布布局必须能通过上级目录找到」）；
2. `packagedLayout.test.ts`：临时目录里**真实复刻安装布局**，断言两侧探测规则一致；
3. `splashContract.test.ts`：「发布布局」一组断言（钉到具体语句，非宽松正则）。

三层都用变异验证过：把上级目录候选删掉（即复现原缺陷）→ 测试如实失败。

## 6. 已知约束

- 仅 Windows：启动器是 Windows GUI 程序（`user32` / `gdi32`），
  `electron-builder.yml` 也只在 `win` 平台引用它。Linux/macOS 包不受影响。
- 启动器必须能找到 `SilverMoon.exe`；布局变化时 `locate_electron()` 的候选表要同步更新。
- 协议新增消息时**两端要同时改**（Rust 与 `electron/splash.ts`），
  契约测试在 `electron/__tests__/splashContract.test.ts`。
- **新增 extraResources 时注意落点是 `resources\`**；若希望落在安装根目录需显式处理。
