// Windows adapter: upstream native/computer-use-windows/runtime.ps1 -> orca-computer contract.
// runtime.ps1 -Serve speaks NDJSON ({"ready":true} banner, requestId echo); ops are flat
// {tool, app, element:{index,runtimeId}, ...}. This module maps MCP/CLI calls onto it and
// normalizes responses to the same shape the macOS CLI/stdio path produces.
import { spawn } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const RUNTIME_PS1 =
  process.env.ORCA_RUNTIME_PS1 ||
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "native", "computer-use-windows", "runtime.ps1");

const WINDOWS_TOOLS = new Set([
  "handshake", "list_apps", "list_windows", "get_app_state", "click", "perform_secondary_action",
  "scroll", "drag", "type_text", "press_key", "hotkey", "paste_text", "set_value",
]);

// ---- request mapping (pure) ------------------------------------------------

// MCP/CLI arg names -> flat runtime.ps1 op fields (non-element).
const OP_FIELDS = {
  app: "app", window_id: "windowId", window_index: "windowIndex",
  restore_window: "restoreWindow", no_screenshot: "noScreenshot",
  x: "x", y: "y", mouse_button: "mouse_button", modifiers: "modifiers",
  click_count: "click_count", action: "action", direction: "direction", pages: "pages",
  from_x: "from_x", from_y: "from_y", to_x: "to_x", to_y: "to_y",
  text: "text", key: "key", value: "value",
};

export function mcpToolToRuntimeTool(name) {
  if (name === "capabilities") return "handshake";
  return name; // get_app_state, click, ... already match upstream snake_case names
}

export function buildOp(tool, args = {}, snapshotCache = new Map()) {
  if (!WINDOWS_TOOLS.has(tool)) throw providerError("unsupported_capability", `tool '${tool}' has no Windows implementation`);
  const op = { tool };
  for (const [arg, field] of Object.entries(OP_FIELDS)) {
    const value = args[arg];
    if (value === undefined || value === null || value === "") continue;
    op[field] = value;
  }
  resolveElements(op, args, snapshotCache);
  return op;
}

function resolveElements(op, args, snapshotCache) {
  const cache = snapshotCache.get(String(args.app ?? "").toLowerCase());
  const record = (index) => {
    if (!cache) throw providerError("element_not_found", `element indexes require a get_app_state snapshot for '${args.app}' first`);
    const element = cache.find((e) => e.index === index);
    if (!element) throw providerError("element_not_found", `element ${index} is not in the current cached snapshot for '${args.app}'; run get_app_state again`);
    return { index: element.index, runtimeId: element.runtimeId };
  };
  if (args.element_index !== undefined && args.element_index !== null) {
    if (["click", "set_value", "perform_secondary_action", "scroll"].includes(op.tool)) {
      op.element = record(args.element_index);
    }
  }
  if (args.from_element_index !== undefined && args.from_element_index !== null) op.fromElement = record(args.from_element_index);
  if (args.to_element_index !== undefined && args.to_element_index !== null) op.toElement = record(args.to_element_index);
  delete op.element_index;
  delete op.from_element_index;
  delete op.to_element_index;
}

// ---- response normalization (pure apart from screenshot file writes) -------

