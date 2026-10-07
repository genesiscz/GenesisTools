import Foundation

/// A review comment written in the review window. It starts local (for the agent working in the
/// repository) and may later become a GitHub / GitLab review draft or a posted comment
/// (handoff h_3te8zv19). It is anchored to the TEXT of the commented lines, not only their numbers,
/// so it survives reloads and edits above it, and goes `outdated` when that text is gone.
struct ReviewComment: Codable, Identifiable, Equatable {
    enum State: String, Codable {
        case local, sent, draft, posted
    }

    var id: String
    var path: String
    var side: DiffSide
    var startLine: Int
    var endLine: Int
    var body: String
    var createdAt: Date
    var updatedAt: Date
    var state: State
    /// The commented lines as they read when the comment was written.
    var anchor: [String]
    /// Up to two lines above and below, used to pick the right copy when the anchor repeats.
    var before: [String]
    var after: [String]
    var outdated = false
    var sentAt: Date?
    var remoteDraftID: String?
    var remoteOwner: PRDraftOwnership?
}

/// `~/.genesis-tools/review/<repo key>/comments.json`, written atomically on every change.
final class ReviewCommentStore {
    let directory: URL
    private(set) var comments: [ReviewComment] = []
    /// Set when an unreadable comments.json could not be moved aside: saving would overwrite it.
    private var saveBlocked = false

    private var file: URL { directory.appendingPathComponent("comments.json") }

    init(repo: URL, directory override: URL? = nil) {
        let key = repo.path.map { $0.isLetter || $0.isNumber ? String($0) : "-" }.joined()
        directory = override ?? FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent(".genesis-tools/review", isDirectory: true)
            .appendingPathComponent(key, isDirectory: true)
        load()
    }

    // MARK: edits

    @discardableResult
    func add(_ input: CommentInput, files: [DiffFile]) -> ReviewComment? {
        guard let file = files.first(where: { $0.id == input.fileID }) else { return nil }
        let lines = Self.lines(of: file, side: input.side)
        let start = max(1, min(input.startLine, input.endLine))
        let end = min(lines.count, max(input.startLine, input.endLine))
        guard start <= end else { return nil }

        let now = Date()
        let comment = ReviewComment(
            id: "c_\(UUID().uuidString.prefix(8).lowercased())",
            path: file.path,
            side: input.side,
            startLine: start,
            endLine: end,
            body: input.body,
            createdAt: now,
            updatedAt: now,
            state: .local,
            anchor: Array(lines[(start - 1)..<end]),
            before: Array(lines[max(0, start - 3)..<(start - 1)]),
            after: Array(lines[end..<min(lines.count, end + 2)])
        )
        comments.append(comment)
        save()
        return comment
    }

    func edit(id: String, body: String) {
        guard let index = comments.firstIndex(where: { $0.id == id }) else { return }
        comments[index].body = body
        comments[index].updatedAt = Date()
        save()
    }

    func delete(id: String) {
        comments.removeAll { $0.id == id }
        save()
    }

    func markSent(_ ids: [String]) {
        let now = Date()
        for index in comments.indices where ids.contains(comments[index].id) {
            comments[index].state = .sent
            comments[index].sentAt = now
        }
        save()
    }

    /// A comment that went to the PR: a pending review draft, or published.
    func mark(_ id: String, _ state: ReviewComment.State, remoteID: String? = nil, owner: PRDraftOwnership? = nil) {
        guard let index = comments.firstIndex(where: { $0.id == id }) else { return }
        comments[index].state = state
        if let owner { comments[index].remoteOwner = owner }
        if let remoteID {
            comments[index].remoteDraftID = remoteID
        }
        comments[index].updatedAt = Date()
        save()
    }

    func reconcileSubmitted(pr: PRIdentity, ids: Set<String>) {
        var changed = false
        for index in comments.indices {
            guard comments[index].state == .draft, let owner = comments[index].remoteOwner,
                  owner.pr == pr, owner.draftID == comments[index].remoteDraftID, ids.contains(owner.draftID) else { continue }
            comments[index].state = .posted
            comments[index].updatedAt = Date()
            changed = true
        }
        if changed { save() }
    }

