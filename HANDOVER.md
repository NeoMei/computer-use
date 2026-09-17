# 交接文档 — orca-computer-use-standalone（GitHub 仓库：computer-use）

> 从 [stablyai/orca](https://github.com/stablyai/orca) 提取的独立 macOS + Windows computer-use 引擎（CLI / stdio JSON-RPC / opencode MCP），不依赖 Orca 桌面程序。上游 MIT，本仓库沿用 MIT（见 LICENSE）。

## 1. 当前状态

| 平台 | 状态 | 证据 |
|---|---|---|
| macOS | ✅ 全部验收通过 | `swift build` 通过；Finder 完整读写闭环（截屏落盘 → AX 树 → 点击 → 状态回读）；MCP initialize/tools/list/tools/call 全通 |
| Windows | ✅ 真机验证通过（2026-09-17，Win11 + Node 24.18） | §5 清单 4 项全过；另补测一次性 CLI 写入闭环（`set-value`+回读）与 MCP 层（initialize / 13 工具 / get_app_state / set_value / click）全通。发现并修复 2 个真机 bug（commit 628ecf7）：① permissions 路径未处理 ready rejection，进程 exit=1；② 一次性 CLI 元素寻址无缓存必失败（已对齐 macOS 一次性快照解析语义） |

## 2. 目录结构

```
computer-use/
├── native/computer-use-macos/          # 上游 Swift 包（最小修改，见 §6）
│   └── .build/release/orca-computer    # 本地构建产物（不入库，swift build -c release 重新生成）
├── native/computer-use-windows/runtime.ps1   # 上游原样复用，未改动（PowerShell + UIA）
├── mcp/server.mjs                      # MCP server（零 npm 依赖，stdio，按平台路由）
├── mcp/win32-provider.mjs              # Windows 适配层：我们的契约 ↔ runtime.ps1（--self-test 自检）
├── cli/orca-computer.mjs               # Windows CLI（与 macOS 二进制同子命令/同参数面）
├── cli/orca-computer.cmd               # Windows 命令行 shim
├── opencode.json                       # 项目级 opencode MCP 配置（在仓库根目录打开 opencode 即生效）
├── demo.sh                             # macOS 端到端自检
├── demo.ps1                            # Windows 端到端自检
├── README.md                           # 英文文档（构建/用法/限制）
└── HANDOVER.md                         # 本文档
```

## 3. macOS 快速上手

```bash
cd native/computer-use-macos && swift build -c release   # 产物 .build/release/orca-computer
cd ../..

# 权限（一次性）：授给启动 orca-computer 的那个 App（终端/OpenChamber 等）
.build/release/orca-computer permissions --json
.build/release/orca-computer permissions --open accessibility
.build/release/orca-computer permissions --open screenshots

./demo.sh                                                # 端到端自检
native/computer-use-macos/.build/release/orca-computer get-app-state --app com.apple.finder --json
```

要点：
- App 选择器**优先用 bundle id**（`com.apple.finder`）。中英系统上 app 名称是本地化的（Finder 显示为「访达」），按名字匹配会失败。
- 元素索引来自最近一次 `get-app-state` 的 `treeText`（每行第一个 token），UI 变化后即失效——操作前先刷新。
- `--json` 模式截图写盘并在 `result.screenshot.path` 返回路径；`--screenshot-out <path>` 可指定落盘位置。

## 4. 三层架构

```
opencode / 其他客户端
      │ MCP (stdio, JSON-RPC 2.0)
      ▼
mcp/server.mjs ── macOS: 每次调用 spawn CLI（swift 二进制）
      │           └─ Windows: 常驻 runtime.ps1 -Serve（NDJSON，先发 {"ready":true}）
      ▼
CLI 子命令（orca-computer <cmd>）/ stdio JSON-RPC（--allow-standalone）
      ▼
Provider（上游 Swift）/ runtime.ps1（上游 PowerShell+UIA）
```

stdio 协议（macOS，`--allow-standalone` 显式开启，旁路 token/peer 门禁；不带参数仍然拒绝服务，Orca 桌面 `--agent` 模式不受影响）：

```
→ {"id":1,"method":"handshake","params":{}}
← {"id":1,"ok":true,"result":{...}}
→ {"id":2,"method":"click","params":{"app":"com.apple.finder","elementIndex":15}}
← {"id":2,"ok":true,"result":{"snapshot":{...},"screenshot":{...},"action":{...}}}
```

Windows 适配层（mcp/win32-provider.mjs）职责：
- 元素寻址：上游 Windows 用 `{index, runtimeId}` 而非裸索引 → 适配层缓存每个 app 最近快照的 elements，把 `element_index` 解析成 runtimeId 记录（等价 macOS 版进程内快照缓存语义）；一次性调用（CLI）无缓存时自动先取一次最新快照再解析，对齐 macOS 一次性 CLI 语义（§6.3）。
- 响应归一化：把上游 `{ok, snapshot:{treeLines, elements, screenshotPngBase64...}}` 归一成与 macOS 相同的 `{snapshot:{window, treeText, elementCount}, screenshot:{path,bytes}, action, screenshotStatus}` 形状（截图 base64 落盘）。
- 错误码映射：`appNotFound(...)` → `app_not_found` 等。
- `permissions` 在 Windows 返回 `not-required`（UIA 无 TCC 类授权）。

## 5. Windows 验证清单（拉代码后照跑）

前置：Windows 10/11，Node.js 在 PATH，交互式桌面会话（不是服务/Session 0）。UIA 无需任何权限授予。

```powershell
git clone https://github.com/NeoMei/computer-use.git
cd computer-use

node mcp\win32-provider.mjs --self-test        # 1. 适配层逻辑（应输出 self-test OK）
cli\orca-computer.cmd list-apps --json         # 2. 进程枚举（应列出有主窗口的应用）
cli\orca-computer.cmd get-app-state --app notepad --json   # 3. 树 + 截图落盘
.\demo.ps1                                     # 4. 端到端：notepad 截屏→UIA树→点击→写入→回读，应输出 DEMO OK
```

> 真机验证记录（2026-09-17，Win11 + Node 24.18）：4 项全过；另补测一次性 CLI `set-value`+回读、MCP `initialize`/`tools/list`（13 工具）/`tools/call` 写入闭环，均通过。环境注意：`HKCU\Software\Microsoft\Command Processor\AutoRun = "chcp 65001"`（中文开发机常见）会让 `.cmd` shim 的 stdout 混入 `Active code page: 65001`，破坏 `--json` 解析——此类机器清单命令改用 `node cli\orca-computer.mjs`（demo.ps1 直调 node，不受影响）。

然后接入 opencode（仓库根目录的 `opencode.json` 已配好，直接在该目录打开 opencode 即可；全局配置则把 `mcp` 块加进 `~/.config/opencode/opencode.json`，`command` 用绝对路径）。验收：opencode 里列出 13 个 orca-computer 工具，成功调用 `get_app_state`。

Windows 侧语义差异（与 macOS 对齐处已在适配层抹平，但选择器不同）：
- app 选择器 = 进程名（`notepad` / `notepad.exe`）、`pid:<n>` 或精确窗口标题；无 bundle id。
- `list_windows` 只报告进程主窗口（上游 MainWindowHandle 方案）。
- 键盘类操作要求目标窗口前台，失败会报 `window_not_focused`，用 `--restore-window` 重试。

## 6. 相对上游 orca 的改动（全部最小化）

- `Package.swift`：可执行 target/product 改名 `orca-computer`（路径未动，上游源码安全测试不受影响）。
- `main.swift` 三处：
  1. `runStandaloneStdio()`：`--allow-standalone` 启用 stdio 行式 JSON-RPC，该模式下旁路 token+peer 门禁；`terminate` 无 runloop 直退；默认无参行为不变（仍 exit 13）。
  2. `permissionStatusSnapshotSettled()` 改 internal 供 CLI 使用。
  3. 无进程内缓存时（一次性 CLI 场景）跳过元素签名比对，索引直接解析最新快照（越界仍报 `element_not_found`）。
- 新增 `StandaloneCLI.swift`：CLI 层（子命令、截图落盘、stdin 传值、JSON/pretty 输出）。
- 其余（`runtime.ps1`、`mcp/`、`cli/`、demo 脚本）为本仓库新增；上游 runtime.ps1 **零改动**，便于跟上游同步。

从上游同步：`runtime.ps1` / `computer-use-macos` 有更新时，直接从 stablyai/orca 对应目录覆盖，重跑 `swift build` + demo 即可。

## 7. 已知坑（都踩过，别再踩）

1. **TCC 归属**：从 App 里 spawn 的二进制，辅助功能/屏幕录制权限记在**责任进程**（终端或 OpenChamber 这类宿主 App）头上，不是二进制自己。本机当时授的是 OpenChamber.app。授权后可能需要重启宿主 App。
2. **目标 App 没有真实窗口**（如 Finder 只剩桌面）时，上游报 `permission_denied` 并误导性提示去开关辅助功能——实际是无可用 AXWindow。开个窗口即好（demo 已用 `open ~` 规避）。
3. **本地化 app 名**：`--app Finder` 在中文系统匹配不到（显示为「访达」），用 bundle id。
4. macOS 截屏引擎走 legacy `CGWindowListCreateImage`（未签名 CLI 用 ScreenCaptureKit 不可靠，上游注释原话）；deprecation 警告属预期。
5. `swift test` 需要完整 Xcode（仅 Command Line Tools 时 XCTest 模块缺失）；不影响 `swift build`。
6. 合成键盘/鼠标输入按上游设计报 `unverified (synthetic input)`，必须以回读状态为准，不要当成失败重试。
7. **cmd AutoRun 污染输出**：注册表 `HKCU\Software\Microsoft\Command Processor\AutoRun`（中文开发机常配 `chcp 65001`）会让所有经 `.cmd` 的调用在 stdout 混入 banner 行，`--json` 解析随即失败；改用 `node cli\orca-computer.mjs` 直调（demo.ps1 不受影响）。

## 8. 后续工作建议

- 考虑给 stdio/CLI 模式加可选 `--token-file`（当前 standalone 完全无鉴权，靠操作者显式 `--allow-standalone` 兜底；暴露给多用户环境前建议补上）。
- 上游 `runtime.ps1` 的 `-Serve` 进程目前随 MCP server 生命周期存活；如遇挂死可在 server.mjs 加空闲重启。
- 可选：MCP `tools/call` 把 `screenshot.path` 读成 `{type:"image"}` 内容返回，多模态客户端可直接看图（当前返回路径文本）。
