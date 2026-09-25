import AppKit
import SwiftUI

// "Waiting for you" (`--mode inbox`): every session whose last reply asks a ❓ DECISION, every open
// decision in the store and every pending question form, grouped by session. The list and the
// answers both go through `tools question inbox` (src/question/lib/inbox): a click on an option letter
// runs `inbox answer`, which types the answer into that session (cmux pane, codex steer) or answers
// the form, and the row shows what happened.

// MARK: - Data (`tools question inbox --json`)

struct InboxChoice: Decodable, Hashable {
    let id: String
    let label: String
    /// Why this option, when the reply gives a reason.
    let rationale: String?
    let recommended: Bool?
}

/// Where the last send took a decision's answer (`delivery` on the stored row).
struct InboxDeliveryRecord: Decodable, Hashable {
    let route: String
    let target: String?
    /// A one-sentence reason a queued send delivered nothing. New rows store it here; older rows put
    /// the raw dump in `target`, which the TS side reads through the same rules (`inboxDelivery`).
    let error: String?
    /// The raw dump behind an old row's sentence, shown behind Details only.
    let raw: String?
    let at: String

    private static let clock: DateFormatter = {
        let formatter = DateFormatter()
        formatter.dateFormat = "HH:mm"
        return formatter
    }()

    /// A short human place, never a multi-line dump: the first line of whatever the row stored.
    private var place: String? {
        target?.split(separator: "\n").first.map(String.init)?.trimmed
    }

    /// "sent 22:31 to cmux pane work · agent", "steered 22:31 into codex worker w1", "queued 22:31: why".
    /// New rows store `cmux · …` and `codex worker …`; older rows stored the bare pane or worker name.
    var line: String {
        let time = HubFormat.date(at).map { Self.clock.string(from: $0) } ?? ""
        switch route {
        case "cmux":
            let where_ = place.map { $0.hasPrefix("cmux") ? $0 : "cmux pane \($0)" } ?? "the cmux pane"
            return "sent \(time) to \(where_)"
        case "codex":
            let who = place.map { $0.hasPrefix("codex") ? $0 : "codex worker \($0)" } ?? "the codex worker"
            return "steered \(time) into \(who)"
        case "resume": return "resumed \(time) at " + (place ?? "a new pane") + "; the answer rides its first prompt"
        case "prompt": return "sent \(time) with the session's next prompt"
        default:
            let why = error ?? place
            return "queued \(time)" + (why.map { ": \($0)" } ?? "") + ". The next prompt receives it when the decisions hook is on."
        }
    }

    var isQueued: Bool { route == "queued" }
}

struct InboxRef: Decodable, Hashable {
    let path: String
    let line: Int?
    let endLine: Int?
    /// Resolved against the session's folder; null when no folder is known.
    let absolute: String?
    /// The real lines read from disk by the loader; null when the file could not be read.
    let excerpt: String?
    /// The 1-based line the excerpt starts at.
    let startLine: Int?
    /// For syntax highlighting.
    let language: String?
    let missing: Bool?

    var hasContent: Bool { (excerpt?.isEmpty == false) || missing == true }
}

struct InboxQuestion: Decodable, Hashable {
    let itemId: String
    let prompt: String
    let choices: [InboxChoice]
    let multiple: Bool
    let freeText: Bool
    let required: Bool
}

/// One thing a session waits on: a decision (`number`, `choices`) or a question form (`questions`).
struct InboxItem: Decodable, Identifiable, Hashable {
    let kind: String
    let id: String
    let at: String
    let status: String
    let number: Int?
    let title: String?
    let prompt: String?
    let choices: [InboxChoice]?
    let recommended: String?
    let blocking: Bool?
    let option: String?
    let answer: String?
    /// A decision: `transcript` or `store`. A form: who posted it.
    let source: String?
    let questions: [InboxQuestion]?
    /// The reply text that leads to this decision (the findings), markdown.
    let context: String?
    /// Text under the options about this decision.
    let notes: String?
    /// A posted decision's extras (null for one read from the transcript).
    let proposal: String?
    let reasoning: String?
    let confidence: String?
    let excerpt: String?
    let refs: [InboxRef]?
    /// The user's unsent pick (letters) and note.
    let draftOption: String?
    let draft: String?
    let delivery: InboxDeliveryRecord?

    var isForm: Bool { kind == "form" }
    var isOpen: Bool { status == "waiting" || status == "drafted" }
    var date: Date? { HubFormat.date(at) }
    /// The excerpt cards to draw: refs the loader could read, or that name a missing file.
    var excerptRefs: [InboxRef] { (refs ?? []).filter(\.hasContent) }
    /// The text ⌘F searches for this item: question, context, notes, options with reasons, ref paths.
    var searchText: String {
        var parts = [title ?? "", prompt ?? "", context ?? "", notes ?? "", answer ?? "", draft ?? ""]
        for choice in choices ?? [] {
            parts.append("\(choice.id)) \(choice.label) \(choice.rationale ?? "")")
        }
        for ref in refs ?? [] {
            parts.append(ref.path)
        }
        for question in questions ?? [] {
            parts.append(question.prompt)
            parts.append(contentsOf: question.choices.map(\.label))
        }
        return parts.joined(separator: " ")
    }
}

extension InboxItem {
    /// What ⌘F searches in a card, in drawing order, under the keys the card draws each text with
    /// (`FindText(_, field:)` and `.findField`). Styled texts are given as their shown characters.
    var findFields: [PanelFindField] {
        var fields = [PanelFindField("title", title ?? prompt ?? "")]
        if let context, !context.isEmpty {
            fields.append(PanelFindField("context", context, markdown: true))
        }
        if let notes, !notes.isEmpty {
            fields.append(PanelFindField("notes", String(inlineMarkdown(notes).characters)))
        }
        if let proposal, !proposal.isEmpty {
            fields.append(PanelFindField("proposal", String(inlineMarkdown(proposal).characters)))
        }
        for choice in choices ?? [] {
            fields.append(PanelFindField("choice:\(choice.id)", String(inlineMarkdown(choice.label).characters)))
            if let rationale = choice.rationale, !rationale.isEmpty {
                fields.append(PanelFindField("rationale:\(choice.id)", String(inlineMarkdown(rationale).characters)))
            }
        }
        for (index, ref) in excerptRefs.enumerated() {
            fields.append(PanelFindField("ref:\(index)", ref.line.map { "\(ref.path):\($0)" } ?? ref.path))
            if let excerpt = ref.excerpt {
                fields.append(PanelFindField("code:\(index)", excerpt))
            }
        }
        if let delivery {
            fields.append(PanelFindField("delivery", delivery.line))
        }
        for question in questions ?? [] {
            fields.append(PanelFindField("q:\(question.itemId)", String(inlineMarkdown(question.prompt).characters)))
            for choice in question.choices {
                fields.append(PanelFindField("q:\(question.itemId):\(choice.id)", choice.label))
            }
        }
        return fields
    }
}

/// The last reply of a session, when its decisions come from the transcript.
struct InboxReply: Decodable, Hashable {
    let at: String?
    let markdown: String
    /// The user prompt that led to it: the first line, and the whole text.
    let ask: String?
    let askFull: String?
    let turnIndex: Int?
}

struct InboxSession: Decodable, Identifiable, Hashable {
    let sessionId: String?
    let provider: String?
    let title: String?
    let project: String?
    let cwd: String?
    let branch: String?
    let account: String?
    let lastAt: String
    let waiting: Int
    let drafted: Int?
    /// Answered decisions no send delivered yet; they ride the session's next prompt.
    let queued: Int?
    let reply: InboxReply?
    let items: [InboxItem]

    /// Listed only for its queued answers: nothing here waits for the user.
    var isQueuedOnly: Bool { waiting == 0 && (queued ?? 0) > 0 }

    var id: String { sessionId ?? "form:\(cwd ?? "")" }
    var date: Date? { HubFormat.date(lastAt) }
    /// Decisions with an unsent pick or note, ready for the session's Send.
    var draftedItems: [InboxItem] {
        items.filter { $0.kind == "decision" && $0.isOpen && ($0.draftOption?.isEmpty == false || $0.draft?.trimmed.isEmpty == false) }
    }
    var searchText: String {
        ([displayTitle, projectName, branch ?? "", account ?? "", sessionId ?? "", reply?.ask ?? ""]
            + items.map(\.searchText)).joined(separator: " ")
    }
    /// The session header row's fields for ⌘F (row id `session:<id>`), as the header draws them.
    var findFields: [PanelFindField] {
        [
            PanelFindField("title", displayTitle),
            PanelFindField("project", projectName),
            PanelFindField("branch", branch ?? ""),
        ]
    }

    var displayTitle: String {
        if let title, !title.trimmed.isEmpty { return title }
        if let sessionId { return "Session \(sessionId.prefix(8))" }
        return "Questions without a session"
    }

