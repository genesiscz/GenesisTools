import Foundation

/// A continuous change on the recorder service (a slider, a drag, a key repeat): one `gesture.begin` at its first
/// step, a `gesture.preview` per step with the ops from the mark, and one `gesture.commit` (one undo step) once it
/// rests for 0.6 s, another change starts, or the window undoes, saves or closes.
struct EditGesture {
    let key: String
    let id: String
    /// The edit when the gesture began: every preview's ops start from it.
    let mark: EditProject
    var ops: [EditOp] = []
    /// The previews sent; only the answer to the newest one is drawn.
    var sent = 0
    /// How far a key-repeated move has gone from the mark, in microseconds.
    var offsetUs: Int64 = 0
    var commit: DispatchWorkItem?
}

/// How the editor changes its edit. The recorder service owns every rule (EditorSession): the window sends ops and
/// draws what the service answers. While no service answers, the same ops run in `tools recorder apply` (the CLI
/// checks the revision too) and the file comes back through the watcher.
extension EditorModel {
    /// How long a continuous change rests before it becomes one undo step.
    static let gestureRest: TimeInterval = 0.6

    /// A change the window's controls make on a copy of the edit (a slider, a toggle, a drag of an item's place):
    /// drawn at once, sent as the ops that name it (EditOpDiff), and merged with the steps that follow within 0.6 s.
    func change(_ build: (inout EditProject) -> Void) {
        var candidate = project
        build(&candidate)
        guard candidate != project else { return }
        let parts = Self.changedParts(project, candidate)
        let key = parts.joined(separator: ",")
        if gesture?.key != key { finishGesture() }
        let mark = gesture?.mark ?? project
        guard let ops = EditOpDiff.ops(from: mark, to: candidate) else {
            HubPerf.log("recorder.editor: a change of \(key) has no op; it was not sent")
            show("This change cannot be sent to the edit.", error: true)
            return
        }
        adopt(candidate, rebuild: parts.contains("clips") || parts.contains("audio"), debounceAudio: parts == ["audio"])
        step(key: key, ops: ops)
    }

    /// A continuous change named by its ops (from the gesture's mark): a zoom dragged in time, a clip edge, the camera.
    /// The window draws each step when the service answers it.
    func continuous(_ key: String, _ ops: [EditOp]) {
        if gesture?.key != key { finishGesture() }
        step(key: key, ops: ops)
    }

    private func step(key: String, ops: [EditOp]) {
        if gesture == nil {
            let id = "g" + UUID().uuidString.prefix(8).lowercased()
            gesture = EditGesture(key: key, id: id, mark: project)
            if session.isOnline {
                session.gesture("gesture.begin", ["gesture": id]) { [weak self] result in
                    if case let .failure(error) = result { self?.show(EditorSession.reason(error), error: true) }
                }
            }
        }
        guard var open = gesture else { return }
        open.ops = ops
        open.sent += 1
        open.commit?.cancel()
        let commit = DispatchWorkItem { [weak self] in self?.finishGesture() }
        open.commit = commit
        gesture = open
        edited = true
        DispatchQueue.main.asyncAfter(deadline: .now() + Self.gestureRest, execute: commit)
        guard session.isOnline else { return }
        let sent = open.sent
        let id = open.id
        session.gesture("gesture.preview", ["gesture": id, "ops": EditOp.objects(ops)]) { [weak self] result in
            guard let self, let current = self.gesture, current.id == id, current.sent == sent else { return }
            switch result {
            case let .success(answer):
                guard answer.superseded != true else { return }
                self.adopt(answer.project, rebuild: answer.project.clips != self.project.clips || answer.project.audio != self.project.audio,
                           debounceAudio: answer.project.clips == self.project.clips)
            case let .failure(error):
                self.show(EditorSession.reason(error), error: true)
            }
        }
    }

