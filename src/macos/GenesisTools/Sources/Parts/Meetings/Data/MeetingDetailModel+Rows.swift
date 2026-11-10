import Foundation

/// F6: the review rows of one meeting. The rows come from the engine (`meeting.rows`): their order, their question as
/// parts, their choices with confidence, their edit kind and their last decision, so the window computes none of it.
/// Every write goes through the decision journal (`decision.plan`, `decision.apply`, `decision.revert`) as the window,
/// so each decision names who made it and its token undoes exactly it (R31, R35).
extension MeetingDetailModel {
    /// A decision whose reach goes beyond its row, waiting for the "This also affects" sheet (R22, G9, G26, G28).
    struct PendingReach: Identifiable, Equatable {
        let id = UUID()
        let row: ReviewRow
        let action: DecisionAction
        let reason: String?
        let reach: DecisionReach
    }

    /// The History sheet: the meeting's journal, or one row's (`item`).
    struct HistorySheet: Equatable, Identifiable {
        let item: String?
        var entries: Loadable<[JournalEntry]>
        var id: String { item ?? "meeting" }
    }

    // MARK: Reading

    /// The rows: `meeting.rows`, or `rows <id> --json` when no service answers. `show` keeps the open questions under
    /// the priority line (`meetings.rows.lowPriority`).
    static func rowsRead(_ id: String, lowPriority: MeetingsPreferences.Rows.LowPriority) -> MeetingsRead<ReviewRows> {
        let all = lowPriority == .show
        return .service(MeetingsAPI.MeetingRows.self, .init(meeting: id, lowPriority: all ? "show" : nil),
                        orRun: ["rows", id, "--json"] + (all ? ["--all"] : []))
    }

    func loadRows() { readRows(quiet: false) }

    func readRows(quiet: Bool) {
        read(\.rows, generation: \.rowsGeneration, Self.rowsRead(id, lowPriority: MeetingsPreferences.Rows.lowPriority.value(defaults)),
             quiet: quiet) { [weak self] rows in
            guard let self else { return }
            self.rowsLanded(rows)
        }
    }

    /// Rows that landed: the player learns once whether this meeting's Moments can play (G-STATE-1).
    private func rowsLanded(_ rows: ReviewRows) {
        if let first = rows.rows.first(where: \.isOpen) ?? rows.rows.first {
            window?.player.checkPlayable(first.target, in: id)
        }
    }

    /// The rows in the order the reader asked for (`meetings.rows.order`), decided rows in place or hidden
    /// (`meetings.rows.decided`); a held row (`keeping`, G33) stays until the reader scrolls. Priority is the engine's own
    /// order, the one `listen` asks in.
    static func visibleRows(_ rows: [ReviewRow], order: MeetingsPreferences.Rows.Order,
                            decided: MeetingsPreferences.Rows.Decided, keeping: Set<String> = []) -> [ReviewRow] {
        var shown = decided == .hidden ? rows.filter { $0.isOpen || keeping.contains($0.id) } : rows
        if order == .time {
            shown = shown.enumerated().sorted { a, b in
                let left = a.element.startSec ?? .infinity, right = b.element.startSec ?? .infinity
                return left == right ? a.offset < b.offset : left < right
            }.map(\.element)
        }
        return shown
    }

    /// The next open row after `id` in `rows`, wrapping to the first; nil when no other row is open (the queue's end).
    static func nextOpenRow(after id: String, in rows: [ReviewRow]) -> ReviewRow? {
        guard let index = rows.firstIndex(where: { $0.id == id }) else { return rows.first(where: \.isOpen) }
        let after = rows[(index + 1)...] + rows[..<index]
        return after.first { $0.isOpen && $0.id != id }
    }

    // MARK: Deciding

    /// A choice of a row (G1, G2): its decision on the row's item.
    func choose(_ choice: RowChoice, on row: ReviewRow) {
        decide(row, choice.action.decision(on: row))
    }