    var projectName: String {
        if let project, !project.isEmpty { return project }
        return cwd.map { ($0 as NSString).lastPathComponent } ?? "No folder"
    }
}

struct InboxEnvelope: Decodable {
    let sessions: [InboxSession]
    let elapsedMs: Int?
}

/// What `tools question inbox send|answer` printed: the delivery, or `{ error }`.
struct InboxDelivery: Decodable, Equatable {
    let text: String?
    let channel: String?
    let delivered: Bool?
    /// A short human place the answers went (`cmux · agents-window · pane 1`). Never an error dump.
    let target: String?
    /// One sentence saying why nothing was delivered.
    let error: String?
    /// The raw tool output behind the sentence, shown only behind a Details disclosure.
    let raw: String?
    /// The form path uses `detail` for its note.
    let detail: String?

    static func failure(_ message: String) -> InboxDelivery {
        InboxDelivery(text: nil, channel: nil, delivered: false, target: nil, error: message, raw: nil, detail: nil)
    }

    var summary: String {
        if let error { return error }
        switch channel {
        case "cmux": return "Sent to \(target ?? "the session's cmux pane")"
        case "codex": return "Steered into \(target ?? "the codex worker")"
        case "resume": return "Resumed at \(target ?? "a new pane"); the answer reaches it on its first prompt"
        case "form": return "Answered; the waiting agent receives it"
        case "dry-run": return "Dry run: \(text ?? "")"
        default:
            return "Not sent: \(target ?? detail ?? "no live target"). The next prompt of the session receives it when the decisions hook is on."
        }
    }

    var isError: Bool { error != nil }
    var isQueued: Bool { error == nil && delivered != true }
}

/// `tools question inbox target --json`: where a session's answers would go right now, and whether
/// a queued answer would ever leave on its own (the UserPromptSubmit hook).
struct InboxTargetResolution: Decodable, Equatable {
    let kind: String
    let label: String?
    let reason: String?
    let worker: String?
    let queueHookOn: Bool?
}

enum InboxSort: String, CaseIterable {
    case recent, oldest, project, count

    var title: String {
        switch self {
        case .recent: return "Most recent first"
        case .oldest: return "Least recent first"
        case .project: return "By project"
        case .count: return "Most waiting first"
        }
    }

    /// The rows the filter text matches (title, project, branch, account, question, context, options), in this order.
    func apply(_ sessions: [InboxSession], filter: String) -> [InboxSession] {
        let needle = filter.trimmed.lowercased()
        let rows = needle.isEmpty ? sessions : sessions.filter { $0.searchText.lowercased().contains(needle) }
        switch self {
        case .recent: return rows.sorted { $0.lastAt > $1.lastAt }
        case .oldest: return rows.sorted { $0.lastAt < $1.lastAt }
        case .project:
            return rows.sorted {
                $0.projectName.localizedCaseInsensitiveCompare($1.projectName) == .orderedSame
                    ? $0.lastAt > $1.lastAt
                    : $0.projectName.localizedCaseInsensitiveCompare($1.projectName) == .orderedAscending
            }
        case .count: return rows.sorted { $0.waiting == $1.waiting ? $0.lastAt > $1.lastAt : $0.waiting > $1.waiting }
        }
    }
}

// MARK: - Model

@MainActor
final class HubInboxModel: ObservableObject {
    @Published private(set) var sessions: [InboxSession] = []
    @Published private(set) var loading = false
    @Published private(set) var loadedAt: Date?
    @Published private(set) var error: String?
    /// The session the sidebar picked; the main list scrolls to it.
    @Published var selectedID: String?
    /// Each answered item's delivery, by item id, until the next answer to it.
    @Published private(set) var deliveries: [String: InboxDelivery] = [:]
    @Published private(set) var sending: Set<String> = []
    /// Decisions being drafted or dismissed right now (a pending write), by item id.
    @Published private(set) var writing: Set<String> = []
    /// Why the last draft or dismiss of an item failed, by item id, until its next write starts.
    @Published private(set) var writeErrors: [String: String] = [:]
    /// The newest draft or dismiss asked for while one ran for the same item: it runs next, so a
    /// second pick or a note saved during a pick is never dropped.
    private var pendingWrites: [String: [String]] = [:]
    /// The write running for each item, so a note queued behind a pick keeps that pick.
    private var runningWrites: [String: [String]] = [:]
    /// A load asked for while one ran (a write finished meanwhile). It runs when that one ends.
    private var reloadPending = false
    /// Sessions whose Send is running, by session id.
    @Published private(set) var sendingSessions: Set<String> = []
    /// The last Send result per session id (where the answers went, or why nothing did).
    @Published private(set) var sessionResults: [String: InboxDelivery] = [:]
    /// Set when a Send found no live target: the view shows the resume dialog for this session.
    @Published var resumeFor: InboxSession?
    /// The session whose info popover is open (`--inbox-info <id>` opens it in a scripted run).
    @Published var infoFor: String?
    /// Whether a queued answer would ever leave on its own, from the last target resolution.
    @Published private(set) var queueHookOn = false
    /// Bumped after every draft, dismiss or send has written the store: the Decisions pane reloads on it.
    @Published private(set) var writeGeneration = 0
    /// `--inbox-resume <id>` / `--inbox-info <id>`: opened once the list has loaded, then cleared.
    enum Reveal {
        case resume(String)
        case info(String)
    }
    var reveal: Reveal?
    /// Called once after the next load (a snapshot run waits for it).
    var onLoaded: (() -> Void)?

    var waitingCount: Int { sessions.reduce(0) { $0 + $1.waiting } }

    func sorted(_ sort: InboxSort, filter: String) -> [InboxSession] {
        sort.apply(sessions, filter: filter)
    }

    /// Reloads unless a load finished in the last `maxAge` seconds.
    func loadIfStale(maxAge: TimeInterval = 20) {
        if let loadedAt, Date().timeIntervalSince(loadedAt) < maxAge {
            finishLoad()
            return
        }
        load()
    }

    func load() {
        guard !loading else {
            // The running load may have read the store before a write landed: read it once more.
            reloadPending = true
            return
        }

        loading = true
        DispatchQueue.global(qos: .userInitiated).async {
            let span = HubPerf.begin("inbox.load")
            let result = Result { try JSONDecoder().decode(InboxEnvelope.self, from: ToolsCLIRunner.run(["question", "inbox", "--json"])) }
            span.end((try? result.get()).map { "\($0.sessions.count) sessions, tools \($0.elapsedMs ?? -1) ms" } ?? "failed")
            DispatchQueue.main.async { [weak self] in
                MainActor.assumeIsolated {
                    guard let self else { return }
                    self.loading = false
                    if self.reloadPending {
                        self.reloadPending = false
                        self.load()
                        return
                    }
                    switch result {
                    case .success(let envelope):
                        // An unchanged Inbox (the usual reload on a mode switch) redraws nothing.
                        if self.sessions != envelope.sessions {
                            HubMainBusy.measure("inbox.render")
                            self.sessions = envelope.sessions
                        }
                        self.error = nil
                        self.loadedAt = Date()
                        self.applyReveal()
                    case .failure(let failure):
                        self.error = "\(failure)"
                    }
                    self.finishLoad()
                }
            }
        }
    }

    private func finishLoad() {
        let done = onLoaded
        onLoaded = nil
        done?()
    }

    /// Opens the view a scripted launch asked for, once the session it names is in the list.
    private func applyReveal() {
        guard let reveal else { return }
        let match = { (id: String) in self.sessions.first { $0.sessionId?.hasPrefix(id) == true } }
        switch reveal {
        case .resume(let id):
            if let session = match(id) {
                resumeFor = session
                self.reveal = nil
            }
        case .info(let id):
            if let session = match(id) {
                infoFor = session.sessionId
                self.reveal = nil
            }
        }
    }

    /// Marks (or clears) a decision's pick and note. Nothing is sent: this is the pick-then-send model.
    /// Pass the whole letters string (`"a"`, `"ac"`, or `""` to clear the pick); `text` is the note.
    func draft(_ item: InboxItem, in session: InboxSession, option: String?, text: String?) {
        guard let sessionId = session.sessionId, let number = item.number else { return }
        var args = ["question", "inbox", "draft", "--session", sessionId, "--decision", String(number)]
        if let option { args += ["--option", option] }
        if let text { args += ["--text", text] }
        if let provider = session.provider { args += ["--provider", provider] }
        if let cwd = session.cwd, !cwd.isEmpty { args += ["--cwd", cwd] }
        write(args, item: item)
    }

    /// Drops a decision that no longer matters, without sending anything.
    func dismiss(_ item: InboxItem, in session: InboxSession) {
        guard let sessionId = session.sessionId, let number = item.number else { return }
        write(["question", "inbox", "dismiss", "--session", sessionId, "--decision", String(number)], item: item)
    }

