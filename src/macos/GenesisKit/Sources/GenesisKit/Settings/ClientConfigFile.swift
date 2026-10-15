import Darwin
import Foundation
import os

/// `~/.genesis/client.json`: the settings file the Genesis app, its CLI and the kit share. Writes take the same
/// `client.json.lock` (an `O_EXCL` file) as the app's ConfigStore and the TypeScript client, re-read the file inside
/// the lock, and land through a 0600 temporary file renamed over `client.json`, so the file never exists under the
/// process umask and a reader never sees half a write.
///
/// Reads are lenient (`readApp`, for display); a write reads strictly: a malformed or unreadable `client.json`
/// throws and stays byte-for-byte intact until the user repairs it. A missing `client.json` falls back to the legacy
/// `config.json`, of which only the client keys are carried over.
///
/// Every call does file I/O on the calling thread or task, so call it off the main actor.
public struct ClientConfigFile: Sendable {
    /// The first bytes of a lock this code writes, followed by its pid.
    public static let lockMarkerPrefix = "genesis-kit pid="

    public static var defaultDirectory: URL {
        FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".genesis")
    }

    public let directory: URL
    /// How long a write waits for another writer's lock before it throws.
    public let lockTimeout: TimeInterval
    /// A lock without this code's pid marker (ConfigStore, the CLI) older than this is a crashed writer's and is
    /// removed, as ConfigStore and the TypeScript client do after 10 s. nil never removes a lock by age. A lock with
    /// this code's marker is removed only when its pid no longer runs, never by age.
    public let staleLockAge: TimeInterval?
    let errorDomain: String
    let log: Logger

    public init(directory: URL = ClientConfigFile.defaultDirectory, lockTimeout: TimeInterval = 5,
                staleLockAge: TimeInterval? = 10) {
        self.init(directory: directory, lockTimeout: lockTimeout, staleLockAge: staleLockAge,
                  errorDomain: "ClientConfigFile",
                  log: Logger(subsystem: Bundle.main.bundleIdentifier ?? "dev.genesis.kit", category: "config"))
    }

    init(directory: URL, lockTimeout: TimeInterval, staleLockAge: TimeInterval?, errorDomain: String, log: Logger) {
        self.directory = directory
        self.lockTimeout = lockTimeout
        self.staleLockAge = staleLockAge
        self.errorDomain = errorDomain
        self.log = log
    }

    public var fileURL: URL { directory.appendingPathComponent("client.json") }
    public var lockURL: URL { directory.appendingPathComponent("client.json.lock") }

    // MARK: - Reads

    /// The whole file, leniently: an unreadable or malformed `client.json` reads as empty. Only a missing
    /// `client.json` falls back to the legacy `config.json`.
    public func read() -> [String: Any] {
        for name in ["client.json", "config.json"] {
            let url = directory.appendingPathComponent(name)
            guard FileManager.default.fileExists(atPath: url.path) else { continue }
            guard let data = try? Data(contentsOf: url),
                  let raw = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
            else { return [:] }
            return name == "config.json" ? Self.clientKeys(fromLegacy: raw) : raw
        }
        return [:]
    }

    /// The `app` object, leniently.
    public func readApp() -> [String: Any] {
        read()["app"] as? [String: Any] ?? [:]
    }

    /// `app.<key>`, leniently; nil when absent.
    public func readAppValue(_ key: String) -> Any? {
        readApp()[key]
    }

    /// The whole file, strictly: only a missing file falls back (to the legacy file, then to empty). A malformed or
    /// unreadable `client.json`, or one that is valid JSON but not an object, throws.
    public func readForWrite() throws -> [String: Any] {
        for name in ["client.json", "config.json"] {
            let data: Data
            do {
                data = try Data(contentsOf: directory.appendingPathComponent(name))
            } catch {
                let cocoa = error as NSError
                if cocoa.domain == NSCocoaErrorDomain && cocoa.code == NSFileReadNoSuchFileError {
                    continue
                }
                throw error
            }
            guard let raw = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
                throw NSError(domain: errorDomain, code: 2,
                              userInfo: [NSLocalizedDescriptionKey: "\(name) must contain a JSON object; it was left unchanged."])
            }
            return name == "config.json" ? Self.clientKeys(fromLegacy: raw) : raw
        }
        return [:]
    }

    /// The keys of a legacy `config.json` that belong in `client.json`. Server-owned keys stay behind.
    public static func clientKeys(fromLegacy legacy: [String: Any]) -> [String: Any] {
        var result: [String: Any] = [:]
        for key in ["app", "obsidian", "server"] {
            if let value = legacy[key] { result[key] = value }
        }
        if let auth = legacy["auth"] as? [String: Any], let session = auth["sessionToken"] {
            result["auth"] = ["sessionToken": session]
        }
        return result
    }

    // MARK: - Writes

    /// Replaces `app.<key>` with `value` as a whole (no merge, so a removed nested key goes away); nil removes the
    /// key. Writes nothing when the stored value is already equal. Throws for a value JSON cannot hold (a `Date`, a
    /// `URL`) before it takes the lock.
    public func replaceAppValue(_ value: Any?, forKey key: String) async throws {
        if let value {
            guard JSONSerialization.isValidJSONObject([key: value]) else {
                throw NSError(domain: errorDomain, code: 3,
                              userInfo: [NSLocalizedDescriptionKey: "The value for app.\(key) cannot be stored as JSON."])
            }
        }
        try await mutate { raw in
            var app = raw["app"] as? [String: Any] ?? [:]
            if let value {
                app[key] = value
            } else {
                app.removeValue(forKey: key)
            }
            raw["app"] = app
        }
    }

    /// Locked read-modify-write of the whole file: takes the lock, reads strictly, lets `body` change the object,
    /// and writes it unless it is unchanged. Returns whether it wrote. A malformed file throws before `body` runs.
    @discardableResult
    public func mutate(_ body: (inout [String: Any]) throws -> Void) async throws -> Bool {
        try await mutate(alwaysWrite: false, body)
    }

    /// `alwaysWrite` keeps a caller's older contract of rewriting the file even when nothing changed.
    @discardableResult
    func mutate(alwaysWrite: Bool, _ body: (inout [String: Any]) throws -> Void) async throws -> Bool {
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true,
                                                attributes: [.posixPermissions: 0o700])
        try await acquireLock()
        defer {
            do { try FileManager.default.removeItem(at: lockURL) }
            catch { log.warning("configuration lock cleanup failed: \(error.localizedDescription)") }
        }
        let original = try readForWrite()
        var raw = original
        try body(&raw)
        if !alwaysWrite, FileManager.default.fileExists(atPath: fileURL.path),
           NSDictionary(dictionary: original).isEqual(to: raw) {
            return false
        }
        try writeAtomically(raw)
        return true
    }

    /// Matches ConfigStore and the CLI's `O_EXCL` protocol. Never falls back to an unlocked write while another
    /// writer holds the lock: it suspends (no thread is held) and retries every 100 ms until `lockTimeout`, then
    /// throws.
    func acquireLock() async throws {
        let lock = lockURL
        let deadline = Date().addingTimeInterval(max(0.1, lockTimeout))
        let marker = Data("\(Self.lockMarkerPrefix)\(getpid())\n".utf8)
        while true {
            let descriptor = open(lock.path, O_CREAT | O_EXCL | O_WRONLY | O_CLOEXEC, 0o600)
            if descriptor >= 0 {
                // The owner's pid, so a later writer can prove this lock is stale if this process dies holding it.
                _ = marker.withUnsafeBytes { write(descriptor, $0.baseAddress, $0.count) }
                close(descriptor)
                return
            }
            guard errno == EEXIST else {
                throw NSError(domain: NSPOSIXErrorDomain, code: Int(errno))
            }
            if Self.reclaimIfOwnerDied(lock, log: log) { continue }
            if let staleLockAge, Self.reclaimIfStale(lock, olderThan: staleLockAge, log: log) { continue }
            guard Date() < deadline else {
                throw NSError(domain: errorDomain, code: 1,
                              userInfo: [NSLocalizedDescriptionKey: "Timed out waiting for client.json.lock"])
            }
            let pause = min(0.1, max(0, deadline.timeIntervalSinceNow))
            try await Task.sleep(nanoseconds: UInt64(pause * 1_000_000_000))
        }
    }

    /// Owner-only from its first byte: the temporary file is created 0600 (`O_EXCL`), written, synced to disk and
    /// then renamed over client.json, so a crash leaves the old file or the new one, never a torn one.
    func writeAtomically(_ raw: [String: Any]) throws {
        let encoded = try JSONSerialization.data(withJSONObject: raw, options: [.prettyPrinted, .sortedKeys])
        let destination = fileURL
        let temporary = directory.appendingPathComponent(".client.json.\(UUID().uuidString).tmp")
        do {
            let descriptor = open(temporary.path, O_CREAT | O_EXCL | O_WRONLY | O_CLOEXEC, 0o600)
            guard descriptor >= 0 else { throw NSError(domain: NSPOSIXErrorDomain, code: Int(errno)) }
            var failure: Int32 = 0
            encoded.withUnsafeBytes { buffer in
                var offset = 0
                while offset < buffer.count {
                    let written = write(descriptor, buffer.baseAddress! + offset, buffer.count - offset)
                    if written < 0 {
                        if errno == EINTR { continue }
                        failure = errno
                        return
                    }
                    offset += written
                }
            }
            if failure == 0, fsync(descriptor) != 0 { failure = errno }
            close(descriptor)
            guard failure == 0 else { throw NSError(domain: NSPOSIXErrorDomain, code: Int(failure)) }
            guard rename(temporary.path, destination.path) == 0 else {
                throw NSError(domain: NSPOSIXErrorDomain, code: Int(errno))
            }
        } catch {
            if FileManager.default.fileExists(atPath: temporary.path) {
                do { try FileManager.default.removeItem(at: temporary) }
                catch let cleanup { log.warning("client.json temporary not removed: \(cleanup.localizedDescription)") }
            }
            throw error
        }
    }

    // MARK: - Lock recovery

    /// A lock this code wrote whose pid no longer runs is removed: the process died between creating it and its
    /// `defer`. A lock in any other format (ConfigStore, the CLI) or of a live pid is never touched here, and age
    /// alone never counts. A reused pid only keeps the lock in place, never removes a live one. The content is read
    /// again just before the removal, so a lock another writer reclaimed and re-created in between is left alone.
    static func reclaimIfOwnerDied(_ lock: URL, log: Logger) -> Bool {
        guard let first = try? Data(contentsOf: lock), let text = String(data: first, encoding: .utf8),
              text.hasPrefix(lockMarkerPrefix),
              let pid = pid_t(text.dropFirst(lockMarkerPrefix.count).trimmingCharacters(in: .whitespacesAndNewlines)),
              pid > 0, pid != getpid()
        else { return false }
        guard kill(pid, 0) == -1, errno == ESRCH else { return false }
        guard (try? Data(contentsOf: lock)) == first else { return false }
        do {
            try FileManager.default.removeItem(at: lock)
            log.warning("configuration lock of dead pid \(pid) removed")
            return true
        } catch {
            log.error("configuration lock of dead pid \(pid) not removed: \(error.localizedDescription)")
            return false
        }
    }

    /// A lock without this code's marker whose modification time is older than `age` is removed, the rule
    /// ConfigStore and the TypeScript client use for a crashed writer. The inode and the modification time are
    /// checked again just before the removal, so a lock re-created in between is left alone.
    static func reclaimIfStale(_ lock: URL, olderThan age: TimeInterval, log: Logger) -> Bool {
        var before = stat()
        guard lstat(lock.path, &before) == 0 else { return false }
        if let data = try? Data(contentsOf: lock), let text = String(data: data, encoding: .utf8),
           text.hasPrefix(lockMarkerPrefix) {
            return false
        }
        let modified = Date(timeIntervalSince1970: TimeInterval(before.st_mtimespec.tv_sec)
            + TimeInterval(before.st_mtimespec.tv_nsec) / 1_000_000_000)
        guard Date().timeIntervalSince(modified) > age else { return false }
        var again = stat()
        guard lstat(lock.path, &again) == 0, again.st_ino == before.st_ino,
              again.st_mtimespec.tv_sec == before.st_mtimespec.tv_sec,
              again.st_mtimespec.tv_nsec == before.st_mtimespec.tv_nsec
        else { return false }
        do {
            try FileManager.default.removeItem(at: lock)
            log.warning("stale configuration lock (older than \(Int(age)) s) removed")
            return true
        } catch {
            log.error("stale configuration lock not removed: \(error.localizedDescription)")
            return false
        }
    }
}
