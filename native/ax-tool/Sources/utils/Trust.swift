import ApplicationServices
import AppKit
import CoreText
import Foundation
import SnapshotSupport
import Vision

// MARK: - Trust

/// Private libSystem API, the same one the launcher uses on the write side: the pid macOS
/// consults for every TCC decision about `pid`.
@_silgen_name("responsibility_get_pid_responsible_for_pid")
func responsibility_get_pid_responsible_for_pid(_ pid: pid_t) -> pid_t

let genesisAppBundleIdentifier = "com.genesiscz.genesistools"

/// Who macOS actually holds responsible for THIS process, read from the kernel rather than
/// from the environment. `GENESIS_TOOLS_APP_BUNDLE_ID` is inherited by every descendant of a
/// launcher-started session, so a bare `ax-tool` run inside such a session still carries it
/// while its grants follow the terminal; only the responsible pid tells those two apart.
func responsibleProcess() -> (pid: pid_t, bundleId: String?, path: String) {
    let pid = responsibility_get_pid_responsible_for_pid(getpid())
    var buffer = [CChar](repeating: 0, count: Int(PATH_MAX) * 4)
    let length = proc_pidpath(pid, &buffer, UInt32(buffer.count))
    let path = length > 0 ? String(cString: buffer) : ""
    let bundleId = NSRunningApplication(processIdentifier: pid)?.bundleIdentifier
        ?? (path.contains("/GenesisTools.app/") ? genesisAppBundleIdentifier : nil)
    return (pid, bundleId, path)
}

/// The GenesisTools.app bundle id when the launcher is this process's responsible process.
func genesisAppBundleId() -> String? {
    responsibleProcess().bundleId == genesisAppBundleIdentifier ? genesisAppBundleIdentifier : nil
}

func axErrorName(_ err: AXError) -> String {
    switch err {
    case .success: return "success"
    case .failure: return "kAXErrorFailure"
    case .illegalArgument: return "kAXErrorIllegalArgument"
    case .invalidUIElement: return "kAXErrorInvalidUIElement"
    case .invalidUIElementObserver: return "kAXErrorInvalidUIElementObserver"
    case .cannotComplete: return "kAXErrorCannotComplete"
    case .attributeUnsupported: return "kAXErrorAttributeUnsupported"
    case .actionUnsupported: return "kAXErrorActionUnsupported"
    case .notificationUnsupported: return "kAXErrorNotificationUnsupported"
    case .notImplemented: return "kAXErrorNotImplemented"
    case .notificationAlreadyRegistered: return "kAXErrorNotificationAlreadyRegistered"
    case .notificationNotRegistered: return "kAXErrorNotificationNotRegistered"
    case .apiDisabled: return "kAXErrorAPIDisabled"
    case .noValue: return "kAXErrorNoValue"
    case .parameterizedAttributeUnsupported: return "kAXErrorParameterizedAttributeUnsupported"
    case .notEnoughPrecision: return "kAXErrorNotEnoughPrecision"
    @unknown default: return "AXError(\(err.rawValue))"
    }
}

/// The one message every AX command prints when the grant is missing. It is a claim about the
/// CALLER, never about the target app: an untrusted client gets an empty window list from every
/// app, and reporting that as "no windows for X" sent a session chasing a window bug that did
/// not exist (handoff h_xt5ixzf9).
func axUntrustedMessage(responsible: (pid: pid_t, bundleId: String?, path: String)) -> String {
    let route: String
    if let bundle = responsible.bundleId, bundle == genesisAppBundleIdentifier {
        route = "This run went through GenesisTools.app (\(bundle)), which is the identity to grant."
    } else {
        route = "macOS currently attributes this run to responsible pid \(responsible.pid) (\(responsible.bundleId ?? responsible.path)); `tools control` normally routes ax-tool through GenesisTools.app."
    }
    return "Accessibility is not granted to the process macOS holds responsible for ax-tool. \(route) Grant it in System Settings > Privacy & Security > Accessibility (`tools macos permissions open --pane accessibility`), then re-run. `tools control doctor` shows every grant tools control needs."
}

func axUntrustedExit() -> Never {
    let responsible = responsibleProcess()
    jsonOutput(["ok": false, "error": axUntrustedMessage(responsible: responsible), "reason": "accessibility-not-granted",
                "refusal": "permission", "pid": getpid(),
                "responsible": responsible.bundleId ?? "unknown",
                "responsiblePid": responsible.pid, "responsibleBundleId": responsible.bundleId ?? "",
                "responsiblePath": responsible.path,
                "viaGenesisApp": responsible.bundleId == genesisAppBundleIdentifier])
    exit(1)
}

/// `AXIsProcessTrusted()` never prompts and never writes a TCC row; the prompting variant is
/// `AXIsProcessTrustedWithOptions`, which nothing here calls.
func requireAxTrust() {
    if !AXIsProcessTrusted() { axUntrustedExit() }
}

/// The window list, or a loud exit that says WHICH of three different things happened: the
/// grant is missing, the app did not answer the AX query, or the query succeeded and the app
/// really has no windows. Only the last one may say "no windows".
func axWindowsOrExit(_ app: AXUIElement, _ appName: String) -> [AXUIElement] {
    var value: CFTypeRef?
    let err = AXUIElementCopyAttributeValue(app, kAXWindowsAttribute as CFString, &value)
    if err == .success, let windows = value as? [AXUIElement], !windows.isEmpty { return windows }
    if !AXIsProcessTrusted() { axUntrustedExit() }
    if err != .success && err != .noValue {
        errorExit("accessibility query failed for \(appName): \(axErrorName(err)); the app has no accessibility server or is not answering, which is not the same as having no windows")
    }
    errorExit("no windows for \(appName)")
}
