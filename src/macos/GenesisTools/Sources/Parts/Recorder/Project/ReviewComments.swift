import Foundation

/// Review comments of a recording, beside it as `comments.jsonl` (`<name>.comments.jsonl` beside a plain movie); the
/// CLI and the REPL write the same file (src/utils/recording-editor/comments.ts). Each line is one change: a new
/// comment, a later version of one (same id, the last line wins), or its removal (`deleted: true`). Times are SOURCE
/// microseconds, so a cut never moves a comment.
struct ReviewComment: Codable, Equatable, Identifiable {
    var id: String
    var atUs: Int64
    var toUs: Int64?
    var text: String
    var author: String?
    /// The page it came from (a review board, a PR).
    var link: String?
    var resolved: Bool?
    var deleted: Bool?
    /// ISO time of this line.
    var at: String

    var isResolved: Bool { resolved == true }
}

enum ReviewComments {
    static func url(forVideo video: String) -> URL {
        let movie = URL(fileURLWithPath: video)
        let folder = movie.deletingLastPathComponent()
        if FileManager.default.fileExists(atPath: folder.appendingPathComponent("recording.json").path) {
            return folder.appendingPathComponent("comments.jsonl")
        }
        return folder.appendingPathComponent(movie.deletingPathExtension().lastPathComponent + ".comments.jsonl")
    }

    /// The comments as they stand, in time order: each id's last line, without the removed ones. A line that does not
    /// parse is skipped.
    static func read(_ url: URL) -> [ReviewComment] {
        guard let text = try? String(contentsOf: url, encoding: .utf8) else { return [] }
        var latest: [String: ReviewComment] = [:]
        let decoder = JSONDecoder()
        for line in text.split(separator: "\n") where !line.trimmingCharacters(in: .whitespaces).isEmpty {
            guard let comment = try? decoder.decode(ReviewComment.self, from: Data(line.utf8)) else { continue }
            latest[comment.id] = comment
        }
        return latest.values.filter { $0.deleted != true }.sorted { ($0.atUs, $0.at) < ($1.atUs, $1.at) }
    }

    /// Appends one line; the file is made when it is missing.
    static func append(_ comment: ReviewComment, to url: URL) throws {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        var data = try encoder.encode(comment)
        data.append(0x0A)
        if !FileManager.default.fileExists(atPath: url.path) {
            try data.write(to: url)
            return
        }
        let handle = try FileHandle(forWritingTo: url)
        defer { try? handle.close() }
        try handle.seekToEnd()
        try handle.write(contentsOf: data)
    }

    static func now() -> String {
        ISO8601DateFormatter.withFraction.string(from: Date())
    }

    static func newID() -> String { "m" + String(UUID().uuidString.prefix(8)).lowercased() }
}

/// The comments of the open edit, read when it opens and again whenever the file changes (an agent's comment shows
/// at once).
@MainActor
final class ReviewCommentsStore {
    let url: URL
    private(set) var comments: [ReviewComment]
    var onChange: (([ReviewComment]) -> Void)?
    private var source: DispatchSourceFileSystemObject?
    private var folderSource: DispatchSourceFileSystemObject?

    init(video: String) {
        url = ReviewComments.url(forVideo: video)
        comments = ReviewComments.read(url)
    }

    func add(atUs: Int64, toUs: Int64?, text: String) throws {
        let comment = ReviewComment(id: ReviewComments.newID(), atUs: atUs, toUs: toUs.flatMap { $0 > atUs ? $0 : nil },
                                    text: String(text.trimmingCharacters(in: .whitespacesAndNewlines).prefix(2000)),
                                    author: NSFullUserName().isEmpty ? nil : NSFullUserName(), at: ReviewComments.now())
        try ReviewComments.append(comment, to: url)
        reload()
    }

    func update(_ id: String, _ change: (inout ReviewComment) -> Void) throws {
        guard var comment = comments.first(where: { $0.id == id }) else { return }
        change(&comment)
        comment.at = ReviewComments.now()
        try ReviewComments.append(comment, to: url)
        reload()
    }

    func remove(_ id: String) throws {
        try update(id) { $0.deleted = true }
    }

    func reload() {
        let next = ReviewComments.read(url)
        guard next != comments else { return }
        comments = next
        onChange?(next)
    }

    /// Watches the file, or its folder until the file exists (the first comment makes it).
    func watch() {
        source?.cancel()
        folderSource?.cancel()
        let descriptor = Darwin.open(url.path, O_EVTONLY)
        if descriptor >= 0 {
            source = Self.watch(descriptor, events: [.write, .extend, .rename, .delete]) { [weak self] in
                self?.reload()
                self?.watch()
            }
            return
        }
        let folder = Darwin.open(url.deletingLastPathComponent().path, O_EVTONLY)
        guard folder >= 0 else { return }
        folderSource = Self.watch(folder, events: [.write]) { [weak self] in
            guard let self, FileManager.default.fileExists(atPath: self.url.path) else { return }
            self.reload()
            self.watch()
        }
    }

    func stopWatching() {
        source?.cancel()
        folderSource?.cancel()
        source = nil
        folderSource = nil
    }

    private static func watch(_ descriptor: Int32, events: DispatchSource.FileSystemEvent,
                              _ handler: @escaping @MainActor () -> Void) -> DispatchSourceFileSystemObject {
        let source = DispatchSource.makeFileSystemObjectSource(fileDescriptor: descriptor, eventMask: events, queue: .main)
        source.setEventHandler { MainActor.assumeIsolated { handler() } }
        source.setCancelHandler { close(descriptor) }
        source.resume()
        return source
    }
}