    // MARK: anchoring

    /// Moves every comment of a file in `files` to where its anchor text is now. Returns true when
    /// any comment moved or changed outdated state. Comments on files that are not in the diff are
    /// left alone (the file may simply be clean now).
    @discardableResult
    func reanchor(files: [DiffFile]) -> Bool {
        var changed = false
        let byPath = Self.filesByPath(files)
        var split: [String: [String]] = [:]
        for index in comments.indices {
            let comment = comments[index]
            guard let file = byPath[comment.path] else { continue }
            let key = file.id + ":" + comment.side.rawValue
            let lines = split[key] ?? Self.lines(of: file, side: comment.side)
            split[key] = lines
            if comment.path != file.path {
                comments[index].path = file.path
                changed = true
            }
            if let start = Self.locate(comment, in: lines) {
                let end = start + comment.anchor.count - 1
                if start != comment.startLine || end != comment.endLine || comment.outdated {
                    comments[index].startLine = start
                    comments[index].endLine = end
                    comments[index].outdated = false
                    changed = true
                }
            } else if !comment.outdated {
                comments[index].outdated = true
                changed = true
            }
        }

        if changed {
            save()
        }

        return changed
    }

    /// The copy of the anchor whose surroundings match best; ties go to the one nearest the old line.
    static func locate(_ comment: ReviewComment, in lines: [String]) -> Int? {
        let count = comment.anchor.count
        guard count > 0, lines.count >= count else { return nil }

        let original = comment.startLine - 1

        var best: (index: Int, score: Int, distance: Int)?
        for index in 0...(lines.count - count) where lines[index] == comment.anchor[0] {
            guard Array(lines[index..<(index + count)]) == comment.anchor else { continue }
            let above = Array(lines[max(0, index - comment.before.count)..<index])
            let below = Array(lines[(index + count)..<min(lines.count, index + count + comment.after.count)])
            let score = zip(above.reversed(), comment.before.reversed()).filter { $0 == $1 }.count
                + zip(below, comment.after).filter { $0 == $1 }.count
            let distance = abs(index - original)
            if best == nil || score > best!.score || (score == best!.score && distance < best!.distance) {
                best = (index, score, distance)
            }
        }

        return best.map { $0.index + 1 }
    }

    private static func filesByPath(_ files: [DiffFile]) -> [String: DiffFile] {
        var result = Dictionary(files.map { ($0.path, $0) }, uniquingKeysWith: { first, _ in first })
        for file in files {
            if let old = file.oldPath, result[old] == nil { result[old] = file }
        }
        return result
    }

    static func lines(of file: DiffFile, side: DiffSide) -> [String] {
        let text = (side == .additions ? file.newContents : file.oldContents) ?? ""
        var lines = text.components(separatedBy: "\n")
        if text.hasSuffix("\n") {
            lines.removeLast()
        }

        return lines
    }

    // MARK: rendering and sending

    func rendered(for files: [DiffFile], now: Date = Date()) -> [RenderedComment] {
        let formatter = RelativeDateTimeFormatter()
        formatter.unitsStyle = .short
        let byPath = Self.filesByPath(files)
        return comments.compactMap { comment in
            guard !comment.outdated, let file = byPath[comment.path] else { return nil }
            return RenderedComment(
                id: comment.id,
                fileId: file.id,
                side: comment.side,
                startLine: comment.startLine,
                endLine: comment.endLine,
                body: comment.body,
                author: "You",
                when: formatter.localizedString(for: comment.updatedAt, relativeTo: now),
                state: comment.state.rawValue,
                remote: false
            )
        }
    }

