import ApplicationServices
import AppKit
import CoreText
import Foundation
import SnapshotSupport
import Vision

// MARK: - Extended Commands

func cmdTree(appName: String, maxDepth: Int) {
    let pid = resolveApp(appName)
    let app = AXUIElementCreateApplication(pid)
    let windows = axWindowsOrExit(app, appName)
    let tree = windows.map { buildTree($0, maxDepth: maxDepth) }
    jsonOutput(["ok": true, "app": appName, "pid": pid, "windows": tree])
}

func cmdAttrs(appName: String) {
    let pid = resolveApp(appName)
    let app = AXUIElementCreateApplication(pid)
    let el = resolveElement(app, appName)
    let names = axAttributeNames(el)
    var attrs: [String: Any] = [:]
    for name in names {
        if let val = axAttribute(el, name) {
            attrs[name] = serializeAXValue(val)
        }
    }
    var result: [String: Any] = ["ok": true, "count": names.count, "attributes": attrs]
    result.merge(elementInfo(el)) { _, new in new }
    jsonOutput(result)
}

func cmdActions(appName: String) {
    let pid = resolveApp(appName)
    let app = AXUIElementCreateApplication(pid)
    let el = resolveElement(app, appName)
    let actionList = axActionNames(el)
    var descs: [[String: String]] = []
    for a in actionList {
        var desc: CFString?
        AXUIElementCopyActionDescription(el, a as CFString, &desc)
        var entry: [String: String] = ["action": a]
        if let d = desc as String? { entry["description"] = d }
        descs.append(entry)
    }
    var result: [String: Any] = ["ok": true, "count": actionList.count, "actions": descs]
    result.merge(elementInfo(el)) { _, new in new }
    jsonOutput(result)
}

func cmdPerform(appName: String, action: String) {
    let pid = resolveApp(appName)
    let app = AXUIElementCreateApplication(pid)
    let el = resolveElement(app, appName)
    let available = axActionNames(el)
    if !available.contains(action) {
        errorExit("action '\(action)' not available. Available: \(available.joined(separator: ", "))")
    }
    ActionCursor.element("perform", el, background: frontmostPid() != pid)
    let err = performActionWithTimeout(el, action: action)
    if err != .success {
        errorExit("perform '\(action)' failed: AXError \(err.rawValue)")
    }
    var result: [String: Any] = ["ok": true, "action": "perform", "performed": action]
    result.merge(elementInfo(el)) { _, new in new }
    jsonOutput(result)
}

func cmdFind(appName: String, role: String?, title: String?, value: String?,
             desc: String?, subrole: String?, text: String?, searchAll: Bool = false,
             exact: Bool, maxDepth: Int) {
    let pid = resolveApp(appName)
    if role == nil && title == nil && value == nil && desc == nil && text == nil && subrole == nil {
        errorExit("at least one of --q, --text, --role, --title, --value, --desc, or --subrole required")
    }
    let app = AXUIElementCreateApplication(pid)
    var windows = axWindowsOrExit(app, appName)
    if let ws = argValue("--window") {
        windows = windows.filter {
            (axStringAttribute($0, "AXTitle") ?? "").localizedCaseInsensitiveContains(ws)
        }
        if windows.isEmpty { errorExit("no window matching '\(ws)' in \(appName)") }
    }
    var all: [[String: Any]] = []
    let cap = 200
    for (i, w) in windows.enumerated() {
        if all.count >= cap { break }
        let wt = axStringAttribute(w, "AXTitle") ?? "window-\(i)"
        let hits = findByAttributes(w, role: role, title: title, value: value,
                                     desc: desc, subrole: subrole, text: text,
                                     searchAll: searchAll, exact: exact, maxDepth: maxDepth)
        for el in hits {
            var entry: [String: Any] = ["window": wt]
            if let id = axStringAttribute(el, "AXIdentifier") { entry["id"] = id }
            if let r = axStringAttribute(el, "AXRole") { entry["role"] = r }
            if let t = axStringAttribute(el, "AXTitle") { entry["title"] = t }
            if let d = axStringAttribute(el, "AXDescription") { entry["desc"] = d }
            if let v = axAttribute(el, "AXValue") { entry["value"] = "\(v)" }
            if let s = axStringAttribute(el, "AXSubrole") { entry["subrole"] = s }
            all.append(entry)
            if all.count >= cap { break }
        }
    }
    var result: [String: Any] = ["ok": true, "app": appName, "count": all.count, "matches": all]
    if all.count >= cap { result["truncated"] = true }
    if all.isEmpty && title != nil {
        result["hint"] = "many apps (e.g. Chromium browsers, SwiftUI) expose visible text via AXDescription, not AXTitle — try --desc or --q"
    } else if all.isEmpty && maxDepth <= 15 {
        // 0 matches at the default depth is ambiguous: missing vs nested past
        // the cutoff (browser page content easily sits at depth 20-40).
        result["hint"] = "0 matches at --depth \(maxDepth) — deeply nested UIs (browser page content) can exceed it; retry with --depth 40"
    }
    jsonOutput(result)
}

