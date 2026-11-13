import Foundation

// MARK: - The transcript beside the sound (F9): marks per line, comments for the listening agent, and a pin's row

extension MeetingDetailModel {
    // MARK: Marks (G57)

    /// The marks of each transcript line: a speaker hint's range covers it (the engine is unsure who spoke), a confirmed
    /// word item changed it, or a staged comment covers it. Built once per read of the parts it comes from, never per tick.
    static func lineMarks(entries: [TranscriptLine], hints: [SpeakerHint], items: [MeetingItem],
                          comments: [MeetingComment]) -> [String: Set<TranscriptLineMark>] {
        var unclear: [ClosedRange<Double>] = []
        for hint in hints {
            for range in hint.ranges ?? [] {
                if let from = range.fromSec, let to = range.toSec, to >= from { unclear.append(from...to) }
            }
        }
        let corrected: [ClosedRange<Double>] = items.compactMap { item in
            guard item.status == "confirmed", item.kind == "term", let from = item.fromSec ?? item.atSec else { return nil }
            return from...max(from, item.toSec ?? from)
        }
        let commented: [ClosedRange<Double>] = comments.filter { $0.state == "staged" }.compactMap { comment in
            switch comment.target {
            case .selection(let from, let to): return from.atSec...max(from.atSec, to.atSec)
            case .range(let from, let to): return from...max(from, to)
            case .time(let at), .stretch(let at, _): return at...at
            case .item: return nil
            }
        }
        var marks: [String: Set<TranscriptLineMark>] = [:]
        guard !unclear.isEmpty || !corrected.isEmpty || !commented.isEmpty else { return marks }
        for entry in entries {
            guard let start = entry.startSec else { continue }
            var set: Set<TranscriptLineMark> = []
            if unclear.contains(where: { $0.contains(start) }) { set.insert(.unclearSpeaker) }
            if corrected.contains(where: { $0.contains(start) }) { set.insert(.corrected) }
            if commented.contains(where: { $0.contains(start) }) { set.insert(.commented) }
            if !set.isEmpty { marks[entry.rowID] = set }
        }
        return marks
    }

    // MARK: Comments for the listening agent (R43, G60)

    /// Save selected audio into the meeting, independently of the playback stack and its temporary cache.
    func saveSelectionClip(_ selection: TranscriptSelection, length: Double, saved: @escaping () -> Void) {
        guard !busy.contains("clip.save") else { return }
        busy.insert("clip.save")
        Task {
            defer { busy.remove("clip.save") }
            do {
                let params = MeetingsAPI.MomentSave.Params(meeting: id, target: selection.target, lengthSec: length,
                                                          quote: selection.quote)
                let result = try await MeetingsService.write(MeetingsAPI.MomentSave.self, params, service: service,
                    orRun: ["play", id, "--save", "--target", MomentPlayer.Engine.targetJSON(selection.target),
                            "--length", String(length), "--quote", selection.quote, "--json"])
                reloadRecord()
                window?.loadOverview(quiet: true)
                var actions: [StackedNotice.Action] = [.init("Show Context", symbol: "doc.on.doc") { [weak self] _ in self?.show(.context) }]
                if result.created {
                    actions.append(.init("Undo", symbol: "arrow.uturn.backward") { [weak self] _ in self?.removeContext(result.entry) })
                }
                notices.push(StackedNotice(text: result.created ? "Saved clip in Context" : "This clip is already in Context",
                                           detail: result.entry.title, actions: actions))
                saved()
            } catch {
                notices.push(.meetingsFailure(error) { [weak self] in self?.saveSelectionClip(selection, length: length, saved: saved) })
            }
        }
    }

    /// The staged comments and the listeners, through the service (no command keeps them); listens for `comment.sent`
    /// so a send from another window shows here too.
    func loadComments() {
        if let service, commentsListening == nil {
            commentsListening = service.listen { [weak self] signal in
                guard let self else { return }
                if case .resumed = signal {
                    self.readComments(service)
                    return
                }
                guard case .event(let event) = signal, event.meeting == self.id else { return }
                switch event {
                case .commentSent(let sent):
                    self.commentDelivery = .sent(comments: sent.comments.count, listeners: sent.listeners.count)
                case .commentChanged:
                    break
                default:
                    return
                }
                self.readComments(service)
            }
        }
        if comments == .idle { comments = .loading(previous: nil) }
        readComments(service)
    }

    func ensureComments() {
        if comments == .idle { loadComments() }
    }

