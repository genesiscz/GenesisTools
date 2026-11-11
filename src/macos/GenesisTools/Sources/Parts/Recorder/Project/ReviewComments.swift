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

    /// The comment popover's link button: a board annotation's link opens the annotation, any other link its page.
    var linkTitle: String { link?.contains("#annotation-") == true ? "Open the Annotation" : "Open Its Page" }
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
}

/// The comments of the open edit, read when it opens and again whenever the file changes (an agent's comment shows
/// at once).
@MainActor
final class ReviewCommentsStore {
    let url: URL
    private(set) var comments: [ReviewComment]
    var onChange: (([ReviewComment]) -> Void)?
    private let file: FileWatch

    init(video: String) {
        url = ReviewComments.url(forVideo: video)
        comments = ReviewComments.read(url)
        file = FileWatch(url: url)
        file.onChange = { [weak self] in self?.reload() }
    }

    func reload() {
        let next = ReviewComments.read(url)
        guard next != comments else { return }
        comments = next
        onChange?(next)
    }

    /// Watches the file, or its folder until the file exists (the first comment makes it).
    func watch() {
        file.start()
    }

    func stopWatching() {
        file.stop()
    }
}
