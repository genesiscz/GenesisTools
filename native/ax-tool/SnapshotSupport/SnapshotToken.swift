import Foundation

/// A token that ties an element index to one snapshot of one window of one process instance.
///
/// `validate` refuses the index when the process was replaced (pid or launch time differ), the
/// tree changed (digest differs), the snapshot expired, or the index is outside the snapshot's
/// element count. Each refusal has a test in `Tests/SnapshotSupportTests.swift`.
///
/// GROUNDWORK, not yet on the shipped path: as of this target's introduction no command in
/// `Sources/main.swift` constructs or validates a token. The executable's `snapshot` command
/// captures mouse position and focus, not a UI tree, so nothing yet produces the `digest`,
/// `depth` and element `count` a token needs. The producer is the planned tree-snapshot command;
/// until it exists, declaring the dependency in `Package.swift` adds no protection to any action.
public struct SnapshotToken: Codable {
    public let version: Int
    public let pid: Int32
    public let launch: Double
    public let window: Int
    public let depth: Int
    public let digest: String
    public let created: Double

    public init(pid: Int32, launch: Double, window: Int, depth: Int, digest: String, created: Double) {
        self.version = 1
        self.pid = pid
        self.launch = launch
        self.window = window
        self.depth = depth
        self.digest = digest
        self.created = created
    }

    public func validate(pid: Int32, launch: Double, digest: String, element: Int, count: Int, now: Double) throws -> Int {
        guard version == 1, self.pid == pid, self.launch == launch else {
            throw SnapshotError.invalid("snapshot belongs to a different app instance; run see again")
        }
        guard now >= created, now - created <= 120 else {
            throw SnapshotError.invalid("snapshot expired; run see again")
        }
        guard element >= 0, element < count else {
            throw SnapshotError.invalid("element index outside snapshot")
        }
        guard self.digest == digest else {
            throw SnapshotError.invalid("UI changed; run see again")
        }
        return element
    }
}

public enum SnapshotError: Error, LocalizedError {
    case invalid(String)
    public var errorDescription: String? {
        switch self {
        case .invalid(let message): return message
        }
    }
}
