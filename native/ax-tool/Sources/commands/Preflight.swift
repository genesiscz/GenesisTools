import ApplicationServices
import AppKit
import CoreText
import Foundation
import SnapshotSupport
import Vision

// MARK: - Preflight

let BROWSER_APPLESCRIPT_APPS: Set<String> = ["Brave Browser", "Google Chrome", "Arc", "Microsoft Edge", "Vivaldi", "Safari"]

func runAppleScript(_ source: String) -> String? {
    var error: NSDictionary?
    let script = NSAppleScript(source: source)
    let result = script?.executeAndReturnError(&error)
    guard error == nil else { return nil }
    return result?.stringValue
}

func screensInfo() -> [[String: Any]] {
    let screens = NSScreen.screens
    guard let primary = screens.first else { return [] }
    let primaryHeight = primary.frame.height
    var infos: [[String: Any]] = []
    for (i, s) in screens.enumerated() {
        let f = s.frame
        let scale = s.backingScaleFactor
        // NSScreen frames are AppKit space (origin bottom-left of primary);
        // originCG converts to the CG top-left global point space that click
        // coords and window bounds live in.
        let cgX = f.origin.x
        let cgY = primaryHeight - f.origin.y - f.height
        infos.append([
            "index": i,
            "isPrimary": i == 0,
            "points": ["width": f.width, "height": f.height],
            "scaleFactor": scale,
            "framePixels": ["width": f.width * scale, "height": f.height * scale],
            "originCG": ["x": cgX, "y": cgY],
        ])
    }
    return infos
}

func browserTabInfo(_ appName: String, axWindowTitles: [String]) -> [String: Any]? {
    guard BROWSER_APPLESCRIPT_APPS.contains(appName) else { return nil }
    let urlScript = appName == "Safari"
        ? "tell application \"Safari\" to get URL of front document"
        : "tell application \"\(appName)\" to get URL of active tab of front window"
    let titleScript = appName == "Safari"
        ? "tell application \"Safari\" to get name of front document"
        : "tell application \"\(appName)\" to get title of active tab of front window"
    var tab: [String: Any] = [:]
    if let u = runAppleScript(urlScript) { tab["url"] = u }
    if let t = runAppleScript(titleScript) { tab["title"] = t }
    guard !tab.isEmpty else { return nil }
    // AppleScript addresses the app by NAME — with two same-named instances it
    // may answer for the OTHER process. Cross-check the tab title against this
    // pid's AX window titles so a mismatch is visible instead of silently wrong.
    if let title = tab["title"] as? String, !title.isEmpty {
        let matches = axWindowTitles.contains { $0.localizedCaseInsensitiveContains(title) }
        tab["pidMatch"] = matches
        if !matches {
            tab["warning"] = "tab title not found in this pid's window titles — likely from ANOTHER instance of \(appName) (AppleScript resolves by name, not pid); do not trust for this process"
        }
    }
    return tab
}

