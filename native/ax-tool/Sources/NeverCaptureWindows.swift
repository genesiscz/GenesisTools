import AppKit
import CoreGraphics
import Foundation
import SnapshotSupport

/// The on-screen windows with their sharing state and owner names. The window list gives these without the Screen
/// Recording grant (only titles need it).
private func sharingWindows() -> (facts: [SharingWindowFacts], names: [Int32: String]) {
    let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly], kCGNullWindowID) as? [[CFString: Any]] ?? []
    var facts: [SharingWindowFacts] = []
    var names: [Int32: String] = [:]
    for window in list {
        guard let pid = window[kCGWindowOwnerPID] as? Int32, let state = window[kCGWindowSharingState] as? Int,
              let raw = window[kCGWindowBounds] as? NSDictionary, let bounds = CGRect(dictionaryRepresentation: raw) else {
            continue
        }
        facts.append(SharingWindowFacts(ownerPID: pid, sharingState: state, bounds: bounds))
        if let name = window[kCGWindowOwnerName] as? String {
            names[pid] = name
        }
    }
    return (facts, names)
}

private func connectedDisplays() -> [DisplayFrame] {
    var count: UInt32 = 0
    CGGetActiveDisplayList(0, nil, &count)
    var ids = [CGDirectDisplayID](repeating: 0, count: Int(count))
    CGGetActiveDisplayList(count, &ids, &count)
    return ids.prefix(Int(count)).map { DisplayFrame(id: $0, bounds: CGDisplayBounds($0)) }
}

/// One app that keeps a never-capture window on a display, as `capture-blockers` and a capture's result name it.
struct NeverCaptureApp {
    let owner: NeverCaptureOwner
    let name: String
    let bundleID: String?
    let path: String?
    /// What `quit-app --launch` takes, so a caller quits the process it saw here.
    let launch: Double?

    var row: [String: Any] {
        var row: [String: Any] = ["pid": Int(owner.pid), "name": name, "windows": owner.windows,
                                  "displays": owner.displays.map { Int($0) }]
        if let bundleID { row["bundleId"] = bundleID }
        if let path { row["path"] = path }
        if let launch { row["processLaunch"] = launch }
        return row
    }
}

/// The apps that keep a never-capture window on `display` (`nil`: on any display) right now (`NeverCaptureRule`).
func neverCaptureApps(on display: CGDirectDisplayID? = nil) -> [NeverCaptureApp] {
    let listed = sharingWindows()
    let owners = NeverCaptureRule.owners(listed.facts, displays: connectedDisplays(), own: getpid())
    return NeverCaptureRule.blocking(owners, display: display).map { owner in
        let app = NSRunningApplication(processIdentifier: owner.pid)
        return NeverCaptureApp(owner: owner, name: app?.localizedName ?? listed.names[owner.pid] ?? "pid \(owner.pid)",
                               bundleID: app?.bundleIdentifier,
                               path: app?.bundleURL?.resolvingSymlinksInPath().standardizedFileURL.path,
                               launch: try? observedLaunch(owner.pid))
    }
}

/// `ax-tool capture-blockers`: the apps that make every capture stream on a display costly.
func cmdCaptureBlockers() {
    jsonOutput(["ok": true, "apps": neverCaptureApps().map(\.row)])
}
