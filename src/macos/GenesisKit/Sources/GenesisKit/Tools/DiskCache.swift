import CryptoKit
import Foundation

/// The last answer of a slow read (a `tools` call, a git scan), kept on disk so a view paints it at once
/// and refreshes behind it (stale-while-revalidate). A view always asks again; the cache only decides
/// what shows while it waits. Files live in `~/.genesis-tools/<folder>/cache/<namespace>-<hash>.json`.
///
///     let cache = DiskCache(folder: "hub", namespace: "pr")
///     if let shown = cache.read(PRDetail.self, key: id) { detail = shown }   // paint at once
///     let fresh = try await load(); cache.write(fresh, key: id)             // then refresh
public struct DiskCache: Sendable {
    public let directory: URL
    public let namespace: String

    public init(folder: String, namespace: String) {
        self.directory = FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent(".genesis-tools/\(folder)/cache", isDirectory: true)
        self.namespace = namespace
    }

    public init(directory: URL, namespace: String) {
        self.directory = directory
        self.namespace = namespace
    }

    /// The file for `key`: the namespace plus a hash, so any text (paths, URLs, argv) is a safe key.
    public func url(for key: String) -> URL {
        let digest = SHA256.hash(data: Data(key.utf8))
        let hex = digest.prefix(12).map { String(format: "%02x", $0) }.joined()
        return directory.appendingPathComponent("\(namespace)-\(hex).json")
    }

    public func readData(key: String) -> Data? {
        try? Data(contentsOf: url(for: key))
    }

    public func read<Value: Decodable>(_ type: Value.Type, key: String) -> Value? {
        guard let data = readData(key: key) else { return nil }
        do {
            return try JSONDecoder().decode(type, from: data)
        } catch {
            // A cache written by an older build: ignore it, the fresh answer overwrites it.
            PerfLog.mark("cache \(namespace) unreadable, ignored: \(error)")
            return nil
        }
    }

    /// When `key` was last written, or nil when it never was.
    public func modified(key: String) -> Date? {
        (try? FileManager.default.attributesOfItem(atPath: url(for: key).path))?[.modificationDate] as? Date
    }

    /// `read` off the main thread: a cache is small, but a view must never wait on the disk.
    public func load<Value: Decodable & Sendable>(_ type: Value.Type, key: String) async -> Value? {
        let cache = self
        return await Task.detached(priority: .userInitiated) { cache.read(type, key: key) }.value
    }

    /// `readData` off the main thread, for answers kept as the CLI printed them.
    public func loadData(key: String) async -> Data? {
        let cache = self
        return await Task.detached(priority: .userInitiated) { cache.readData(key: key) }.value
    }

    public func writeData(_ data: Data, key: String) {
        do {
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            try data.write(to: url(for: key), options: .atomic)
        } catch {
            PerfLog.mark("cache \(namespace) write failed: \(error)")
        }
    }

    public func write<Value: Encodable>(_ value: Value, key: String) {
        do {
            writeData(try JSONEncoder().encode(value), key: key)
        } catch {
            PerfLog.mark("cache \(namespace) encode failed: \(error)")
        }
    }
}