    /// A draft or dismiss write: run it, then reload so the stored pick shows. No delivery banner;
    /// a failed write says why on the card. `queued`: a write that waited behind another one; it
    /// leaves the card's error alone, so a failure of the one before it stays readable.
    private func write(_ args: [String], item: InboxItem, queued: Bool = false) {
        guard !writing.contains(item.id) else {
            pendingWrites[item.id] = Self.keepingPick(args, from: pendingWrites[item.id] ?? runningWrites[item.id])
            return
        }

        writing.insert(item.id)
        runningWrites[item.id] = args
        if !queued {
            writeErrors[item.id] = nil
        }
        DispatchQueue.global(qos: .userInitiated).async {
            let span = HubPerf.begin("inbox.draft")
            let failure: String?
            do {
                let capture = try ToolsCLIRunner.capture(args)
                failure = capture.status == 0 ? nil
                    : "exited \(capture.status): \(String(decoding: capture.stderr, as: UTF8.self).trimmed.suffix(200))"
            } catch {
                failure = "\(error)"
            }
            span.end(failure == nil ? "ok" : "failed")
            DispatchQueue.main.async { [weak self] in
                MainActor.assumeIsolated {
                    guard let self else { return }
                    self.writing.remove(item.id)
                    self.runningWrites[item.id] = nil
                    if let failure {
                        self.writeErrors[item.id] = "Not saved: \(failure)"
                    } else {
                        self.writeGeneration += 1
                    }
                    if let next = self.pendingWrites.removeValue(forKey: item.id) {
                        self.write(next, item: item, queued: true)
                    } else {
                        self.load()
                    }
                }
            }
        }
    }

    /// A note-only draft (`--text`, no `--option`) that waits behind a pick keeps that pick's letters:
    /// it replaces the queued pick, and the running pick may still fail. A dismiss never gets letters.
    nonisolated static func keepingPick(_ args: [String], from earlier: [String]?) -> [String] {
        guard args.count > 2, args[2] == "draft", !args.contains("--option"),
              let earlier, earlier.count > 2, earlier[2] == "draft",
              let at = earlier.firstIndex(of: "--option"), at + 1 < earlier.count
        else { return args }
        return args + ["--option", earlier[at + 1]]
    }

    /// Resolves where a session's answers would go right now (a live cmux pane, a codex worker, or
    /// nothing), off the main thread, then sends. No live target opens the resume dialog instead.
    func sendSession(_ session: InboxSession) {
        guard let sessionId = session.sessionId, !sendingSessions.contains(sessionId) else { return }
        sendingSessions.insert(sessionId)
        sessionResults[sessionId] = nil
        var targetArgs = ["question", "inbox", "target", "--session", sessionId]
        if let provider = session.provider { targetArgs += ["--provider", provider] }
        DispatchQueue.global(qos: .userInitiated).async {
            // A failed run or unreadable JSON is an error, never "no target known": a nil here once
            // fell through to a send that queued the answers silently.
            let resolved = Result { try JSONDecoder().decode(InboxTargetResolution.self, from: ToolsCLIRunner.run(targetArgs)) }
            DispatchQueue.main.async { [weak self] in
                MainActor.assumeIsolated {
                    guard let self else { return }
                    self.queueHookOn = Self.queueHook(from: resolved)
                    self.sendingSessions.remove(sessionId)
                    self.run(Self.sendStep(resolved), for: session)
                }
            }
        }
    }

    /// What a Send or a resume leads to. The decisions are pure (`sendStep`, `resumeStep`) so tests
    /// pin them; `run` carries one out.
    enum SendStep: Equatable {
        /// Type the answers into the live target (`resumeTarget`: the pane a resume opened).
        case deliver(resumeTarget: String?)
        /// Nothing is open: ask where to resume. Never queue silently.
        case askWhereToResume
        /// Nothing was sent, and this says why.
        case report(String)
        /// Cancelled: the answers stay drafted.
        case nothing
    }

    /// Whether "Keep queued" can deliver, from this lookup only: a failed lookup establishes nothing,
    /// so it can never inherit the last session's answer.
    nonisolated static func queueHook(from resolved: Result<InboxTargetResolution, Error>) -> Bool {
        guard case .success(let target) = resolved else { return false }
        return target.queueHookOn ?? false
    }

    nonisolated static func sendStep(_ resolved: Result<InboxTargetResolution, Error>) -> SendStep {
        switch resolved {
        case .failure(let error):
            return .report("Nothing was sent: finding where the answers go failed (\(String("\(error)".prefix(200))))")
        case .success(let target):
            return target.kind == "none" ? .askWhereToResume : .deliver(resumeTarget: nil)
        }
    }

    /// Only a session that did resume gets the answers; a failed resume sends nothing and says why.
    nonisolated static func resumeStep(_ outcome: LaunchOutcome) -> SendStep {
        switch outcome {
        case .cancelled: return .nothing
        case .launched(let label): return .deliver(resumeTarget: "resumed — \(label)")
        case .failed(let why): return .report("Nothing was sent: the resume failed (\(why))")
        }
    }

    func run(_ step: SendStep, for session: InboxSession) {
        guard let sessionId = session.sessionId else { return }
        switch step {
        case .deliver(let resumeTarget):
            deliverSession(session, resumeTarget: resumeTarget)
        case .askWhereToResume:
            resumeFor = session
        case .report(let why):
            sessionResults[sessionId] = .failure(why)
        case .nothing:
            break
        }
    }

    /// How long a Send after a resume waits for the reopened pane before typing. Claude boots in a
    /// few seconds; the account picker can take longer.
    static let resumeWaitSeconds = 30

    /// Sends the drafted answers of a session as one message. `resumeTarget` names the place the
    /// resume dialog reopened it: the send then waits for that pane to be live and types into it.
    func deliverSession(_ session: InboxSession, resumeTarget: String?) {
        guard let sessionId = session.sessionId else { return }
        sendingSessions.insert(sessionId)
        var args = ["question", "inbox", "send", "--session", sessionId]
        if let provider = session.provider { args += ["--provider", provider] }
        if let resumeTarget { args += ["--resume-target", resumeTarget, "--wait-live", String(Self.resumeWaitSeconds)] }
        DispatchQueue.global(qos: .userInitiated).async {
            let span = HubPerf.begin("inbox.send")
            let delivery: InboxDelivery
            do {
                // The wait for a resumed pane sits inside the run: give it room beyond the default.
                let capture = try ToolsCLIRunner.capture(args, timeout: TimeInterval(Self.resumeWaitSeconds + 60))
                delivery = (try? JSONDecoder().decode(InboxDelivery.self, from: capture.stdout))
                    ?? .failure("tools question inbox send exited \(capture.status): \(String(decoding: capture.stderr, as: UTF8.self).trimmed.suffix(200))")
            } catch {
                delivery = .failure("\(error)")
            }
            span.end(delivery.channel ?? "error")
            DispatchQueue.main.async { [weak self] in
                MainActor.assumeIsolated {
                    guard let self else { return }
                    self.sendingSessions.remove(sessionId)
                    self.sessionResults[sessionId] = delivery
                    if !delivery.isError {
                        self.writeGeneration += 1
                        self.load()
                    }
                }
            }
        }
    }

    /// Answers a form: one entry per question, the chosen choice ids and any text.
    func answerForm(_ item: InboxItem, choices: [String: Set<String>], texts: [String: String]) {
        let answers: [[String: Any]] = (item.questions ?? []).map { question in
            var entry: [String: Any] = ["itemId": question.itemId]
            if let picked = choices[question.itemId], !picked.isEmpty {
                entry["selectedChoices"] = question.choices.map(\.id).filter { picked.contains($0) }
            }
            if let text = texts[question.itemId]?.trimmed, !text.isEmpty {
                entry["freeText"] = text
            }
            return entry
        }
        guard let data = try? JSONSerialization.data(withJSONObject: answers) else { return }
        run(["question", "inbox", "answer", "--form", item.id, "--answers", String(decoding: data, as: UTF8.self)], item: item)
    }

    private func run(_ args: [String], item: InboxItem) {
        guard !sending.contains(item.id) else { return }
        sending.insert(item.id)
        deliveries[item.id] = nil
        HubPerf.log("inbox.answer \(item.id)")
        DispatchQueue.global(qos: .userInitiated).async {
            let span = HubPerf.begin("inbox.answer")
            let delivery: InboxDelivery
            do {
                let capture = try ToolsCLIRunner.capture(args)
                delivery = (try? JSONDecoder().decode(InboxDelivery.self, from: capture.stdout))
                    ?? .failure("tools question inbox answer exited \(capture.status): \(String(decoding: capture.stderr, as: UTF8.self).trimmed.suffix(200))")
            } catch {
                delivery = .failure("\(error)")
            }
            span.end(delivery.channel ?? "error")
            DispatchQueue.main.async { [weak self] in
                MainActor.assumeIsolated {
                    guard let self else { return }
                    self.sending.remove(item.id)
                    self.deliveries[item.id] = delivery
                    if !delivery.isError {
                        self.load()
                    }
                }
            }
        }
    }

