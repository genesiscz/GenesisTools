import CryptoKit
import Darwin
import Foundation
import GenesisKit

struct RecastPreviewRequest: Sendable {
    var data: Data
    var sourceHash: String
    var kind: String
    var page: Int
    var key: String { "native-2400-v1:\(sourceHash):\(kind):\(page)" }
}

actor RecastPreviewCache {
    static let shared = RecastPreviewCache()
    private struct Entry: Codable {
        var version: Int
        var sourceHash: String
        var kind: String
        var page: Int
        var png: Data
        var pngHash: String
    }
    private let cache: DiskCache
    private let budgetBytes: Int
    private let maximumEntries: Int
    private let maximumEntryBytes = 32 * 1024 * 1024
    private let lifetime: TimeInterval = 14 * 24 * 60 * 60
    private let decode: @Sendable (RecastPreviewRequest) async throws -> Data
    private(set) var hits = 0
    private(set) var misses = 0

    init(directory: URL? = nil, budgetBytes: Int = 64 * 1024 * 1024, maximumEntries: Int = 128,
         decode: @escaping @Sendable (RecastPreviewRequest) async throws -> Data = {
             try await NativeSourceReader.shared.preview(data: $0.data, kind: $0.kind, page: $0.page)
         }) {
        cache = directory.map { DiskCache(directory: $0, namespace: "page-v1") } ?? DiskCache(folder: "recast/previews", namespace: "page-v1")
        self.budgetBytes = max(1, budgetBytes)
        self.maximumEntries = max(1, maximumEntries)
        self.decode = decode
    }

    func artifactURL(_ request: RecastPreviewRequest) -> URL { cache.url(for: request.key) }

    func preview(_ request: RecastPreviewRequest) async throws -> Data {
        try Task.checkCancellation()
        let url = cache.url(for: request.key)
        if let entry = cached(request, url: url) {
            hits += 1
            do { try FileManager.default.setAttributes([.modificationDate: Date()], ofItemAtPath: url.path) }
            catch { HubPerf.log("recast: preview cache access date failed: \(error)") }
            HubPerf.log("recast: preview cache hit page \(request.page)")
            return entry.png
        }
        misses += 1
        let png = try await decode(request)
        try Task.checkCancellation()
        do {
            try FileManager.default.createDirectory(at: cache.directory, withIntermediateDirectories: true)
            let directory = try cache.directory.resourceValues(forKeys: [.isDirectoryKey, .isSymbolicLinkKey])
            guard directory.isDirectory == true, directory.isSymbolicLink != true else { throw recastError("Preview cache directory is invalid.") }
            let lockURL = cache.directory.appendingPathComponent("page-v1.lock")
            let descriptor = lockURL.path.withCString { Darwin.open($0, O_CREAT | O_RDWR | O_NOFOLLOW, mode_t(S_IRUSR | S_IWUSR)) }
            guard descriptor >= 0 else { throw recastError("Preview cache lock could not be opened.") }
            defer { Darwin.close(descriptor) }
            guard flock(descriptor, LOCK_EX | LOCK_NB) == 0 else {
                HubPerf.log("recast: preview cache is busy; using the decoded page without writing")
                return png
            }
            defer { flock(descriptor, LOCK_UN) }
            let entry = Entry(version: 1, sourceHash: request.sourceHash, kind: request.kind, page: request.page,
                png: png, pngHash: digest(png))
            let encoded = try JSONEncoder().encode(entry)
            if encoded.count <= min(maximumEntryBytes, budgetBytes) {
                try encoded.write(to: url, options: .atomic)
            }
            try prune()
        } catch { HubPerf.log("recast: disposable preview cache unavailable: \(error)") }
        return png
    }

    private func cached(_ request: RecastPreviewRequest, url: URL) -> Entry? {
        guard FileManager.default.fileExists(atPath: url.path) else { return nil }
        do {
            let values = try url.resourceValues(forKeys: [.isRegularFileKey, .isSymbolicLinkKey, .fileSizeKey, .contentModificationDateKey])
            guard values.isRegularFile == true, values.isSymbolicLink != true,
                  let size = values.fileSize, size <= min(maximumEntryBytes, budgetBytes),
                  let modified = values.contentModificationDate, Date().timeIntervalSince(modified) <= lifetime else { return nil }
            let data = try Data(contentsOf: url)
            guard data.count <= min(maximumEntryBytes, budgetBytes) else { return nil }
            let entry = try JSONDecoder().decode(Entry.self, from: data)
            guard entry.version == 1, entry.sourceHash == request.sourceHash, entry.kind == request.kind,
                  entry.page == request.page, entry.png.starts(with: [137, 80, 78, 71, 13, 10, 26, 10]),
                  digest(entry.png) == entry.pngHash else { return nil }
            return entry
        } catch { HubPerf.log("recast: preview cache entry ignored: \(error)"); return nil }
    }

    private func prune() throws {
        let keys: Set<URLResourceKey> = [.isRegularFileKey, .isSymbolicLinkKey, .fileSizeKey, .contentModificationDateKey]
        let urls = try FileManager.default.contentsOfDirectory(at: cache.directory, includingPropertiesForKeys: Array(keys))
        var entries: [(url: URL, bytes: Int, modified: Date)] = []
        for url in urls where url.lastPathComponent.range(of: "^page-v1-[a-f0-9]{24}\\.json$", options: .regularExpression) != nil {
            let values = try url.resourceValues(forKeys: keys)
            guard values.isRegularFile == true, values.isSymbolicLink != true,
                  let bytes = values.fileSize, let modified = values.contentModificationDate else { continue }
            entries.append((url, bytes, modified))
        }
        entries.sort { $0.modified < $1.modified }
        var bytes = entries.reduce(0) { $0 + $1.bytes }, count = entries.count
        for entry in entries {
            if bytes > budgetBytes || count > maximumEntries || Date().timeIntervalSince(entry.modified) > lifetime {
                try FileManager.default.removeItem(at: entry.url)
                bytes -= entry.bytes; count -= 1
            }
        }
    }

    private func digest(_ data: Data) -> String { SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined() }
}
