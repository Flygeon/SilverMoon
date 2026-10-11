# 磁盘透镜（disk-lens）

一个**能真正拿来用**的示例扩展：扫描你指定的目录，告诉你空间被谁吃掉了 ——
按文件类型、按子目录、按单个文件排行，每一项都能一键在文件管理器里定位。

和其它两个示例的分工不同：

| 示例 | 定位 |
|------|------|
| [`hello-world/`](../hello-world/) | 最小骨架 —— 只演示握手与桥，代码越短越好 |
| [`skin-manager/`](../skin-manager/) | 皮肤扩展 —— 演示 `contributes.themes` |
| **`disk-lens/`（本目录）** | **完整形态** —— 带引擎、带进度、带设置、带托盘/热键，接近真实插件该怎么写 |

## 装它

**从文件夹安装**（示例推荐，改完立刻能重装）：

> 设置 → 扩展 → 「从文件夹安装」→ 选中本目录

**装 zip**（注意 `manifest.json` 必须在压缩包**根**）：

```bash
cd example/extensions/disk-lens
Compress-Archive -Path * -DestinationPath ../disk-lens.zip -Force
```

装好后按 `Ctrl+Alt+D` 呼出窗口，或从托盘菜单进。

> 引擎是 `.py`，由宿主用系统 Python 解释器拉起。宿主按 `python` → `python3` → `py`
> 的顺序探测；本机实测只有 `py`（Windows 启动器）可用，宿主能找到，无需额外配置。

## 它演示了扩展框架的哪些能力

| 能力 | 在本扩展里的落点 |
|------|------------------|
| 引擎握手（`READY <port>`） | `engine/serve.py`：`print(f"READY {port}", flush=True)` |
| 端口交给系统分配 | `ThreadingHTTPServer(("127.0.0.1", 0))` —— 写死端口迟早撞车 |
| `supportEnv` 注入私有数据目录 | 参数持久化到 `DISK_LENS_DATA_DIR/options.json` |
| 长任务不撞 30 秒超时 | `scan` 起后台线程立即返回，前端轮询 `status` |
| 宿主保留方法 `settings:get/set` | 扫描目录、条数、体积阈值存在宿主设置里，与数据目录分开 |
| 宿主保留方法 `reveal` | 每条结果后面的「定位」按钮（需 `opener:open-path` 权限） |
| `contributes.windows` | 自定义尺寸的扩展窗口（900×660） |
| `contributes.hotkeys` | `Ctrl+Alt+D` 呼出 |
| `contributes.tray` | 「磁盘透镜」（`open:report`）+「重新扫描」（`invoke:scan`） |
| `contributes.settings.schema` | 四个设置项 + 默认值 |
| `activationEvents` 懒加载 | 声明了 `onHotkey/onTray/onInvoke`，所以**启动时不拉起引擎**，首次用到才起 |
| `permissions` | 只声明 `ext:invoke` 与 `opener:open-path`，没有多要 |

## 引擎路由

| 方法 | payload | 返回 |
|------|---------|------|
| `ping` | 任意 | `{ ok, version, dataDir }` |
| `scan` | `{ roots?, topN?, minMB?, followSymlinks? }`，**可为 `null`** | `{ started, options }` 或 `{ started:false, reason }` |
| `status` | 任意 | `{ running, files, dirs, bytes, current, elapsedMs, report? }` |
| `cancel` | 任意 | `{ cancelled }` |
| `options` | 任意 | `{ options }` 上次用的参数 |

托盘那条 `invoke:scan` 的 payload 就是 `null` —— 引擎复用上次保存的参数，
这正是 `_normalize_options()` 里 `if not isinstance(payload, dict)` 那一支要处理的情况。

## 几个设计取舍（值得照抄的部分）

1. **不伪造百分比。** 扫描前并不知道一共有多少文件，所以进度只报「已看到多少」，
   而不是编一个 0~100% 出来。
2. **只读。** 本扩展不删、不改、不移动任何文件 —— 示例不该教人写危险操作。
3. **上限兜底。** `MAX_ENTRIES` / `MAX_DEPTH` 防止在一个超大目录树上跑飞；
   命中时会回 `truncated: true`，UI 上明确标出来。
4. **错误进 `errors` 而不是抛异常。** 权限不足的目录很常见，跳过并记账就好。
5. **stdout 只出现 `READY` 那一行。** 访问日志走 stderr —— 这是引擎的铁律，
   写多了可能把管道写满。

## 一个实测踩到的坑

**数据目录不能落在被扫描的目录树里。**

第一版测试把 `DISK_LENS_DATA_DIR` 设在扫描根内部，结果引擎自己写进去的
`options.json` 被算进了统计 —— 文件数多 1、字节数对不上。

真实运行时这个目录是 `app_data/extensions/disk-lens/data`，本来就在用户的目录之外，
所以这不是实现问题；但**写扩展时要想清楚：任何你自己写盘的位置，会不会出现在
别人要扫描的范围里**。
