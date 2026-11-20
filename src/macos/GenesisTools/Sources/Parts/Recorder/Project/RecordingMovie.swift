import AVFoundation
import Foundation

/// Which file is the movie of a recording folder, for every list that asks: the menu bar's Recent rows, the library
/// window (its cards, drag and Copy Movie) and the editor's open. The CLI and the REPL answer the same with
/// `movieOf` and `shareableMovie` (src/recorder/lib/library.ts, quick-actions.ts); both sides run the cases in
/// src/utils/recording-editor/__fixtures__/recording-movies.json. Read off the main thread or at a click, never in a body.
enum RecordingMovie {
    /// The recording's own movie, in the order the editor looks for one: the recorder's movie, then the proxy
    /// `tools recorder proxy` makes of a frames recording (a meeting recording often has only that).
    static let names = ["screen.mp4", "screen.mov", "proxy.mp4"]
    /// The camera's movie beside `screen.mp4`: part of the recording, never an export of it.
    static let camera = "camera.mov"
    private static let exportExtensions: Set<String> = ["mp4", "gif", "webm", "mov"]

    /// The recording's own movie, nil for a frames recording that has no proxy yet.
    static func own(in folder: URL) -> URL? {
        names.map { folder.appendingPathComponent($0) }.first { FileManager.default.fileExists(atPath: $0.path) }
    }

    /// A movie file's length in milliseconds, nil when it has none or is not a movie. A frames or meeting recording writes
    /// no settings.video.durationMs, so the library card reads its proxy's own length. Blocks for the read: call it off
    /// the main thread (readRecents runs on a background queue).
    ///
    /// The answer is kept per file (its path, inode, size and modification date), because the library rereads every
    /// recording on each change in it (an edit or a comment on one): each read is an asset load of up to 3 s, so a library
    /// of meetings took seconds per refresh. A file that changes is read again; a read that timed out is not kept.
    nonisolated static func lengthMs(_ url: URL) -> Double? {
        guard let identity = MovieFileIdentity(url) else { return nil }
        if let known = lengthCache.answer(for: identity) { return known }
        final class Box: @unchecked Sendable { var ms: Double? }
        let box = Box()
        let done = DispatchSemaphore(value: 0)
        Task.detached {
            if let duration = try? await AVURLAsset(url: url).load(.duration), duration.isNumeric, duration.seconds > 0 {
                box.ms = duration.seconds * 1000
            }
            done.signal()
        }
        guard done.wait(timeout: .now() + 3) == .success else { return nil }
        lengthCache.keep(box.ms, for: identity)
        return box.ms
    }

    private static let lengthCache = MovieLengthCache()

    /// What a drag or Copy Movie hands out for a recording folder.
    enum Shareable: Equatable {
        /// The newest export of the current edit, or the recording's own movie when it has no edit.
        case file(URL)
        /// The recording has an edit and no export shows it: export first, never hand out an older or unedited movie.
        case stale(revision: Int)
        /// No movie at all (a frames recording before its proxy).
        case none
        /// edit.json cannot be read, so no export can be shown to match the edit: nothing is handed out.
        case unreadable

        var url: URL? {
            if case let .file(url) = self { return url }
            return nil
        }
    }

    /// The one rule for the file a recording shares, as `shareableMovieOf` (src/utils/recording-editor/exports.ts):
    /// the newest export whose recorded edit revision (exports.json, `ExportLedger`) equals edit.json's revision now;
    /// with no edit, the newest export of the unedited recording, else its own movie. An edit.json that cannot be read
    /// is `unreadable`, never revision 0. Reads files: call it at a click.
    static func shareable(in folder: URL) -> Shareable {
        let revision: Int?
        switch ExportLedger.editRevision(in: folder) {
        case .missing: revision = nil
        case let .known(value): revision = value
        case .unreadable: return .unreadable
        }
        let modified = { (url: URL) in (try? url.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate) ?? .distantPast }
        let current = ExportLedger.read(folder)
            .filter { $0.value.revision == revision && !$0.key.contains(".partial.") }
            .map { ExportLedger.url(of: $0.key, in: folder) }
            .filter { FileManager.default.fileExists(atPath: $0.path) }
        if let newest = current.max(by: { modified($0) < modified($1) }) { return .file(newest) }
        if let revision { return .stale(revision: revision) }
        return own(in: folder).map(Shareable.file) ?? .none
    }
}

/// exports.json beside a recording's edit: which edit revision each whole export rendered. The window's MP4 export
/// records here; every other export records through `recordExport` (src/utils/recording-editor/exports.ts), the same
/// shape. A part of the edit is never recorded, so it is never handed out as the movie.
enum ExportLedger {
    static let file = "exports.json"

    struct Entry: Codable, Equatable {
        /// edit.json's revision the export rendered; nil when the recording had no edit.json.
        var revision: Int?
        var writtenAt: String

        private enum CodingKeys: String, CodingKey { case revision, writtenAt }

