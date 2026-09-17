#!/usr/bin/env node
// Minimal MCP server wrapping the orca-computer CLI (no dependencies).
// Local stdio server: newline-delimited JSON-RPC 2.0, tools/list + tools/call.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createInterface } from "node:readline";
import path from "node:path";
import { fileURLToPath } from "node:url";

const pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BIN =
  process.env.ORCA_COMPUTER_BIN ||
  path.join(pkgRoot, "native", "computer-use-macos", ".build", "release", "orca-computer");

const str = (desc) => ({ type: "string", description: desc });
const obj = (properties, required = []) => ({ type: "object", properties, required, additionalProperties: false });

const TOOLS = [
  {
    name: "permissions",
    description: "Check macOS Accessibility and Screen Recording permission state for computer use.",
    inputSchema: obj({}),
  },
  {
    name: "capabilities",
    description: "Provider capability map (supported actions, windows, observation).",
    inputSchema: obj({}),
  },
  {
    name: "list_apps",
    description: "List running GUI apps with bundle ids and pids.",
    inputSchema: obj({}),
  },
  {
    name: "list_windows",
    description: "List on-screen windows of one app.",
    inputSchema: obj({ app: str("Bundle id, name, or pid:<n>") }, ["app"]),
  },
  {
    name: "get_app_state",
    description:
      "Accessibility tree + screenshot of an app window. Read element indexes from result.snapshot.treeText; screenshot PNG path at result.screenshot.path. Element indexes are short-lived: refresh before each action.",
    inputSchema: obj({
      app: str("Bundle id, name, or pid:<n>"),
      window_id: str("Optional window id from list_windows"),
      window_index: { type: "number", description: "Optional window index from list_windows" },
      restore_window: { type: "boolean", description: "Bring the window forward first" },
      no_screenshot: { type: "boolean", description: "Skip screenshot, tree only" },
    }, ["app"]),
  },
  {
    name: "click",
    description:
      "Click an element (by index from the latest tree) or window-local coordinates. Returns fresh post-action state.",
    inputSchema: obj({
      app: str("Bundle id, name, or pid:<n>"),
      element_index: { type: "number", description: "Element index from get_app_state tree" },
      x: { type: "number" }, y: { type: "number" },
      mouse_button: { type: "string", enum: ["left", "right", "middle"] },
      modifiers: str('e.g. "CmdOrCtrl+Shift"'),
      click_count: { type: "number" },
      window_id: { type: "number" },
      no_screenshot: { type: "boolean" },
    }, ["app"]),
  },
  {
    name: "set_value",
    description: "Write a value directly into an editable element (preferred over typing).",
    inputSchema: obj({
      app: str("Bundle id, name, or pid:<n>"),
      element_index: { type: "number" },
      value: str("New value; empty string allowed"),
    }, ["app", "element_index", "value"]),
  },
  {
    name: "type_text",
    description: "Type text into the focused field of an app. Verify via returned state.",
    inputSchema: obj({
      app: str("Bundle id, name, or pid:<n>"),
      text: str(),
      restore_window: { type: "boolean" },
    }, ["app", "text"]),
  },
  {
    name: "press_key",
    description: 'Press a single key: Return, Escape, Tab, arrows, etc.',
    inputSchema: obj({
      app: str("Bundle id, name, or pid:<n>"),
      key: str("e.g. Return, Escape, Tab, Down"),
      restore_window: { type: "boolean" },
    }, ["app", "key"]),
  },
  {
    name: "hotkey",
    description: 'One modifier chord plus one key, e.g. "CmdOrCtrl+A".',
    inputSchema: obj({
      app: str("Bundle id, name, or pid:<n>"),
      key: str('e.g. CmdOrCtrl+A, CmdOrCtrl+Shift+P'),
      restore_window: { type: "boolean" },
    }, ["app", "key"]),
  },
  {
    name: "paste_text",
    description: "Paste text into the focused field via clipboard.",
    inputSchema: obj({
      app: str("Bundle id, name, or pid:<n>"),
      text: str(),
      restore_window: { type: "boolean" },
    }, ["app", "text"]),
  },
  {
    name: "scroll",
    description: "Scroll up/down at an element or coordinates.",
    inputSchema: obj({
      app: str("Bundle id, name, or pid:<n>"),
      element_index: { type: "number" },
      x: { type: "number" }, y: { type: "number" },
      direction: { type: "string", enum: ["up", "down"] },
      pages: { type: "number" },
    }, ["app", "direction"]),
  },
  {
    name: "drag",
    description: "Drag between two elements or two window-local coordinate pairs.",
    inputSchema: obj({
      app: str("Bundle id, name, or pid:<n>"),
      from_element_index: { type: "number" },
      to_element_index: { type: "number" },
      from_x: { type: "number" }, from_y: { type: "number" },
      to_x: { type: "number" }, to_y: { type: "number" },
    }, ["app"]),
  },
];

