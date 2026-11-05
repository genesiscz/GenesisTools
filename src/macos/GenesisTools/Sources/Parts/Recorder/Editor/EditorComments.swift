import AppKit

/// The review comments' actions in the editor: add one at the playhead or over a range, resolve, delete, and go to one.
/// The comments live in comments.jsonl beside the recording, not in the edit, so they have no undo step; the TypeScript
/// side writes them (src/utils/recording-editor/comments.ts) and the window reads the file (ReviewComments.swift).
extension EditorModel {
    /// Adds a comment over what plays from `fromOut` (to `toOut`), stored at the source times there: the REPL's
    /// comment() on the recorder service, else `tools recorder comment --source`.
    func addComment(fromOut: Int64, toOut: Int64?, text: String) {
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

    /// Asks for the comment's words, then adds it at the playhead (or over `range`).
    func commentPrompt(range: TimelineRange? = nil) {
        let from = range?.fromUs ?? clock.outUs
        let alert = NSAlert()
        alert.messageText = range == nil ? "Comment at \(formatClock(from, tenths: true))"
            : "Comment on \(formatClock(from, tenths: true)) – \(formatClock(range?.toUs ?? from, tenths: true))"
        alert.informativeText = "It shows as a marker on the timeline, and tools recorder comments lists it."
        let field = NSTextField(string: "")
        field.placeholderString = "What should change here?"
        field.frame = NSRect(x: 0, y: 0, width: 320, height: 24)
        alert.accessoryView = field
        alert.addButton(withTitle: "Add Comment")
        alert.addButton(withTitle: "Cancel")
        alert.window.initialFirstResponder = field
        guard alert.runModal() == .alertFirstButtonReturn else { return }
        addComment(fromOut: from, toOut: range?.toUs, text: field.stringValue)
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