    /// Brings the session's cmux pane forward (`tools claude cmux focus`), for a Claude session.
    func focusPane(_ session: InboxSession, notice: @escaping (String) -> Void) {
        guard let sessionId = session.sessionId else { return }
        DispatchQueue.global(qos: .userInitiated).async {
            // --first as CmuxHost.focus passes it: without a terminal, a session open in two panes fails.
            let capture = try? ToolsCLIRunner.capture(["claude", "cmux", "focus", sessionId, "--first"])
            let failed = capture.map { $0.status != 0 } ?? true
            let message = failed
                ? "No cmux pane found for this session: " + (capture.map { String(decoding: $0.stderr, as: UTF8.self).trimmed.suffix(120) } ?? "tools did not run")
                : "Focused the session's cmux pane"
            DispatchQueue.main.async { notice(String(message)) }
        }
    }
}

// MARK: - Sidebar

struct InboxListView: View {
    @ObservedObject var model: HubModel
    @ObservedObject var inbox: HubInboxModel
    @AppStorage("hub.inbox.sort") private var sortKey = InboxSort.recent.rawValue

    private var sort: InboxSort { InboxSort(rawValue: sortKey) ?? .recent }

    var body: some View {
        let rows = inbox.sorted(sort, filter: model.filter)
        VStack(spacing: 0) {
            HStack(spacing: 6) {
                Menu {
                    ForEach(InboxSort.allCases, id: \.self) { option in
                        Button {
                            sortKey = option.rawValue
                        } label: {
                            if option == sort { Label(option.title, systemImage: "checkmark") } else { Text(option.title) }
                        }
                    }
                } label: {
                    Label(sort.title, systemImage: "arrow.up.arrow.down")
                        .font(.system(size: 11.5))
                        .foregroundColor(ReviewPalette.dim)
                }
                .menuStyle(.borderlessButton)
                .menuIndicator(.hidden)
                .fixedSize()
                .instantTooltip("Order the waiting sessions")
                Spacer()
                if inbox.loading {
                    ProgressView().controlSize(.small)
                }
                IconButton(systemName: "arrow.clockwise", tooltip: "Look for waiting sessions again") { inbox.load() }
            }
            .padding(.horizontal, 14)
            .padding(.bottom, 6)
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 2) {
                    if rows.isEmpty {
                        Text(inbox.loading ? "Looking for waiting sessions…" : inbox.error ?? "Nothing is waiting for you.")
                            .font(.system(size: 12))
                            .foregroundColor(ReviewPalette.dim)
                            .padding(14)
                    }
                    ForEach(rows) { session in
                        InboxSessionRow(session: session, selected: session.id == inbox.selectedID)
                            .rowButton { inbox.selectedID = session.id }
                    }
                }
                .padding(.bottom, 12)
            }
        }
    }
}

private struct InboxSessionRow: View {
    let session: InboxSession
    let selected: Bool

    var body: some View {
        HStack(alignment: .top, spacing: 9) {
            ProviderBadge(provider: session.provider ?? "?")
                .padding(.top, 1)
            VStack(alignment: .leading, spacing: 3) {
                Text(session.displayTitle)
                    .font(.system(size: 12.5, weight: selected ? .semibold : .regular))
                    .lineLimit(2)
                // Project and age only: the meta line is about 150 pt wide, and a branch beside them
                // read "fe…nts", then "f" (snapshots 2026-09-25). The card header names the branch.
                HStack(spacing: 6) {
                    Text(session.projectName).lineLimit(1)
                    Spacer(minLength: 0)
                    Text(HubFormat.ago(session.date)).fixedSize()
                }
                .font(.system(size: 10.5))
                .foregroundColor(ReviewPalette.dim)
                .lineLimit(1)
            }
            if session.waiting > 0 {
                Text(verbatim: "\(session.waiting)")
                    .font(.system(size: 10.5, weight: .bold, design: .monospaced))
                    .foregroundColor(.black)
                    .frame(minWidth: 18, minHeight: 18)
                    .background(Capsule().fill(InboxStyle.accent))
                    .instantTooltip(session.waiting == 1 ? "1 answer waiting" : "\(session.waiting) answers waiting")
            } else {
                InboxTag(text: "queued", color: ReviewPalette.modified)
                    .instantTooltip("Answered; the session's next prompt receives it. Nothing waits for you here.")
            }
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 7)
        .background(
            RoundedRectangle(cornerRadius: 8)
                .fill(selected ? Color.white.opacity(0.08) : Color.clear)
                .overlay(RoundedRectangle(cornerRadius: 8).stroke(selected ? Color.accentColor.opacity(0.55) : Color.clear))
        )
        .padding(.horizontal, 6)
        .contentShape(Rectangle())
    }
}

enum InboxStyle {
    static let accent = Color(red: 1, green: 0.63, blue: 0.12)
}

// MARK: - Main

struct InboxMain: View {
    @ObservedObject var model: HubModel
    @ObservedObject var inbox: HubInboxModel
    @AppStorage("hub.inbox.sort") private var sortKey = InboxSort.recent.rawValue

    var body: some View {
        let rows = inbox.sorted(InboxSort(rawValue: sortKey) ?? .recent, filter: model.filter)
        VStack(spacing: 0) {
            header(rows)
            Rectangle().fill(ReviewPalette.hairline).frame(height: 1)
            // ⌘F: the shared find bar, wired around InboxMain (Hub/HubInboxFind.swift); draws nothing until opened.
            PanelFindBarSlot()
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 22) {
                        if rows.isEmpty {
                            Text(inbox.loading ? "Looking for waiting sessions…" : "No session is waiting for an answer.")
                                .font(.system(size: 13))
                                .foregroundColor(ReviewPalette.dim)
                                .frame(maxWidth: .infinity)
                                .padding(.top, 40)
                        }
                        ForEach(rows.filter { !$0.isQueuedOnly }) { session in
                            InboxSessionSection(model: model, inbox: inbox, session: session)
                                .id(session.id)
                        }
                        let queuedOnly = rows.filter(\.isQueuedOnly)
                        if !queuedOnly.isEmpty {
                            // Answered, not yet taken by the session: shown apart, so they never read as waiting.
                            HStack(spacing: 8) {
                                Image(systemName: "tray.and.arrow.down").foregroundColor(ReviewPalette.modified)
                                Text("Queued for the session's next prompt")
                                    .font(.system(size: 12.5, weight: .semibold))
                                    .foregroundColor(Color.white.opacity(0.8))
                                Text("Nothing here waits for you; the agent picks these up when it runs again.")
                                    .font(.system(size: 11))
                                    .foregroundColor(ReviewPalette.dim)
                                    .lineLimit(1)
                            }
                            .padding(.top, 6)
                            ForEach(queuedOnly) { session in
                                InboxSessionSection(model: model, inbox: inbox, session: session)
                                    .id(session.id)
                            }
                        }
                    }
                    .padding(18)
                }
                .onChange(of: inbox.selectedID) { _, id in
                    guard let id else { return }
                    withAnimation(.easeInOut(duration: 0.25)) { proxy.scrollTo(id, anchor: .top) }
                }
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .onReceive(NotificationCenter.default.publisher(for: NSWindow.didBecomeKeyNotification)) { _ in
            // Coming back to the window is when new questions matter; no timer runs meanwhile.
            inbox.loadIfStale(maxAge: 30)
        }
        .sheet(item: $inbox.resumeFor) { session in
            InboxResumeSheet(model: model, inbox: inbox, session: session)
        }
    }

    /// "3 waiting in 2 sessions · 1 queued": what waits for the user, in how many sessions, and how
    /// many answers only wait for their session's next prompt.
    static func summary(_ rows: [InboxSession]) -> String {
        let waiting = rows.reduce(0) { $0 + $1.waiting }
        let sessions = rows.filter { $0.waiting > 0 }.count
        let queued = rows.reduce(0) { $0 + ($1.queued ?? 0) }
        var parts: [String] = []
        if waiting > 0 {
            parts.append("\(waiting) waiting in \(sessions) session\(sessions == 1 ? "" : "s")")
        } else {
            parts.append("nothing waiting")
        }
        if queued > 0 {
            parts.append("\(queued) queued")
        }
        return parts.joined(separator: " · ")
    }

    private func header(_ rows: [InboxSession]) -> some View {
        HStack(spacing: 10) {
            Image(systemName: "tray.full").foregroundColor(InboxStyle.accent)
            Text("Waiting for you").font(.system(size: 14, weight: .semibold))
            Text(verbatim: Self.summary(rows))
                .font(.system(size: 12))
                .foregroundColor(ReviewPalette.dim)
            Spacer()
            if let notice = model.notice {
                NoticePill(text: notice) { model.notice = nil }
            }
            if let loadedAt = inbox.loadedAt {
                Text("checked \(HubFormat.ago(loadedAt))")
                    .font(.system(size: 11))
                    .foregroundColor(ReviewPalette.dim)
            }
            IconButton(systemName: "arrow.clockwise", tooltip: "Look for waiting sessions again") { inbox.load() }
        }
        .padding(.horizontal, 18)
        .frame(height: 44)
        .hubSurface(.bar)
    }
}

