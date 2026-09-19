import ApplicationServices
import AppKit
import CoreText
import Foundation
import SnapshotSupport
import Vision

// MARK: - Permissions and audit (read-only)

/// Live grant state for THIS process: what a `tools control` call actually holds, as opposed
/// to what TCC.db records for some bundle. `CGPreflightScreenCaptureAccess` is the
/// non-prompting probe; `CGRequestScreenCaptureAccess` is the one that shows the dialog.
func cmdPermissions() {
    let responsible = responsibleProcess()
    jsonOutput(["ok": true, "pid": getpid(),
                "accessibility": AXIsProcessTrusted(),
                "screenRecording": CGPreflightScreenCaptureAccess(),
                "responsible": responsible.bundleId ?? "unknown",
                "responsiblePid": responsible.pid,
                "responsibleBundleId": responsible.bundleId ?? "",
                "responsiblePath": responsible.path,
                "viaGenesisApp": responsible.bundleId == genesisAppBundleIdentifier])
}

/// One app-level boolean attribute, read without touching the target. `AXManualAccessibility`
/// is what `resolveApp` writes into every target (and nothing clears); `AXEnhancedUserInterface`
/// is what VoiceOver writes and this tool deliberately never does.
private func readAppFlag(_ app: AXUIElement, _ attr: String) -> String {
    var value: CFTypeRef?
    let err = AXUIElementCopyAttributeValue(app, attr as CFString, &value)
    switch err {
    case .success:
        if let b = value as? NSNumber { return b.boolValue ? "on" : "off" }
        return "unreadable"
    case .attributeUnsupported, .noValue:
        return "unsupported"
    default:
        return axErrorName(err)
    }
}

/// Which running apps carry the accessibility flags an assistive client can set. Iterates
/// NSWorkspace directly and never calls `resolveApp`, so auditing cannot flip the flag it audits.
/// Default scope is apps with a UI (regular + accessory); `--all` adds background-only processes.
func cmdAudit() {
    let includeAll = args.contains("--all")
    let trusted = AXIsProcessTrusted()
    let me = getpid()
    var list: [[String: Any]] = []
    for app in NSWorkspace.shared.runningApplications {
        if app.processIdentifier == me { continue }
        if !includeAll && app.activationPolicy == .prohibited { continue }
        var entry: [String: Any] = ["pid": app.processIdentifier]
        if let n = app.localizedName { entry["name"] = n }
        if let b = app.bundleIdentifier { entry["bundleId"] = b }
        entry["policy"] = app.activationPolicy == .regular ? "regular"
            : app.activationPolicy == .accessory ? "accessory" : "prohibited"
        if trusted {
            let el = AXUIElementCreateApplication(app.processIdentifier)
            // A hung app must not hang the audit: half a second per attribute, no retry.
            AXUIElementSetMessagingTimeout(el, 0.5)
            entry["manualAccessibility"] = readAppFlag(el, "AXManualAccessibility")
            entry["enhancedUserInterface"] = readAppFlag(el, "AXEnhancedUserInterface")
        } else {
            entry["manualAccessibility"] = "unknown (not trusted)"
            entry["enhancedUserInterface"] = "unknown (not trusted)"
        }
        list.append(entry)
    }
    list.sort { (($0["name"] as? String) ?? "").lowercased() < (($1["name"] as? String) ?? "").lowercased() }
    jsonOutput(["ok": true, "trusted": trusted, "count": list.count, "apps": list,
                "responsible": genesisAppBundleId() ?? "not GenesisTools.app",
                "note": "manualAccessibility on = an assistive client asked the app to build its AX tree; tools control sets it on every --app resolution and never clears it. enhancedUserInterface is never set by tools control."])
}
