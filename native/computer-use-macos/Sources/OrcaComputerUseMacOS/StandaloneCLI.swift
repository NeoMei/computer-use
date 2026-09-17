import AppKit
import Foundation

// CLI layer over the same in-process Provider the upstream app-agent socket exposes.
// Subcommand semantics mirror upstream skill-guides/computer-use.md.
// Screenshots arrive as base64 PNG inside the provider result; --json writes them
// to disk and reports result.screenshot.path instead of the payload.
enum StandaloneCLI {
    private static let commandMethods: [String: String] = [
        "capabilities": "handshake",
        "list-apps": "listApps",
        "list-windows": "listWindows",
        "get-app-state": "getAppState",
        "click": "click",
        "perform-secondary-action": "performSecondaryAction",
        "set-value": "setValue",
        "type-text": "typeText",
        "press-key": "pressKey",
        "hotkey": "hotkey",
        "paste-text": "pasteText",
        "scroll": "scroll",
        "drag": "drag",
    ]

    private static let booleanFlags: Set<String> = [
        "--json", "--restore-window", "--no-screenshot", "--value-stdin", "--text-stdin", "--help",
    ]

    // Maps CLI flags to provider param names; key "" is CLI-local.
    private static let valueFlags: [String: (key: String, number: Bool)] = [
        "--app": ("app", false),
        "--element-index": ("elementIndex", true),
        "--window-id": ("windowId", true),
        "--window-index": ("windowIndex", true),
        "--x": ("x", true),
        "--y": ("y", true),
        "--mouse-button": ("mouseButton", false),
        "--modifiers": ("modifiers", false),
        "--click-count": ("clickCount", true),
        "--action": ("action", false),
        "--value": ("value", false),
        "--text": ("text", false),
        "--key": ("key", false),
        "--direction": ("direction", false),
        "--pages": ("pages", true),
        "--from-element-index": ("fromElementIndex", true),
        "--to-element-index": ("toElementIndex", true),
        "--from-x": ("fromX", true),
        "--from-y": ("fromY", true),
        "--to-x": ("toX", true),
        "--to-y": ("toY", true),
        "--screenshot-out": ("", false),
    ]

    static func isCommand(_ token: String?) -> Bool {
        guard let token else { return false }
        return commandMethods[token] != nil || token == "permissions" || token == "help"
    }

    static func run(_ arguments: [String]) -> Never {
        guard let command = arguments.first else { fail(usage(), exitCode: 2) }
        if command == "help" || booleans(in: arguments).contains("--help") {
            print(usage())
            exit(0)
        }
        if command == "permissions" {
            runPermissions(Array(arguments.dropFirst()), json: booleans(in: arguments).contains("--json"))
        }
        guard let method = commandMethods[command] else { fail("unknown command '\(command)'", exitCode: 2) }

        var flags: [String: String] = [:]
        var booleans: Set<String> = []
        var index = 1
        while index < arguments.count {
            let token = arguments[index]
            guard token.hasPrefix("--") else { fail("unexpected argument '\(token)'", exitCode: 2) }
            if booleanFlags.contains(token) {
                booleans.insert(token)
                index += 1
                continue
            }
            guard valueFlags[token] != nil else { fail("unknown flag '\(token)'", exitCode: 2) }
            let valueIndex = index + 1
            guard valueIndex < arguments.count else { fail("missing value for \(token)", exitCode: 2) }
            flags[token] = arguments[valueIndex]
            index = valueIndex + 1
        }

        var params: [String: JSONValue] = [:]
        for (token, value) in flags {
            guard let spec = valueFlags[token], !spec.key.isEmpty else { continue }
            if spec.number {
                guard let number = Double(value) else {
                    fail("invalid number for \(token): '\(value)'", exitCode: 2)
                }
                params[spec.key] = .number(number)
            } else {
                params[spec.key] = .string(value)
            }
        }
        if booleans.contains("--restore-window") { params["restoreWindow"] = .bool(true) }
        if booleans.contains("--no-screenshot") { params["noScreenshot"] = .bool(true) }
        if booleans.contains("--value-stdin") { params["value"] = .string(readStdin()) }
        if booleans.contains("--text-stdin") { params["text"] = .string(readStdin()) }

        do {
            let result = try Provider().handle(method: method, params: params)
            if booleans.contains("--json") {
                let payload = withScreenshotOnDisk(result, outPath: flags["--screenshot-out"])
                guard let data = try? JSONSerialization.data(withJSONObject: payload, options: [.withoutEscapingSlashes, .sortedKeys]),
                      let text = String(data: data, encoding: .utf8)
                else {
                    fail("failed to serialize result", exitCode: 1)
                }
                print(text)
            } else {
                printSummary(command, result)
            }
            exit(0)
        } catch let error as ProviderError {
            fail("\(error.code): \(error.message)", exitCode: 1, json: booleans.contains("--json"), code: error.code)
        } catch {
            fail("accessibility_error: \(error)", exitCode: 1, json: booleans.contains("--json"))
        }
    }

    private static func booleans(in arguments: [String]) -> Set<String> {
        Set(arguments.filter(booleanFlags.contains))
    }