private struct InboxSessionSection: View {
    @ObservedObject var model: HubModel
    @ObservedObject var inbox: HubInboxModel
    let session: InboxSession
    @State private var showInfo = false

    private var hubSession: HubSession? {
        session.sessionId.flatMap { id in model.sessions.first { $0.sessionId == id } }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            header
                .findRow("session:\(session.id)")
            ForEach(session.items) { item in
                if item.isForm {
                    InboxFormCard(inbox: inbox, item: item)
                } else {
                    InboxDecisionCard(model: model, inbox: inbox, session: session, item: item)
                }
            }
            InboxSendBar(model: model, inbox: inbox, session: session)
        }
    }

    private var header: some View {
        HStack(spacing: 8) {
            ProviderBadge(provider: session.provider ?? "?")
            FindText(session.displayTitle, field: "title")
                .font(.system(size: 13.5, weight: .semibold))
                .lineLimit(1)
            FindText(session.projectName, field: "project")
                .font(.system(size: 11.5))
                .foregroundColor(ReviewPalette.dim)
            if let branch = session.branch {
                FindText(branch, field: "branch")
                    .font(.system(size: 11, design: .monospaced))
                    .foregroundColor(ReviewPalette.dim)
                    .lineLimit(1)
                    .truncationMode(.middle)
            }
            Spacer(minLength: 8)
            if let sessionId = session.sessionId {
                Button {
                    showInfo.toggle()
                } label: {
                    HStack(spacing: 4) {
                        Image(systemName: "info.circle").font(.system(size: 11))
                        Text(verbatim: "# \(sessionId.prefix(8))").font(.system(size: 11, design: .monospaced))
                    }
                    .foregroundColor(ReviewPalette.dim)
                }
                .buttonStyle(.genHoverPlain())
                .instantTooltip("Session details: account, model, cost, cmux, resume")
                .popover(isPresented: $showInfo, arrowEdge: .bottom) {
                    SessionInfoPopover(model: model, inbox: inbox, session: session, hubSession: hubSession)
                }
                // `--inbox-info <id>`: a scripted run opens this popover.
                .onChange(of: inbox.infoFor) { _, id in
                    if id == sessionId {
                        showInfo = true
                    }
                }
                .onAppear {
                    if inbox.infoFor == sessionId {
                        showInfo = true
                    }
                }
            }
            if session.provider == "claude" {
                IconButton(systemName: "terminal", tooltip: "Show this session's cmux pane") {
                    inbox.focusPane(session) { model.notice = $0 }
                }
            }
            IconButton(systemName: "text.bubble", tooltip: hubSession == nil ? "This session is older than the hub's list" : "Open this session's transcript in the hub") {
                if let hubSession { model.openSession(hubSession) }
            }
            .disabled(hubSession == nil)
        }
    }

}

/// One session's Send: "Send N answers to <session>", the exact message under it, then where it went
/// (or why it did not, with Resume elsewhere). Shared by the Inbox section and the Decisions pane, so
/// both send the same way: every marked answer as one message through `tools question inbox send`.
struct InboxSendBar: View {
    @ObservedObject var model: HubModel
    @ObservedObject var inbox: HubInboxModel
    let session: InboxSession

    private var drafted: [InboxItem] { session.draftedItems }
    private var sending: Bool { session.sessionId.map { inbox.sendingSessions.contains($0) } ?? false }
    private var result: InboxDelivery? { session.sessionId.flatMap { inbox.sessionResults[$0] } }

    /// The message the Send button will type, previewed under it.
    static func preview(_ drafted: [InboxItem]) -> String {
        drafted.compactMap { item -> String? in
            guard let number = item.number else { return nil }
            let letters = (item.draftOption ?? "").map { "\($0)) " }.joined()
            let note = item.draft?.trimmed ?? ""
            let labels = (item.draftOption ?? "").compactMap { letter in
                (item.choices ?? []).first { $0.id == String(letter) }?.label
            }
            let text = note.isEmpty ? labels.joined(separator: " / ") : note
            return "DECISION \(number): \(letters)\(text)".trimmed
        }.joined(separator: "\n")
    }

    var body: some View {
        if !drafted.isEmpty || result != nil || sending {
            VStack(alignment: .leading, spacing: 6) {
                HStack(spacing: 8) {
                    Button {
                        inbox.sendSession(session)
                    } label: {
                        Label(sending ? "Sending…" : "Send \(drafted.count) answer\(drafted.count == 1 ? "" : "s") to \(session.displayTitle)", systemImage: "paperplane.fill")
                            .font(.system(size: 12, weight: .semibold))
                            .foregroundColor(drafted.isEmpty ? ReviewPalette.dim : .black)
                            .padding(.horizontal, 12)
                            .frame(height: 28)
                            .background(RoundedRectangle(cornerRadius: 8).fill(drafted.isEmpty ? Color.white.opacity(0.06) : InboxStyle.accent))
                    }
                    .buttonStyle(.genHoverPlain())
                    .disabled(drafted.isEmpty || sending || session.sessionId == nil)
                    .instantTooltip("Send every marked answer to the agent as one message")
                    if sending {
                        ProgressView().controlSize(.small)
                    }
                    Spacer()
                }
                let preview = Self.preview(drafted)
                if !preview.isEmpty && result == nil {
                    Text(verbatim: preview)
                        .font(.system(size: 11, design: .monospaced))
                        .foregroundColor(ReviewPalette.dim)
                        .textSelection(.enabled)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(7)
                        .background(RoundedRectangle(cornerRadius: 7).fill(Color.black.opacity(0.3)))
                }
                if let result {
                    InboxDeliveryLine(delivery: result)
                    if result.isQueued || result.isError {
                        Button {
                            inbox.resumeFor = session
                        } label: {
                            Label("Resume this session elsewhere…", systemImage: "arrow.uturn.forward")
                                .font(.system(size: 11.5))
                                .foregroundColor(ReviewPalette.renamed)
                        }
                        .buttonStyle(.genHoverPlain())
                        .instantTooltip("Pick a pane to reopen this session; the answer rides its first prompt")
                    }
                }
            }
            .padding(.top, 2)
        }
    }
}

/// A delivery under a Send: what reached the agent, or a one-sentence reason nothing did. A failure
/// never shows a green check, and the raw tool output hides behind a Details disclosure.
struct InboxDeliveryLine: View {
    let delivery: InboxDelivery

    var body: some View {
        let color = delivery.isError ? ReviewPalette.removed : delivery.isQueued ? ReviewPalette.modified : ReviewPalette.added
        HStack(alignment: .top, spacing: 7) {
            Image(systemName: delivery.isError ? "exclamationmark.triangle.fill" : delivery.isQueued ? "tray.and.arrow.down" : "checkmark.circle.fill")
                .foregroundColor(color)
            VStack(alignment: .leading, spacing: 2) {
                Text(delivery.summary).foregroundColor(color)
                if let raw = delivery.raw, !raw.isEmpty {
                    DisclosureGroup {
                        Text(verbatim: raw)
                            .font(.system(size: 10.5, design: .monospaced))
                            .foregroundColor(ReviewPalette.dim)
                            .textSelection(.enabled)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    } label: {
                        Text("Details").font(.system(size: 11)).foregroundColor(ReviewPalette.dim)
                    }
                }
            }
        }
        .font(.system(size: 11.5))
        .textSelection(.enabled)
    }
}

/// One decision, with the context that led to it: the findings, the code it points at, each option
/// with its reason and a Recommended badge. A click MARKS an option (⌘-click adds a second); the
/// session's Send delivers every mark at once. Nothing is sent on a click.
struct InboxDecisionCard: View {
    @ObservedObject var model: HubModel
    @ObservedObject var inbox: HubInboxModel
    let session: InboxSession
    let item: InboxItem
    @State private var note = ""
    @State private var noteSeeded = false
    @State private var showContext = false
    @State private var showAsk = false
    @State private var showReply = false
    @State private var saveTask: Task<Void, Never>?
    /// ⌘F: when the current match is in this card's folded context, the context unfolds by itself.
    @Environment(\.panelFindHighlight) private var highlight

    private var writing: Bool { inbox.writing.contains(item.id) }
    private var pickable: Bool { item.isOpen && session.sessionId != nil }
    private var letters: String { item.draftOption ?? "" }
    private var contextRevealed: Bool {
        showContext || (highlight?.current?.row == item.id && highlight?.current?.field == "context")
    }