    /// What the row's editor holds now, as the decision its edit kind makes (R10, R11, G8): a spelling or a person is a
    /// respell (confirmed so), an answer is the question's answer. Nil when the draft is empty or the row has no editor.
    static func draftDecision(_ draft: String?, on row: ReviewRow) -> DecisionAction? {
        guard let text = draft.flatMap(MeetingsWords.typedAnswer) else { return nil }
        switch row.edit {
        case "spelling", "person": return .respell(row.id, to: text)
        case "answer": return .answer(row.id, text)
        default: return nil
        }
    }

    /// The editor's second Return, or its Save: the draft decides the row.
    func submitDraft(on row: ReviewRow) {
        guard let action = Self.draftDecision(drafts[row.id], on: row) else { return }
        decide(row, action)
    }

    /// Opens a row's editor, its field holding the draft kept for it, else the suggested value (R11).
    func edit(_ row: ReviewRow) {
        guard row.edit != "none" else { return }
        if drafts[row.id] == nil {
            drafts[row.id] = row.choices.first { $0.role == "suggested" }?.value ?? row.choices.first?.value ?? ""
        }
        editingRow = row.id
        selectedRow = row.id
    }

    func closeEditor() {
        editingRow = nil
    }

    /// One decision on a row through the journal. With `meetings.rows.askReach` always, a decision that reaches beyond
    /// its row (look-alikes it settles, other lines, the dictionary) asks first with the "This also affects" sheet.
    func decide(_ row: ReviewRow, _ action: DecisionAction, askReach: Bool = true) {
        guard !busyItems.contains(row.id) else { return }
        let reason = reasons[row.id].flatMap(MeetingsWords.typedAnswer)
        let asks = askReach && MeetingsPreferences.Rows.askReach.value(defaults) == .always && Self.mayReach(action)
        guard asks else {
            apply(row, action, reason: reason)
            return
        }
        busyItems.insert(row.id)
        Task {
            let plan = try? await Self.planDecision(meeting: id, action: action, reason: reason, service: service)
            busyItems.remove(row.id)
            if let reach = plan?.reach, !reach.isEmpty {
                pendingReach = PendingReach(row: row, action: action, reason: reason, reach: reach)
            } else {
                apply(row, action, reason: reason)
            }
        }
    }

    /// Only these can reach beyond their row: an answer settles look-alike questions, a spelling changes other lines and
    /// teaches the dictionary, a confirm of a term teaches it.
    static func mayReach(_ action: DecisionAction) -> Bool {
        ["answer", "respell", "confirm"].contains(action.kind)
    }

    /// The sheet's Apply; `askAgain` false is its "Do not ask again", which turns `meetings.rows.askReach` to never.
    func applyReach(_ pending: PendingReach, askAgain: Bool = true) {
        pendingReach = nil
        if !askAgain { defaults.set(MeetingsPreferences.Rows.AskReach.never.rawValue, forKey: MeetingsPreferences.Rows.askReach.key) }
        apply(pending.row, pending.action, reason: pending.reason)
    }

    func cancelReach() {
        pendingReach = nil
    }

    /// The questions among a planned decision's reach that an answer would settle the same way; the other items in
    /// the reach are the ones the question itself decides.
    func lookAlikes(of pending: PendingReach) -> [String] {
        guard pending.action.kind == "answer" else { return [] }
        let questions = Set((rows.value?.rows ?? []).filter(\.isQuestion).map(\.id))
        return pending.reach.items.map(\.id).filter(questions.contains)
    }

    /// "Only this question" (R22): the answer goes to this question and what it decides; the questions that look
    /// alike stay open for their own answers.
    func applyOnlyThis(_ pending: PendingReach) {
        pendingReach = nil
        var action = pending.action
        action.lookAlikes = "leave"
        apply(pending.row, action, reason: pending.reason)
    }

