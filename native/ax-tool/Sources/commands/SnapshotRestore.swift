import ApplicationServices
import AppKit
import CoreText
import Foundation
import SnapshotSupport
import Vision

// MARK: - Snapshot/Restore

func cmdSnapshot() {
    let mousePos = CGEvent(source: nil)!.location
    let frontApp = NSWorkspace.shared.frontmostApplication
    let appName = frontApp?.localizedName ?? ""
    let pid = frontApp?.processIdentifier ?? 0

    var result: [String: Any] = [
        "ok": true, "action": "snapshot",
        "mouse": ["x": mousePos.x, "y": mousePos.y],
        "app": appName, "pid": pid
    ]

    if pid != 0 {
        let app = AXUIElementCreateApplication(pid)
        let wins = axWindows(app)
        if let w = wins.first {
            if let t = axStringAttribute(w, "AXTitle") { result["windowTitle"] = t }
            if let id = axStringAttribute(w, "AXIdentifier") { result["windowId"] = id }
        }
    }
    jsonOutput(result)
}

func cmdRestore(snapshotJson: String) {
    guard let data = snapshotJson.data(using: .utf8),
          let snap = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
        errorExit("invalid snapshot JSON")
    }

    if let mouse = snap["mouse"] as? [String: Double],
       let mx = mouse["x"], let my = mouse["y"] {
        let point = CGPoint(x: mx, y: my)
        CGWarpMouseCursorPosition(point)
    }

    if let appName = snap["app"] as? String, !appName.isEmpty {
        if let runningApp = NSWorkspace.shared.runningApplications.first(where: {
            $0.localizedName == appName
        }) {
            runningApp.activate(options: [.activateIgnoringOtherApps])
            Thread.sleep(forTimeInterval: 0.1)

            let app = AXUIElementCreateApplication(runningApp.processIdentifier)
            if let wTitle = snap["windowTitle"] as? String {
                for w in axWindows(app) {
                    if axStringAttribute(w, "AXTitle") == wTitle {
                        let _ = performActionWithTimeout(w, action: kAXRaiseAction as String, timeoutMs: 1000)
                        break
                    }
                }
            }
        }
    }

    jsonOutput(["ok": true, "action": "restore",
                "mouse": snap["mouse"] ?? [:], "app": snap["app"] ?? ""])
}