    private var heading: String {
        if let title = item.title, !title.trimmed.isEmpty { return title }
        return (item.prompt ?? "").split(separator: "\n").first.map(String.init) ?? "DECISION \(item.number ?? 0)"
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 9) {
            headerRow
            if let ask = session.reply?.ask, !ask.isEmpty, item.source == "transcript" {
                askRow(ask)
            }
            if let context = item.context, !context.isEmpty {
                contextSection(context)
            }
            if !item.excerptRefs.isEmpty {
                excerptSection
            }
            if let notes = item.notes, !notes.isEmpty {
                FindText(inlineMarkdown(notes), field: "notes")
                    .font(.system(size: 11.5))
                    .foregroundColor(ReviewPalette.dim)
                    .textSelection(.enabled)
            }
            if let proposal = item.proposal, !proposal.isEmpty {
                HStack(alignment: .top, spacing: 6) {
                    Image(systemName: "lightbulb").foregroundColor(InboxStyle.accent.opacity(0.9))
                    FindText(inlineMarkdown(proposal), field: "proposal").italic()
                }
                .font(.system(size: 12)).foregroundColor(Color.white.opacity(0.8))
            }
            VStack(alignment: .leading, spacing: 3) {
                ForEach(item.choices ?? [], id: \.id) { choice in
                    optionRow(choice)
                }
            }
            if item.isOpen {
                noteField
            }
            footerRow
        }
        .padding(13)
        .background(RoundedRectangle(cornerRadius: 11).fill(Color.white.opacity(item.isOpen ? 0.045 : 0.025)))
        .overlay(RoundedRectangle(cornerRadius: 11).stroke(borderColor))
        .findRow(item.id, cornerRadius: 11)
        .onAppear {
            if !noteSeeded {
                note = item.draft ?? ""
                noteSeeded = true
            }
        }
        .sheet(isPresented: $showReply) {
            InboxReplySheet(title: heading, markdown: session.reply?.markdown ?? item.prompt ?? "")
        }
    }

    private var borderColor: Color {
        if !item.isOpen {
            return ReviewPalette.added.opacity(0.3)
        }
        return (letters.isEmpty && note.trimmed.isEmpty) ? InboxStyle.accent.opacity(0.3) : InboxStyle.accent.opacity(0.7)
    }

    private var headerRow: some View {
        HStack(spacing: 8) {
            Text(verbatim: "\(item.number ?? 0)")
                .font(.system(size: 11, weight: .heavy, design: .monospaced))
                .foregroundColor(.black)
                .frame(minWidth: 20, minHeight: 20)
                .background(RoundedRectangle(cornerRadius: 5).fill(item.isOpen ? InboxStyle.accent : ReviewPalette.added))
            FindText(heading, field: "title")
                .font(.system(size: 13.5, weight: .semibold))
                .foregroundColor(Color.white.opacity(item.isOpen ? 0.95 : 0.7))
                .lineLimit(3)
                .textSelection(.enabled)
            if item.blocking == true && item.isOpen {
                InboxTag(text: "blocking", color: ReviewPalette.removed)
            }
            if let confidence = item.confidence {
                Text(verbatim: "[\(confidence)]")
                    .font(.system(size: 11, weight: .semibold, design: .monospaced))
                    .foregroundColor(ReviewPalette.dim)
            }
            Spacer(minLength: 8)
            if item.isOpen {
                Label(HubFormat.ago(item.date), systemImage: "clock")
                    .font(.system(size: 11))
                    .foregroundColor(ReviewPalette.dim)
            } else {
                Label(item.option.map { "\(item.status) \($0))" } ?? item.status, systemImage: "checkmark.circle.fill")
                    .font(.system(size: 11.5))
                    .foregroundColor(ReviewPalette.added)
            }
        }
    }

    private func askRow(_ ask: String) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Button { showAsk.toggle() } label: {
                HStack(spacing: 5) {
                    Image(systemName: "quote.opening").font(.system(size: 9))
                    Text(verbatim: showAsk ? "Asked" : "Asked: \(ask)")
                        .font(.system(size: 11))
                        .lineLimit(showAsk ? nil : 1)
                }
                .foregroundColor(ReviewPalette.dim)
            }
            .buttonStyle(.genHoverPlain())
            .instantTooltip("The prompt that led to this reply")
            if showAsk, let full = session.reply?.askFull {
                Text(verbatim: full)
                    .font(.system(size: 11.5))
                    .foregroundColor(Color.white.opacity(0.7))
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
    }

    private func contextSection(_ context: String) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 6) {
                Text("Context").font(.system(size: 10.5, weight: .semibold)).foregroundColor(ReviewPalette.dim)
                Spacer()
                Button(contextRevealed ? "Show less" : "Show all") { withAnimation(.easeInOut(duration: 0.15)) { showContext = !contextRevealed } }
                    .buttonStyle(.genHoverPlain())
                    .font(.system(size: 10.5))
                    .foregroundColor(ReviewPalette.renamed)
            }
            MarkdownContentView(markdown: context, style: contextStyle)
                .findField("context")
                .frame(maxHeight: contextRevealed ? nil : 150, alignment: .top)
                .clipped()
        }
        .padding(9)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: 8).fill(Color.black.opacity(0.22)))
    }

    private var contextStyle: MarkdownStyle {
        var style = MarkdownStyle()
        style.bodySize = 12
        style.textColor = .white.opacity(0.82)
        style.blockSpacing = 6
        return style
    }

    private var excerptSection: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("Code").font(.system(size: 10.5, weight: .semibold)).foregroundColor(ReviewPalette.dim)
            ForEach(Array(item.excerptRefs.enumerated()), id: \.offset) { index, ref in
                InboxExcerptCard(ref: ref, cwd: session.cwd, field: "ref:\(index)")
            }
        }
    }

    private var noteField: some View {
        TextField((item.choices ?? []).isEmpty ? "Your answer…" : "Note to send with the letter, or an answer of your own…", text: $note, axis: .vertical)
            .textFieldStyle(.plain)
            .font(.system(size: 12))
            .lineLimit(1...4)
            .padding(7)
            .background(RoundedRectangle(cornerRadius: 7).stroke(Color.white.opacity(0.12)))
            .disabled(!pickable)
            .onChange(of: note) { _, value in
                guard noteSeeded, pickable else { return }
                saveTask?.cancel()
                saveTask = Task {
                    try? await Task.sleep(nanoseconds: 600_000_000)
                    if !Task.isCancelled {
                        inbox.draft(item, in: session, option: nil, text: value)
                    }
                }
            }
            .onSubmit {
                saveTask?.cancel()
                inbox.draft(item, in: session, option: nil, text: note)
            }
    }

    private var footerRow: some View {
        HStack(spacing: 8) {
            if writing {
                ProgressView().controlSize(.small)
            }
            if let failure = inbox.writeErrors[item.id] {
                Label(failure, systemImage: "exclamationmark.triangle.fill")
                    .font(.system(size: 11))
                    .foregroundColor(ReviewPalette.removed)
                    .lineLimit(2)
                    .truncationMode(.middle)
                    .textSelection(.enabled)
            }
            if let record = item.delivery {
                VStack(alignment: .leading, spacing: 2) {
                    FindText(record.line, field: "delivery")
                        .font(.system(size: 11))
                        .foregroundColor(record.isQueued ? ReviewPalette.modified : ReviewPalette.dim)
                        .lineLimit(2)
                        .truncationMode(.middle)
                    if let raw = record.raw, !raw.isEmpty {
                        DisclosureGroup {
                            Text(verbatim: raw)
                                .font(.system(size: 10.5, design: .monospaced))
                                .foregroundColor(ReviewPalette.dim)
                                .textSelection(.enabled)
                                .frame(maxWidth: .infinity, alignment: .leading)
                        } label: {
                            Text("Details").font(.system(size: 10.5)).foregroundColor(ReviewPalette.dim)
                        }
                    }
                }
            }
            Spacer(minLength: 6)
            if item.isOpen {
                Button("Dismiss") { inbox.dismiss(item, in: session) }
                    .buttonStyle(.genHoverPlain())
                    .font(.system(size: 11))
                    .foregroundColor(ReviewPalette.dim)
                    .instantTooltip("Drop this decision without sending an answer")
            }
            if session.reply != nil {
                Button("Open the whole reply") { showReply = true }
                    .buttonStyle(.genHoverPlain())
                    .font(.system(size: 11))
                    .foregroundColor(ReviewPalette.renamed)
            }
            if let hubSession = session.sessionId.flatMap({ id in model.sessions.first { $0.sessionId == id } }) {
                Button("Open in transcript") {
                    model.transcriptQuery = "DECISION \(item.number ?? 0)"
                    model.openSession(hubSession)
                }
                .buttonStyle(.genHoverPlain())
                .font(.system(size: 11))
                .foregroundColor(ReviewPalette.renamed)
                .instantTooltip("Open the session and search the transcript for this decision")
            }
        }
    }

    private func optionRow(_ choice: InboxChoice) -> some View {
        let chosen = letters.contains(choice.id)
        return Button {
            let add = (NSApp.currentEvent?.modifierFlags ?? NSEvent.modifierFlags).contains(.command)
            let next = Self.toggled(letters, choice.id, add: add)
            inbox.draft(item, in: session, option: next, text: note)
        } label: {
            HStack(alignment: .top, spacing: 9) {
                Text(verbatim: "\(choice.id))")
                    .font(.system(size: 12.5, weight: .bold, design: .monospaced))
                    .foregroundColor(chosen ? .black : Color.white.opacity(0.85))
                    .frame(width: 26, height: 21)
                    .background(RoundedRectangle(cornerRadius: 5).fill(chosen ? ReviewPalette.added : Color.white.opacity(0.08)))
                VStack(alignment: .leading, spacing: 2) {
                    HStack(spacing: 6) {
                        FindText(inlineMarkdown(choice.label), field: "choice:\(choice.id)")
                            .font(.system(size: 12.5))
                            .foregroundColor(Color.white.opacity(item.isOpen || chosen ? 0.92 : 0.55))
                            .frame(maxWidth: .infinity, alignment: .leading)
                        if choice.recommended == true || item.recommended == choice.id {
                            InboxTag(text: "recommended", color: ReviewPalette.added)
                        }
                    }
                    if let rationale = choice.rationale, !rationale.isEmpty {
                        FindText(inlineMarkdown(rationale), field: "rationale:\(choice.id)")
                            .font(.system(size: 11))
                            .foregroundColor(ReviewPalette.dim)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                }
            }
            .padding(.vertical, 4)
            .padding(.horizontal, 6)
            .contentShape(Rectangle())
        }
        .buttonStyle(.genHoverRow(accent: .white, cornerRadius: 7))
        .disabled(!pickable)
        .instantTooltip(pickable
            ? (chosen ? "Click to unmark \(choice.id))  ·  ⌘-click to add another" : "Mark \(choice.id))  ·  ⌘-click to add a second")
            : "Already \(item.status)")
    }

    /// Toggles one letter in a pick string. Plain click replaces the set; ⌘-click adds or removes.
    static func toggled(_ current: String, _ id: String, add: Bool) -> String {
        var set = Set(current.map(String.init))
        if add {
            if set.contains(id) { set.remove(id) } else { set.insert(id) }
        } else {
            set = set == [id] ? [] : [id]
        }
        return set.sorted().joined()
    }
}