    private func readComments(_ service: MeetingsService?) {
        let id = id
        Task { [weak self] in
            do {
                let list = try await MeetingsRead.service(MeetingsAPI.CommentList.self, .init(meeting: id),
                                                         orRun: ["comments", "list", id, "--json"]).run(service: service)
                self?.settle(\.comments, .loaded(list))
            } catch {
                guard let self else { return }
                self.settle(\.comments, .failed(asFailure(error), previous: self.comments.value))
            }
        }
    }

    /// Stages a comment on the selected lines; the list reads again.
    func stageComment(_ selection: TranscriptSelection, text: String) {
        let text = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        let service = service
        let id = id
        commentDelivery = .idle
        Task { [weak self] in
            do {
                _ = try await MeetingsService.write(MeetingsAPI.CommentStage.self,
                                                    .init(meeting: id, target: selection.target, text: text, quote: selection.quote),
                                                    service: service,
                                                    orRun: ["comments", "stage", id, "--target", MomentPlayer.Engine.targetJSON(selection.target),
                                                            "--text", text, "--quote", selection.quote, "--json"])
                self?.readComments(service)
            } catch {
                self?.notices.push(.meetingsFailure(error) { [weak self] in self?.stageComment(selection, text: text) })
            }
        }
    }

    func unstageComment(_ comment: String) {
        let service = service
        let id = id
        Task { [weak self] in
            do {
                _ = try await MeetingsService.write(MeetingsAPI.CommentUnstage.self, .init(meeting: id, id: comment),
                                                    service: service, orRun: ["comments", "unstage", id, comment, "--json"])
                self?.readComments(service)
            } catch {
                self?.notices.push(.meetingsFailure(error) { [weak self] in self?.unstageComment(comment) })
            }
        }
    }

    /// Sends every staged comment; the result says how many listeners got them, or that nobody listens (G60).
    func sendComments() {
        let service = service
        let staged = comments.value?.comments.filter { $0.state == "staged" }.count ?? 0
        guard staged > 0 else { return }
        let id = id
        commentDelivery = .sending(count: staged)
        Task { [weak self] in
            do {
                let result = try await MeetingsService.write(MeetingsAPI.CommentSend.self, .init(meeting: id, requireListener: true),
                                                            service: service, orRun: ["comments", "send", id, "--require-listener", "--json"])
                self?.commentDelivery = .sent(comments: result.sent.isEmpty ? staged : result.sent.count, listeners: result.listeners.count)
                self?.readComments(service)
            } catch {
                self?.commentDelivery = .failed(message: asFailure(error).sentence)
            }
        }
    }

    func withdrawComment(_ comment: String) {
        let service = service
        let id = id
        Task { [weak self] in
            do {
                _ = try await MeetingsService.write(MeetingsAPI.CommentWithdraw.self, .init(meeting: id, id: comment),
                                                    service: service, orRun: ["comments", "withdraw", id, comment, "--json"])
                self?.readComments(service)
            } catch {
                self?.notices.push(.meetingsFailure(error) { [weak self] in self?.withdrawComment(comment) })
            }
        }
    }

    // MARK: A pin's row (R3, G-PLAY-5)

    /// Selects a row from a pin or a "?" banner: the Items tab, the row selected (the tab scrolls to it, instantly under
    /// Reduce Motion). A decided row that `meetings.rows.decided` hides shows again, with an Undo that hides it again.
    func reveal(row id: String, defaults: UserDefaults? = nil) {
        let defaults = defaults ?? self.defaults
        if let row = rows.value?.rows.first(where: { $0.id == id }) {
            if itemsFilter.rows([row]).isEmpty { itemsFilter = .all }
        } else {
            // The requested meeting's rows may still be loading.
            itemsFilter = .all
        }
        if tab != .items { show(.items) }
        let setting = MeetingsPreferences.Rows.decided
        if let row = rows.value?.rows.first(where: { $0.id == id }), !row.isOpen, setting.value(defaults) == .hidden {
            defaults.set(MeetingsPreferences.Rows.Decided.inPlace.rawValue, forKey: setting.key)
            notices.push(StackedNotice(text: "Decided rows show again, so \(row.label) is in the list",
                                       actions: [.undo { [weak self] notice in
                                           defaults.set(MeetingsPreferences.Rows.Decided.hidden.rawValue, forKey: setting.key)
                                           self?.notices.push(StackedNotice(text: "Decided rows are hidden again"), replacing: notice)
                                       }]))
        }
        selectedRow = id
    }
}