func cmdPreflight(appName: String, maxDepth: Int) {
    let pid = resolveApp(appName)
    // --app may be a pid — resolve the display name for browser detection etc.
    let displayName = NSWorkspace.shared.runningApplications
        .first { $0.processIdentifier == pid }?.localizedName ?? appName
    let app = AXUIElementCreateApplication(pid)
    let windows = axWindowsOrExit(app, appName)

    // --wanted screens,frontmost,windows,elements[,elements:<Role>],browser,plan
    // Default: all groups, element groups truncated to 15/role.
    var wantedGroups: Set<String>? = nil
    var fullElementRole: String? = nil
    if let w = argValue("--wanted") {
        var groups: Set<String> = []
        for part in w.split(separator: ",").map({ String($0).trimmingCharacters(in: .whitespaces) }) {
            if part.hasPrefix("elements:") {
                groups.insert("elements")
                fullElementRole = String(part.dropFirst("elements:".count))
            } else {
                groups.insert(part)
            }
        }
        wantedGroups = groups
    }
    func wanted(_ g: String) -> Bool { wantedGroups?.contains(g) ?? true }

    var out: [String: Any] = ["ok": true, "app": appName, "pid": pid]

    if wanted("screens") {
        out["screens"] = screensInfo()
    }

    if wanted("frontmost") {
        let front = NSWorkspace.shared.frontmostApplication
        var f: [String: Any] = [:]
        if let n = front?.localizedName { f["app"] = n }
        if let p = front?.processIdentifier { f["pid"] = p }
        if let b = front?.bundleIdentifier { f["bundleId"] = b }
        out["frontmost"] = f
    }

    if wanted("windows") {
        var windowInfos: [[String: Any]] = []
        var phantomStrips: [[String: Any]] = []
        for (i, w) in windows.enumerated() {
            var info: [String: Any] = ["title": axStringAttribute(w, "AXTitle") ?? "window-\(i)"]
            if let id = axStringAttribute(w, "AXIdentifier") { info["id"] = id }
            if let pos = axPointValue(w, "AXPosition") { info["x"] = pos.x; info["y"] = pos.y }
            if let sz = axSizeValue(w, "AXSize") { info["width"] = sz.width; info["height"] = sz.height }
            let sub = axStringAttribute(w, "AXSubrole")
            if let s = sub { info["subrole"] = s }
            let height = axSizeValue(w, "AXSize")?.height ?? 0
            if sub == "AXUnknown" || sub == "AXHelpTag" || height <= 50 {
                info["transient"] = true
                phantomStrips.append(info)
            } else {
                windowInfos.append(info)
            }
        }
        out["windows"] = windowInfos
        if !phantomStrips.isEmpty { out["phantomStrips"] = phantomStrips }
    }

    if wanted("browser"),
       let tab = browserTabInfo(displayName, axWindowTitles: windows.compactMap { axStringAttribute($0, "AXTitle") }) {
        out["browserTab"] = tab
    }

    var addressable: [[String: String]] = []
    var roleCounts: [String: Int] = [:]
    if wanted("elements") || wanted("plan") {
        for window in windows {
            for info in collectElements(window, maxDepth: maxDepth) {
                let role = info.role ?? "?"
                roleCounts[role, default: 0] += 1
                // Addressable = targetable by id OR desc OR title (browsers
                // have no AXIdentifiers but are fully targetable via desc).
                if info.identifier != nil || info.description != nil || info.title != nil {
                    var entry: [String: String] = ["role": role]
                    if let eid = info.identifier { entry["id"] = eid }
                    if let d = info.description { entry["desc"] = d }
                    if let t = info.title { entry["title"] = t }
                    entry["window"] = axStringAttribute(window, "AXTitle") ?? ""
                    addressable.append(entry)
                }
            }
        }
    }

    if wanted("elements") {
        var grouped: [String: [[String: String]]] = [:]
        for el in addressable {
            grouped[el["role"] ?? "?", default: []].append(el)
        }
        let perRoleCap = 15
        var truncatedRoles: [String: Int] = [:]
        if let fullRole = fullElementRole {
            grouped = grouped.filter { fuzzyRoleMatch($0.key, fullRole, exact: false) }
        } else {
            for (role, els) in grouped where els.count > perRoleCap {
                truncatedRoles[role] = els.count
                grouped[role] = Array(els.prefix(perRoleCap))
            }
        }
        out["grouped"] = grouped
        out["roleCounts"] = roleCounts
        out["addressableCount"] = addressable.count
        out["totalElements"] = roleCounts.values.reduce(0, +)
        if !truncatedRoles.isEmpty {
            out["truncatedRoles"] = truncatedRoles
            out["note"] = "element groups truncated to \(perRoleCap)/role — re-run with --wanted elements:<Role> for the full list of one role"
        }
    }

    if wanted("plan") {
        func targetKey(_ el: [String: String]) -> [String: Any] {
            if let id = el["id"] { return ["id": id] }
            if let d = el["desc"] { return ["q": d] }
            return ["q": el["title"] ?? "?"]
        }
        let uniqueButtons = addressable.filter { $0["role"] == "AXButton" }
            .reduce(into: [[String: String]]()) { result, el in
                let key = el["id"] ?? el["desc"] ?? el["title"] ?? ""
                if !result.contains(where: { ($0["id"] ?? $0["desc"] ?? $0["title"] ?? "") == key }) {
                    result.append(el)
                }
            }
        let fields = addressable.filter { $0["role"] == "AXTextField" }
        let checkboxes = addressable.filter { $0["role"] == "AXCheckBox" }

        var planSteps: [[String: Any]] = [["do": "focus"]]
        planSteps.append(["do": "screenshot", "path": "/tmp/ax-\(appName.lowercased())-before.png"])
        for el in uniqueButtons.prefix(6) {
            var step: [String: Any] = ["do": "press", "_label": el["desc"] ?? el["title"] ?? el["id"] ?? "?"]
            step.merge(targetKey(el)) { _, new in new }
            planSteps.append(step)
        }
        for el in fields.prefix(3) {
            var step: [String: Any] = ["do": "set", "value": "example",
                                        "_label": el["desc"] ?? el["title"] ?? el["id"] ?? "?"]
            step.merge(targetKey(el)) { _, new in new }
            planSteps.append(step)
        }
        for el in checkboxes.prefix(2) {
            var step: [String: Any] = ["do": "press", "_label": el["desc"] ?? el["title"] ?? el["id"] ?? "?"]
            step.merge(targetKey(el)) { _, new in new }
            planSteps.append(step)
        }
        planSteps.append(["do": "screenshot", "path": "/tmp/ax-\(appName.lowercased())-after.png"])

        out["suggestedPlan"] = [
            "app": appName, "restore": true, "delayMs": 300, "steps": planSteps,
            "_contract": "tools control run --help for the full plan schema",
            "_note": "SKELETON — review before executing: press/set steps target real UI and set writes example text into real fields"
        ] as [String: Any]
    }

    out["unitsReminder"] = [
        "clickCoords": "GLOBAL CG points (window bounds space; negatives legal on multi-display)",
        "screenshotCrop": "PIXELS of the captured image (points x scaleFactor, origin top-left)",
        "captureCropRegion": "FRAME pixels of the captured screen (points x scaleFactor)",
    ]

    jsonOutput(out)
}
