import AppKit
import Foundation

/// One GenesisTools tile in the Dock (DECISION 72 b, 2026-10-08). The Dock shows one tile per
/// process, and every face is its own process of the same bundle, so nine faces showed nine tiles.
/// Only one process may be `.regular`:
///
/// - The hub (`--hub`) is always `.regular`. It is single-instance (HubSingleInstance), so it owns
///   the tile whenever it runs.
/// - A window face (a review window, the settings window) is `.accessory` while a hub runs.
/// - While NO hub runs, the window face that holds `~/.genesis-tools/app/dock-tile.lock` is `.regular`
///   and owns the tile; every other window face stays `.accessory`. The kernel drops the lock when its
///   holder ends, so the next window face takes the tile on its next check. A hub that starts later
///   takes the tile from it the same way.
/// - A windowless face (the link relay) is always `.accessory`.
///
/// An accessory window still activates and takes key focus (`NSApp.activate`), but it has no
/// Cmd+Tab entry and the menu bar keeps showing the previous app's menus. Reach it through the hub,
/// Mission Control, or the link that opened it.
///
/// The policy does not stay put on its own: a reopen event (`open -a GenesisTools`, a Dock click
/// routed to the oldest instance) turns an accessory process `.regular` BEFORE
/// `applicationShouldHandleReopen` runs (measured with a probe bundle on macOS 26.3, 2026-10-08), and
/// the link relay was found `.regular` with no reopen in its journal. So every reopen handler calls
/// `enforce()`, and each face checks again on activation changes and on a slow timer.
@MainActor
enum DockTile {
    enum Role: String {
        /// A face with a window that is not the hub.
        case window
        /// A face with no window: the link relay.
        case windowless
    }

    private static let checkSeconds = 2.0
    private static var role: Role?
    private nonisolated(unsafe) static var lockDescriptor: Int32 = -1
    private static var timer: DispatchSourceTimer?
    private static var observers: [NSObjectProtocol] = []

    private static var lockFile: URL {
        FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".genesis-tools/app/dock-tile.lock")
    }

    /// The policy this face should have now. Takes or gives back the tile lock as a side effect.
    static func policy(for role: Role) -> NSApplication.ActivationPolicy {
        switch role {
        case .windowless:
            return .accessory
        case .window:
            if HubSingleInstance.isRunningElsewhere {
                releaseTile()
                return .accessory
            }
            return claimTile() ? .regular : .accessory
        }
    }

    /// Sets this face's policy by the rule above and keeps it there for the life of the process.
    static func keep(_ role: Role) {
        self.role = role
        enforce("start")
        guard timer == nil else { return }
        let center = NotificationCenter.default
        for name in [NSApplication.didBecomeActiveNotification, NSApplication.didResignActiveNotification] {
            observers.append(center.addObserver(forName: name, object: nil, queue: .main) { note in
                MainActor.assumeIsolated { enforce(note.name.rawValue) }
            })
        }
        let source = DispatchSource.makeTimerSource(queue: .main)
        source.schedule(deadline: .now() + checkSeconds, repeating: checkSeconds, leeway: .milliseconds(500))
        source.setEventHandler {
            MainActor.assumeIsolated { enforce("check") }
        }
        source.resume()
        timer = source
    }

    /// Puts the policy back where the rule says. Call it first thing in `applicationShouldHandleReopen`.
    static func enforce(_ reason: String) {
        guard let role else { return }
        let wanted = policy(for: role)
        let current = NSApp.activationPolicy()
        guard current != wanted else { return }
        NSApp.setActivationPolicy(wanted)
        HubPerf.log("dock: \(role.rawValue) face policy \(name(current)) -> \(name(wanted)) (\(reason))")
    }

    private static func claimTile() -> Bool {
        if lockDescriptor >= 0 {
            return true
        }

        try? FileManager.default.createDirectory(at: lockFile.deletingLastPathComponent(), withIntermediateDirectories: true)
        let descriptor = open(lockFile.path, O_RDWR | O_CREAT | O_CLOEXEC, 0o644)
        guard descriptor >= 0 else {
            HubPerf.log("dock: tile lock not opened (errno \(errno)); this face stays an accessory")
            return false
        }
        guard flock(descriptor, LOCK_EX | LOCK_NB) == 0 else {
            close(descriptor)
            return false
        }
        lockDescriptor = descriptor
        return true
    }

    private static func releaseTile() {
        guard lockDescriptor >= 0 else { return }
        flock(lockDescriptor, LOCK_UN)
        close(lockDescriptor)
        lockDescriptor = -1
    }

    private static func name(_ policy: NSApplication.ActivationPolicy) -> String {
        switch policy {
        case .regular: return "regular"
        case .accessory: return "accessory"
        case .prohibited: return "prohibited"
        @unknown default: return "\(policy.rawValue)"
        }
    }
}