    /// One markdown message for the agent: every comment with the code it points at.
    func agentMessage(repo: URL, branch: String, files: [DiffFile], ids: [String]) -> String {
        let selected = Set(ids)
        let byPath = Self.filesByPath(files)
        var split: [String: [String]] = [:]
        let chosen = comments
            .filter { selected.contains($0.id) }
            .sorted { ($0.path, $0.startLine) < ($1.path, $1.startLine) }
        // The folder too: a review of several repositories sends one section per repository, and each
        // file path below is relative to its own.
        var out = "Review comments on \(repo.lastPathComponent) (\(branch)) in \(repo.path). Address each one and reply with what you changed for each.\n"

        for (index, comment) in chosen.enumerated() {
            let lineRange = comment.startLine == comment.endLine ? "\(comment.endLine)" : "\(comment.startLine)-\(comment.endLine)"
            let sideLabel = comment.side == .additions ? "new" : "old"
            out += "\n--- \(index + 1) of \(chosen.count) ---\n"
            out += "File: \(comment.path)\n"
            out += "Lines: \(lineRange) (\(sideLabel) side)\(comment.outdated ? " [outdated: the code moved or is gone]" : "")\n"
            out += "User comment: \"\(comment.body.replacingOccurrences(of: "\"", with: "\\\""))\"\n"
            let key = comment.path + ":" + comment.side.rawValue
            let lines = split[key] ?? byPath[comment.path].map { Self.lines(of: $0, side: comment.side) } ?? []
            split[key] = lines
            let ext = (comment.path as NSString).pathExtension
            out += "Code:\n```\(ext)\n"
            if !lines.isEmpty && !comment.outdated {
                let from = max(1, comment.startLine - 2)
                let to = min(lines.count, comment.endLine + 2)
                for number in from...to {
                    let marker = number >= comment.startLine && number <= comment.endLine ? ">" : " "
                    out += "\(marker)\(String(number).leftPadded(to: 5)) \(lines[number - 1])\n"
                }
            } else {
                out += comment.anchor.joined(separator: "\n") + "\n"
            }
            out += "```\n"
        }

        return out
    }

    // MARK: persistence


    private struct Patch {
        let before: ReviewComment?
        let after: ReviewComment?

        func apply(to rows: inout [ReviewComment]) {
            guard let before else {
                if let after, !rows.contains(where: { $0.id == after.id }) { rows.append(after) }
                return
            }
            guard let after else {
                rows.removeAll { $0.id == before.id }
                return
            }
            guard let index = rows.firstIndex(where: { $0.id == before.id }) else { return }
            func changed<T: Equatable>(_ key: WritableKeyPath<ReviewComment, T>) {
                if before[keyPath: key] != after[keyPath: key] { rows[index][keyPath: key] = after[keyPath: key] }
            }
            changed(\.path); changed(\.side); changed(\.startLine); changed(\.endLine)
            changed(\.body); changed(\.updatedAt); changed(\.state)
            changed(\.anchor); changed(\.before); changed(\.after); changed(\.outdated)
            changed(\.sentAt); changed(\.remoteDraftID); changed(\.remoteOwner)
        }
    }

    /// A change written to disk in the background. A failed change stays pending, marked, until a
    /// later write carries it.
    private struct Pending {
        let id: UUID
        let patches: [Patch]
        var failed = false
    }

    /// The changes of one store that are not on disk yet, read by the writer queue when a write
    /// RUNS: a write takes the unwritten changes up to its own, in order, and drops them once they
    /// are saved. A later edit therefore never reaches disk without the addition it depends on, a
    /// change that is already saved is never replayed over another store's newer edit, and a change
    /// is never written before another store's write that was queued ahead of it.
    private final class Unwritten: @unchecked Sendable {
        private let lock = NSLock()
        private var changes: [Pending] = []

        func append(_ change: Pending) {
            lock.lock(); defer { lock.unlock() }
            changes.append(change)
        }

        /// The unwritten changes up to and including `id`: a write never pulls a change queued
        /// after it ahead of another store's write that was queued in between.
        func through(_ id: UUID) -> [Pending] {
            lock.lock(); defer { lock.unlock() }
            guard let end = changes.firstIndex(where: { $0.id == id }) else { return [] }
            return Array(changes[...end])
        }

        func remove(_ ids: Set<UUID>) {
            lock.lock(); defer { lock.unlock() }
            changes.removeAll { ids.contains($0.id) }
        }
    }
    private let unwritten = Unwritten()
    static let writer = DispatchQueue(label: "review.comments.writer", qos: .utility)
    private static let registryLock = NSLock()
    private static let registry = NSHashTable<ReviewCommentStore>.weakObjects()
    static let changed = Notification.Name("ReviewCommentStore.changed")
    private var projection: [ReviewComment] = []
    private var pending: [Pending] = []
    private(set) var saveError: String?

    private static func read(_ file: URL) throws -> [ReviewComment] {
        guard FileManager.default.fileExists(atPath: file.path) else { return [] }
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        return try decoder.decode([ReviewComment].self, from: Data(contentsOf: file))
    }

    private func load() {
        do {
            comments = try Self.read(file)
            projection = comments
        } catch {
            saveBlocked = true
            saveError = "Comments could not be read; the original file was preserved."
            FileHandle.standardError.write(Data("review comments: could not read \(file.path): \(error)\n".utf8))
        }
        Self.registryLock.lock()
        Self.registry.add(self)
        Self.registryLock.unlock()
    }

    private func save() {
        guard !saveBlocked else {
            comments = projection
            NotificationCenter.default.post(name: Self.changed, object: self)
            return
        }
        let old = Dictionary(projection.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
        let new = Dictionary(comments.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
        let patches = comments.compactMap { row -> Patch? in
            old[row.id] == row ? nil : Patch(before: old[row.id], after: row)
        } + projection.filter { new[$0.id] == nil }.map { Patch(before: $0, after: nil) }
        guard !patches.isEmpty else { return }
        let change = Pending(id: UUID(), patches: patches)
        pending.append(change)
        unwritten.append(change)
        projection = comments
        let target = file
        let queue = unwritten
        Self.writer.async {
            let batch = queue.through(change.id)
            let covered = Set(batch.map(\.id))
            let result = Result { () throws -> [ReviewComment] in
                try FileManager.default.createDirectory(at: target.deletingLastPathComponent(), withIntermediateDirectories: true)
                return try FileLock.withLock(target) {
                    var rows = try Self.read(target)
                    guard !batch.isEmpty else { return rows }
                    batch.flatMap(\.patches).forEach { $0.apply(to: &rows) }
                    let encoder = JSONEncoder()
                    encoder.dateEncodingStrategy = .iso8601
                    encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
                    try encoder.encode(rows).write(to: target, options: .atomic)
                    return rows
                }
            }
            if case .success = result { queue.remove(covered) }
            DispatchQueue.main.async {
                switch result {
                case .success(let rows):
                    self.pending.removeAll { covered.contains($0.id) }
                    Self.registryLock.lock()
                    let stores = Self.registry.allObjects.filter { $0.file == target }
                    Self.registryLock.unlock()
                    for store in stores {
                        var visible = rows
                        store.pending.flatMap(\.patches).forEach { $0.apply(to: &visible) }
                        store.comments = visible
                        store.projection = visible
                        if !store.pending.contains(where: \.failed) { store.saveError = nil }
                        NotificationCenter.default.post(name: Self.changed, object: store)
                    }
                case .failure(let error):
                    for index in self.pending.indices where covered.contains(self.pending[index].id) {
                        self.pending[index].failed = true
                    }
                    self.saveError = "Comment changes could not be saved yet; they are retried with the next change: \(error.localizedDescription)"
                    FileHandle.standardError.write(Data("review comments: could not write \(target.path): \(error)\n".utf8))
                    NotificationCenter.default.post(name: Self.changed, object: self)
                }
            }
        }
    }

    func flush() async {
        await withCheckedContinuation { continuation in
            Self.writer.async { DispatchQueue.main.async { continuation.resume() } }
        }
    }

}

private extension String {
    func leftPadded(to width: Int) -> String {
        count >= width ? self : String(repeating: " ", count: width - count) + self
    }
}