// MCP tool args -> CLI flags. Number-valued flags listed here are passed through as-is.
const NUMBER_FLAGS = new Set([
  "element_index", "window_id", "window_index", "x", "y", "click_count", "pages",
  "from_element_index", "to_element_index", "from_x", "from_y", "to_x", "to_y",
]);
const FLAG_MAP = {
  app: "--app", element_index: "--element-index", window_id: "--window-id",
  window_index: "--window-index", x: "--x", y: "--y", mouse_button: "--mouse-button",
  modifiers: "--modifiers", click_count: "--click-count", value: "--value", text: "--text",
  key: "--key", direction: "--direction", pages: "--pages",
  from_element_index: "--from-element-index", to_element_index: "--to-element-index",
  from_x: "--from-x", from_y: "--from-y", to_x: "--to-x", to_y: "--to-y",
  restore_window: "--restore-window", no_screenshot: "--no-screenshot",
};

function cliArgs(name, a = {}) {
  if (name === "permissions" || name === "capabilities" || name === "list_apps") return [name, "--json"];
  const args = [name.replace(/_/g, "-"), "--json"];
  for (const [key, flag] of Object.entries(FLAG_MAP)) {
    const value = a[key];
    if (value === undefined || value === null || value === "") continue;
    if (typeof value === "boolean") {
      if (value) args.push(flag);
    } else if (NUMBER_FLAGS.has(key)) {
      args.push(flag, String(value));
    } else {
      args.push(flag, String(value));
    }
  }
  return args;
}

function callCli(args) {
  return new Promise((resolve) => {
    if (!existsSync(BIN)) {
      resolve({ exitCode: 127, stdout: "", stderr: `orca-computer binary not found at ${BIN}; run: swift build -c release in ${path.join(pkgRoot, "native", "computer-use-macos")}` });
      return;
    }
    const child = spawn(BIN, args, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", (e) => resolve({ exitCode: 127, stdout: out, stderr: err + String(e) }));
    child.on("close", (code) => resolve({ exitCode: code ?? 1, stdout: out, stderr: err }));
  });
}

async function handleToolCall(name, a) {
  if (process.platform === "win32") {
    const { createRuntime, createWin32Provider } = await import("./win32-provider.mjs");
    if (!globalThis.__orcaWin32) {
      globalThis.__orcaWin32 = createWin32Provider(createRuntime());
    }
    try {
      const result = await globalThis.__orcaWin32(name, a);
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    } catch (error) {
      const payload = { error: { code: error.code ?? "provider_error", message: String(error.message ?? error) } };
      return { content: [{ type: "text", text: JSON.stringify(payload) }], isError: true };
    }
  }
  const { exitCode, stdout, stderr } = await callCli(cliArgs(name, a));
  let text = stdout.trim();
  if (!text) text = stderr.trim() || `orca-computer ${name} exited with code ${exitCode}`;
  // Surface the screenshot inline when one was captured, so multimodal clients can see it.
  try {
    const parsed = JSON.parse(text);
    const shotPath = parsed?.screenshot?.path;
    if (shotPath && existsSync(shotPath)) {
      return { content: [{ type: "text", text }] };
    }
  } catch { /* non-JSON output passes through as text */ }
  return { content: [{ type: "text", text }], isError: exitCode !== 0 };
}

function send(message) {
  process.stdout.write(JSON.stringify(message) + "\n");
}

createInterface({ input: process.stdin }).on("line", async (line) => {
  if (!line.trim()) return;
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (msg.id === undefined || msg.id === null) return; // notification
  let result;
  switch (msg.method) {
    case "initialize":
      result = {
        protocolVersion: msg.params?.protocolVersion ?? "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "orca-computer", version: "1.0.0" },
      };
      break;
    case "tools/list":
      result = { tools: TOOLS };
      break;
    case "tools/call": {
      const { name, arguments: a } = msg.params ?? {};
      result = TOOLS.some((t) => t.name === name)
        ? await handleToolCall(name, a)
        : { content: [{ type: "text", text: `unknown tool: ${name}` }], isError: true };
      break;
    }
    case "ping":
      result = {};
      break;
    default:
      send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: `method not found: ${msg.method}` } });
      return;
  }
  send({ jsonrpc: "2.0", id: msg.id, result });
});