    /// Ends the open continuous change: its last ops become one change and one undo step.
    func finishGesture() {
        guard let open = gesture else { return }
        gesture = nil
        open.commit?.cancel()
        edited = false
        guard !open.ops.isEmpty else {
            if session.isOnline { session.gesture("gesture.cancel", ["gesture": open.id]) { _ in } }
            return
        }
        if session.isOnline {
            // The step goes on the Edit menu's stack now: a ⌘Z right after the drag (its commit not answered yet)
            // must name and undo the drag, and the service takes the commit before that undo.
            record(before: open.mark)
            session.edit("gesture.commit", ["gesture": open.id]) { [weak self] result in
                guard let self else { return }
                switch result {
                case let .success(answer):
                    self.adopt(answer.project, rebuild: answer.project.clips != self.project.clips || answer.project.audio != self.project.audio)
                case let .failure(error):
                    if let at = self.undoStack.lastIndex(of: .edit(open.mark)) { self.undoStack.remove(at: at) }
                    self.canUndo = !self.undoStack.isEmpty
                    self.show(EditorSession.reason(error), error: true)
                    self.adopt(open.mark, rebuild: open.mark.clips != self.project.clips || open.mark.audio != self.project.audio)
                }
                self.refetchIfOutsideChanged()
            }
        } else {
            applyOffline(open.ops, before: open.mark) { [weak self] result in
                if case let .failure(failure) = result {
                    self?.show(failure.reason, error: true)
                    self?.adopt(open.mark, rebuild: true)
                }
            }
        }
    }

    /// One change named by its ops: one undo step. `then` gets the edit before and after, to select what was added.
    func edit(_ ops: [EditOp], then: ((_ before: EditProject, _ after: EditProject) -> Void)? = nil,
              failed: ((String) -> Void)? = nil) {
        finishGesture()
        let before = project
        let refused = failed ?? { [weak self] reason in self?.show(reason, error: true) }
        if session.isOnline {
            session.edit("edit.apply", ["ops": EditOp.objects(ops)]) { [weak self] result in
                guard let self else { return }
                switch result {
                case let .success(answer):
                    self.took(answer.project, before: self.project)
                    then?(before, answer.project)
                case let .failure(error): refused(EditorSession.reason(error))
                }
            }
            return
        }
        applyOffline(ops, before: before) { [weak self] result in
            guard let self else { return }
            switch result {
            case .success: then?(before, self.project)
            case let .failure(failure): refused(failure.reason)
            }
        }
    }

    /// The window's own change, saved by the service (or the CLI): one undo step in the Edit menu's names.
    func took(_ next: EditProject, before: EditProject) {
        guard next != before || next != project else { return }
        record(before: before)
        adopt(next, rebuild: next.clips != project.clips || next.audio != project.audio)
    }

    /// One undo step in the Edit menu's names; the service (or the CLI's undo file) holds the step itself.
    func record(before: EditProject) {
        undoStack.append(.edit(before))
        if undoStack.count > 200 { undoStack.removeFirst() }
        redoStack.removeAll()
        historyGeneration += 1
        canUndo = true
        canRedo = false
    }