export function normalizeResponse(tool, response, writePng = defaultWritePng) {
  if (!response || response.ok !== true) {
    throw mapRuntimeError(response?.error ?? "unknown runtime error");
  }
  if (tool === "capabilities") return response.capabilities ?? {};
  if (response.apps !== undefined) return { apps: response.apps };
  if (response.windows !== undefined) return { app: response.app, windows: response.windows };
  const result = {};
  if (response.action !== undefined) result.action = response.action;
  if (response.snapshot !== undefined) {
    const s = response.snapshot;
    const screenshot = s.screenshotPngBase64
      ? writePng(s.screenshotPngBase64, {
          width: s.screenshotWidth, height: s.screenshotHeight, scale: s.screenshotScale,
        })
      : null;
    result.snapshot = {
      id: s.snapshotId,
      app: s.app,
      window: {
        id: s.windowId, title: s.windowTitle,
        x: Math.round(s.windowBounds?.x ?? 0), y: Math.round(s.windowBounds?.y ?? 0),
        width: Math.round(s.windowBounds?.width ?? 0), height: Math.round(s.windowBounds?.height ?? 0),
      },
      coordinateSpace: s.coordinateSpace,
      treeText: (s.treeLines ?? []).join("\n"),
      elementCount: (s.elements ?? []).length,
      focusedElementId: s.focusedElementId ?? null,
      truncation: s.truncation,
    };
    result.screenshot = screenshot
      ? { path: screenshot.path, bytes: screenshot.bytes, width: screenshot.width, height: screenshot.height, scale: screenshot.scale, format: "png" }
      : null;
    result.screenshotStatus = screenshot
      ? { state: "captured", metadata: { windowId: s.windowId } }
      : s.screenshotError
        ? { state: "failed", code: "screenshot_failed", message: s.screenshotError }
        : { state: "skipped", reason: "no_screenshot_flag" };
  }
  return result;
}

function defaultWritePng(base64, meta) {
  const png = Buffer.from(base64, "base64");
  const file = path.join(os.tmpdir(), `orca-computer-${crypto.randomUUID()}.png`);
  writeFileSync(file, png);
  return { path: file, bytes: png.length, ...meta };
}

const ERROR_CODE_MAP = [
  [/^appNotFound/, "app_not_found"],
  [/^appBlocked/, "app_blocked"],
  [/^windowNotFound/, "window_not_found"],
  [/^window_not_focused/, "window_not_focused"],
  [/^stale element/, "element_not_found"],
  [/^unknown element_index/, "element_not_found"],
  [/^element value is not settable/, "value_not_settable"],
  [/^unsupported tool/, "unsupported_capability"],
];

function mapRuntimeError(message) {
  const code = ERROR_CODE_MAP.find(([re]) => re.test(message))?.[1] ?? "provider_error";
  return providerError(code, message);
}

function providerError(code, message) {
  return Object.assign(new Error(message), { code });
}

// ---- serve-mode runtime process ---------------------------------------------