    private func apply(_ row: ReviewRow, _ action: DecisionAction, reason: String?) {
        guard !busyItems.contains(row.id) else { return }
        busyItems.insert(row.id)
        autoplayTask?.cancel()
        Task {
            defer { busyItems.remove(row.id) }
            do {
                let result = try await Self.applyDecision(meeting: id, action: action, reason: reason, service: service)
                decided(row, action: action, result: result)
            } catch let failure as MeetingsCLI.Failure where failure.code == "already-decided" {
                // Someone decided it since the row was read (G47): the draft stays, the row says who, and "Use mine
                // instead" puts this decision over theirs.
                let refused = failure.decodeData(AlreadyDecided.self)
                if let entry = refused?.entry { decidedMeanwhile[row.id] = entry }
                notices.push(StackedNotice(
                    text: "\(Self.sentenceStart(rowName(row.id))) was decided meanwhile by \(refused?.entry.map { MeetingsWords.actor($0.actor) } ?? "someone else")",
                    detail: refused?.entry.map { MeetingsWords.entryAction($0, label: rowName) }, tone: .warning,
                    actions: [.init("Use mine instead", symbol: "arrow.uturn.forward") { [weak self] _ in self?.useMine(action, on: row) }]))
                refreshAfterDecision()
            } catch {
                notices.push(.meetingsFailure(error) { [weak self] in self?.apply(row, action, reason: reason) })
            }
        }
    }

    /// A decision landed: the row folds in place at once, the notice carries its Undo, and the next row plays by itself
    /// (`meetings.rows.autoplayNext`).
    private func decided(_ row: ReviewRow, action: DecisionAction, result: DecisionResult) {
        guard let entry = result.entry else {
            let reason = result.skipped.first { $0.id == row.id }?.reason ?? "nothing changed"
            notices.push(StackedNotice(text: "\(Self.sentenceStart(rowName(row.id))) was not decided: \(reason)", tone: .warning))
            refreshAfterDecision()
            return
        }
        ownTokens.insert(entry.token)
        drafts[row.id] = nil
        reasons[row.id] = nil
        decidedMeanwhile[row.id] = nil
        if editingRow == row.id { editingRow = nil }
        foldAnswered(row, entry: entry)
        showDecided(entry, row: row)
        if !result.skipped.isEmpty {
            notices.push(StackedNotice(text: "\(Plural.count(result.skipped.count, "item")) left as \(result.skipped.count == 1 ? "it was" : "they were")",
                                       more: result.skipped.map { "\(Self.sentenceStart(rowName($0.id))): \($0.reason)" }.joined(separator: "\n"), tone: .warning))
        }
        refreshAfterDecision()
        autoplayNext(after: row)
    }

    /// The notice of one decision of this window: what it did, with an Undo that takes back exactly it. A second
    /// decision adds its own notice (R31).
    @discardableResult
    func showDecided(_ entry: JournalEntry, row: ReviewRow?) -> StackedNotice.ID {
        let text = MeetingsWords.entryAction(entry, label: rowName)
        let items = entry.touched.isEmpty ? nil : Array(entry.touched).sorted()
        return notices.push(StackedNotice(text: text.prefix(1).uppercased() + text.dropFirst(),
                                          actions: [.undo { [weak self] id in self?.revert(token: entry.token, items: items, replacing: id) }]))
    }

    /// How a notice or the history names an item: a question by the label its row shows ("Q9"), never by its item id.
    func rowLabel(_ id: String) -> String {
        rows.value?.rows.first { $0.id == id }?.label ?? id
    }

    /// A row as a sentence names it: a question by its label ("Q9"), any other row by what it is and where ("the word
    /// at 00:12"). Its id ("i53") is the handle a terminal takes; in a notice or the history it told a reader nothing.
    func rowName(_ id: String) -> String {
        rows.value?.rows.first { $0.id == id }.map(MeetingsWords.rowName) ?? id
    }

    /// "the word at 00:12" as the start of a sentence.
    static func sentenceStart(_ text: String) -> String { text.prefix(1).uppercased() + text.dropFirst() }

