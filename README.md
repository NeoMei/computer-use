# computer-use-standalone

Standalone macOS **and Windows** computer-use CLI / MCP server. No host desktop app required — the accessibility/screenshot/input engine talks JSON-RPC and CLI directly.

```
computer-use-standalone/
├── native/computer-use-macos/        # upstream Swift package (minimally modified)
│   └── .build/release/computer-use  # built macOS binary
├── native/computer-use-windows/      # upstream runtime.ps1 (PowerShell + UIA, unmodified)
├── mcp/server.mjs                    # dependency-free MCP server (stdio, both platforms)
├── mcp/win32-provider.mjs            # Windows adapter: contract <-> runtime.ps1 (self-testable)
├── cli/computer-use.mjs + .cmd      # Windows CLI (same subcommands as the macOS binary)
├── opencode.json                     # project-level opencode MCP config
├── demo.sh                           # macOS end-to-end self check
└── demo.ps1                          # Windows end-to-end self check
```

## Build

Requires macOS 14+ and Swift 6 toolchain (Xcode or Command Line Tools).

```bash
cd native/computer-use-macos
swift build -c release
# binary: .build/release/computer-use
```

(`swift test` additionally needs full Xcode for the XCTest module; Command Line Tools alone cannot build the test target.)

## Permissions (one-time)

The binary needs **Accessibility** (AX tree + actions) and **Screen Recording** (screenshots). Grant them to whichever app actually launches `computer-use` — a bare binary inherits the TCC identity of its parent app (Terminal, iTerm, OpenChamber, ...). Check state and open the right Settings pane:

```bash
.build/release/computer-use permissions --json
.build/release/computer-use permissions --open accessibility
.build/release/computer-use permissions --open screenshots
```

## CLI

```bash
C=native/computer-use-macos/.build/release/computer-use

$C permissions --json
$C capabilities --json
$C list-apps --json
$C list-windows --app com.apple.finder --json
$C get-app-state --app com.apple.finder --json          # treeText + screenshot saved to disk (result.screenshot.path)
$C get-app-state --app com.apple.finder --no-screenshot --json
$C click --app com.apple.finder --element-index 12 --json
$C click --app com.apple.finder --x 100 --y 200 --modifiers CmdOrCtrl+Shift --json
$C set-value --app com.apple.finder --element-index 3 --value "hello" --json
$C type-text --app com.apple.finder --text "hello" --json
$C press-key --app com.apple.finder --key Return --json
$C hotkey --app com.apple.finder --key CmdOrCtrl+A --json
$C scroll --app com.apple.finder --element-index 5 --direction down --json
$C drag --app com.apple.finder --from-x 100 --from-y 100 --to-x 300 --to-y 300 --json
```

Semantics mirror upstream `skill-guides/computer-use.md`: element indexes come from the latest snapshot's `treeText` (first token of each line) and go stale after UI changes — always re-read state between actions. `--json` output puts the screenshot PNG on disk and reports `result.screenshot.path` (or pass `--screenshot-out <path>`); without `--json` you get a human summary. `--value-stdin` / `--text-stdin` read sensitive payloads from stdin instead of argv.

## stdio JSON-RPC mode (machine protocol)

```bash
computer-use --allow-standalone
```

Line-delimited: one request per line, one response per line. **`--allow-standalone` is required explicitly** — it disables the upstream token + peer-process gating (the desktop-agent mode `--agent <socket> --token-file <path>` is preserved and behaves exactly as before, and a bare invocation still refuses to serve).

```json
{"id": 1, "method": "handshake", "params": {}}
{"id": 2, "method": "getAppState", "params": {"app": "Finder"}}
{"id": 3, "method": "click", "params": {"app": "Finder", "elementIndex": 12}}
```

Responses: `{"id": 1, "ok": true, "result": {...}}` or `{"id": 1, "ok": false, "error": {"code": "...", "message": "..."}}`. Methods: `handshake`, `listApps`, `listWindows`, `getAppState`, `click`, `performSecondaryAction`, `setValue`, `typeText`, `pressKey`, `hotkey`, `pasteText`, `scroll`, `drag`, `terminate`. In this mode screenshots stay inline base64 (`result.screenshot.data`).

## opencode MCP

The repo includes a project-level config (open opencode in this directory):

