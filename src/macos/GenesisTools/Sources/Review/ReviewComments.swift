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
}

/// `~/.genesis-tools/review/<repo key>/comments.json`, written atomically on every change.
final class ReviewCommentStore {
    let directory: URL
    private(set) var comments: [ReviewComment] = []
    /// Set when an unreadable comments.json could not be moved aside: saving would overwrite it.
    private var saveBlocked = false

    private var file: URL { directory.appendingPathComponent("comments.json") }

    init(repo: URL) {
        let key = repo.path.map { $0.isLetter || $0.isNumber ? String($0) : "-" }.joined()
        directory = FileManager.default.homeDirectoryForCurrentUser
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
    func mark(_ id: String, _ state: ReviewComment.State, remoteID: String? = nil) {
        guard let index = comments.firstIndex(where: { $0.id == id }) else { return }
        comments[index].state = state
        if let remoteID {
            comments[index].remoteDraftID = remoteID
        }
        comments[index].updatedAt = Date()
        save()
    }

    // MARK: anchoring

    /// Moves every comment of a file in `files` to where its anchor text is now. Returns true when
    /// any comment moved or changed outdated state. Comments on files that are not in the diff are
    /// left alone (the file may simply be clean now).
    @discardableResult
    func reanchor(files: [DiffFile]) -> Bool {
        var changed = false
        for index in comments.indices {
            let comment = comments[index]
            guard let file = files.first(where: { $0.path == comment.path }) else { continue }
            let lines = Self.lines(of: file, side: comment.side)
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
        if original >= 0, original + count <= lines.count, Array(lines[original..<(original + count)]) == comment.anchor {
            return comment.startLine
        }

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
        return comments.compactMap { comment in
            guard !comment.outdated, let file = files.first(where: { $0.path == comment.path }) else { return nil }
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
        let chosen = comments
            .filter { ids.contains($0.id) }
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
            let lines = files.first(where: { $0.path == comment.path }).map { Self.lines(of: $0, side: comment.side) } ?? []
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

    private func load() {
        guard let data = try? Data(contentsOf: file) else { return }
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        do {
            comments = try decoder.decode([ReviewComment].self, from: data)
        } catch {
            // The next save would replace the file with only the new comments, so keep the unreadable
            // one under another name first: one bad record (a newer build's state) must not erase the rest.
            let stamp = ISO8601DateFormatter().string(from: Date()).replacingOccurrences(of: ":", with: "-")
            let backup = directory.appendingPathComponent("comments.unreadable-\(stamp).json")
            let moved = (try? FileManager.default.moveItem(at: file, to: backup)) != nil
            saveBlocked = !moved
            FileHandle.standardError.write(Data("review comments: \(file.path) unreadable (\(moved ? "kept as \(backup.path)" : "could not move it aside")): \(error)\n".utf8))
        }
    }

    private func save() {
        if saveBlocked {
            FileHandle.standardError.write(Data("review comments: not saving over the unreadable \(file.path)\n".utf8))
            return
        }

        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        do {
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            try encoder.encode(comments).write(to: file, options: .atomic)
        } catch {
            FileHandle.standardError.write(Data("review comments: could not write \(file.path): \(error)\n".utf8))
        }
    }
}

private extension String {
    func leftPadded(to width: Int) -> String {
        count >= width ? self : String(repeating: " ", count: width - count) + self
    }
}