    private static func runPermissions(_ arguments: [String], json: Bool) -> Never {
        if arguments.first == "--open" {
            let target = arguments.dropFirst().first
            let url: String
            switch target {
            case "accessibility":
                url = "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility"
            case "screenshots":
                url = "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture"
            default:
                fail("usage: computer-use permissions --open accessibility|screenshots", exitCode: 2)
            }
            NSWorkspace.shared.open(URL(string: url)!)
            exit(0)
        }
        let snapshot = permissionStatusSnapshotSettled()
        let text = #"{"accessibility":"\#(snapshot.accessibilityGranted ? "granted" : "not-granted")","screenshots":"\#(snapshot.screenshotsGranted ? "granted" : "not-granted")"}"#
        print(text)
        exit(0)
    }

    private static func withScreenshotOnDisk(_ result: Any, outPath: String?) -> Any {
        guard var dict = result as? [String: Any],
              var screenshot = dict["screenshot"] as? [String: Any],
              let base64 = screenshot["data"] as? String,
              let png = Data(base64Encoded: base64)
        else {
            return result
        }
        let path = outPath ?? FileManager.default.temporaryDirectory
            .appendingPathComponent("computer-use-\(UUID().uuidString).png").path
        do {
            try png.write(to: URL(fileURLWithPath: path))
        } catch {
            return result
        }
        screenshot.removeValue(forKey: "data")
        screenshot["path"] = path
        screenshot["bytes"] = png.count
        dict["screenshot"] = screenshot
        return dict
    }

    private static func printSummary(_ command: String, _ result: Any) {
        guard let dict = result as? [String: Any] else {
            print(result)
            return
        }
        if let apps = dict["apps"] as? [[String: Any]] {
            for app in apps {
                print("\(app["pid"] ?? "-")\t\(app["bundleId"] ?? NSNull())\t\(app["name"] ?? "-")")
            }
            return
        }
        if let windows = dict["windows"] as? [[String: Any]] {
            for window in windows {
                print("#\(window["index"] ?? "-") id=\(window["id"] ?? "-") \(window["title"] ?? "") (\(window["width"] ?? "-")x\(window["height"] ?? "-"))")
            }
            return
        }
        if let snapshot = dict["snapshot"] as? [String: Any] {
            if let window = snapshot["window"] as? [String: Any] {
                print("window: \(window["title"] ?? "") [id=\(window["id"] ?? "-")]")
            }
            if let tree = snapshot["treeText"] as? String, !tree.isEmpty {
                print(tree)
            }
            print("elements: \(snapshot["elementCount"] ?? 0)")
        }
        if let action = dict["action"] as? [String: Any] {
            let verification = action["verification"] as? [String: Any]
            print("action: path=\(action["path"] ?? "-") name=\(action["actionName"] ?? "-") verification=\(verification?["state"] ?? "n/a")")
        }
        if let status = dict["screenshotStatus"] as? [String: Any] {
            var line = "screenshot: \(status["state"] ?? "-")"
            if let message = status["message"] as? String {
                line += " (\(message))"
            }
            print(line)
        }
        if command == "capabilities" {
            if let data = try? JSONSerialization.data(withJSONObject: dict, options: [.prettyPrinted, .sortedKeys]),
               let text = String(data: data, encoding: .utf8) {
                print(text)
            }
        }
    }

    private static func readStdin() -> String {
        let data = FileHandle.standardInput.readDataToEndOfFile()
        return String(data: data, encoding: .utf8) ?? ""
    }

    private static func fail(_ message: String, exitCode: Int32, json: Bool = false, code: String = "invalid_argument") -> Never {
        if json {
            let payload: [String: Any] = ["error": ["code": code, "message": message]]
            if let data = try? JSONSerialization.data(withJSONObject: payload, options: [.sortedKeys]),
               let text = String(data: data, encoding: .utf8) {
                print(text)
            }
        } else {
            FileHandle.standardError.write(Data("computer-use: \(message)\n".utf8))
        }
        exit(exitCode)
    }

    private static func usage() -> String {
        """
        computer-use — standalone macOS computer-use CLI (no desktop app required)

        usage: computer-use <command> [flags]

        commands:
          permissions [--open accessibility|screenshots]   check TCC permission state
          capabilities                                      provider capability map
          list-apps                                         running GUI apps
          list-windows --app <app>                          windows of one app
          get-app-state --app <app> [--window-id <id>] [--window-index <n>]
                        [--restore-window] [--no-screenshot]
          click --app <app> (--element-index <n> | --x <x> --y <y>)
                [--mouse-button left|right|middle] [--modifiers CmdOrCtrl+Shift]
                [--click-count <n>]
          perform-secondary-action --app <app> --element-index <n> --action <name>
          set-value --app <app> --element-index <n> --value "text" [--value-stdin]
          type-text --app <app> --text "text" [--text-stdin]
          press-key --app <app> --key Return
          hotkey --app <app> --key CmdOrCtrl+A
          paste-text --app <app> --text "text"
          scroll --app <app> (--element-index <n> | --x <x> --y <y>) --direction up|down [--pages <n>]
          drag --app <app> (--from-element-index <n> --to-element-index <n>
                | --from-x <x> --from-y <y> --to-x <x> --to-y <y>)

        global flags: --json (machine output; screenshots are written to disk and
        reported as result.screenshot.path), --screenshot-out <path>, --help

        app selector: bundle id (com.apple.finder), name (Finder), or pid:<n>
        element indexes come from the latest get-app-state / action snapshot tree
        """
    }
}