/// One `file:line` excerpt: the real lines the loader read, syntax highlighted, with Open in Cursor.
private struct InboxExcerptCard: View {
    let ref: InboxRef
    let cwd: String?
    /// The ⌘F field key of this excerpt's path (`ref:<index>`).
    let field: String

    private var displayPath: String {
        ref.line.map { "\(ref.path):\($0)" } ?? ref.path
    }

    private var absolute: String {
        if let absolute = ref.absolute { return absolute }
        if ref.path.hasPrefix("/") { return ref.path }
        return cwd.map { projectRoot(of: $0) + "/" + ref.path } ?? ref.path
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            HStack(spacing: 6) {
                Button { PathOpener.cursor(absolute, line: ref.line ?? 1) } label: {
                    FindText(displayPath, field: field)
                        .font(.system(size: 11, design: .monospaced))
                        .foregroundColor(Color(red: 0.55, green: 0.7, blue: 1))
                }
                .buttonStyle(.genHoverPlain())
                .instantTooltip("Open \(displayPath) in Cursor")
                Spacer()
                if ref.missing == true {
                    Text("file not found").font(.system(size: 10.5)).foregroundColor(ReviewPalette.removed)
                }
            }
            if let excerpt = ref.excerpt, !excerpt.isEmpty {
                CodeBlockText(
                    block: CodeBlockBuilder.numbered(excerpt, start: ref.startLine ?? ref.line ?? 1, language: SyntaxLanguage.forPath(ref.path), focus: ref.line),
                    limit: nil,
                    cacheKey: "inbox-\(ref.path):\(ref.line ?? 0)"
                )
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(7)
                .background(RoundedRectangle(cornerRadius: 6).fill(Color.black.opacity(0.35)))
            }
        }
    }
}

/// The whole assistant reply behind "Open the whole reply".
private struct InboxReplySheet: View {
    let title: String
    let markdown: String
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Text(title).font(.system(size: 13, weight: .semibold)).lineLimit(2)
                Spacer()
                IconButton(systemName: "xmark", tooltip: "Close") { dismiss() }
            }
            ScrollView {
                MarkdownContentView(markdown: markdown)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
        .padding(16)
        .frame(width: 680, height: 560)
        .background(Color(nsColor: ReviewPalette.background))
    }
}

/// A HubSession for the terminal and resume actions: the row from the hub's list when it has one,
/// else a stand-in built from what the inbox knows (an older session missing from the list).
func inboxHubSession(_ session: InboxSession, in model: HubModel) -> HubSession? {
    guard let sessionId = session.sessionId else { return nil }
    if let row = model.sessions.first(where: { $0.sessionId == sessionId }) {
        return row
    }
    let cwd = session.cwd ?? ""
    return HubSession(
        provider: session.provider ?? HubSession.claudeProvider,
        sessionId: sessionId,
        title: session.title,
        cwd: cwd,
        cwdShort: (cwd as NSString).lastPathComponent,
        project: session.project,
        gitBranch: session.branch,
        mtime: (session.date?.timeIntervalSince1970 ?? 0) * 1000,
        modelSwitched: false,
        filePath: ""
    )
}

/// R3: the rich session view behind the `# id` chip. Identity, place, cmux, cost and files, loaded
/// from what the inbox already knows plus the shared stores (repo facts, spend), off the main thread.
private struct SessionInfoPopover: View {
    @ObservedObject var model: HubModel
    @ObservedObject var inbox: HubInboxModel
    @ObservedObject private var repos = RepoFactsStore.shared
    let session: InboxSession
    let hubSession: HubSession?
    @State private var spend: HubSpend.Estimate?

    private var facts: RepoFacts? { session.cwd.flatMap { repos.facts(for: $0, pr: true) } }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 12) {
                identity
                place
                if let hubSession {
                    SessionTerminalSection(session: hubSession)
                }
                cost
                files
            }
            .padding(14)
            .frame(width: 360, alignment: .leading)
        }
        .frame(maxHeight: 560)
        .onAppear(perform: loadSpend)
    }

    private func row(_ label: String, _ value: String) -> some View {
        HStack(alignment: .top, spacing: 8) {
            Text(label).font(.system(size: 10.5)).foregroundColor(ReviewPalette.dim).frame(width: 84, alignment: .leading)
            Text(verbatim: value).font(.system(size: 11.5)).foregroundColor(Color.white.opacity(0.9)).textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    private var identity: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 8) {
                ProviderBadge(provider: session.provider ?? "?")
                Text(session.displayTitle).font(.system(size: 13, weight: .semibold)).lineLimit(2)
            }
            if let sessionId = session.sessionId {
                HStack(spacing: 6) {
                    Text("id").font(.system(size: 10.5)).foregroundColor(ReviewPalette.dim).frame(width: 84, alignment: .leading)
                    CopyChip(label: String(sessionId.prefix(12)), value: sessionId, tooltip: "Copy the full session id")
                }
            }
            if let account = session.account { row("account", account) }
            if let model = hubSession?.model { row("model", model) }
            if let last = hubSession?.lastActivity { row("last activity", HubFormat.ago(last)) }
            if let ttl = hubSession?.cacheTtlSec, ttl > 0 { row("cache", "\(ttl / 60) min left") }
        }
    }

    private var place: some View {
        VStack(alignment: .leading, spacing: 6) {
            Rectangle().fill(ReviewPalette.hairline).frame(height: 1)
            row("project", session.projectName)
            if let cwd = session.cwd, !cwd.isEmpty {
                HStack(alignment: .top, spacing: 8) {
                    Text("folder").font(.system(size: 10.5)).foregroundColor(ReviewPalette.dim).frame(width: 84, alignment: .leading)
                    PathLabel(path: cwd)
                }
            }
            if let branch = session.branch { row("branch", branch) }
            if let facts, facts.pr != nil {
                HStack(alignment: .top, spacing: 8) {
                    Text("pull request").font(.system(size: 10.5)).foregroundColor(ReviewPalette.dim).frame(width: 84, alignment: .leading)
                    PullRequestLink(facts: facts)
                }
            }
        }
    }

    private var cost: some View {
        VStack(alignment: .leading, spacing: 6) {
            Rectangle().fill(ReviewPalette.hairline).frame(height: 1)
            if let tokens = hubSession?.totalTokens { row("tokens", Self.compact(tokens)) }
            if let context = hubSession?.contextTokens { row("context", Self.compact(context)) }
            if let spend {
                row("est. cost", String(format: "$%.2f", spend.usd))
            } else {
                row("est. cost", "estimating…")
            }
        }
    }

    private var files: some View {
        VStack(alignment: .leading, spacing: 6) {
            Rectangle().fill(ReviewPalette.hairline).frame(height: 1)
            if let path = hubSession?.filePath, !path.isEmpty {
                HStack(alignment: .top, spacing: 8) {
                    Text("transcript").font(.system(size: 10.5)).foregroundColor(ReviewPalette.dim).frame(width: 84, alignment: .leading)
                    PathLabel(path: path)
                }
            }
            HStack(spacing: 10) {
                if let hubSession {
                    Button("Open in hub") { model.openSession(hubSession) }
                        .buttonStyle(.genHoverPlain()).font(.system(size: 11)).foregroundColor(ReviewPalette.renamed)
                }
            }
        }
    }

    /// A compact token count: 980, 12.3k, 1.4M.
    static func compact(_ n: Int) -> String {
        if n >= 1_000_000 { return String(format: "%.1fM", Double(n) / 1_000_000) }
        if n >= 1_000 { return String(format: "%.1fk", Double(n) / 1_000) }
        return String(n)
    }

    private func loadSpend() {
        if let cached = session.sessionId.flatMap({ HubSpend.cached($0) }) {
            spend = cached
            return
        }
        guard let hubSession else { return }
        DispatchQueue.global(qos: .utility).async {
            let estimate = HubSpend.fetch(hubSession)
            DispatchQueue.main.async { spend = estimate }
        }
    }
}

