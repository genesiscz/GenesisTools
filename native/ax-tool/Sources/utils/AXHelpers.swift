import ApplicationServices
import AppKit
import CoreText
import Foundation
import SnapshotSupport
import Vision

// MARK: - AX helpers

// Resolves --app: numeric pid > exact name > case-insensitive name > bundleId
// substring. Fails loud (with candidates) when 2+ processes match a tier —
// same-named instances (two Brave profiles) must be targeted by pid, never
// silently picked. Regular-activation-policy apps win over background helpers.
func resolveApp(_ name: String) -> pid_t {
    let pid = resolveAppPid(name)
    enableManualAccessibility(pid)
    return pid
}

/// Chromium and Electron build no AX tree until an assistive client asks for one. Setting this
/// attribute is one way to ask, and it is left on because the tree is torn down again the moment
/// it is cleared and a CLI has no session to scope it to.
///
/// ⚠️ It only actually lands on ELECTRON. Chromium itself implements `AXEnhancedUserInterface` and
/// not this one, so Brave and Chrome report `AXManualAccessibility` unsupported while Cursor
/// reports a real value — confirmed by `tools control audit` reading all 117 running apps on
/// 2026-09-16. Chromium builds its tree on any AX access anyway, so the no-op costs nothing and
/// the call stays for Electron's sake. Do NOT "fix" it by setting `AXEnhancedUserInterface`
/// instead: AppKit apps change layout behaviour under that one and the user would see it.
///
/// 🛑 This WRITES to another application and nothing ever clears it. That is why `resolveAppPid`
/// exists for callers that only need the pid, and why `tools control audit` reports every app
/// carrying the flag.
private func enableManualAccessibility(_ pid: pid_t) {
    _ = AXUIElementSetAttributeValue(AXUIElementCreateApplication(pid), "AXManualAccessibility" as CFString, kCFBooleanTrue)
}

/// Resolve a name or pid WITHOUT touching the target. Use this wherever the pid is only an
/// identifier — a `kCGWindowOwnerPID` filter, a process lookup — because `resolveApp` writes
/// `AXManualAccessibility` into the app and nothing ever clears it again.
///
/// Every other command in this file legitimately keeps `resolveApp`: they read or drive the AX
/// tree, and on Chromium and Electron there IS no tree until that attribute is set. That
/// includes `window`, `screenshot`/`ocr` and `preflight`, each of which calls `axWindows` or
/// `resolveWindow` within a few lines of resolving the pid.
func resolveAppPid(_ name: String) -> pid_t {
    let apps = NSWorkspace.shared.runningApplications
    if let pidNum = Int32(name) {
        if apps.contains(where: { $0.processIdentifier == pidNum }) { return pidNum }
        errorExit("no running process with pid \(name)")
    }
    let tiers: [(NSRunningApplication) -> Bool] = [
        { $0.localizedName == name },
        { $0.localizedName?.lowercased() == name.lowercased() },
        { $0.bundleIdentifier?.lowercased().contains(name.lowercased()) == true },
    ]
    for tier in tiers {
        var matches = apps.filter(tier)
        if matches.count > 1 {
            let regular = matches.filter { $0.activationPolicy == .regular }
            if !regular.isEmpty { matches = regular }
        }
        if matches.count == 1 { return matches[0].processIdentifier }
        if matches.count > 1 {
            jsonOutput(["ok": false,
                "error": "ambiguous: \(matches.count) processes match '\(name)' — target one with --app <pid>",
                "candidates": matches.map { ["name": $0.localizedName ?? "?", "pid": $0.processIdentifier,
                                             "bundleId": $0.bundleIdentifier ?? ""] }])
            exit(1)
        }
    }
    errorExit("app not found: \(name)")
}

func axChildren(_ element: AXUIElement) -> [AXUIElement] {
    var value: CFTypeRef?
    let err = AXUIElementCopyAttributeValue(element, kAXChildrenAttribute as CFString, &value)
    guard err == .success, let children = value as? [AXUIElement] else { return [] }
    return children
}

func axAttribute(_ element: AXUIElement, _ attr: String) -> CFTypeRef? {
    var value: CFTypeRef?
    let err = AXUIElementCopyAttributeValue(element, attr as CFString, &value)
    guard err == .success else { return nil }
    return value
}

func axStringAttribute(_ element: AXUIElement, _ attr: String) -> String? {
    axAttribute(element, attr) as? String
}

func axWindows(_ app: AXUIElement) -> [AXUIElement] {
    var value: CFTypeRef?
    let err = AXUIElementCopyAttributeValue(app, kAXWindowsAttribute as CFString, &value)
    guard err == .success, let windows = value as? [AXUIElement] else { return [] }
    return windows
}
