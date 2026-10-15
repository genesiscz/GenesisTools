import Foundation

public struct MenuSnapshotToken: Codable {
    public let version: Int
    public let surface: String
    public let pid: Int32
    public let launch: Double
    public let depth: Int
    public let digest: String
    public let created: Double
    public let rootTitle: String?
    /// Set when the observation was an open context menu rather than the menu bar. Optional, so a token
    /// minted before the field existed still decodes, and as the menu bar.
    public let contextMenu: Bool?

    public init(pid: Int32, launch: Double, depth: Int, digest: String, created: Double, rootTitle: String? = nil,
                contextMenu: Bool = false) {
        self.version = 1
        self.surface = "menu"
        self.pid = pid
        self.launch = launch
        self.depth = depth
        self.digest = digest
        self.created = created
        self.rootTitle = rootTitle
        self.contextMenu = contextMenu ? true : nil
    }
    public func validate(pid: Int32, launch: Double, digest: String, element: Int, count: Int, now: Double) throws {
        guard version == 1, surface == "menu", self.pid > 0, self.launch.isFinite, self.launch > 0,
              created.isFinite, now.isFinite, (1...50).contains(depth), !self.digest.isEmpty else {
            throw SnapshotError.invalid("invalid menu snapshot metadata; inspect the menu again")
        }
        guard self.pid == pid, self.launch == launch else {
            throw SnapshotError.refusal(.scopeChanged, "menu belongs to a different app instance")
        }
        guard now >= created, now - created <= 30 else {
            throw SnapshotError.refusal(.staleObservation, "menu snapshot expired; inspect again")
        }
        guard element >= 0, element < count else {
            throw SnapshotError.refusal(.missingTarget, "menu index outside current observation")
        }
        guard self.digest == digest else {
            throw SnapshotError.refusal(.staleObservation, "menu changed; inspect again")
        }
    }
}

/// AXPress on a menu bar item OPENS a menu, and macOS only tracks an open menu for the active
/// app, so that one genuinely needs the key window. AXPick selects an item outright and AXCancel
/// dismisses; neither needs the app in front. Gating all three on frontmost meant every menu
/// action stole the user's focus to do its job.
///
/// An item of a context menu that is already open needs nothing in front either: the menu is tracking
/// already, and the app that owns it was never activated to open it (a right-click is a background act).
public func menuActionRequiresFrontmost(_ action: String, contextMenu: Bool = false) -> Bool {
    return !contextMenu && !["AXPick", "AXCancel"].contains(action)
}

public func dispatchMenuAction<T>(token: MenuSnapshotToken, pid: Int32, launch: Double, digest: String,
    element: Int, count: Int, now: Double, frontmost: Bool, enabled: Bool, action: () throws -> T,
    axAction: String = "AXPress") throws -> T {
    try token.validate(pid: pid, launch: launch, digest: digest, element: element, count: count, now: now)
    guard frontmost || !menuActionRequiresFrontmost(axAction, contextMenu: token.contextMenu == true) else {
        throw SnapshotError.refusal(.focusMismatch, "\(axAction) on a menu needs the app frontmost; AXPick selects an item without focus")
    }
    guard enabled else { throw SnapshotError.refusal(.missingTarget, "menu item is disabled") }
    return try action()
}
