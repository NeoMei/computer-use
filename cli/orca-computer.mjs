#!/usr/bin/env node
// orca-computer CLI for Windows. Same subcommands/flags as the macOS Swift binary;
// backed by upstream runtime.ps1 via mcp/win32-provider.mjs. On macOS use the native
// binary (native/computer-use-macos/.build/release/orca-computer) instead.
import { readFileSync } from "node:fs";
import { createRuntime, createWin32Provider } from "../mcp/win32-provider.mjs";

const VALUE_FLAGS = new Set([
  "--app", "--element-index", "--window-id", "--window-index", "--x", "--y",
  "--mouse-button", "--modifiers", "--click-count", "--action", "--value", "--text",
  "--key", "--direction", "--pages", "--from-element-index", "--to-element-index",
  "--from-x", "--from-y", "--to-x", "--to-y", "--screenshot-out",
]);
const BOOLEAN_FLAGS = new Set(["--json", "--restore-window", "--no-screenshot", "--value-stdin", "--text-stdin", "--help"]);
const FLAGS_TO_ARGS = {
  "--app": "app", "--element-index": "element_index", "--window-id": "window_id",
  "--window-index": "window_index", "--x": "x", "--y": "y", "--mouse-button": "mouse_button",
  "--modifiers": "modifiers", "--click-count": "click_count", "--action": "action",
  "--value": "value", "--text": "text", "--key": "key", "--direction": "direction",
  "--pages": "pages", "--from-element-index": "from_element_index",
  "--to-element-index": "to_element_index", "--from-x": "from_x", "--from-y": "from_y",
  "--to-x": "to_x", "--to-y": "to_y", "--restore-window": "restore_window",
  "--no-screenshot": "no_screenshot",
};

const usage = `orca-computer (Windows) — UIA-backed computer-use CLI

usage: node cli/orca-computer.mjs <command> [flags]

commands: permissions | capabilities | list-apps | list-windows | get-app-state | click |
  perform-secondary-action | set-value | type-text | press-key | hotkey | paste-text | scroll | drag

examples:
  node cli/orca-computer.mjs list-apps --json
  node cli/orca-computer.mjs get-app-state --app notepad --json
  node cli/orca-computer.mjs click --app notepad --element-index 3 --json

app selector on Windows: process name (notepad / notepad.exe), pid:<n>, or exact window title.
element indexes come from the latest get-app-state treeText (first token per line).`;

function fail(message, { json = false, code = "invalid_argument" } = {}) {
  const payload = { error: { code, message } };
  console.log(json ? JSON.stringify(payload) : `orca-computer: ${message}`);
  process.exit(1);
}

async function main() {
  const argv = process.argv.slice(2);
  const command = argv[0];
  if (!command || command === "help" || argv.includes("--help")) {
    console.log(usage);
    process.exit(command ? 0 : 2);
  }

  const args = {};
  let json = false;
  let screenshotOut = null;
  for (let i = 1; i < argv.length; i++) {
    const token = argv[i];
    if (BOOLEAN_FLAGS.has(token)) {
      if (token === "--json") { json = true; continue; }
      if (token === "--value-stdin") { args.value = readFileSync(0, "utf8"); continue; }
      if (token === "--text-stdin") { args.text = readFileSync(0, "utf8"); continue; }
      if (FLAGS_TO_ARGS[token]) args[FLAGS_TO_ARGS[token]] = true;
      continue;
    }
    if (!VALUE_FLAGS.has(token)) fail(`unknown flag '${token}'`, { json });
    const value = argv[++i];
    if (value === undefined) fail(`missing value for ${token}`, { json });
    if (token === "--screenshot-out") { screenshotOut = value; continue; }
    args[FLAGS_TO_ARGS[token]] = /^pid:\d+$/.test(value) || Number.isNaN(Number(value)) || token === "--app"
      ? value
      : Number(value);
  }
  const runtime = createRuntime();
  const callTool = createWin32Provider(runtime);
  try {
    let result;
    if (command === "permissions") {
      result = await callTool("permissions", {});
    } else if (command === "capabilities") {
      result = await callTool("capabilities", {});
    } else {
      result = await callTool(command.replace(/-/g, "_"), args);
    }
    if (screenshotOut && result.screenshot?.path) {
      const { copyFileSync } = await import("node:fs");
      copyFileSync(result.screenshot.path, screenshotOut);
      result.screenshot.path = screenshotOut;
    }
    console.log(JSON.stringify(result));
  } catch (error) {
    fail(String(error.message ?? error), {
      json,
      code: error.code ?? "provider_error",
    });
  } finally {
    runtime.kill();
  }
}

main();
