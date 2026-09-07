import Foundation

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
