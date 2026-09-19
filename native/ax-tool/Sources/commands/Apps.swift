import ApplicationServices
import AppKit
import CoreText
import Foundation
import SnapshotSupport
import Vision

// MARK: - Apps

func cmdApps() {
    let includeAll = args.contains("--all")
    var list: [[String: Any]] = []
    for app in NSWorkspace.shared.runningApplications {
        if !includeAll && app.activationPolicy != .regular { continue }
        var entry: [String: Any] = ["pid": app.processIdentifier]
        if let n = app.localizedName { entry["name"] = n }
        if let b = app.bundleIdentifier { entry["bundleId"] = b }
        if app.isActive { entry["frontmost"] = true }
        if app.isHidden { entry["hidden"] = true }
        list.append(entry)
    }
    list.sort { (($0["name"] as? String) ?? "").lowercased() < (($1["name"] as? String) ?? "").lowercased() }
    jsonOutput(["ok": true, "count": list.count, "apps": list,
                "note": "these names are valid --app values (also matched case-insensitively and by bundleId substring)"])
}
