import Darwin
import Foundation

/// The same stable-inode flock used by the native Widget and Clicky faces, with one shared
/// directory for both feature hosts. Metadata is discovery only; the descriptor owns the role.
public final class FlowFocusLease {
    public struct Owner: Codable, Equatable, Sendable {
        public static let protocolVersion = 1
        public let version: Int
        public let pid: Int32
        public let nonce: UUID
        public let hostID: String
        public let startedAt: Date

        public init(hostID: String, pid: Int32 = ProcessInfo.processInfo.processIdentifier) {
            version = Self.protocolVersion
            self.pid = pid
            nonce = UUID()
            self.hostID = hostID
            startedAt = Date()
        }
    }

    public let directory: URL
    public let owner: Owner
    private var descriptor: Int32

    private init(directory: URL, owner: Owner, descriptor: Int32) {
        self.directory = directory
        self.owner = owner
        self.descriptor = descriptor
    }

    /// A loser must attach or report the incumbent. It may never steal a busy lock because a
    /// PID or metadata file looks old, nor replace owner.lock while someone holds its inode.
    public static func acquire(directory: URL, hostID: String) throws -> FlowFocusLease? {
        let fm = FileManager.default
        try fm.createDirectory(at: directory, withIntermediateDirectories: true,
                               attributes: [.posixPermissions: 0o700])
        try fm.setAttributes([.posixPermissions: 0o700], ofItemAtPath: directory.path)
        let file = directory.appendingPathComponent("owner.lock")
        let descriptor = open(file.path, O_CREAT | O_RDWR | O_CLOEXEC | O_NOFOLLOW, 0o600)
        guard descriptor >= 0 else { throw posixError("open owner.lock") }
        guard flock(descriptor, LOCK_EX | LOCK_NB) == 0 else {
            let code = errno
            close(descriptor)
            guard code == EWOULDBLOCK || code == EAGAIN else {
                throw NSError(domain: NSPOSIXErrorDomain, code: Int(code))
            }
            return nil
        }
        return FlowFocusLease(directory: directory, owner: Owner(hostID: hostID), descriptor: descriptor)
    }

    public func advertise() throws {
        guard descriptor >= 0 else {
            throw NSError(domain: "FlowFocusLease", code: 1,
                          userInfo: [NSLocalizedDescriptionKey: "Cannot advertise a released owner lease"])
        }
        try Self.writePrivate(try JSONEncoder().encode(owner), to: directory.appendingPathComponent("owner.json"))
    }

    public static func readOwner(directory: URL) throws -> Owner {
        let data = try Data(contentsOf: directory.appendingPathComponent("owner.json"))
        let owner = try JSONDecoder().decode(Owner.self, from: data)
        guard owner.version == Owner.protocolVersion else {
            throw NSError(domain: "FlowFocusLease", code: 2,
                          userInfo: [NSLocalizedDescriptionKey: "This Flow and Focus owner uses an incompatible protocol"])
        }
        return owner
    }

    /// Stops advertising only its own nonce. A delayed old shutdown cannot remove a new owner.
    public func release() {
        guard descriptor >= 0 else { return }
        let record = directory.appendingPathComponent("owner.json")
        if let current = try? Self.readOwner(directory: directory), current.nonce == owner.nonce {
            do { try FileManager.default.removeItem(at: record) }
            catch { FlowFocusLog.focus.warning("owner record cleanup failed: \(error.localizedDescription)") }
        }
        flock(descriptor, LOCK_UN)
        close(descriptor)
        descriptor = -1
    }

    public static func writePrivate(_ data: Data, to url: URL) throws {
        try data.write(to: url, options: .atomic)
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
    }

    private static func posixError(_ operation: String) -> NSError {
        NSError(domain: NSPOSIXErrorDomain, code: Int(errno),
                userInfo: [NSLocalizedDescriptionKey: "\(operation): \(String(cString: strerror(errno)))"])
    }

    deinit { release() }
}