    /// Statuses from an entry's changes, at once: the row folds before the re-read brings its words (R16).
    func markRows(_ entry: JournalEntry) {
        guard var value = rows.value else { return }
        var changed = false
        for change in entry.changes {
            guard let index = value.rows.firstIndex(where: { $0.id == change.id }) else { continue }
            let status = change.after?.status ?? value.rows[index].status
            if value.rows[index].status != status {
                value.rows[index].status = status
                changed = true
            }
            mark(change.id, status: status)
        }
        if changed { rows = .loaded(value) }
    }

    /// This window's answer folds its row (R16). With `meetings.rows.keepPlace` the folded row keeps its open height
    /// until the reader scrolls, so the next row stays under the eye (G33, R15): a fold that frees 100 pt moved every
    /// row under it.
    func foldAnswered(_ row: ReviewRow, entry: JournalEntry) {
        if MeetingsPreferences.Rows.keepPlace.value(defaults) { heldFolds.insert(row.id) }
        markRows(entry)
    }

    /// The reader scrolled: every held row gives its room back (G33).
    func releaseHeldFolds() {
        if !heldFolds.isEmpty { heldFolds = [] }
    }

    /// "Revert and edit" on a decided row (R16, G35): its decision is taken back for this row only, and its editor opens.
    func revertAndEdit(_ row: ReviewRow) {
        guard let token = row.decision?.token else {
            edit(row)
            return
        }
        revert(token: token, items: [row.id]) { [weak self] in self?.edit(row) }
    }

    /// "Use mine instead": the other decision is taken back for this row, then this one is made.
    func useMine(_ action: DecisionAction, on row: ReviewRow) {
        guard let theirs = decidedMeanwhile[row.id]?.token ?? row.decision?.token else {
            apply(row, action, reason: reasons[row.id])
            return
        }
        revert(token: theirs, items: [row.id]) { [weak self] in
            self?.decidedMeanwhile[row.id] = nil
            self?.apply(row, action, reason: self?.reasons[row.id])
        }
    }

    /// Takes back one journal entry, or only `items` of it; the result takes the place of the notice `replacing`.
    func revert(token: String, items: [String]?, replacing: StackedNotice.ID? = nil, then: (() -> Void)? = nil) {
        let key = "revert.\(token)"
        guard !busy.contains(key) else {
            if let replacing { notices.release(replacing) }
            return
        }
        busy.insert(key)
        Task {
            defer { busy.remove(key) }
            do {
                let result = try await Self.revertDecision(meeting: id, token: token, items: items, service: service)
                if let entry = result.entry {
                    ownTokens.insert(entry.token)
                    markRows(entry)
                }
                notices.push(StackedNotice(text: "Undone"), replacing: replacing)
                then?()
            } catch let failure as MeetingsCLI.Failure where failure.code == "item-changed" {
                notices.push(StackedNotice(text: "Not undone: it was decided again since, in another window, the terminal or by an agent.",
                                           more: failure.detail, tone: .error), replacing: replacing)
            } catch {
                notices.push(.meetingsFailure(error) { [weak self] in self?.revert(token: token, items: items) }, replacing: replacing)
            }
            refreshAfterDecision()
        }
    }

    /// After a decision: the rows and the record read again quietly (what is on screen stays until the answer lands),
    /// the list's counts follow, and the transcript reads again where it shows.
    func refreshAfterDecision() {
        readRecord(quiet: true)
        if rows != .idle { readRows(quiet: true) }
        window?.loadOverview(quiet: true)
        transcriptChanged()
    }

    // MARK: Autoplay (R19, G22, G24)

