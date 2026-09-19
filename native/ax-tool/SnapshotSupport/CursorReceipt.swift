import Foundation
import Darwin

public func dispatchAfterPresentation<T>(present: () throws -> Void, validate: () throws -> Void,
                                        dispatch: () throws -> T) throws -> T {
    try present()
    try validate()
    return try dispatch()
}

/// One event owns one socket, so late receipts cannot release a subsequent action.
public final class CursorReceipt {
    public static let directory = "/tmp/genesis-control-cursor-\(getuid())"
    public let id = UUID().uuidString
    private var fd: Int32 = -1
    private var filename: String { Self.filename(id) }

    private static func filename(_ id: String) -> String { directory + "/ack-" + id + ".sock" }

    public static func address(_ filename: String) -> sockaddr_un {
        var address = sockaddr_un()
        address.sun_len = UInt8(MemoryLayout<sockaddr_un>.size)
        address.sun_family = sa_family_t(AF_UNIX)
        withUnsafeMutableBytes(of: &address.sun_path) { $0.copyBytes(from: Array(filename.utf8) + [0]) }
        return address
    }

    public init() throws {
        var info = stat()
        guard lstat(Self.directory, &info) == 0, info.st_uid == getuid(),
              (info.st_mode & S_IFMT) == S_IFDIR, (info.st_mode & 0o077) == 0 else {
            throw CocoaError(.fileReadNoPermission)
        }
        fd = socket(AF_UNIX, SOCK_DGRAM, 0)
        guard fd >= 0 else { throw CocoaError(.fileWriteUnknown) }
        var address = Self.address(filename)
        let bound = withUnsafePointer(to: &address) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                bind(fd, $0, socklen_t(MemoryLayout<sockaddr_un>.size))
            }
        }
        guard bound == 0 else {
            close(fd)
            fd = -1
            throw CocoaError(.fileWriteUnknown)
        }
        chmod(filename, 0o600)
    }

    deinit {
        if fd >= 0 { close(fd) }
        unlink(filename)
    }

    public func wait(timeoutMs: Int32) -> Bool {
        let deadline = ProcessInfo.processInfo.systemUptime + Double(max(0, timeoutMs)) / 1000
        var descriptor = pollfd(fd: fd, events: Int16(POLLIN), revents: 0)
        repeat {
            let remaining = max(0, Int32(ceil((deadline - ProcessInfo.processInfo.systemUptime) * 1000)))
            let result = poll(&descriptor, 1, remaining)
            if result > 0 {
                var bytes = [UInt8](repeating: 0, count: 64)
                let count = recv(fd, &bytes, bytes.count, MSG_DONTWAIT)
                return count > 0 && String(bytes: bytes.prefix(count), encoding: .utf8) == id
            }
            if result == 0 || errno != EINTR { return false }
        } while ProcessInfo.processInfo.systemUptime < deadline
        return false
    }

    @discardableResult public static func acknowledge(_ id: String) -> Bool {
        guard UUID(uuidString: id) != nil else { return false }
        let fd = socket(AF_UNIX, SOCK_DGRAM, 0)
        guard fd >= 0 else { return false }
        defer { close(fd) }
        var address = address(filename(id))
        return Array(id.utf8).withUnsafeBytes { bytes in
            withUnsafePointer(to: &address) {
                $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                    sendto(fd, bytes.baseAddress, bytes.count, MSG_DONTWAIT, $0,
                           socklen_t(MemoryLayout<sockaddr_un>.size)) == bytes.count
                }
            }
        }
    }
}