func resolveWindow(_ app: AXUIElement, _ appName: String) -> AXUIElement {
    let windows = axWindowsOrExit(app, appName)
    if let ws = argValue("--window") {
        let matches = windows.filter {
            (axStringAttribute($0, "AXTitle") ?? "").localizedCaseInsensitiveContains(ws)
        }
        if matches.count == 1 { return matches[0] }
        let titles = windows.map { axStringAttribute($0, "AXTitle") ?? "(untitled)" }
        if matches.isEmpty {
            jsonOutput(["ok": false,
                "error": "no window matching '\(ws)' in \(appName)",
                "candidates": titles])
            exit(1)
        }
        jsonOutput(["ok": false,
            "error": "ambiguous: '\(ws)' matches \(matches.count) windows in \(appName) — use a longer substring",
            "candidates": matches.map { axStringAttribute($0, "AXTitle") ?? "(untitled)" }])
        exit(1)
    }
    return windows.first!
}

func cmdWindow(appName: String) {
    let pid = resolveApp(appName)
    let app = AXUIElementCreateApplication(pid)

    if let action = argValue("--action") {
        let w = resolveWindow(app, appName)
        let title = axStringAttribute(w, "AXTitle") ?? ""
        if ["move", "resize", "minimize", "maximize", "close", "focus"].contains(action) {
            ActionCursor.element("window", w, background: frontmostPid() != pid)
        }
        switch action {
        case "move":
            guard let xStr = argValue("--x"), let yStr = argValue("--y"),
                  let x = Double(xStr), let y = Double(yStr) else { errorExit("--x and --y required for move") }
            var point = CGPoint(x: x, y: y)
            guard let val = AXValueCreate(.cgPoint, &point) else { errorExit("failed to create AXValue") }
            AXUIElementSetAttributeValue(w, kAXPositionAttribute as CFString, val)
            jsonOutput(["ok": true, "action": "move", "window": title, "x": x, "y": y])
        case "resize":
            guard let wStr = argValue("--width"), let hStr = argValue("--height"),
                  let width = Double(wStr), let height = Double(hStr) else { errorExit("--width and --height required") }
            var size = CGSize(width: width, height: height)
            guard let val = AXValueCreate(.cgSize, &size) else { errorExit("failed to create AXValue") }
            AXUIElementSetAttributeValue(w, kAXSizeAttribute as CFString, val)
            jsonOutput(["ok": true, "action": "resize", "window": title, "width": width, "height": height])
        case "minimize":
            AXUIElementSetAttributeValue(w, kAXMinimizedAttribute as CFString, true as CFTypeRef)
            jsonOutput(["ok": true, "action": "minimize", "window": title])
        case "maximize":
            let _ = performActionWithTimeout(w, action: "AXZoomWindow" as String, timeoutMs: 2000)
            jsonOutput(["ok": true, "action": "maximize", "window": title])
        case "close":
            // `--no-raise`: close without pulling the window forward first.
            // Raising to close is a visible disturbance for something the user
            // never asked to see, and AXPress on the close button works fine
            // on a background window.
            if !args.contains("--no-raise") {
                let _ = performActionWithTimeout(w, action: "AXRaise" as String, timeoutMs: 1000)
            }
            for child in axChildren(w) {
                if axStringAttribute(child, "AXSubrole") == "AXCloseButton" {
                    let _ = performActionWithTimeout(child, action: kAXPressAction as String)
                    jsonOutput(["ok": true, "action": "close", "window": title])
                    return
                }
            }
            errorExit("no close button found on window '\(title)'")
        case "focus":
            NSWorkspace.shared.runningApplications.first { $0.processIdentifier == pid }?
                .activate(options: [.activateIgnoringOtherApps])
            let _ = performActionWithTimeout(w, action: kAXRaiseAction as String, timeoutMs: 1000)
            jsonOutput(["ok": true, "action": "focus", "window": title])
        default:
            errorExit("unknown window action: \(action). Use: move, resize, minimize, maximize, close, focus")
        }
        return
    }

    let windows = axWindowsOrExit(app, appName)
    var infos: [[String: Any]] = []
    for (i, w) in windows.enumerated() {
        var info: [String: Any] = ["title": axStringAttribute(w, "AXTitle") ?? "window-\(i)"]
        if let windowID = nativeAXWindowID(w) { info["window_id"] = Int(windowID) }
        if let id = axStringAttribute(w, "AXIdentifier") { info["id"] = id }
        let pos = axPointValue(w, "AXPosition")
        let sz = axSizeValue(w, "AXSize")
        if let pos { info["x"] = pos.x; info["y"] = pos.y }
        if let sz { info["width"] = sz.width; info["height"] = sz.height }
        if pos == nil || sz == nil {
            info["unavailable"] = "the window reported no position or size"
        }
        if let role = axStringAttribute(w, "AXRole") { info["role"] = role }
        if let sub = axStringAttribute(w, "AXSubrole") { info["subrole"] = sub }
        if let val = axAttribute(w, "AXMinimized") as? NSNumber { info["minimized"] = val.boolValue }
        if let val = axAttribute(w, "AXFullScreen") as? NSNumber { info["fullscreen"] = val.boolValue }
        // Transient popups (find bars, tooltips, hover cards) pollute the list
        // and are easily mistaken for real windows.
        // The rule see uses to choose a default window, so both commands call the same popups transient.
        let candidate = WindowCandidate(index: i, windowID: nil, title: "", subrole: axStringAttribute(w, "AXSubrole"),
                                        height: Double(axSizeValue(w, "AXSize")?.height ?? 0), minimized: false)
        if candidate.secondary {
            info["transient"] = true
        }
        // A sheet (an open or save panel, an alert attached to the window) is a child of its
        // window, not a window of its own, so the list above never showed the file panel that
        // "Load unpacked" had opened. Name it on its window: it blocks everything behind it.
        let sheets = axChildren(w).filter { axStringAttribute($0, "AXRole") == "AXSheet" }.map { sheet -> [String: Any] in
            var entry: [String: Any] = ["title": axStringAttribute(sheet, "AXTitle") ?? ""]
            if let sub = axStringAttribute(sheet, "AXSubrole") { entry["subrole"] = sub }
            if let identifier = axStringAttribute(sheet, "AXIdentifier") { entry["id"] = identifier }
            let frame = axFrame(sheet)
            entry["x"] = frame.minX; entry["y"] = frame.minY
            entry["width"] = frame.width; entry["height"] = frame.height
            return entry
        }
        if !sheets.isEmpty { info["sheets"] = sheets }
        infos.append(info)
    }
    jsonOutput(["ok": true, "app": appName, "pid": pid, "count": infos.count, "windows": infos,
                "screenLocked": sessionScreenLocked()])
}
