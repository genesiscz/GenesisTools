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

/// Who macOS actually holds responsible for THIS process, read from the kernel rather than
/// from the environment. `GENESIS_TOOLS_APP_BUNDLE_ID` is inherited by every descendant of a
/// launcher-started session, so a bare `ax-tool` run inside such a session still carries it
/// while its grants follow the terminal; only the responsible pid tells those two apart.
func responsibleProcess() -> ResponsibleProcess {
    let pid = responsibility_get_pid_responsible_for_pid(getpid())
    var buffer = [CChar](repeating: 0, count: Int(PATH_MAX) * 4)
    let length = proc_pidpath(pid, &buffer, UInt32(buffer.count))
    let path = length > 0 ? String(cString: buffer) : ""
    let app = NSRunningApplication(processIdentifier: pid)
    let bundleId = app?.bundleIdentifier
        ?? (path.contains("/GenesisTools.app/") ? genesisAppBundleIdentifier : nil)
    return ResponsibleProcess(pid: pid, bundleId: bundleId, path: path, localizedName: app?.localizedName)
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

/// The refusal for a missing grant, naming the app macOS holds responsible (see
/// `permissionRefusalMessage`). Every AX command and every capture path ends here.
func permissionRefusalExit(_ grant: PermissionGrant) -> Never {
    jsonOutput(permissionRefusal(grant, responsible: responsibleProcess(), pid: getpid()))
    exit(1)
}

func axUntrustedExit() -> Never {
    permissionRefusalExit(.accessibility)
}

/// `CGPreflightScreenCaptureAccess()` never prompts. Without the grant a window capture fails
/// with nothing but a nil image, so every capture path asks first and refuses with the app's name.
func requireScreenRecording() {
    if !CGPreflightScreenCaptureAccess() { permissionRefusalExit(.screenRecording) }
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