    /// The next open row is selected and, after `autoplayDelaySec`, plays by itself: unless autoplay is off, an editor
    /// is open, the window cannot be seen, or the reader played something else meanwhile. At the queue's end a notice
    /// says so.
    func autoplayNext(after row: ReviewRow) {
        guard let rows = rows.value?.rows else { return }
        let order = MeetingsPreferences.Rows.order.value(defaults), shown = Self.visibleRows(rows, order: order, decided: .inPlace)
        guard let next = Self.nextOpenRow(after: row.id, in: shown) else {
            notices.push(StackedNotice(text: "That was the last open row of this meeting"))
            return
        }
        selectedRow = next.id
        guard MeetingsPreferences.Rows.autoplayNext.value(defaults) == .afterAnswer, let player = window?.player else { return }
        player.precut(next.target, in: id)
        let delay = MeetingsPreferences.Rows.autoplayDelaySec.value(defaults)
        let playingBefore = player.top?.id
        autoplayTask?.cancel()
        autoplayTask = Task { [weak self] in
            try? await Task.sleep(for: .seconds(delay))
            guard let self, !Task.isCancelled, self.editingRow == nil, self.window?.windowVisible ?? false,
                  self.selectedRow == next.id, player.top?.id == playingBefore || player.phase != .playing else { return }
            player.play(next.target, in: self.id, from: .autoplay)
        }
    }

    // MARK: Events (R36)

    /// An event of this meeting: a decision updates the rows in place at once and reads them again; a change outside
    /// the service reads the parts it names.
    func receive(_ event: MeetingsEvent) {
        guard event.meeting == id || event.meeting == record.value?.id else { return }
        switch event {
        case .decisionApplied(let applied):
            receiveDecision(applied.entry)
        case .decisionReverted(let reverted):
            receiveDecision(reverted.entry)
        case .meetingChanged(let changed):
            if changed.parts.contains("show") {
                readRecord(quiet: true)
                if rows != .idle { readRows(quiet: true) }
            }
            if changed.parts.contains("transcript") { transcriptChanged() }
            if changed.parts.contains("speakers"), speakers != .idle { readSpeakers(quiet: true) }
            if changed.parts.contains("timeline"), timeline != .idle { readTimeline(quiet: true) }
        case .commentSent:
            break
        }
    }

    private func receiveDecision(_ entry: JournalEntry) {
        let own = ownTokens.contains(entry.token)
        markRows(entry)
        if !own {
            // A row decided elsewhere while its editor holds a draft keeps the draft and offers "Use mine instead".
            for id in entry.touched where drafts[id] != nil && editingRow == id { decidedMeanwhile[id] = entry }
        }
        // One re-read per burst of events (an agent's 40 confirms are 40 events).
        eventRefresh?.cancel()
        eventRefresh = Task { [weak self] in
            try? await Task.sleep(for: .milliseconds(150))
            guard let self, !Task.isCancelled else { return }
            self.readRecord(quiet: true)
            if self.rows != .idle { self.readRows(quiet: true) }
            if !entry.labels.isEmpty || !entry.changes.isEmpty { self.transcriptChanged() }
        }
    }

    // MARK: History (G43)

    /// Opens the History sheet: the meeting's journal (`item` nil) or one row's, newest first.
    func openHistory(item: String? = nil) {
        history = HistorySheet(item: item, entries: .loading(previous: nil))
        let read = Self.journalRead(id, item: item)
        Task {
            let next: Loadable<[JournalEntry]>
            do {
                next = .loaded(try await read.run(service: service).entries)
            } catch {
                next = .failed(asFailure(error), previous: nil)
            }
            guard history?.item == item else { return }
            history?.entries = next
        }
    }

    static func journalRead(_ id: String, item: String?, limit: Int = 200) -> MeetingsRead<MeetingsAPI.JournalRead.Result> {
        .service(MeetingsAPI.JournalRead.self, .init(meeting: id, item: item, limit: limit),
                 orRun: ["journal", id, "--json", "--limit", String(limit)] + (item.map { ["--item", $0] } ?? []))
    }

    // MARK: The writes, through the service or the command