```json
{
  "mcp": {
    "computer-use": {
      "type": "local",
      "command": ["node", "mcp/server.mjs"],
      "enabled": true
    }
  }
}
```

For a global setup add the same `mcp` block to `~/.config/opencode/opencode.json` with an absolute path to `mcp/server.mjs`. The server exposes 13 tools (`list_apps`, `get_app_state`, `click`, `set_value`, `type_text`, `press_key`, `hotkey`, `paste_text`, `scroll`, `drag`, `list_windows`, `permissions`, `capabilities`) and routes by platform: on macOS it spawns the CLI per call; on Windows it keeps one `runtime.ps1 -Serve` process alive. Override the binary location with `COMPUTER_USE_BIN` (macOS) / `COMPUTER_USE_RUNTIME_PS1` (Windows).

## Windows

No build step — Windows PowerShell 5.1 (shipped with Windows), Node.js, and an interactive desktop session are all it needs. UI Automation requires no TCC-style permission grants.

```powershell
cd native/computer-use-windows   # runtime.ps1 is upstream, unmodified
cd ..\..
cli\computer-use.cmd list-apps --json
cli\computer-use.cmd get-app-state --app notepad --json     # treeText + screenshot.path
cli\computer-use.cmd click --app notepad --element-index 3 --json
cli\computer-use.cmd set-value --app notepad --element-index 3 --value "hello" --json
cli\computer-use.cmd permissions --json                     # not-required on Windows
node mcp\win32-provider.mjs --self-test                      # adapter logic check
.\demo.ps1                                                   # end-to-end: notepad screenshot -> tree -> click -> set-value -> readback
```

Verified end-to-end on a real Windows 11 machine (Node 24): the commands above, the one-shot CLI write loop (`set-value` + tree readback), the MCP write loop (13 tools, `get_app_state`/`set_value`/`click`), and `demo.ps1`. One-shot CLI element calls take a fresh `get-app-state` snapshot automatically when none is cached (macOS CLI parity); the MCP server keeps a persistent per-app cache instead.

Windows notes: the app selector is process name (`notepad`/`notepad.exe`), `pid:<n>`, or exact window title (no bundle ids); `list_windows` reports the process's main window only; element indexes are resolved through `{index, runtimeId}` records from the most recent snapshot (the adapter caches them per app, same freshness contract as macOS); keyboard ops require the target window foreground (`--restore-window` helps); every action needs an interactive desktop session. A `Command Processor\AutoRun` registry entry (commonly `chcp 65001`) prints its banner into `.cmd` stdout and corrupts `--json` output — on such machines invoke `node cli\computer-use.mjs` directly.

## Self check

```bash
./demo.sh    # macOS: permissions -> Finder screenshot -> AX tree -> click -> state readback
```

```powershell
.\demo.ps1   # Windows: permissions -> notepad screenshot -> UIA tree -> click -> set-value -> readback
```

## Changes vs upstream

- `Package.swift`: executable target/product renamed to `computer-use` (module sanitized to `computer_use`).
- `main.swift` (macOS CLI entry):
  - `runStdio()` unlocked behind `--allow-standalone` (`runStandaloneStdio()`), token/peer checks bypassed only in that mode; `terminate` handled without a runloop.
  - `permissionStatusSnapshotSettled()` made internal for the CLI.
  - default no-arg behavior unchanged (refuses to serve, exit 13).
- `StandaloneCLI.swift`: new CLI layer (flag → params mapping, screenshot decode → disk, pretty/JSON output).

## Known limitations

- Screenshot engine is the legacy `CGWindowListCreateImage` path in CLI/stdio mode (deprecated upstream API, still functional; ScreenCaptureKit path stays reserved for signed app-agent mode). Deprecation warning is expected.
- `swift test` requires full Xcode (XCTest unavailable with Command Line Tools only).
- Synthetic keyboard input is reported `unverified (synthetic input)` by design — verify via returned state.
- `permissions --open` opens System Settings; the actual grant is always a manual user action.
- App-blocklist / safety semantics from upstream (e.g. blocked bundle ids) are preserved.
- When the target app has no real window (e.g. Finder showing only the desktop), `get-app-state` reports a confusing `permission_denied` (upstream message blames Accessibility toggling) — the actual cause is "no usable AXWindow"; open a window and retry.
