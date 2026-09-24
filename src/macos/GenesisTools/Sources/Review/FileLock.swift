import Foundation

/// The lock `withFileLock` in src/utils/storage/file-lock.ts takes: `<file>.lock`, created with O_EXCL
/// and holding the owner's pid. The TypeScript side reads a bare pid as a valid owner, and either side
/// takes over a lock whose owner has died. Hold it around a read-modify-write of a file the CLI also
/// writes, so neither side overwrites the other's change.
enum FileLock {
    struct Timeout: Error, CustomStringConvertible {
        let path: String
        var description: String { "could not lock \(path): another writer held it for 5 s" }
    }

    static func withLock<T>(_ file: URL, timeout: TimeInterval = 5, _ body: () throws -> T) throws -> T {
        let lock = file.path + ".lock"
        let deadline = Date().addingTimeInterval(timeout)
        while !acquire(lock) {
            if Date() >= deadline { throw Timeout(path: lock) }
            Thread.sleep(forTimeInterval: 0.1)
        }
        defer { release(lock) }
        return try body()
    }

    private static func acquire(_ lock: String) -> Bool {
        let fd = open(lock, O_CREAT | O_EXCL | O_WRONLY, 0o644)
        if fd >= 0 {
            let record = "\(getpid())\n"
            _ = record.withCString { write(fd, $0, strlen($0)) }
            close(fd)
            return true
        }
        guard errno == EEXIST, let content = try? String(contentsOfFile: lock, encoding: .utf8),
              let owner = ownerPid(content), kill(owner, 0) != 0, errno == ESRCH
        else { return false }

        // The owner is gone. Move the lock aside and check it is still the one judged stale, so two
        // processes taking over at once cannot delete a lock the other has just created.
        let aside = "\(lock).stale.\(getpid())"
        guard rename(lock, aside) == 0 else { return false }
        if (try? String(contentsOfFile: aside, encoding: .utf8)) == content {
            unlink(aside)
        } else {
            rename(aside, lock)
        }
        return false
    }

    private static func release(_ lock: String) {
        guard let content = try? String(contentsOfFile: lock, encoding: .utf8), ownerPid(content) == getpid() else { return }
        unlink(lock)
    }

    /// A bare pid (this side) or the TypeScript JSON record `{"pid": N, ...}`.
    private static func ownerPid(_ content: String) -> pid_t? {
        let trimmed = content.trimmingCharacters(in: .whitespacesAndNewlines)
        if let bare = pid_t(trimmed) { return bare }
        guard let data = trimmed.data(using: .utf8),
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let pid = object["pid"] as? Int
        else { return nil }
        return pid_t(pid)
    }
}
