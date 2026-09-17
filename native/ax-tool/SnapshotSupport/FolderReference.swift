import Foundation

/// A short-lived selector reference. Unlike SnapshotToken it deliberately permits unrelated UI changes.
public struct FolderReference: Codable {
    public let version: Int
    public let pid: Int32
    public let launch: Double
    public let window: Int
    public let created: Double
    public let label: String
    public let identityAttribute: String
    public let identity: String

    public init(pid: Int32, launch: Double, window: Int, created: Double, label: String,
                identityAttribute: String, identity: String) {
        self.version = 1; self.pid = pid; self.launch = launch; self.window = window
        self.created = created; self.label = label; self.identityAttribute = identityAttribute; self.identity = identity
    }

    public func validate(pid: Int32, launch: Double, now: Double) throws {
        guard version == 1, self.pid == pid, pid > 0, self.launch == launch, launch.isFinite,
              window > 0, window <= Int(UInt32.max), created.isFinite, now >= created, now - created <= 120,
              !label.isEmpty, label.count <= 1000, !identity.isEmpty, identity.count <= 2000,
              ["AXIdentifier", "AXDOMIdentifier", "AXDescription", "AXTitle"].contains(identityAttribute) else {
            throw SnapshotError.invalid("folder reference expired or app identity changed; inspect folders again")
        }
    }
}
