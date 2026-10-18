import AppKit
import os

/// The part of the app's host the base library needs: its log, its perf file, the fresh-process permission probe,
/// and whether it opens a terminal. GenesisKit's `GenesisKitHost` refines it with the markdown, transcript and git
/// hooks, so an app that implements `GenesisKitHost` (Genesis.app) gets both. An app that links only GenesisKitBase
/// (GenesisTools' permissions host) implements this one. Every member has a default.
public protocol GenesisKitBaseHost: AnyObject {
    /// One diagnostic line (GenesisTools: `HubPerf.log` into app-perf.log).
    func log(_ line: String)
    /// Whether "Open in a new cmux workspace" is offered for a path.
    var opensTerminal: Bool { get }
    /// Opens a shell in `folder`. Called on the main thread; the host moves slow work off it.
    func openTerminal(folder: String)
    /// Where PerfLog, HangWatch and MainStackSampler write, and whether they are on. Read once.
    var perf: PerfConfiguration { get }
    /// What a NEW process of this app reads for `kind`. macOS caches Input Monitoring and Screen Recording per
    /// process, so a grant given while this one runs shows only in a new one. nil when the app has no probe.
    func freshPermissionStatus(_ kind: PermissionKind) async -> PermissionStatus?
}

public extension GenesisKitBaseHost {
    func log(_ line: String) {}
    var opensTerminal: Bool { false }
    func openTerminal(folder: String) {}
    var perf: PerfConfiguration { .fallback }
    func freshPermissionStatus(_ kind: PermissionKind) async -> PermissionStatus? { nil }
}

/// The app's host, found once by the class name `GenesisKitHostAdapter` (declare it
/// `@objc(GenesisKitHostAdapter) final class …: NSObject, GenesisKitHost`), so no launch code has to call anything.
/// `GenesisKit.host` is the same object as a `GenesisKitHost`.
public enum KitHost {
    nonisolated(unsafe) private static var installed: GenesisKitBaseHost?
    nonisolated(unsafe) private static var looked = false
    private static let lock = NSLock()

    /// Sets the host by hand instead of the class-name lookup.
    public static func install(_ host: GenesisKitBaseHost?) {
        lock.lock()
        defer { lock.unlock() }
        installed = host
        looked = true
    }

    /// The app's host, found once by class name; nil in an app that declares none.
    public static var host: GenesisKitBaseHost? {
        lock.lock()
        defer { lock.unlock() }
        if !looked {
            looked = true
            if let type = NSClassFromString("GenesisKitHostAdapter") as? NSObject.Type {
                installed = type.init() as? GenesisKitBaseHost
            }
        }
        return installed
    }

    /// `package`: GenesisKit and the Genesis-only libraries (GenesisKitPosture, GenesisKitDisk) log through it too.
    package static func log(_ line: String) {
        host?.log(line)
        unifiedLog.notice("\(line, privacy: .public)")
    }

    /// Every kit log line also goes here, so an app with no log of its own still keeps it.
    private static let unifiedLog = Logger(subsystem: "genesiskit", category: "kit")
}
