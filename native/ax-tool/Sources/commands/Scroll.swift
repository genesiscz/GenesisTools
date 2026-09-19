import ApplicationServices
import AppKit
import CoreText
import Foundation
import SnapshotSupport
import Vision

// MARK: - Scroll

func cmdScroll(appName: String) {
    let pid = resolveApp(appName)
    let app = AXUIElementCreateApplication(pid)
    let direction = argValue("--direction")
    let amount = Int(argValue("--amount") ?? "3") ?? 3

    let hasTarget = argValue("--id") != nil || argValue("--q") != nil || argValue("--role") != nil ||
                    argValue("--title") != nil || argValue("--desc") != nil || argValue("--subrole") != nil
    var point: CGPoint? = nil
    var el: AXUIElement? = nil
    if let coordStr = argValue("--coords") {
        let parts = coordStr.split(separator: ",").compactMap { Double($0.trimmingCharacters(in: .whitespaces)) }
        guard parts.count == 2 else { errorExit("--coords format: x,y") }
        point = CGPoint(x: parts[0], y: parts[1])
    } else if hasTarget {
        el = resolveElement(app, appName)
        if let pos = axPointValue(el!, "AXPosition"), let size = axSizeValue(el!, "AXSize") {
            point = CGPoint(x: pos.x + size.width / 2, y: pos.y + size.height / 2)
        }
    }

    // No --direction: scroll the target element INTO VIEW (AXScrollToVisible).
    if direction == nil {
        guard let el = el else {
            errorExit("scroll without --direction needs a target element (performs AXScrollToVisible); add --direction up/down/left/right for wheel scrolling")
        }
        if axActionNames(el).contains("AXScrollToVisible") {
            ActionCursor.element("scroll", el, background: frontmostPid() != pid)
            let err = performActionWithTimeout(el, action: "AXScrollToVisible", timeoutMs: 3000)
            if err != .success { errorExit("AXScrollToVisible failed: AXError \(err.rawValue)") }
            var result: [String: Any] = ["ok": true, "action": "scroll", "method": "AXScrollToVisible"]
            result.merge(elementInfo(el)) { _, new in new }
            jsonOutput(result)
            return
        }
        errorExit("element does not support AXScrollToVisible — use --direction with wheel scrolling instead")
    }

    var dy: Int32 = 0
    var dx: Int32 = 0
    switch direction! {
    case "up": dy = Int32(amount)
    case "down": dy = Int32(-amount)
    case "left": dx = Int32(amount)
    case "right": dx = Int32(-amount)
    default: errorExit("--direction must be up, down, left, or right")
    }

    // No target/coords: aim at the app's main window center. A nil location
    // posts at (0,0) — the menu bar — and scrolls nothing.
    if point == nil {
        for w in axWindows(app) {
            guard let pos = axPointValue(w, "AXPosition"), let size = axSizeValue(w, "AXSize"),
                  size.height > 50 else { continue }
            point = CGPoint(x: pos.x + size.width / 2, y: pos.y + size.height / 2)
            break
        }
    }

    // Synthetic wheel events are DROPPED for background apps (verified against
    // Chromium: identical event scrolls when frontmost, no-ops when not).
    // Real mice scroll background windows; CGEvent posts do not.
    if !bringFrontmost(pid) {
        errorExit("could not bring \(appName) frontmost — synthetic wheel events are dropped for background apps, refusing to scroll")
    }
    Thread.sleep(forTimeInterval: 0.08)

    guard let ev = CGEvent(scrollWheelEvent2Source: nil, units: .line, wheelCount: 2,
                           wheel1: dy, wheel2: dx, wheel3: 0) else {
        errorExit("failed to create scroll event")
    }
    if let p = point { ev.location = p }
    ActionCursor.emit("scroll", point: point, target: hasTarget ? "ax" : "pixel")
    ev.postRouted()
    var result: [String: Any] = ["ok": true, "action": "scroll", "method": "wheel",
                                  "direction": direction!, "amount": amount]
    if let p = point { result["x"] = p.x; result["y"] = p.y }
    if let el = el { result.merge(elementInfo(el)) { _, new in new } }
    jsonOutput(result)
}