/// R4: "This session is not open anywhere. Where should it resume?" Reuses the LaunchPicker in resume
/// mode; once it reopens the session, the answers are queued and ride its first prompt.
struct InboxResumeSheet: View {
    @ObservedObject var model: HubModel
    @ObservedObject var inbox: HubInboxModel
    let session: InboxSession
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("This session is not open anywhere")
                .font(.system(size: 13, weight: .semibold))
            Text("Pick where to resume \(session.displayTitle). Once its pane is up, the answer is typed into it.")
                .font(.system(size: 11.5))
                .foregroundColor(ReviewPalette.dim)
                .fixedSize(horizontal: false, vertical: true)
            if let hubSession = inboxHubSession(session, in: model) {
                LaunchPicker(mode: .resume(hubSession)) { outcome in
                    inbox.run(HubInboxModel.resumeStep(outcome), for: session)
                    dismiss()
                }
            } else {
                Text("This session has no folder on this Mac, so it cannot be resumed here.")
                    .font(.system(size: 11.5)).foregroundColor(ReviewPalette.removed)
            }
            if !inbox.queueHookOn {
                Text("The decisions hook is off on this Mac, so a queued answer leaves only when you press Send again once the session runs.")
                    .font(.system(size: 11))
                    .foregroundColor(ReviewPalette.dim)
                    .fixedSize(horizontal: false, vertical: true)
            }
            HStack(spacing: 10) {
                if inbox.queueHookOn {
                    Button("Keep queued") {
                        inbox.deliverSession(session, resumeTarget: nil)
                        dismiss()
                    }
                    .instantTooltip("Store the answers; the session's next prompt receives them through the decisions hook")
                }
                Button("Copy the answer") {
                    // The same text Send would type, choice labels included.
                    PathOpener.copy(InboxSendBar.preview(session.draftedItems))
                }
                Spacer()
                Button("Cancel") { dismiss() }
            }
            .font(.system(size: 12))
        }
        .padding(16)
        .frame(width: 520)
        .background(Color(nsColor: ReviewPalette.background))
    }
}

/// A pending question form. One question with single-choice options sends on the click; anything
/// else (several questions, multiple choice, free text) is staged and sent with Submit.
private struct InboxFormCard: View {
    @ObservedObject var inbox: HubInboxModel
    let item: InboxItem
    @State private var picked: [String: Set<String>] = [:]
    @State private var texts: [String: String] = [:]

    private var questions: [InboxQuestion] { item.questions ?? [] }
    private var sending: Bool { inbox.sending.contains(item.id) }

    /// One question, single choice: the click is the answer.
    private var oneClick: Bool {
        questions.count == 1 && questions[0].multiple == false && !questions[0].choices.isEmpty
    }

    private var complete: Bool {
        questions.allSatisfy { question in
            !question.required || !(picked[question.itemId] ?? []).isEmpty || !(texts[question.itemId]?.trimmed.isEmpty ?? true)
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 8) {
                Image(systemName: "questionmark.bubble.fill").foregroundColor(ReviewPalette.renamed)
                Text("Question form").font(.system(size: 13, weight: .semibold))
                if let source = item.source {
                    Text(source).font(.system(size: 11)).foregroundColor(ReviewPalette.dim)
                }
                Spacer()
                CopyChip(label: String(item.id.suffix(8)), value: item.id, tooltip: "Copy the form id")
                Label(HubFormat.ago(item.date), systemImage: "clock")
                    .font(.system(size: 11))
                    .foregroundColor(ReviewPalette.dim)
            }
            ForEach(questions, id: \.itemId) { question in
                VStack(alignment: .leading, spacing: 5) {
                    FindText(inlineMarkdown(question.prompt), field: "q:\(question.itemId)")
                        .font(.system(size: 12.5))
                        .textSelection(.enabled)
                    HStack(spacing: 6) {
                        ForEach(question.choices, id: \.id) { choice in
                            choiceChip(question, choice)
                        }
                    }
                    if question.freeText {
                        TextField("Answer in your own words…", text: Binding(get: { texts[question.itemId] ?? "" }, set: { texts[question.itemId] = $0 }), axis: .vertical)
                            .textFieldStyle(.plain)
                            .font(.system(size: 12))
                            .lineLimit(1...4)
                            .padding(7)
                            .background(RoundedRectangle(cornerRadius: 7).stroke(Color.white.opacity(0.12)))
                    }
                }
            }
            HStack(spacing: 8) {
                if sending {
                    ProgressView().controlSize(.small)
                } else if let delivery = inbox.deliveries[item.id] {
                    InboxDeliveryLine(delivery: delivery)
                }
                Spacer()
                if !oneClick || questions.contains(where: \.freeText) {
                    Button {
                        inbox.answerForm(item, choices: picked, texts: texts)
                    } label: {
                        Label("Submit", systemImage: "paperplane.fill")
                            .font(.system(size: 12, weight: .semibold))
                            .foregroundColor(complete ? .black : ReviewPalette.dim)
                            .padding(.horizontal, 12)
                            .frame(height: 26)
                            .background(RoundedRectangle(cornerRadius: 7).fill(complete ? InboxStyle.accent : Color.white.opacity(0.06)))
                    }
                    .buttonStyle(.genHoverPlain())
                    .disabled(!complete || sending)
                    .instantTooltip(complete ? "Answer the form; the agent waiting on it continues" : "Every required question needs an answer first")
                }
            }
        }
        .padding(13)
        .background(RoundedRectangle(cornerRadius: 11).fill(Color.white.opacity(0.045)))
        .overlay(RoundedRectangle(cornerRadius: 11).stroke(ReviewPalette.renamed.opacity(0.3)))
        .findRow(item.id, cornerRadius: 11)
    }

    private func choiceChip(_ question: InboxQuestion, _ choice: InboxChoice) -> some View {
        let chosen = picked[question.itemId]?.contains(choice.id) ?? false
        return Button {
            var set = picked[question.itemId] ?? []
            if question.multiple {
                if chosen { set.remove(choice.id) } else { set.insert(choice.id) }
            } else {
                set = chosen ? [] : [choice.id]
            }
            picked[question.itemId] = set
            if oneClick && !question.freeText && !set.isEmpty {
                inbox.answerForm(item, choices: picked, texts: texts)
            }
        } label: {
            FindText(choice.label, field: "q:\(question.itemId):\(choice.id)")
                .font(.system(size: 12, weight: .medium))
                .foregroundColor(chosen ? .black : Color.white.opacity(0.9))
                .padding(.horizontal, 10)
                .frame(height: 24)
                .background(Capsule().fill(chosen ? InboxStyle.accent : Color.white.opacity(0.08)))
        }
        .buttonStyle(.genHoverPlain())
        .disabled(sending)
        .instantTooltip(oneClick && !question.freeText ? "Answer \"\(choice.label)\"" : chosen ? "Click again to unselect" : "Choose \"\(choice.label)\"")
    }
}

struct InboxTag: View {
    let text: String
    let color: Color

    var body: some View {
        Text(text)
            .font(.system(size: 10, weight: .semibold))
            .padding(.horizontal, 6)
            .padding(.vertical, 1)
            .background(Capsule().fill(color.opacity(0.18)))
            .foregroundColor(color)
    }
}

/// Bold, code and links in a prompt; anything that is not valid markdown stays plain text.
func inlineMarkdown(_ text: String) -> AttributedString {
    (try? AttributedString(markdown: text, options: AttributedString.MarkdownParsingOptions(interpretedSyntax: .inlineOnlyPreservingWhitespace)))
        ?? AttributedString(text)
}