export function createRuntime({
  command = "powershell.exe",
  runtimePath = RUNTIME_PS1,
  spawnFn = spawn,
} = {}) {
  const child = spawnFn(command, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", runtimePath, "-Serve"], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  const pending = new Map();
  let nextRequestId = 1;
  let ready;
  const isReady = new Promise((resolve, reject) => {
    ready = { resolve, reject };
  });
  child.stderr.on("data", (d) => process.stderr.write(`[orca-runtime] ${d}`));
  child.on("exit", (code) => {
    const error = providerError("provider_error", `runtime.ps1 exited unexpectedly (code ${code})`);
    ready.reject(error);
    for (const p of pending.values()) p.reject(error);
    pending.clear();
  });
  createInterface({ input: child.stdout }).on("line", (line) => {
    if (!line.trim()) return;
    let message;
    try { message = JSON.parse(line); } catch { return; }
    if (message.ready === true) { ready.resolve(); return; }
    const waiter = pending.get(message.requestId);
    if (waiter) {
      pending.delete(message.requestId);
      waiter(message);
    }
  });

  async function request(op) {
    await isReady;
    const requestId = nextRequestId++;
    const response = await new Promise((resolve, reject) => {
      pending.set(requestId, resolve);
      child.stdin.write(JSON.stringify({ requestId, ...op }) + "\n", (err) => err && reject(err));
    });
    return response;
  }

  return { request, kill: () => child.kill() };
}

// ---- high-level tool call ----------------------------------------------------

export function createWin32Provider(runtime) {
  const snapshotCache = new Map(); // app (lowercased) -> elements[] of the last snapshot
  return async function callTool(name, args = {}) {
    if (name === "permissions") {
      // Windows UIA/screen capture needs no TCC-style grants.
      return { accessibility: "not-required", screenshots: "not-required" };
    }
    const tool = mcpToolToRuntimeTool(name);
    const op = buildOp(tool, args, snapshotCache);
    const response = await runtime.request(op);
    const result = normalizeResponse(tool, response);
    if (result.snapshot) {
      // Element addressing on Windows is {index, runtimeId}; keep the freshest tree per app.
      const responseElements = response.snapshot?.elements ?? [];
      if (responseElements.length) snapshotCache.set(String(args.app ?? "").toLowerCase(), responseElements);
    }
    return result;
  };
}

// ---- self test ---------------------------------------------------------------

function selfTest() {
  const cache = new Map([["notepad", [
    { index: 0, runtimeId: [42, 1] },
    { index: 3, runtimeId: [42, 7], name: "Edit" },
  ]]]);
  const assert = (cond, label) => { if (!cond) { console.error("SELF-TEST FAIL:", label); process.exit(1); } };

  const clickOp = buildOp("click", { app: "notepad", element_index: 3 }, cache);
  assert(clickOp.element.index === 3 && clickOp.element.runtimeId[1] === 7, "element record resolved");
  assert(!("element_index" in clickOp), "element_index stripped");

  const coordOp = buildOp("click", { app: "notepad", x: 10, y: 20 }, cache);
  assert(coordOp.x === 10 && coordOp.y === 20 && coordOp.element === undefined, "coordinate click");

  let threw = null;
  try { buildOp("click", { app: "unseen", element_index: 3 }, cache); } catch (e) { threw = e; }
  assert(threw?.code === "element_not_found", "missing snapshot -> element_not_found");

  const dragOp = buildOp("drag", { app: "notepad", from_element_index: 0, to_element_index: 3 }, cache);
  assert(dragOp.fromElement.index === 0 && dragOp.toElement.index === 3, "drag endpoints");

  const normalized = normalizeResponse("get_app_state", {
    ok: true,
    snapshot: {
      snapshotId: "s1", app: { name: "Notepad", bundleId: "notepad", pid: 1 },
      windowTitle: "t", windowId: 9, windowBounds: { x: 1.4, y: 2.6, width: 100.5, height: 50 },
      screenshotPngBase64: null, screenshotError: null,
      coordinateSpace: "window", treeLines: ["0 pane", "3 edit hello"], elements: [{}, {}],
      truncation: { truncated: false },
    },
  });
  assert(normalized.snapshot.window.x === 1 && normalized.snapshot.window.y === 3, "bounds rounding");
  assert(normalized.snapshot.treeText === "0 pane\n3 edit hello", "treeText join");
  assert(normalized.snapshot.elementCount === 2, "elementCount");
  assert(normalized.screenshot === null && normalized.screenshotStatus.state === "skipped", "no screenshot status");

  const captured = normalizeResponse("get_app_state", {
    ok: true,
    snapshot: {
      snapshotId: "s2", app: {}, windowTitle: "", windowId: 1, windowBounds: { x: 0, y: 0, width: 0, height: 0 },
      screenshotPngBase64: Buffer.from("png").toString("base64"), screenshotWidth: 8, screenshotHeight: 8, screenshotScale: 1,
      treeLines: [], elements: [],
    },
    action: { path: "synthetic" },
  }, () => ({ path: "/tmp/x.png", bytes: 3, width: 8, height: 8, scale: 1 }));
  assert(captured.screenshot.path === "/tmp/x.png" && captured.screenshotStatus.state === "captured", "screenshot normalization");
  assert(captured.action.path === "synthetic", "action passthrough");

  let mapped = null;
  try { normalizeResponse("click", { ok: false, error: 'appNotFound("nope")' }); } catch (e) { mapped = e; }
  assert(mapped?.code === "app_not_found", "error code mapping");

  console.log("win32-provider self-test OK");
}

if (process.argv[2] === "--self-test") selfTest();