    /// `decision.apply` as the window (`onDecided: refuse`). Without a service the command makes the decisions it has
    /// (confirm, reject, reopen, an answer); the rest need the service, which the window starts by itself.
    static func applyDecision(meeting: String, action: DecisionAction, reason: String?,
                              service: MeetingsService?) async throws -> DecisionResult {
        if let service {
            do {
                return try await service.call(MeetingsAPI.DecisionApply.self,
                                              .init(meeting: meeting, action: action, reason: reason, onDecided: "refuse"))
            } catch is MeetingsService.Unavailable {
                try Task.checkCancellation()
            }
        }
        guard let args = commandArgs(meeting: meeting, action: action, reason: reason) else {
            throw MeetingsCLI.Failure(sentence: "This change needs the Meetings service, and it does not answer yet. Try again in a moment.",
                                      detail: "decision.apply \(action.kind) has no command form")
        }
        return try await decodedDecision(args)
    }

    /// `decision.plan`: what a decision would do and reach; nil when no service answers (the decision then goes ahead).
    static func planDecision(meeting: String, action: DecisionAction, reason: String?,
                             service: MeetingsService?) async throws -> MeetingsAPI.DecisionPlan.Result? {
        guard let service else { return nil }
        do {
            return try await service.call(MeetingsAPI.DecisionPlan.self, .init(meeting: meeting, action: action, reason: reason))
        } catch is MeetingsService.Unavailable {
            return nil
        }
    }

    /// `decision.revert`, or `reopen <items> --token` when no service answers.
    static func revertDecision(meeting: String, token: String, items: [String]?, service: MeetingsService?) async throws -> DecisionResult {
        if let service {
            do {
                return try await service.call(MeetingsAPI.DecisionRevert.self, .init(meeting: meeting, token: token, items: items))
            } catch is MeetingsService.Unavailable {
                try Task.checkCancellation()
            }
        }
        guard let items, !items.isEmpty else {
            throw MeetingsCLI.Failure(sentence: "This Undo needs the Meetings service, and it does not answer yet. Try again in a moment.",
                                      detail: "reopen --token needs the items")
        }
        return try await decodedDecision(["reopen", meeting] + items + ["--token", token, "--json"])
    }

    /// The command of a decision the CLI makes, or nil.
    static func commandArgs(meeting: String, action: DecisionAction, reason: String?) -> [String]? {
        let why = reason.map { ["--reason", $0] } ?? []
        switch action.kind {
        case "confirm":
            var args = ["confirm", meeting] + (action.items ?? [])
            if let speaker = action.speaker { args += ["--speaker", speaker] }
            if let proposed = action.proposed { args += ["--proposed", proposed] }
            if let line = action.minConfidence { args += ["--min-confidence", String(line)] }
            return args + why + ["--json"]
        case "reject":
            var args = ["reject", meeting] + (action.items ?? [])
            if let line = action.minConfidence { args += ["--min-confidence", String(line)] }
            return args + why + ["--json"]
        case "reopen":
            return ["reopen", meeting] + (action.items ?? []) + why + ["--json"]
        case "answer":
            // The command settles the look-alikes; an answer that leaves them needs the service.
            guard let question = action.question, let answer = action.answer, action.lookAlikes == nil else { return nil }
            return ["listen", meeting, "--item", question, "--answer", answer] + why + ["--json"]
        default:
            return nil
        }
    }

    /// A command's `--json` answer as a decision result; a command that printed another shape decided what it says.
    private static func decodedDecision(_ args: [String]) async throws -> DecisionResult {
        let data = try await MeetingsCLI.run(args, timeoutSeconds: 120)
        return (try? JSONDecoder().decode(DecisionResult.self, from: data)) ?? DecisionResult(entry: nil, skipped: [], warnings: nil)
    }
}

extension ReviewRow {
    /// Where the row's Moment starts on the transcript clock, for the time order: its `when` part, else its target.
    var startSec: Double? {
        for part in parts { if case .when(let from, _, _) = part { return from.sec } }
        return target.startSec
    }

    /// The text its MomentButton shows: the `when` part's times ("05:09", "05:09–05:31").
    /// The second the row's time starts at (its `when` part).
    var whenSec: Double? {
        for part in parts {
            if case .when(let from, _, _) = part { return from.sec }
        }
        return nil
    }

    var whenText: String? {
        for part in parts {
            if case .when(let from, let to, _) = part { return to.map { "\(from.text)–\($0.text)" } ?? from.text }
        }
        return nil
    }
}

