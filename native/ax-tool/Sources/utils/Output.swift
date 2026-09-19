import ApplicationServices
import AppKit
import CoreText
import Foundation
import SnapshotSupport
import Vision

// MARK: - JSON output

func jsonOutput(_ dict: [String: Any]) {
    var opts: JSONSerialization.WritingOptions = [.sortedKeys]
    if CommandLine.arguments.contains("--pretty") { opts.insert(.prettyPrinted) }
    if let data = try? JSONSerialization.data(withJSONObject: dict, options: opts),
       let str = String(data: data, encoding: .utf8) {
        print(str)
    }
}

func errorExit(_ message: String) -> Never {
    jsonOutput(["ok": false, "error": message])
    exit(1)
}

/// WindowServer-truth frontmost pid. NSWorkspace.frontmostApplication caches
/// and lags in a runloop-less CLI — the AX system-wide focused application
/// reflects activation immediately (round-7 regression: scroll aborted right
/// as its own activation landed).
func frontmostPid() -> pid_t? {
    let sys = AXUIElementCreateSystemWide()
    var v: CFTypeRef?
    if AXUIElementCopyAttributeValue(sys, "AXFocusedApplication" as CFString, &v) == .success, let appRef = v {
        let appEl = appRef as! AXUIElement
        var pid: pid_t = 0
        if AXUIElementGetPid(appEl, &pid) == .success { return pid }
    }
    return NSWorkspace.shared.frontmostApplication?.processIdentifier
}

/// Activate an app and poll until it is actually frontmost. One activate()
/// call + fixed sleep races when another activation is still in flight —
/// re-request each poll (up to ~3s), pumping the runloop so NSWorkspace
/// state can update too.
func bringFrontmost(_ pid: pid_t) -> Bool {
    let runningApp = NSWorkspace.shared.runningApplications.first { $0.processIdentifier == pid }
    for _ in 0..<30 {
        if frontmostPid() == pid { return true }
        runningApp?.activate(options: [.activateIgnoringOtherApps])
        CFRunLoopRunInMode(.defaultMode, 0.1, false)
    }
    return frontmostPid() == pid
}
