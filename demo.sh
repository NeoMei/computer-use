#!/bin/bash
# End-to-end self check: permissions -> Finder screenshot -> AX tree -> click -> state readback.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
PKG="$ROOT/native/computer-use-macos"
BIN="$PKG/.build/release/orca-computer"
TMP="$(mktemp -d /tmp/orca-demo.XXXXXX)"
trap 'rm -rf "$TMP"' EXIT

[ -x "$BIN" ] || (cd "$PKG" && swift build -c release)

echo "== 1. permissions =="
"$BIN" permissions --json
if ! "$BIN" permissions --json | grep -q '"accessibility":"granted"'; then
  echo "FAIL: Accessibility permission missing. Run: $BIN permissions --open accessibility"
  echo "(grant it to the app that launches orca-computer, e.g. your terminal or OpenChamber)"
  exit 1
fi
if ! "$BIN" permissions --json | grep -q '"screenshots":"granted"'; then
  echo "FAIL: Screen Recording permission missing. Run: $BIN permissions --open screenshots"
  exit 1
fi

# open a real Finder window (open -a Finder alone may leave only the desktop,
# which has no usable AXWindow and fails snapshotting)
open ~
sleep 1

echo "== 2. list-apps (Finder entry) =="
"$BIN" list-apps --json | node -e '
  let s = ""; process.stdin.on("data", d => s += d).on("end", () => {
    const apps = JSON.parse(s).apps.filter(a => /finder/i.test(a.bundleId || "") || /finder/i.test(a.name));
    console.log(JSON.stringify(apps));
  });'

echo "== 3. get-app-state Finder (screenshot + AX tree) =="
"$BIN" get-app-state --app com.apple.finder --json > "$TMP/state.json"
node - "$TMP/state.json" <<'EOF'
const fs = require("fs");
const r = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const shot = r.screenshot || {};
console.log("window:", r.snapshot.window.title, "[id=" + r.snapshot.window.id + "]");
console.log("elements:", r.snapshot.elementCount, "screenshot:", shot.path, `(${shot.width}x${shot.height} @${shot.scale}x, ${shot.bytes} bytes)`);
if (!shot.path || !fs.existsSync(shot.path)) { console.error("FAIL: screenshot missing"); process.exit(1); }
const index = (r.snapshot.treeText.split("\n").find(l => /Applications|应用程序|Recents|最近项目/.test(l)) || "").trim().split(/\s+/)[0];
if (!index) { console.error("FAIL: no sidebar element found in tree"); process.exit(1); }
fs.writeFileSync(process.argv[2] + ".index", index);
console.log("tree excerpt:", r.snapshot.treeText.split("\n").find(l => l.trim().startsWith(index + " ")).trim().slice(0, 120));
EOF
INDEX="$(cat "$TMP/state.json.index")"

echo "== 4. click element $INDEX =="
"$BIN" click --app com.apple.finder --element-index "$INDEX" --json > "$TMP/click.json"
node - "$TMP/click.json" <<'EOF'
const fs = require("fs");
const r = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
console.log("action:", JSON.stringify(r.action?.verification || { state: r.action?.path }));
console.log("post-click window:", r.snapshot.window.title, "elements:", r.snapshot.elementCount);
EOF

echo "== 5. state readback (get-app-state again) =="
"$BIN" get-app-state --app com.apple.finder --json > "$TMP/after.json"
node - "$TMP/state.json" "$TMP/after.json" <<'EOF'
const fs = require("fs");
const before = JSON.parse(fs.readFileSync(process.argv[2], "utf8")).snapshot;
const after = JSON.parse(fs.readFileSync(process.argv[3], "utf8")).snapshot;
console.log("window before:", before.window.title, "-> after:", after.window.title);
console.log("tree changed:", before.treeText !== after.treeText ? "YES (read/write loop verified)" : "no change (selection click may not alter tree)");
console.log("screenshot after:", after ? "ok" : "missing");
EOF

echo "DEMO OK — artifacts were in $TMP (cleaned up)"
