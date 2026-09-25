import Foundation

// Keyboard-first review: the page (web/diff-viewer/main.ts) posts a `key` message for j k r e x f n p s
// while the diff has the keyboard and no box, composer or find field is focused; ? and Esc stay on the
// page (the key list). Swift keeps the state (which card j / k is on, the Fix selection) and acts.

enum ReviewKey: String {
    case nextThread = "j"
    case previousThread = "k"
    case reply = "r"
    case resolve = "e"
    case select = "x"
    case fix = "f"
    case nextFile = "n"
    case previousFile = "p"
    case submit = "s"
}

/// What a `--snapshot` run does before it captures, so the keys and the Fix selection can be checked
/// without a screen: `--select-open <n>`, `--step-threads <n>` (j), `--reply` (r), `--keys` (?), `--fix-form`.
struct ReviewSnapshotDemo {
    var keys = false
    var selectOpen = 0
    var steps = 0
    var reply = false
    /// `--toggle`: x on the marked thread (it joins the Fix selection).
    var toggle = false
    var fixForm = false
    /// `--blame <path>:<line>`: that line's agent blame tip, as a hover would show it.
    var blame: (path: String, line: Int)?

    private var needsPR: Bool { keys || selectOpen > 0 || steps > 0 || reply || toggle || fixForm }

    static func blameTarget(_ value: String?) -> (path: String, line: Int)? {
        guard let value, let colon = value.lastIndex(of: ":"), let line = Int(value[value.index(after: colon)...]) else { return nil }
        return (String(value[..<colon]), line)
    }

    /// Waits for the PR threads (a half-second check, 20 s at most), acts, then calls `done`.
    func apply(to model: ReviewModel, waited: Double = 0, done: @escaping () -> Void) {
        guard needsPR else { return applyBlame(to: model, done: done) }
        // A standalone window attaches its branch's PR once the repo facts load, after the first render.
        if !(model.pr?.settled ?? false), waited < 20 {
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) {
                apply(to: model, waited: waited + 0.5, done: done)
            }
            return
        }

        let open = (model.pr?.payload?.threads ?? []).filter { !$0.resolved && !$0.outdated && !$0.isMyDraft }
        if selectOpen > 0 {
            model.selectedThreads = Set(open.prefix(selectOpen).map(\.id))
        }
        for _ in 0..<steps {
            model.handleKey(.nextThread)
        }
        if toggle {
            model.handleKey(.select)
        }
        if reply {
            model.handleKey(.reply)
        }
        if keys {
            model.renderer.showKeys(true)
        }
        if fixForm {
            model.showsFixFormInline = true
        }
        HubPerf.log("review.snapshot demo: \(open.count) open threads, \(model.selectedThreads.count) selected, focused \(model.focusedCard ?? "none")")
        // The Fix form's plan is a `tools hub pr fix --dry-run` that searches the sessions.
        DispatchQueue.main.asyncAfter(deadline: .now() + (fixForm ? 8 : 1)) {
            applyBlame(to: model, done: done)
        }
    }

    /// Asks for the file's blame as a hover does, then shows the line's tip (20 s at most).
    private func applyBlame(to model: ReviewModel, waited: Double = 0, done: @escaping () -> Void) {
        guard let blame else { return done() }
        if !model.requestBlame(path: blame.path), waited < 20 {
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) {
                applyBlame(to: model, waited: waited + 0.5, done: done)
            }
            return
        }
        model.showBlame(path: blame.path, line: blame.line)
        HubPerf.log("review.snapshot demo: blame \(blame.path):\(blame.line) after \(waited) s")
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.5, execute: done)
    }
}

enum ReviewKeyNav {
    /// The live PR thread cards in the order the diff shows them: file by file, then by line.
    static func threadCards(_ comments: [RenderedComment], files: [DiffFile]) -> [RenderedComment] {
        let order = Dictionary(files.enumerated().map { ($1.id, $0) }, uniquingKeysWith: { first, _ in first })
        return comments
            .filter { $0.kind == "thread" && $0.live != nil }
            .sorted { (order[$0.fileId] ?? .max, $0.endLine, $0.id) < (order[$1.fileId] ?? .max, $1.endLine, $1.id) }
    }

    /// The card j / k lands on. From no card, j starts at the first card in or after the selected file
    /// and k at the last card before or in it; both wrap around at the ends.
    static func step(_ cards: [RenderedComment], from current: String?, by delta: Int, files: [DiffFile], selectedFile: String?) -> String? {
        guard !cards.isEmpty else { return nil }
        if let current, let index = cards.firstIndex(where: { $0.id == current }) {
            return cards[(index + delta % cards.count + cards.count) % cards.count].id
        }

        let order = Dictionary(files.enumerated().map { ($1.id, $0) }, uniquingKeysWith: { first, _ in first })
        let here = selectedFile.flatMap { order[$0] } ?? 0
        if delta > 0 {
            return (cards.first { (order[$0.fileId] ?? .max) >= here } ?? cards[0]).id
        }
        return (cards.last { (order[$0.fileId] ?? .max) <= here } ?? cards[cards.count - 1]).id
    }

    /// n / p: the next or previous file, stopping at the ends.
    static func stepFile(_ files: [DiffFile], from selected: String?, by delta: Int) -> String? {
        guard !files.isEmpty else { return nil }
        let index = selected.flatMap { id in files.firstIndex { $0.id == id } }
        guard let index else { return files[delta > 0 ? 0 : files.count - 1].id }
        return files[min(max(index + delta, 0), files.count - 1)].id
    }

    /// `live:<id>` and a proposal's `thread:<id>` name the same PR thread.
    static func threadID(ofCard id: String) -> String {
        for prefix in ["live:", "thread:"] where id.hasPrefix(prefix) {
            return String(id.dropFirst(prefix.count))
        }
        return id
    }
}
