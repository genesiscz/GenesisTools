import AppKit

/// The review comments' actions in the editor: add one at the playhead or over a range, resolve, delete, and go to one.
/// The comments live in comments.jsonl beside the recording (ReviewComments.swift), not in the edit, so they have no
/// undo step; a deleted one stays in the file as the line that removed it.
extension EditorModel {
    /// Adds a comment over what plays from `fromOut` (to `toOut`), stored at the source times there.
    func addComment(fromOut: Int64, toOut: Int64?, text: String) {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        let atUs = TimelineMap.sourceTime(atOutput: fromOut, in: project)
        let toUs = toOut.map { TimelineMap.sourceTime(atOutput: $0, in: project) }
        do {
            try commentsStore.add(atUs: atUs, toUs: toUs, text: trimmed)
            show("Added a comment at \(formatClock(fromOut, tenths: true)).", error: false)
        } catch {
            show("The comment was not saved: \(error.localizedDescription)", error: true)
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
        do {
            try commentsStore.update(id) { $0.resolved = resolved }
        } catch {
            show("The comment was not changed: \(error.localizedDescription)", error: true)
        }
    }

    func deleteComment(_ id: String) {
        do {
            try commentsStore.remove(id)
            if openComment == id { openComment = nil }
        } catch {
            show("The comment was not removed: \(error.localizedDescription)", error: true)
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