extension MeetingsWords {
    /// "Q9" for a question; "the word at 00:12", "the speaker range at 01:12–01:40", "the join at 24:09" for a
    /// suggestion; the label for a row without a time.
    static func rowName(_ row: ReviewRow) -> String {
        guard !row.isQuestion, let when = row.whenText else { return row.label }
        let kind: String
        switch row.kind {
        case "term": kind = "word"
        case "speaker-range": kind = "speaker range"
        case "label": kind = "mixed voices"
        case "join": kind = "join"
        default: kind = "item"
        }
        return "the \(kind) at \(when)"
    }

    /// Who made a decision, in the engine's words (decision-journal.ts, G44): "you", "you in the terminal", "you at the
    /// command line", "an agent (Claude Code, session 3f98b772)", "rule E2", "someone, before the history existed".
    static func actor(_ actor: DecisionActor) -> String {
        switch actor.kind {
        case "window": return "you"
        case "listen": return "you in the terminal"
        case "cli": return "you at the command line"
        case "agent":
            let harness = actor.harness.map { Harness(runtimeAgent: $0)?.label ?? $0 } ?? "an agent"
            return "an agent (\([harness, actor.session.map { "session \($0.prefix(8))" }].compactMap { $0 }.joined(separator: ", ")))"
        case "rule": return "rule \(actor.rule ?? "?")"
        default: return "someone, before the history existed"
        }
    }

    /// What one journal entry did, as a sentence after its actor: "confirmed i3", "answered Q2: JSON". `label` names an
    /// item as its row does (a question is "Q2", not its item id); without it the ids stand.
    static func entryAction(_ entry: JournalEntry, label: (String) -> String = { $0 }) -> String {
        let action = entry.action
        let ids = entry.decided.isEmpty ? (action.items ?? entry.changes.map(\.id)) : entry.decided
        switch action.kind {
        case "add": return "added \(Plural.count(entry.changes.count, "finding"))"
        case "revert":
            return entry.changes.isEmpty ? "undid a decision" : "undid the decision on \(list(entry.changes.map(\.id).map(label)))"
        case "answer": return actionWords(action, items: ids, question: entry.question, label: label)
        default: return actionWords(action, items: ids, label: label)
        }
    }

    /// What a decision does, before or after it is made: "confirm i3" reads "confirmed i3".
    static func actionWords(_ action: DecisionAction, items ids: [String], question: String? = nil,
                            label: (String) -> String = { $0 }) -> String {
        let items = list(ids.map(label))
        let asked = (action.question ?? question).map(label) ?? "a question"
        switch action.kind {
        case "confirm": return "confirmed \(items)"
        case "reject": return "rejected \(items)"
        case "respell": return "respelled \(action.item.map(label) ?? items) to “\(action.text ?? "")”"
        case "answer": return "answered \(asked): \(action.answer ?? "")"
        case "skip": return "skipped \(asked)"
        case "split": return "split \(asked) by voice"
        case "rename":
            guard let label = action.label else { return "renamed a speaker" }
            return action.name == label ? "gave \(label) its own name back" : "renamed \(label) to \(action.name ?? "")"
        case "reopen": return "reopened \(items)"
        case "add": return "added findings"
        case "set": return "changed the meeting's project, title or labels"
        case "assign": return "gave a stretch to \(action.person ?? "someone")"
        case "revert": return "undid a decision"
        case "comment": return "told the listening agent"
        default: return action.kind
        }
    }

    /// "i1", "i1 and i2", "i1, i2 and 5 more".
    private static func list(_ ids: [String]) -> String {
        switch ids.count {
        case 0: return "nothing"
        case 1: return ids[0]
        case 2: return "\(ids[0]) and \(ids[1])"
        case 3: return "\(ids[0]), \(ids[1]) and \(ids[2])"
        default: return "\(ids[0]), \(ids[1]) and \(ids.count - 2) more"
        }
    }
}