    /// Draws `next`: the zoom filter told, the movie made again when clips or the sound changed (a sound slider's
    /// steps once it rests for 0.2 s), the paused frame drawn again otherwise.
    func adopt(_ next: EditProject, rebuild rebuildMovie: Bool, debounceAudio: Bool = false) {
        guard next != project else { return }
        project = next
        zoom.update(next)
        canUndo = !undoStack.isEmpty
        canRedo = !redoStack.isEmpty
        guard rebuildMovie else {
            refreshFrame()
            return
        }
        if debounceAudio {
            rebuildSoon?.cancel()
            let work = DispatchWorkItem { [weak self] in self?.rebuild() }
            rebuildSoon = work
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.2, execute: work)
        } else {
            rebuild()
        }
    }

    // MARK: Undo

    /// An undo or redo in flight: its step left one list when it started (`beginMove`), and `counterpart` (the step
    /// that takes it back) went onto the other.
    struct HistoryMove {
        let undoing: Bool
        let step: UndoStep
        let counterpart: UndoStep
        /// Where `step` was in its list.
        let index: Int
        let generation: Int
    }

    /// Moves the last step of the undo (or redo) list to the other list now, before the slow part runs (the service's
    /// answer, the CLI, a movie made again), so a change made meanwhile lands above it and no answer pops a list it
    /// did not read (2026-11-05 review R1.1: a redo answered after an edit popped the emptied list and crashed).
    func beginMove(undoing: Bool, counterpart: UndoStep) -> HistoryMove? {
        guard let step = undoing ? undoStack.popLast() : redoStack.popLast() else { return nil }
        if undoing { redoStack.append(counterpart) } else { undoStack.append(counterpart) }
        refreshUndoState()
        return HistoryMove(undoing: undoing, step: step, counterpart: counterpart,
                           index: undoing ? undoStack.count : redoStack.count, generation: historyGeneration)
    }

    /// The undo or redo did not happen: its counterpart leaves the list it went onto, and the step goes back where it
    /// was; to the redo list only while no new step came since (one empties that list).
    func failMove(_ move: HistoryMove) {
        if move.undoing {
            if let at = redoStack.lastIndex(of: move.counterpart) { redoStack.remove(at: at) }
            undoStack.insert(move.step, at: min(move.index, undoStack.count))
        } else {
            if let at = undoStack.lastIndex(of: move.counterpart) { undoStack.remove(at: at) }
            if historyGeneration == move.generation { redoStack.insert(move.step, at: min(move.index, redoStack.count)) }
        }
        refreshUndoState()
    }

    func undo() {
        finishGesture()
        guard let step = undoStack.last else { return }
        let change = name(of: step, undoing: true)
        if case .display = step {
            undoDisplaySwitch(step, change: change)
            return
        }
        if session.isOnline {
            guard let move = beginMove(undoing: true, counterpart: .edit(project)) else { return }
            session.edit("edit.undo", [:]) { [weak self] result in
                guard let self else { return }
                switch result {
                case let .success(answer):
                    self.adopt(answer.project, rebuild: answer.project.clips != self.project.clips || answer.project.audio != self.project.audio)
                    self.announce("Undid", change)
                case let .failure(error):
                    self.failMove(move)
                    self.show(EditorSession.reason(error), error: true)
                }
            }
            return
        }
        // Without the service each change is its own `tools` process: an undo started beside a running apply could
        // reach the file first.
        guard ownOpsRunning == 0 else {
            show("The last change is still saving; press ⌘Z again in a moment.", error: false)
            return
        }
        guard let move = beginMove(undoing: true, counterpart: .edit(project)) else { return }
        ownOpsRunning += 1
        runTools(["recorder", "undo", store.url.path]) { [weak self] status, _, stderr in
            guard let self else { return }
            defer { self.ownOpsRunning -= 1 }
            guard status == 0, let next = self.readOwnFile() else {
                self.failMove(move)
                self.show(stderr.split(separator: "\n").last.map(String.init) ?? "The undo failed (exit \(status)).", error: true)
                return
            }
            self.store.noteWritten(next.revision)
            // The CLI keeps no redo: nothing to redo until the service runs.
            if let at = self.redoStack.lastIndex(of: move.counterpart) { self.redoStack.remove(at: at) }
            self.refreshUndoState()
            self.adopt(next, rebuild: next.clips != self.project.clips || next.audio != self.project.audio)
            self.announce("Undid", change)
        }
    }

    func redo() {
        finishGesture()
        guard let step = redoStack.last else { return }
        let change = name(of: step, undoing: false)
        if case .display = step {
            redoDisplaySwitch(step, change: change)
            return
        }
        guard session.isOnline else {
            show("Redo needs the recorder service (tools recorder serve); it is not running.", error: true)
            return
        }
        guard let move = beginMove(undoing: false, counterpart: .edit(project)) else { return }
        session.edit("edit.redo", [:]) { [weak self] result in
            guard let self else { return }
            switch result {
            case let .success(answer):
                self.adopt(answer.project, rebuild: answer.project.clips != self.project.clips || answer.project.audio != self.project.audio)
                self.announce("Redid", change)
            case let .failure(error):
                self.failMove(move)
                self.show(EditorSession.reason(error), error: true)
            }
        }
    }

    // MARK: Without the service

    /// The edit file as the CLI left it.
    func readOwnFile() -> EditProject? {
        guard let data = try? Data(contentsOf: store.url) else { return nil }
        return try? EditProject.decode(data, at: store.url)
    }

    /// The ops through `tools recorder apply`, which checks the revision and keeps its own undo file.
    func applyOffline(_ ops: [EditOp], before: EditProject, done: @escaping @MainActor (Result<EditProject, ApplyFailure>) -> Void) {
        runOps(EditOp.json(ops)) { [weak self] result in
            guard let self else { return }
            switch result {
            case let .success(next):
                self.took(next, before: before)
                done(.success(next))
            case let .failure(failure): done(.failure(failure))
            }
        }
    }

    /// Edit ops (a JSON op or list) on the service, or through `tools recorder apply` while none answers; the saved
    /// edit is this window's own change. `done` gets how much shorter the edit got, or the reason it was refused.
    func applyOps(_ ops: String, done: @escaping @MainActor (Result<Int64, ApplyFailure>) -> Void) {
        finishGesture()
        let before = durationUs
        guard let parsed = try? JSONSerialization.jsonObject(with: Data(ops.utf8)) else {
            done(.failure(ApplyFailure(reason: "the ops are not JSON")))
            return
        }
        let list = (parsed as? [Any]) ?? [parsed]
        if session.isOnline {
            session.edit("edit.apply", ["ops": list], timeout: 15 * 60) { [weak self] result in
                guard let self else { return }
                switch result {
                case let .success(answer):
                    if let loudness = answer.loudness { self.measuredLufs = loudness.measuredLufs }
                    self.took(answer.project, before: self.project)
                    done(.success(before - self.durationUs))
                case let .failure(error): done(.failure(ApplyFailure(reason: EditorSession.reason(error))))
                }
            }
            return
        }
        let start = project
        runOps(ops) { [weak self] result in
            guard let self else { return }
            switch result {
            case let .success(next):
                self.took(next, before: start)
                done(.success(before - self.durationUs))
            case let .failure(failure): done(.failure(failure))
            }
        }
    }

    private func runOps(_ ops: String, done: @escaping @MainActor (Result<EditProject, ApplyFailure>) -> Void) {
        ownOpsRunning += 1
        runTools(["recorder", "apply", store.url.path, ops]) { [weak self] status, stdout, stderr in
            guard let self else { return }
            defer { self.ownOpsRunning -= 1 }
            guard status == 0 else {
                done(.failure(ApplyFailure(reason: stderr.split(separator: "\n").last.map(String.init) ?? "exit \(status)")))
                return
            }
            guard let next = self.readOwnFile() else {
                done(.failure(ApplyFailure(reason: "the edit file did not read after the change")))
                return
            }
            // `normalize` prints what it measured.
            let answer = stdout.split(separator: "\n").last.flatMap { try? JSONSerialization.jsonObject(with: Data($0.utf8)) as? [String: Any] }
            if let measured = (answer?["loudness"] as? [String: Any])?["measuredLufs"] as? NSNumber { self.measuredLufs = measured.doubleValue }
            self.store.noteWritten(next.revision)
            done(.success(next))
        }
    }

    /// A REPL method of the recorder (`movie.<name>`) on the service, else the same work through `tools`; the edit it
    /// saved is this window's own change (no outside-edit banner). `done` gets the method's answer, or the reason.
    func movie(_ name: String, _ params: [String: Any] = [:], recording: String? = nil, argv: [String], timeout: TimeInterval = 10 * 60,
               done: @escaping @MainActor (Result<Any?, ApplyFailure>, _ stdout: String) -> Void) {
        finishGesture()
        ownOpsRunning += 1
        let target = recording ?? store.url.path
        if session.isOnline, session.offers("movie.\(name)") {
            session.call("movie.\(name)", params.merging(["recording": target]) { $1 }, timeout: timeout) { [weak self] result in
                guard let self else { return }
                defer { self.ownOpsRunning -= 1 }
                switch result {
                case let .success(value):
                    // The method changed the edit through the service: take it as this window's own change.
                    self.session.refetch { [weak self] next in
                        guard let self else { return }
                        if next != self.project { self.took(next, before: self.project) }
                    }
                    done(.success(value), "")
                case let .failure(error): done(.failure(ApplyFailure(reason: EditorSession.reason(error))), "")
                }
            }
            return
        }
        runTools(argv) { [weak self] status, stdout, stderr in
            guard let self else { return }
            defer { self.ownOpsRunning -= 1 }
            guard status == 0 else {
                done(.failure(ApplyFailure(reason: stderr.split(separator: "\n").last.map(String.init) ?? "exit \(status)")), stdout)
                return
            }
            if let next = self.readOwnFile(), next != self.project {
                self.store.noteWritten(next.revision)
                self.took(next, before: self.project)
            }
            done(.success(nil), stdout)
        }
    }

    /// A REPL method of the recorder that only reads (`movie.lineWords`, `movie.findOnScreen`) on the service, else the
    /// same command through `tools`; `done` gets the answer as JSON, or the failure's last line.
    func ask(_ name: String, _ params: [String: Any] = [:], recording: String? = nil, argv: [String], timeout: TimeInterval = 120,
             done: @escaping @MainActor (Result<Data, ApplyFailure>) -> Void) {
        if session.isOnline, session.offers("movie.\(name)") {
            session.call("movie.\(name)", params.merging(["recording": recording ?? store.url.path]) { $1 }, timeout: timeout) { result in
                switch result {
                case let .success(value):
                    let wrapped: Any = value ?? NSNull()
                    let data = JSONSerialization.isValidJSONObject(wrapped) ? (try? JSONSerialization.data(withJSONObject: wrapped)) : nil
                    done(data.map { .success($0) } ?? .failure(ApplyFailure(reason: "the answer is not JSON")))
                case let .failure(error): done(.failure(ApplyFailure(reason: EditorSession.reason(error))))
                }
            }
            return
        }
        runTools(argv) { status, stdout, stderr in
            guard status == 0 else {
                done(.failure(ApplyFailure(reason: stderr.split(separator: "\n").last.map(String.init) ?? "exit \(status)")))
                return
            }
            done(.success(Data(stdout.utf8)))
        }
    }

    // MARK: Writers outside the window

    /// The service says another writer changed the edit: draw its version (one undo step away), after any drag.
    func outsideChanged() {
        guard gesture == nil else {
            refetchPending = true
            return
        }
        session.refetch { [weak self] next in self?.adoptExternal(next) }
    }

    private func refetchIfOutsideChanged() {
        guard refetchPending else { return }
        refetchPending = false
        outsideChanged()
    }

    /// The file changed on disk. With the service the session is the edit (its own saves and the agents' changes come
    /// as answers and notifications), so only a writer that went round it reaches the window here.
    func fileChanged(_ next: EditProject) {
        if session.isOnline, next.revision <= (session.revision ?? .max) { return }
        adoptExternal(next)
    }

    /// An agent changed the edit file: its version replaces this one, and this one stays one undo away.
    func adoptExternal(_ next: EditProject) {
        guard next != project else { return }
        undoStack.append(.edit(project))
        redoStack.removeAll()
        historyGeneration += 1
        let previous = project
        // An agent that transcribed the movie and turned captions on: read the transcript it cached.
        adopt(next, rebuild: next.clips != project.clips || next.audio != project.audio)
        if next.captions != nil, !hasTranscript { hasTranscript = zoom.reloadCaptions() }
        canUndo = true
        canRedo = false
        // The window's own op names itself in its notice.
        guard ownOpsRunning == 0 else { return }
        if !announceExternal(old: previous, new: next) {
            show("The edit changed on disk (\(next.updatedBy ?? "another process")); ⌘Z brings this version back.", error: false)
        }
    }

    /// The service holds the edit: its version replaces the window's when the session opens.
    func sessionOpened(_ next: EditProject) {
        guard next != project else { return }
        HubPerf.log("recorder.editor: the service's edit (revision \(next.revision)) replaces the window's (revision \(project.revision))")
        adopt(next, rebuild: next.clips.map(\.fromUs) != project.clips.map(\.fromUs) || next.clips.map(\.toUs) != project.clips.map(\.toUs)
            || next.clips.map(\.speed) != project.clips.map(\.speed) || next.audio != project.audio)
    }

    /// ⌘S: the open change ends now; the service saves it a moment later (the CLI at once).
    func saveNow() {
        finishGesture()
    }

    /// The id of the item of `kind` that `after` has and `before` did not.
    static func addedID(_ before: EditProject, _ after: EditProject, _ list: (EditProject) -> [String]) -> String? {
        let had = Set(list(before))
        return list(after).first { !had.contains($0) }
    }
}