        /// Writes a nil revision as an explicit `null`, the shape `recordExport` writes. Synthesized Codable left the key
        /// out; reading still takes a missing key as nil, as older builds wrote it.
        func encode(to encoder: Encoder) throws {
            var container = encoder.container(keyedBy: CodingKeys.self)
            try container.encode(revision, forKey: .revision)
            try container.encode(writtenAt, forKey: .writtenAt)
        }
    }

    private struct Ledger: Codable {
        var version = 1
        var files: [String: Entry]
    }

    /// The entries, keyed by the export's file name inside the folder, else its absolute path. Empty when unreadable.
    static func read(_ folder: URL) -> [String: Entry] {
        guard let data = try? Data(contentsOf: folder.appendingPathComponent(file)),
              let ledger = try? JSONDecoder().decode(Ledger.self, from: data), ledger.version == 1 else { return [:] }
        return ledger.files
    }

    static func url(of key: String, in folder: URL) -> URL {
        key.hasPrefix("/") ? URL(fileURLWithPath: key) : folder.appendingPathComponent(key)
    }

    /// edit.json's revision, as `editRevisionOf` (src/utils/recording-editor/exports.ts) reads it.
    enum EditRevision: Equatable {
        /// The recording has no edit.json.
        case missing
        /// edit.json's revision; 0 for an edit saved before it had one.
        case known(Int)
        /// edit.json exists but cannot be read or is no edit (no source movie, no clip), so which edit is current is
        /// unknown. Never read as revision 0: a ledger entry for 0 must not match an edit nobody could read.
        case unreadable
    }

    static func editRevision(in folder: URL) -> EditRevision {
        let edit = folder.appendingPathComponent("edit.json")
        guard FileManager.default.fileExists(atPath: edit.path) else { return .missing }
        guard let data = try? Data(contentsOf: edit),
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return .unreadable }
        // An edit at all: the source movie and at least one clip, as every version has. `{}` is no legacy edit.
        guard (object["source"] as? [String: Any])?["video"] is String,
              let clips = object["clips"] as? [Any], !clips.isEmpty else { return .unreadable }
        guard let raw = object["revision"] else { return .known(0) }
        guard let number = raw as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID(),
              number.doubleValue >= 0, number.doubleValue == number.doubleValue.rounded() else { return .unreadable }
        return .known(number.intValue)
    }

    /// Records that `export` is a whole export of the edit at `revision`; entries whose file is gone are dropped. The
    /// read and the write hold `exports.json.lock` (`FileLock`, the lock `recordExport` takes), so an export the CLI
    /// records at the same moment stays in the ledger. It can wait for that lock: call it off the main thread.
    static func record(_ export: URL, revision: Int?, in folder: URL, now: Date = Date()) throws {
        try FileLock.withLock(folder.appendingPathComponent(file)) {
            var files = read(folder).filter { FileManager.default.fileExists(atPath: url(of: $0.key, in: folder).path) }
            let inside = export.deletingLastPathComponent().standardizedFileURL.path == folder.standardizedFileURL.path
            let stamp = ISO8601DateFormatter()
            stamp.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
            files[inside ? export.lastPathComponent : export.standardizedFileURL.path] = Entry(revision: revision, writtenAt: stamp.string(from: now))
            let encoder = JSONEncoder()
            encoder.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
            try encoder.encode(Ledger(files: files)).write(to: folder.appendingPathComponent(file), options: .atomic)
        }
    }
}

/// Which version of a movie file a kept length belongs to: a rewrite in place changes its size or modification date,
/// a replace (a new proxy renamed over the old one) changes its inode.
struct MovieFileIdentity: Hashable, Sendable {
    let path: String
    let inode: UInt64
    let size: UInt64
    let modified: Date

    init?(_ url: URL) {
        guard let attributes = try? FileManager.default.attributesOfItem(atPath: url.path),
              let modified = attributes[.modificationDate] as? Date else { return nil }
        path = url.standardizedFileURL.path
        inode = (attributes[.systemFileNumber] as? NSNumber)?.uint64Value ?? 0
        size = (attributes[.size] as? NSNumber)?.uint64Value ?? 0
        self.modified = modified
    }
}

/// The movie lengths `RecordingMovie.lengthMs` has read, one per path: a newer version of a file replaces the older.
final class MovieLengthCache: @unchecked Sendable {
    private let lock = NSLock()
    private var lengths: [String: (identity: MovieFileIdentity, ms: Double?)] = [:]

    /// The kept answer for this version of the file (itself nil for a file that is not a movie), nil when none is kept.
    func answer(for identity: MovieFileIdentity) -> Double?? {
        lock.lock()
        defer { lock.unlock() }
        guard let kept = lengths[identity.path], kept.identity == identity else { return nil }
        return .some(kept.ms)
    }

    func keep(_ ms: Double?, for identity: MovieFileIdentity) {
        lock.lock()
        defer { lock.unlock() }
        lengths[identity.path] = (identity, ms)
    }
}
