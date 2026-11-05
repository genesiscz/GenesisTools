import AppKit

/// The review comments' actions in the editor: add one at the playhead or over a range, resolve, delete, and go to one.
/// The comments live in comments.jsonl beside the recording, not in the edit, so they have no undo step; the TypeScript
/// side writes them (src/utils/recording-editor/comments.ts) and the window reads the file (ReviewComments.swift).
extension EditorModel {
    /// Adds a comment over what plays from `fromOut` (to `toOut`), stored at the source times there: the REPL's
    /// comment() on the recorder service, else `tools recorder comment --source`. `link` is the page it came from: a
    /// vitrinka annotation's link, or the board's link with `annotation`, the annotation's number; the recorder writes
    /// the annotation's link from them (src/recorder/lib/board-comments.ts `commentLink`), so the comment opens it.
    func addComment(fromOut: Int64, toOut: Int64?, text: String, link: String? = nil, annotation: Int? = nil) {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        let at = EditOpDiff.seconds(TimelineMap.sourceTime(atOutput: fromOut, in: project))
        let to = toOut.map { EditOpDiff.seconds(TimelineMap.sourceTime(atOutput: $0, in: project)) }
        var params: [String: Any] = ["at": at, "text": trimmed, "source": true]
        var argv = ["recorder", "comment", recordingTarget, String(format: "%.6f", at), trimmed, "--source"]
        if let to {
            params["to"] = to
            argv += ["--to", String(format: "%.6f", to)]
        }
        if let page = link?.trimmingCharacters(in: .whitespacesAndNewlines), !page.isEmpty {
            params["link"] = page
            argv += ["--link", page]
        }
        if let annotation {
            params["annotation"] = annotation
            argv += ["--annotation", String(annotation)]
        }
        if !NSFullUserName().isEmpty {
            params["author"] = NSFullUserName()
            argv += ["--author", NSFullUserName()]
        }
        commentCall("comment", params, argv: argv, failed: "The comment was not saved") { [weak self] in
            self?.show("Added a comment at \(formatClock(fromOut, tenths: true)).", error: false)
        }
    }

    /// The recording the comment commands name: its folder for a library recording, else the edit file.
    private var recordingTarget: String {
        let folder = URL(fileURLWithPath: project.source.video).deletingLastPathComponent()
        return FileManager.default.fileExists(atPath: folder.appendingPathComponent("recording.json").path) ? folder.path : store.url.path
    }

    /// A comment method of the recorder: comments.jsonl changes, and the store's watcher shows it.
    private func commentCall(_ name: String, _ params: [String: Any], argv: [String], failed: String, done: @escaping @MainActor () -> Void) {
        ask(name, params, recording: recordingTarget, argv: argv) { [weak self] result in
            guard let self else { return }
            switch result {
            case .success:
                self.commentsStore.reload()
                done()
            case let .failure(failure): self.show("\(failed): \(failure.reason)", error: true)
            }
        }
    }

    /// The annotation number typed in the comment sheet ("12" or "#12"); nil when the field is empty.
    nonisolated static func annotationNumber(_ typed: String) throws -> Int? {
        let trimmed = typed.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }
        guard let number = Int(trimmed.hasPrefix("#") ? String(trimmed.dropFirst()) : trimmed), number > 0 else {
            throw ApplyFailure(reason: "the annotation is its number on the board, such as 12, not “\(trimmed)”")
        }
        return number
    }

    /// Asks for the comment's words, and optionally the page it came from (a board annotation's link, or the board's
    /// link and the annotation's number), then adds it at the playhead (or over `range`).
    func commentPrompt(range: TimelineRange? = nil) {
        let from = range?.fromUs ?? clock.outUs
        let alert = NSAlert()
        alert.messageText = range == nil ? "Comment at \(formatClock(from, tenths: true))"
            : "Comment on \(formatClock(from, tenths: true)) – \(formatClock(range?.toUs ?? from, tenths: true))"
        alert.informativeText = "It shows as a marker on the timeline, and tools recorder comments lists it. A board annotation's link, or the board's link and the annotation's number, makes it open that annotation."
        let field = NSTextField(string: "")
        field.placeholderString = "What should change here?"
        let page = NSTextField(string: "")
        page.placeholderString = "Link (optional): a board annotation, a board, a PR"
        let number = NSTextField(string: "")
        number.placeholderString = "Annotation number on that board (optional)"
        let fields = NSView(frame: NSRect(x: 0, y: 0, width: 320, height: 88))
        for (row, each) in [number, page, field].enumerated() {
            each.frame = NSRect(x: 0, y: CGFloat(row) * 32, width: 320, height: 24)
            fields.addSubview(each)
        }
        field.nextKeyView = page
        page.nextKeyView = number
        alert.accessoryView = fields
        alert.addButton(withTitle: "Add Comment")
        alert.addButton(withTitle: "Cancel")
        alert.window.initialFirstResponder = field
        guard alert.runModal() == .alertFirstButtonReturn else { return }
        do {
            addComment(fromOut: from, toOut: range?.toUs, text: field.stringValue, link: page.stringValue,
                       annotation: try Self.annotationNumber(number.stringValue))
        } catch {
            show("The comment was not saved: \((error as? ApplyFailure)?.reason ?? error.localizedDescription)", error: true)
        }
    }

    func resolveComment(_ id: String, _ resolved: Bool) {
        var argv = ["recorder", "resolve", recordingTarget, id]
        if !resolved { argv.append("--reopen") }
        commentCall("resolveComment", ["id": id, "resolved": resolved], argv: argv, failed: "The comment was not changed") {}
    }

    func deleteComment(_ id: String) {
        commentCall("uncomment", ["id": id], argv: ["recorder", "uncomment", recordingTarget, id], failed: "The comment was not removed") { [weak self] in
            if self?.openComment == id { self?.openComment = nil }
        }
    }

    /// Moves the playhead to a comment and opens its popover; a comment on a cut moment goes to the next kept one.
    func goToComment(_ comment: ReviewComment) {
        let out = TimelineMap.outputTime(ofSource: comment.atUs, in: project)
            ?? TimelineMap.placed(project).first { $0.clip.fromUs >= comment.atUs }?.outStartUs ?? durationUs
        player.pause()
        seek(out)
        openComment = comment.id
    }
}
