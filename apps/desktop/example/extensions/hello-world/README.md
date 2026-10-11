# hello-world —— 最小扩展示例

SilverMoon 扩展框架的「能跑的最小扩展」。它同时演示**两条链路**：

- **扩展 UI ↔ 宿主**：`settings:get` / `settings:set`（宿主保留方法）；
- **扩展 UI ↔ 扩展引擎**：`greet` / `status` / `remember` / `recall`（转发到本地 HTTP 引擎）。

## 结构

```
hello-world/
├── manifest.json          ← 清单：元数据 + 引擎入口 + 贡献点 + 权限
├── engine/serve.py        ← 扩展引擎（40 行 Python，只用标准库，无需 pip install）
└── web/dist/index.html    ← 扩展 UI（单文件纯静态，无需任何构建工具）
```

## 怎么跑

1. 打开应用 → 设置 → **扩展** → 「从文件夹安装」→ 选中本目录（`example/extensions/hello-world`）；
2. 打开界面，二选一：
   - 按 `Ctrl+Alt+H`（全局热键）；
   - 托盘菜单 → 「打开 Hello World」。
3. 页面顶部显示「已连接宿主」= 桥通了。之后可以：
   - 「读取 / 保存」验证设置读写；
   - 「greet」把输入的名字发给引擎，引擎回一句话；
   - 「status」看引擎自己的运行时长、Python 版本、data/ 目录路径；
   - 「remember / recall」写读 `data/notes.json`（演示 `supportEnv` 注入的私有数据目录）。

## 前置条件

- 引擎是 `.py`，宿主会用系统 Python 解释器拉起（依次探测 `python` / `python3` / `py`）。
  机器上没有 Python 时：把 `engines` 换成任意可执行文件即可，协议不变。
- 界面本身不需要任何东西 —— 双击 `web/dist/index.html` 就能在浏览器里看（只是那时
  `invoke` 会超时，「未连接宿主」是预期行为）。

## 值得抄的几点

| 文件 | 看什么 |
|------|--------|
| `web/dist/index.html` | 桥的完整实现（约 80 行）：reqId 配对、超时、只认 `source === "lumiluna-host"`；无边框窗口的自绘标题栏与 `no-drag` |
| `engine/serve.py` | `READY <port>` 握手（`flush=True`）、端口用 `0` 让系统分配、stdout 只留给握手、日志走 stderr、按路径分发方法 |
| `manifest.json` | `activationEvents` 懒加载、最小权限、`settings.schema` 类型化声明 |

## 常见坑

- **改 id 要改两处**：`manifest.json` 的 `id` 与 `index.html` 里的 `EXT_ID` 常量必须一致，
  否则宿主会因为 `source` 对不上而**静默丢弃**所有请求（表现为一直超时）。
- **stdout 不能乱写**：引擎只在启动时往 stdout 打一行 `READY <port>`，之后所有输出都会
  挤进同一个管道且无人消费 —— 日志请走 `stderr`。
- **权限**：`manifest.permissions` 写了数组就严格校验。本示例声明 `["ext:invoke"]`，
  引擎方法都要它；如果哪天用 `open` / `reveal`，记得补 `opener:open-path`。

完整字段说明与调试步骤见 `doc/扩展开发指南.md`。
