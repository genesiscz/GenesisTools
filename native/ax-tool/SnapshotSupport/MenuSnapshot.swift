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

    public init(pid: Int32, launch: Double, depth: Int, digest: String, created: Double, rootTitle: String? = nil) {
        self.version = 1
        self.surface = "menu"
        self.pid = pid
        self.launch = launch
        self.depth = depth
        self.digest = digest
        self.created = created
        self.rootTitle = rootTitle
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

public func dispatchMenuAction<T>(token: MenuSnapshotToken, pid: Int32, launch: Double, digest: String,
    element: Int, count: Int, now: Double, frontmost: Bool, enabled: Bool, action: () throws -> T) throws -> T {
    try token.validate(pid: pid, launch: launch, digest: digest, element: element, count: count, now: now)
    guard frontmost else { throw SnapshotError.refusal(.focusMismatch, "menu actions require the app to be frontmost; focus explicitly") }
    guard enabled else { throw SnapshotError.refusal(.missingTarget, "menu item is disabled") }
    return try action()
}
