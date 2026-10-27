import AppKit
import SwiftUI
import UniformTypeIdentifiers

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

    /// The label without the agent's own "a) " before it: the row draws the letter in its badge, and "a) a) keep it"
    /// showed on 176 of 201 options (UX audit 2026-10-27, F1). The widget strips it the same way.
    var shownLabel: String { WidgetOptionText.text(label, letter: id) }
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

    /// "Sent 22:31 to cmux pane work · agent", "Sent 22:31 to Codex worker w1", "Waiting to send since 22:31: why".
    /// New rows store `cmux · …` and `codex worker …`; older rows stored the bare pane or worker name. Every delivered
    /// route reads "Sent": a Claude session's own channel (`claude-peer`) read "queued … when the decisions hook is on"
    /// under a header that said "Sent" (UX audit 2026-10-27, F7).
    var line: String {
        let time = HubFormat.date(at).map { Self.clock.string(from: $0) } ?? ""
        switch route {
        case "cmux":
            let where_ = place.map { $0.hasPrefix("cmux") ? $0 : "cmux pane \($0)" } ?? "the cmux pane"
            return "Sent \(time) to \(where_)"
        case "codex":
            let who = place.map { $0.hasPrefix("codex") ? "C" + $0.dropFirst() : "Codex worker \($0)" } ?? "the Codex worker"
            return "Sent \(time) to \(who)"
        case "resume": return "Resumed \(time) in " + (place ?? "a new pane") + "; the answer goes with its first prompt"
        case "prompt": return "Sent \(time) with the session's next prompt"
        case "queued":
            let why = error ?? place
            return "Waiting to send since \(time)" + (why.map { ": \($0)" } ?? "") + "."
        default:
            return "Sent \(time) to " + (place ?? "the session")
        }
    }

    var isQueued: Bool { route == "queued" }
}

struct InboxRef: Decodable, Hashable {
    let path: String
    let line: Int?
    let endLine: Int?
    /// The file the path names (the loader tries the session's folder, its checkout and the main checkout,
    /// then a unique suffix match); null when it could not be located.
    let absolute: String?
    /// The real lines read from disk by the loader; null when the file could not be read.
    let excerpt: String?
    /// The 1-based line the excerpt starts at.
    let startLine: Int?
    /// For syntax highlighting.
    let language: String?
    let missing: Bool?
    /// The folders a relative path was looked up in.
    let searched: [String]?
    /// Files the path matched by suffix: more than one means it is ambiguous.
    let matches: Int?

    var hasContent: Bool { (excerpt?.isEmpty == false) || missing == true }

    /// Why a missing ref has no lines, in the words the card shows: what was searched and where. Never
    /// "file not found" for a file that exists elsewhere (H5).
    var unresolvedNote: (label: String, detail: String) {
        let folders = (searched ?? []).map { ($0 as NSString).lastPathComponent }
        let unique = folders.reduce(into: [String]()) { if !$0.contains($1) { $0.append($1) } }
        if let matches, matches > 1 {
            return ("\(matches) matches", "\(matches) files end with \(path) under \(unique.first ?? "the session's folder"); the reply does not say which one.")
        }
        if path.hasPrefix("/") {
            return ("not on disk", "\(path) is not on this Mac any more.")
        }
        if unique.isEmpty {
            return ("can't locate", "The session's folder is not known, so \(path) cannot be looked up.")
        }
        return ("can't locate", "Not under \(unique.joined(separator: ", ")): the reply may name a file of another repository.")
    }
}

struct InboxQuestion: Decodable, Hashable {
    let itemId: String
    let prompt: String
    let choices: [InboxChoice]
    let multiple: Bool
    let freeText: Bool
    let required: Bool
    /// Whether this item accepts an `@file` tag (`AskItem.allowFileTags`, `src/question/lib/inbox/build.ts`).
    let fileTags: Bool
    /// Whether this item accepts a pasted/attached image (`AskItem.allowImagePaste`).
    let imagePaste: Bool
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
    /// A form's resolved cwd (`AskForm.cwd`): `@file` tags and the file-browse picker both root
    /// here. Null for a decision.
    let cwd: String?
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
    /// The posted text's revision; a pick or a dismiss sends it back so a pick on text the agent has since re-posted
    /// is refused (`--expected-revision`, src/question/lib/inbox/drafts.ts). Nil for a form.
    var revision: Int? = nil
    /// Who recorded a closed decision's answer (`agent`, `automatic_heuristic`, or the user), when the row says.
    var answeredVia: String? = nil

    var isForm: Bool { kind == "form" }
    var isOpen: Bool { status == "waiting" || status == "drafted" }
    /// The recorded answer's own words, when they say more than the picked options do. Nil when the answer only repeats
    /// a picked option ("b", "b) Keep it", "Keep it"), so a closed card never prints the same option twice (F7).
    var answerBeyondPick: String? {
        guard let answer = answer?.trimmed, !answer.isEmpty else { return nil }
        let picked = (option ?? "").map(String.init).compactMap { letter in choices?.first { $0.id == letter } }
        let echoes = picked.flatMap { [$0.id, "\($0.id))", $0.label, $0.shownLabel, "\($0.id)) \($0.shownLabel)"] }
        return echoes.contains { $0.trimmed.caseInsensitiveCompare(answer) == .orderedSame } ? nil : answer
    }
    var date: Date? { HubFormat.date(at) }
    /// The excerpt cards to draw: refs the loader could read, or that name a missing file.
    var excerptRefs: [InboxRef] { (refs ?? []).filter(\.hasContent) }
    /// The text ⌘F searches for this item: question, context, notes, options with reasons, ref paths.
    var searchText: String {
        var parts = [title ?? "", prompt ?? "", context ?? "", notes ?? "", answer ?? "", draft ?? ""]
        for choice in choices ?? [] {
            parts.append("\(choice.id)) \(choice.shownLabel) \(choice.rationale ?? "")")
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
            fields.append(PanelFindField("choice:\(choice.id)", String(inlineMarkdown(choice.shownLabel).characters)))
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
    /// Quiet for three days (the widget's rule, `INBOX_STALE_MS` in src/question/lib/inbox/build.ts): still
    /// listed and answerable, but its items no longer count as waiting.
    let stale: Bool?
    let reply: InboxReply?
    let items: [InboxItem]
    /// The account home the session runs under, so a send reaches the receiver of that home (the widget sends it too).
    var sourceHome: String? = nil

    /// Listed only for its queued answers: nothing here waits for the user.
    var isQueuedOnly: Bool { waiting == 0 && (queued ?? 0) > 0 }
    var isStale: Bool { stale ?? false }
    /// What this session adds to the "waiting" badges: nothing once it is quiet for three days.
    var countedWaiting: Int { isStale ? 0 : waiting }

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
    /// A send through the widget's engine: its outcome's own words (`WidgetDecisionSendOutcome.notice`), the same note
    /// the widget shows.
    var outcomeText: String? = nil
    /// Answered decisions no receiver took: Send again sends them (`resend-answers`), as in the widget.
    var resendIDs: [String] = []

    private enum CodingKeys: String, CodingKey {
        case text, channel, delivered, target, error, raw, detail
    }

    /// `message`: one sentence the user reads. `raw`: the tool's own output, shown behind Details only (F10).
    static func failure(_ message: String, raw: String? = nil) -> InboxDelivery {
        InboxDelivery(text: nil, channel: nil, delivered: false, target: nil, error: message, raw: raw, detail: nil)
    }

    /// A send through the widget's engine (`send-staged`, `resend-answers`), read by the widget's outcome: delivered,
    /// waiting for the session's next prompt (with Send again), or failed.
    static func outcome(_ outcome: WidgetDecisionSendOutcome, ids: [String], resend: Bool) -> InboxDelivery {
        // The hub skipped every id (sent, unstaged or answered meanwhile): the widget's sentence, never "sent".
        guard outcome.sent + outcome.queued + outcome.failed > 0 || !outcome.waiting.isEmpty else {
            return .failure(resend ? "These answers no longer wait for a send, so nothing was sent."
                                   : "These decisions are no longer staged, so nothing was sent.")
        }
        let text = outcome.notice(summary: Plural.count(ids.count, "decision") + " sent.", staged: !resend)
        var delivery = InboxDelivery(text: nil, channel: "widget", delivered: outcome.delivered, target: nil,
                                     error: outcome.failed > 0 ? text : nil, raw: outcome.details, detail: nil)
        delivery.outcomeText = text
        delivery.resendIDs = outcome.waiting.isEmpty || outcome.failed > 0 ? [] : ids
        return delivery
    }

    var summary: String {
        if let error { return error }
        if let outcomeText { return outcomeText }
        switch channel {
        case "cmux": return "Sent to \(target ?? "the session's cmux pane")"
        case "codex": return "Sent to \(target ?? "the Codex worker")"
        // The resumed pane never came up in time: the answers are stored, and nothing types them by itself.
        case "resume": return "Resumed at \(target ?? "a new pane"), but its pane was not up yet. The answers are kept: send them again once it is open."
        case "form": return "Answered; the waiting agent receives it"
        case "dry-run": return "Dry run: \(text ?? "")"
        // A Claude session's own message channel (`claude-peer`) and any later route: it says where the answer went.
        case _ where delivered == true: return "Sent to \(target ?? "the session")"
        // Stored, and no receiver took it: the widget's word for that state (P3), with the reason.
        default:
            return "Waiting to send: \(target ?? detail ?? "no open pane or worker took the answer"). Send again once the session runs."
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
    /// The Inbox rows the arrow keys step through, in InboxListView's order: the waiting sessions, then the quiet ones
    /// while their fold is open.
    nonisolated static func keyOrder(_ rows: [InboxSession], showsQuiet: Bool) -> [String] {
        let fresh = rows.filter { !$0.isStale }.map(\.id)
        return showsQuiet ? fresh + rows.filter(\.isStale).map(\.id) : fresh
    }


    @Published private(set) var sessions: [InboxSession] = []
    /// A notification's target that is not waiting any more: said once, instead of the click doing nothing.
    @Published var revealMissing: String?
    @Published private(set) var loading = false
    @Published private(set) var loadedAt: Date?
    @Published private(set) var error: String?
    /// The session the sidebar picked; the main list scrolls to it.
    @Published var selectedID: String?
    /// The sidebar's fold of sessions quiet for three days is open. One state for the list and its arrow keys, so Down
    /// reaches exactly the rows on screen (`keyOrder`).
    @Published var showsQuiet = false
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
    /// The card a `--decision` / `--question` launch asked for (a banner click): outlined and scrolled to.
    @Published var focusedItemID: String?
    /// Bumped per reveal, so a second click on the same banner scrolls back to the card.
    @Published private(set) var focusRequest = 0
    /// `--inbox-resume <id>` / `--inbox-info <id>` / `--decision <id>` / `--question <id>`: opened once the
    /// list has loaded, then cleared.
    enum Reveal {
        case resume(String)
        case info(String)
        case item(String)
    }
    var reveal: Reveal?
    /// Called once after the next load (a snapshot run waits for it).
    var onLoaded: (() -> Void)?
    /// The widget's settings for answering a decision (Decision click, ⌘ does the other, Return in an own answer):
    /// the Inbox answers the way the widget does (`DecisionAnswering`). Read again on each load and before each click.
    @Published private(set) var preferences: WidgetPreferences?
    /// The decision whose note field has the keyboard: ⌘-Return there belongs to the note, not to the Send bar.
    @Published var noteFocusID: String?
    /// Work waiting for an item's draft writes to land: a send at once waits for its pick.
    private var afterWrites: [String: [() -> Void]] = [:]
    /// The letters a click staged a moment ago, by item id, shown until the reload after its write (the widget's
    /// `pendingStage`): a second ⇧-click builds on them instead of on the last load.
    @Published private(set) var pendingLetters: [String: String] = [:]
    /// Staged ids whose send waits for the session's running send to end, by session id.
    private var queuedSends: [String: [String]] = [:]
    /// Dismisses held for their Undo, by item id: the write happens when the hold ends (the widget's Dismiss).
    @Published private(set) var heldDismiss: Set<String> = []
    private var dismissTasks: [String: Task<Void, Never>] = [:]
    /// A decision's note as typed in its card and not staged yet, by item id. Not published: a keystroke redraws its own
    /// card only. It outlives the lazy row, so a note survives scrolling away and a reload. Nothing is staged until
    /// Return, ⌘-Return, Stage note or an option click (UX audit 2026-10-27, F3: a pause in typing staged it and
    /// reloaded the whole Inbox).
    var noteTexts: [String: String] = [:]
    /// Images attached to a question form and not sent yet, by form id, then question id. Here, not in the lazy card:
    /// a card scrolled out of view deleted them (F11). Dropped with their files once the form is no longer listed.
    fileprivate var formImages: [String: [String: [QaAttachedImage]]] = [:]
    /// The decision card the number keys act on (1 to 9 pick its options), moved by Up and Down in the list (F8).
    @Published var keyCardID: String?
    /// Return on the key card puts the keyboard into its note: the card whose id this names, once per count.
    @Published private(set) var noteFocusTarget: String?
    @Published private(set) var noteFocusCount = 0
    /// When the last reveal began: its card flashes for the alert flash time, and a card built later plays the rest (F18).
    @Published private(set) var focusedAt: Date?
    /// Reveals per item id: a card's flash plays when its own count moves, never when another card is revealed.
    @Published private(set) var revealCounts: [String: Int] = [:]
    private var focusClear: Task<Void, Never>?
    /// The session and number of a revealed decision that no longer waits, for the notice's "Open in transcript".
    @Published var revealMissingTarget: RevealTarget?
    struct RevealTarget: Equatable {
        let sessionId: String
        let number: Int
    }
    /// The tool's own output behind a write's one-sentence failure, by item id, shown behind Details (F10).
    @Published private(set) var writeErrorDetails: [String: String] = [:]
    /// A delivered send's result fades after the note time, as the widget's note does (P2); a warning or error stays.
    private var resultFades: [String: Task<Void, Never>] = [:]

    /// The badge count (mode switch, header): items of sessions that moved in the last three days.
    var waitingCount: Int { sessions.reduce(0) { $0 + $1.countedWaiting } }

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
            let preferences = WidgetPreferencesFile.shared.current()
            DispatchQueue.main.async { [weak self] in
                MainActor.assumeIsolated {
                    guard let self else { return }
                    self.loading = false
                    if self.preferences != preferences { self.preferences = preferences }
                    if self.reloadPending {
                        self.reloadPending = false
                        self.load()
                        return
                    }
                    switch result {
                    case .success(let envelope):
                        // A pick the reload now shows (or that another surface changed meanwhile) is the store's.
                        // Each assignment publishes, and every view of the Inbox runs again: only a change assigns.
                        let pending = self.pendingLetters.filter { self.writing.contains($0.key)
                            || self.pendingWrites[$0.key] != nil }
                        if pending != self.pendingLetters { self.pendingLetters = pending }
                        // An unchanged Inbox (the usual reload on a mode switch) redraws nothing.
                        if self.sessions != envelope.sessions {
                            HubMainBusy.measure("inbox.render")
                            self.sessions = envelope.sessions
                        }
                        if self.error != nil { self.error = nil }
                        self.loadedAt = Date()
                        self.pruneFormImages()
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
        // Once per load: a target already answered is not listed, and must not jump the list later.
        self.reveal = nil
        switch reveal {
        case .resume(let id):
            if let session = match(id) {
                resumeFor = session
            } else {
                revealMissing = "Session \(id.prefix(8)) has nothing waiting in the Inbox any more"
            }
        case .info(let id):
            if let session = match(id) {
                infoFor = session.sessionId
            } else {
                revealMissing = "Session \(id.prefix(8)) has nothing waiting in the Inbox any more"
            }
        case .item(let id):
            guard let session = sessions.first(where: { $0.items.contains { $0.id == id } }) else {
                HubPerf.log("inbox.reveal: \(id) is not waiting in the Inbox")
                let target = Self.revealTarget(id)
                revealMissingTarget = target
                revealMissing = target.map { "\(WidgetWords.decision($0.number)) is not waiting any more." }
                    ?? "That decision is not waiting any more."
                explainNotWaiting(id)
                return
            }
            selectedID = session.id
            focusedItemID = id
            keyCardID = id
            focusRequest += 1
            focusedAt = Date()
            revealCounts[id, default: 0] += 1
            // The flash points at the card, then leaves nothing behind: the outline stayed until the next link (F18).
            let seconds = WidgetAlerts.flashSeconds(preferences)
            focusClear?.cancel()
            focusClear = Task { [weak self] in
                do { try await Task.sleep(for: .seconds(max(seconds, 1.5))) } catch { return }
                self?.focusedItemID = nil
            }
        }
    }

    /// `d_<number>_<session>`: the session and number a decision id names.
    nonisolated static func revealTarget(_ id: String) -> RevealTarget? {
        let parts = id.split(separator: "_", maxSplits: 2)
        guard parts.count == 3, parts[0] == "d", let number = Int(parts[1]) else { return nil }
        return RevealTarget(sessionId: String(parts[2]), number: number)
    }

    /// The card the number keys act on: the one named, else the first open decision of the selected session.
    func keyCard(in rows: [InboxSession]) -> (session: InboxSession, item: InboxItem)? {
        let open = rows.flatMap { session in session.items.filter { !$0.isForm && $0.isOpen }.map { (session, $0) } }
        if let id = keyCardID, let hit = open.first(where: { $0.1.id == id }) { return hit }
        if let selected = selectedID, let hit = open.first(where: { $0.0.id == selected }) { return hit }
        return nil
    }

    /// Up and Down in the main list: the key card moves to the open decision above or below, across sessions.
    @discardableResult
    func moveKeyCard(_ step: Int, in rows: [InboxSession]) -> String? {
        let ids = rows.flatMap { $0.items.filter { !$0.isForm && $0.isOpen }.map(\.id) }
        guard !ids.isEmpty else { return nil }
        let current = keyCard(in: rows)?.item.id
        let index = current.flatMap { ids.firstIndex(of: $0) }
        let next = index.map { min(max($0 + step, 0), ids.count - 1) } ?? (step > 0 ? 0 : ids.count - 1)
        keyCardID = ids[next]
        return ids[next]
    }

    /// Return on the key card: the keyboard goes into its note.
    func focusNote(_ id: String) {
        noteFocusTarget = id
        noteFocusCount += 1
    }

    /// Form images whose form is no longer listed (answered, withdrawn, gone) are deleted with their files.
    private func pruneFormImages() {
        let listed = Set(sessions.flatMap { $0.items.filter(\.isForm).map(\.id) })
        for (formId, images) in formImages where !listed.contains(formId) && !sending.contains(formId) {
            images.values.flatMap { $0 }.forEach { QaAttachedImage.remove($0.path) }
            formImages[formId] = nil
        }
    }

    /// Says what became of a decision a banner or a link asked for that the Inbox no longer lists: its state and the
    /// answer it took, read from the session's decisions (`tools question inbox --session <id> --json`).
    private func explainNotWaiting(_ id: String) {
        let parts = id.split(separator: "_", maxSplits: 2)
        guard parts.count == 3, parts[0] == "d", let number = Int(parts[1]) else { return }
        let sessionId = String(parts[2])
        DispatchQueue.global(qos: .userInitiated).async {
            let found = try? JSONDecoder().decode(SessionDecisionsEnvelope.self, from: ToolsCLIRunner.run(
                ["question", "inbox", "--session", sessionId, "--json"]))
            let item = found?.decisions.first { $0.id == id }
            DispatchQueue.main.async { [weak self] in
                MainActor.assumeIsolated {
                    guard let self, self.revealMissing != nil else { return }
                    self.revealMissing = Self.notWaitingSentence(number: number, item: item)
                }
            }
        }
    }

    /// "Decision 26 is not waiting: it was answered (b) as a separate draft pr)."
    nonisolated static func notWaitingSentence(number: Int, item: InboxItem?) -> String {
        guard let item else { return "\(WidgetWords.decision(number)) is not in the decision log any more." }
        let state: String
        switch item.status {
        case "acknowledged", "implemented": state = "it was answered"
        case "answered": state = "its answer waits to be sent"
        case "sent": state = "its answer was sent"
        case "dismissed": state = "it was dismissed"
        case "superseded": state = "a later decision replaced it"
        default: state = "it is \(item.status)"
        }
        let picks = (item.option ?? "").map { "\($0))" }.joined(separator: " ")
        let words = [picks, item.answer?.trimmed ?? ""].filter { !$0.isEmpty }.joined(separator: " ")
        return "\(WidgetWords.decision(number)) is not waiting: \(state)" + (words.isEmpty ? "." : " (\(words.prefix(160))).")
    }

    /// Marks (or clears) a decision's pick and note: it is staged. Pass the whole letters string (`"a"`, `"ac"`, or
    /// `""` to clear the pick); `text` is the note, nil to keep the stored one. `then` runs once the write landed (a
    /// send at once). The item's revision goes along, so a pick on text the agent has since changed is refused.
    func draft(_ item: InboxItem, in session: InboxSession, option: String?, text: String?, then: (() -> Void)? = nil) {
        guard let sessionId = session.sessionId, let number = item.number else { return }
        var args = ["question", "inbox", "draft", "--session", sessionId, "--decision", String(number)]
        if let option {
            args += ["--option", option]
            pendingLetters[item.id] = option
        }
        if let text { args += ["--text", text] }
        if let provider = session.provider { args += ["--provider", provider] }
        if let cwd = session.cwd, !cwd.isEmpty { args += ["--cwd", cwd] }
        if let revision = item.revision { args += ["--expected-revision", String(revision)] }
        write(args, item: item, then: then)
    }

    /// The letters a card shows as staged: a click's a moment ago, else the last load's.
    func letters(_ item: InboxItem) -> String {
        pendingLetters[item.id] ?? item.draftOption ?? ""
    }

    /// What `item`'s card draws of this model, as values: the card compares them and skips a publish that changed none.
    func cardState(for item: InboxItem, in session: InboxSession, hubSession: HubSession?) -> InboxCardState {
        InboxCardState(
            letters: letters(item),
            heldDismiss: heldDismiss.contains(item.id),
            writing: writing.contains(item.id),
            sessionSending: session.sessionId.map { sendingSessions.contains($0) } ?? false,
            writeError: writeErrors[item.id],
            writeErrorDetail: writeErrorDetails[item.id],
            preferences: preferences,
            noteFocusRequest: noteFocusTarget == item.id ? noteFocusCount : nil,
            hubSession: hubSession,
            keyCard: keyCardID == item.id
        )
    }

    /// The widget's settings as they are now: a click follows a change made since the last load.
    private func freshPreferences() -> WidgetPreferences? {
        let current = WidgetPreferencesFile.shared.current()
        if current != preferences { preferences = current }
        return current
    }

    /// A click on a decision option, as the widget answers one (`DecisionAnswering.clickStages`): it stages the pick (a
    /// click on the staged letter clears it) or sends it at once, and ⌘ does the other while "⌘ does the other" is on.
    /// ⇧-click adds or removes another letter, staged.
    /// `note`: the card's note when the user changed it since it was saved, else nil, so a click never writes back a
    /// stale copy over a note staged in the widget or the session's sidebar.
    func choose(_ item: InboxItem, in session: InboxSession, letter: String, note: String?, shift: Bool, command: Bool) {
        let plan = Self.clickPlan(letters: letters(item), letter: letter, shift: shift,
                                  stages: DecisionAnswering.clickStages(freshPreferences(), command: command))
        keyCardID = item.id
        // The typed note goes along with the pick and is the staged one now.
        if note != nil { noteTexts[item.id] = nil }
        draft(item, in: session, option: plan.option, text: note,
              then: plan.send ? { [weak self] in self?.sendStaged([item.id], in: session) } : nil)
    }

    /// What a click on `letter` does with the staged `letters`: the pick it stores, and whether it is sent at once.
    nonisolated static func clickPlan(letters: String, letter: String, shift: Bool, stages: Bool) -> (option: String, send: Bool) {
        if shift { return (InboxDecisionCard.toggled(letters, letter, add: true), false) }
        return stages ? (InboxDecisionCard.toggled(letters, letter, add: false), false) : (letter, true)
    }

    /// Return in a decision's note, as Return in the widget's own answer (`DecisionAnswering.returnStages`): it stages
    /// the note with the pick, or sends both now; ⌘-Return does the other. Returns the hint to show when there is
    /// nothing to stage or send: an input hint, drawn quiet and gone on the next key, never as an error (P12).
    @discardableResult
    func submitNote(_ item: InboxItem, in session: InboxSession, note: String, command: Bool) -> String? {
        let stages = DecisionAnswering.returnStages(freshPreferences(), command: command)
        if let hint = Self.emptyNoteHint(note: note, stored: item.draft, letters: letters(item), stages: stages) {
            return hint
        }
        noteTexts[item.id] = nil
        if stages {
            draft(item, in: session, option: nil, text: note)
        } else {
            draft(item, in: session, option: nil, text: note) { [weak self] in self?.sendStaged([item.id], in: session) }
        }
        return nil
    }

    /// What Return in an empty note says instead of doing nothing: staging needs a note (or clears a stored one), a
    /// send needs a note or a staged letter.
    nonisolated static func emptyNoteHint(note: String, stored: String?, letters: String, stages: Bool) -> String? {
        guard note.trimmed.isEmpty else { return nil }
        if stages { return (stored ?? "").isEmpty ? "Write a note first." : nil }
        return letters.isEmpty ? "Write your answer or pick an option first." : nil
    }

    /// The card's Stage note: the typed note is staged with the pick, nothing is sent.
    func stageNote(_ item: InboxItem, in session: InboxSession, note: String) {
        noteTexts[item.id] = nil
        draft(item, in: session, option: nil, text: note)
    }

    /// The card's Send now: a note typed since the last stage goes first, then this decision alone is sent.
    func sendNow(_ item: InboxItem, in session: InboxSession, note: String?) {
        guard let note, note != (item.draft ?? "") else {
            sendStaged([item.id], in: session)
            return
        }
        noteTexts[item.id] = nil
        draft(item, in: session, option: nil, text: note) { [weak self] in self?.sendStaged([item.id], in: session) }
    }

    /// The card's Unstage: the pick and the note leave the staged list; the note stays in the field, unstaged.
    func unstage(_ item: InboxItem, in session: InboxSession, keeping note: String) {
        noteTexts[item.id] = note.isEmpty ? nil : note
        draft(item, in: session, option: "", text: "")
    }

    /// Drops a decision that no longer matters, without sending anything. The write waits for the Undo window the
    /// widget's Dismiss has (`WidgetModel.undoSeconds`); meanwhile no send takes the decision.
    func dismiss(_ item: InboxItem, in session: InboxSession) {
        guard let sessionId = session.sessionId, let number = item.number, !heldDismiss.contains(item.id) else { return }
        var args = ["question", "inbox", "dismiss", "--session", sessionId, "--decision", String(number)]
        if let revision = item.revision { args += ["--expected-revision", String(revision)] }
        heldDismiss.insert(item.id)
        let seconds = WidgetModel.undoSeconds(freshPreferences())
        dismissTasks[item.id] = Task { [weak self] in
            do { try await Task.sleep(for: .seconds(seconds)) } catch { return }
            guard let self, self.heldDismiss.contains(item.id) else { return }
            self.heldDismiss.remove(item.id)
            self.dismissTasks[item.id] = nil
            self.write(args, item: item)
        }
    }

    /// Undo of a held Dismiss: nothing was written, the decision waits as before.
    func undoDismiss(_ item: InboxItem) {
        dismissTasks.removeValue(forKey: item.id)?.cancel()
        heldDismiss.remove(item.id)
    }

    /// A draft or dismiss write: run it, then reload so the stored pick shows. No delivery banner;
    /// a failed write says why on the card. `queued`: a write that waited behind another one; it
    /// leaves the card's error alone, so a failure of the one before it stays readable.
    private func write(_ args: [String], item: InboxItem, queued: Bool = false, then: (() -> Void)? = nil) {
        if let then { afterWrites[item.id, default: []].append(then) }
        guard !writing.contains(item.id) else {
            pendingWrites[item.id] = Self.keepingPick(args, from: pendingWrites[item.id] ?? runningWrites[item.id])
            return
        }

        writing.insert(item.id)
        runningWrites[item.id] = args
        if !queued {
            writeErrors[item.id] = nil
            writeErrorDetails[item.id] = nil
        }
        DispatchQueue.global(qos: .userInitiated).async {
            let span = HubPerf.begin("inbox.draft")
            let failure: (text: String, raw: String?)?
            do {
                let capture = try ToolsCLIRunner.capture(args)
                failure = capture.status == 0 ? nil : Self.refusal(capture)
            } catch {
                failure = ("the hub could not run tools. Try again.", "\(error)")
            }
            span.end(failure == nil ? "ok" : "failed")
            DispatchQueue.main.async { [weak self] in
                MainActor.assumeIsolated {
                    guard let self else { return }
                    self.writing.remove(item.id)
                    self.runningWrites[item.id] = nil
                    if let failure {
                        self.writeErrors[item.id] = "Not saved: \(failure.text)"
                        self.writeErrorDetails[item.id] = failure.raw
                        // A send waiting on this pick must not send what was stored before it.
                        self.afterWrites[item.id] = nil
                        self.pendingLetters[item.id] = nil
                    } else {
                        self.writeGeneration += 1
                    }
                    if let next = self.pendingWrites.removeValue(forKey: item.id) {
                        self.write(next, item: item, queued: true)
                    } else {
                        let waiting = self.afterWrites.removeValue(forKey: item.id) ?? []
                        self.load()
                        waiting.forEach { $0() }
                    }
                }
            }
        }
    }

    /// Why a `tools question inbox` write was refused: the `{ "error" }` sentence it prints on stdout ("DECISION 4
    /// changed: …"), else one plain sentence with the exit status and stderr as the raw detail behind Details (F10: the
    /// card printed "Not saved: exited 1: <stderr>", cut in the middle).
    nonisolated static func refusal(_ capture: ProcessCapture) -> (text: String, raw: String?) {
        struct Refusal: Decodable { let error: String }
        if let refusal = try? JSONDecoder().decode(Refusal.self, from: capture.stdout), !refusal.error.isEmpty {
            return (refusal.error, nil)
        }
        let stderr = String(decoding: capture.stderr, as: UTF8.self).trimmed
        return ("the decision log refused the change. Try again.",
                "tools exited \(capture.status)" + (stderr.isEmpty ? "" : ": \(stderr)"))
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
        /// Nothing was sent: one sentence why, and the raw failure behind Details.
        case report(String, raw: String? = nil)
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
            return .report("Nothing was sent: the hub could not tell where this session takes answers.", raw: "\(error)")
        case .success(let target):
            return target.kind == "none" ? .askWhereToResume : .deliver(resumeTarget: nil)
        }
    }

    /// Only a session that did resume gets the answers; a failed resume sends nothing and says why.
    nonisolated static func resumeStep(_ outcome: LaunchOutcome) -> SendStep {
        switch outcome {
        case .cancelled: return .nothing
        case .launched(let label): return .deliver(resumeTarget: "resumed — \(label)")
        case .failed(let why): return .report("Nothing was sent: the session did not resume. The answers stay staged.", raw: why)
        }
    }

    func run(_ step: SendStep, for session: InboxSession) {
        guard let sessionId = session.sessionId else { return }
        switch step {
        case .deliver(let resumeTarget):
            deliverSession(session, resumeTarget: resumeTarget)
        case .askWhereToResume:
            resumeFor = session
        case .report(let why, let raw):
            record(.failure(why, raw: raw), for: sessionId)
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
        // A live target: the widget's own send (`send-staged`), worded as the widget words it. A resumed session
        // waits for its new pane below, which only `inbox send` does.
        guard resumeTarget != nil else {
            sendStaged(session.draftedItems.map(\.id).filter { !heldDismiss.contains($0) }, in: session)
            return
        }
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
                    ?? .failure("Nothing was sent: the send did not finish.",
                                raw: "tools question inbox send exited \(capture.status): \(String(decoding: capture.stderr, as: UTF8.self).trimmed)")
            } catch {
                delivery = .failure("Nothing was sent: the hub could not run tools.", raw: "\(error)")
            }
            span.end(delivery.channel ?? "error")
            DispatchQueue.main.async { [weak self] in
                MainActor.assumeIsolated {
                    guard let self else { return }
                    self.sendingSessions.remove(sessionId)
                    self.record(delivery, for: sessionId)
                    if !delivery.isError {
                        self.writeGeneration += 1
                        self.load()
                    }
                }
            }
        }
    }

    /// Sends the staged decisions `ids` of `session` with the widget's own engine (`tools hub widget call`, the
    /// `send-staged` action: one message per session), or sends answered ones again (`resend-answers`, Send again).
    /// The result reads as the widget's note: delivered, waiting for the session's next prompt, or failed.
    func sendStaged(_ ids: [String], in session: InboxSession, action: DecisionAnswering.SendAction = .sendStaged) {
        guard let sessionId = session.sessionId, !ids.isEmpty else { return }
        guard !sendingSessions.contains(sessionId) else {
            // A send at once while another send of the session runs: it goes next, never silently nowhere.
            if action == .sendStaged { queuedSends[sessionId, default: []].append(contentsOf: ids) }
            return
        }
        sendingSessions.insert(sessionId)
        sessionResults[sessionId] = nil
        let target = DecisionAnswering.Target(provider: session.provider ?? "", sourceHome: session.sourceHome ?? "",
                                              cwd: session.cwd ?? "")
        let request = DecisionAnswering.sendRequest(action, ids: ids, targets: [sessionId: target])
        let titles = [sessionId: session.displayTitle]
        HubPerf.log("inbox.\(action.rawValue) \(ids.count) to \(sessionId.prefix(8))")
        DispatchQueue.global(qos: .userInitiated).async {
            let span = HubPerf.begin("inbox.\(action.rawValue)")
            let delivery = Self.callWidget(request, ids: ids, titles: titles, resend: action == .resendAnswers)
            span.end(delivery.isError ? "failed" : delivery.isQueued ? "waiting" : "delivered")
            DispatchQueue.main.async { [weak self] in
                MainActor.assumeIsolated {
                    guard let self else { return }
                    self.sendingSessions.remove(sessionId)
                    self.record(delivery, for: sessionId)
                    self.writeGeneration += 1
                    self.load()
                    if let next = self.queuedSends.removeValue(forKey: sessionId), !next.isEmpty {
                        self.sendStaged(Array(Set(next)).sorted(), in: session)
                    }
                }
            }
        }
    }

    /// Every staged decision of every session, sent as the widget's staged list sends them: one message per session
    /// (the header's "Send all staged", ⌘-Return; F2). A decision whose Dismiss waits for its Undo stays out.
    func sendAllStaged() {
        for session in sessions {
            let ids = session.draftedItems.map(\.id).filter { !heldDismiss.contains($0) }
            if !ids.isEmpty { sendStaged(ids, in: session) }
        }
    }

    /// How many decisions wait staged in every session (the header's count and its Send all staged).
    var stagedCount: Int {
        sessions.reduce(0) { $0 + $1.draftedItems.filter { !heldDismiss.contains($0.id) }.count }
    }

    /// A session's send result: shown under its Send bar, read out by VoiceOver (F17), and a delivered one fades after
    /// the widget's note time (P2). A warning or an error stays until the next send.
    private func record(_ delivery: InboxDelivery, for sessionId: String) {
        sessionResults[sessionId] = delivery
        GenAnnounce.post(delivery.summary)
        resultFades.removeValue(forKey: sessionId)?.cancel()
        guard !delivery.isError, !delivery.isQueued else { return }
        let seconds = max(0, min(60, preferences?.noteSeconds ?? 6))
        guard seconds > 0 else { return }
        resultFades[sessionId] = Task { [weak self] in
            do { try await Task.sleep(for: .seconds(seconds)) } catch { return }
            guard let self, self.sessionResults[sessionId] == delivery else { return }
            self.sessionResults[sessionId] = nil
            self.resultFades[sessionId] = nil
        }
    }

    /// Runs one widget action through `tools hub widget call` and reads its answer with the widget's outcome.
    nonisolated static func callWidget(_ request: WidgetJSON, ids: [String], titles: [String: String], resend: Bool) -> InboxDelivery {
        let file = FileManager.default.temporaryDirectory.appendingPathComponent("hub-inbox-send-\(UUID().uuidString).json")
        defer { try? FileManager.default.removeItem(at: file) }
        do {
            try JSONEncoder().encode(request).write(to: file)
            // The send can wait on a busy receiver: room beyond the default.
            let capture = try ToolsCLIRunner.capture(["hub", "widget", "call", "--input", file.path], timeout: 120)
            guard capture.status == 0, let result = try? JSONDecoder().decode(WidgetJSON.self, from: capture.stdout) else {
                let why = String(decoding: capture.stderr, as: UTF8.self).trimmed
                return .failure("Nothing was sent: the widget's sender did not answer. The answers stay staged.",
                                raw: "tools hub widget call exited \(capture.status): \(why)")
            }
            return .outcome(WidgetDecisionSendOutcome(result, titles: titles), ids: ids, resend: resend)
        } catch {
            return .failure("Nothing was sent: the hub could not run tools. The answers stay staged.", raw: "\(error)")
        }
    }

    /// Answers a form: one entry per question, the chosen choice ids, any text and any `@file`
    /// tags. Images never ride the JSON: they go as `--image itemId=path` so a screenshot never
    /// has to cross argv as base64 (`kern.argmax` on this Mac is 1 MB; one image alone can carry
    /// `MAX_IMAGE_BASE64_CHARS`, 2 MB, of it). `tools question inbox answer` reads each file in
    /// place (`src/question/lib/pending/form.ts` `attachImageFiles`).
    func answerForm(
        _ item: InboxItem,
        choices: [String: Set<String>],
        texts: [String: String],
        fileTags: [String: [String]] = [:],
        imagePaths: [String: [String]] = [:]
    ) {
        guard
            let args = Self.formAnswerArgs(
                formId: item.id,
                questions: item.questions ?? [],
                choices: choices,
                texts: texts,
                fileTags: fileTags,
                imagePaths: imagePaths
            )
        else {
            return
        }

        // The answering process reads the staged images in place; once it is done they are not needed.
        run(args, item: item, staged: imagePaths.values.flatMap { $0 })
    }

    /// Pure: the argv `answerForm` sends to `tools question inbox answer`
    /// (`src/question/commands/inbox.ts`), so a wire-shape change is caught without spawning a
    /// process. `--image itemId=path` never carries base64 — `attachImageFiles`
    /// (`src/question/lib/pending/form.ts`) reads each file in place. `imagePaths`/`fileTags`
    /// iterate a `Dictionary`, so a test should compare the decoded `--answers` JSON and a SET
    /// of `--image` specs, not raw argv equality.
    nonisolated static func formAnswerArgs(
        formId: String,
        questions: [InboxQuestion],
        choices: [String: Set<String>],
        texts: [String: String],
        fileTags: [String: [String]],
        imagePaths: [String: [String]]
    ) -> [String]? {
        let answers: [[String: Any]] = questions.map { question in
            var entry: [String: Any] = ["itemId": question.itemId]
            if let picked = choices[question.itemId], !picked.isEmpty {
                entry["selectedChoices"] = question.choices.map(\.id).filter { picked.contains($0) }
            }
            if let text = texts[question.itemId]?.trimmed, !text.isEmpty {
                entry["freeText"] = text
            }
            if let tags = fileTags[question.itemId], !tags.isEmpty {
                entry["fileTags"] = tags
            }
            return entry
        }

        guard let data = try? JSONSerialization.data(withJSONObject: answers) else {
            return nil
        }

        var args = ["question", "inbox", "answer", "--form", formId, "--answers", String(decoding: data, as: UTF8.self)]

        for (itemId, paths) in imagePaths {
            for path in paths {
                args += ["--image", "\(itemId)=\(path)"]
            }
        }

        return args
    }

    private func run(_ args: [String], item: InboxItem, staged: [String] = []) {
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
                    ?? .failure("The answer was not sent. Try again.",
                                raw: "tools question inbox answer exited \(capture.status): \(String(decoding: capture.stderr, as: UTF8.self).trimmed)")
            } catch {
                delivery = .failure("The answer was not sent: the hub could not run tools.", raw: "\(error)")
            }
            span.end(delivery.channel ?? "error")
            // A failed answer keeps them: the card is still there, and a retry sends the same files.
            if !delivery.isError {
                staged.forEach(QaAttachedImage.remove)
            }
            DispatchQueue.main.async { [weak self] in
                MainActor.assumeIsolated {
                    guard let self else { return }
                    self.sending.remove(item.id)
                    self.deliveries[item.id] = delivery
                    GenAnnounce.post(delivery.summary)
                    if !delivery.isError {
                        // The answering process read the images; the form leaves the list on this load.
                        self.formImages[item.id] = nil
                        self.load()
                    }
                }
            }
        }
    }

    /// Brings the session's cmux pane forward through its own agent's resolver (`tools <agent> cmux focus`).
    func focusPane(_ session: InboxSession, notice: @escaping (String, NoticePill.Tone) -> Void) {
        guard let sessionId = session.sessionId else { return }
        let tool = cmuxTool(provider: session.provider)
        DispatchQueue.global(qos: .userInitiated).async {
            // --first as CmuxHost.focus passes it: without a terminal, a session open in two panes fails.
            let capture = try? ToolsCLIRunner.capture([tool, "cmux", "focus", sessionId, "--first"])
            let failed = capture.map { $0.status != 0 } ?? true
            // One sentence on screen; the tool's own words go to the log (F10).
            if failed {
                HubPerf.log("inbox.focusPane \(sessionId.prefix(8)): " + (capture.map { String(decoding: $0.stderr, as: UTF8.self).trimmed } ?? "tools did not run"))
            }
            let message = failed ? "No cmux pane runs this session." : "Showed the session's cmux pane."
            DispatchQueue.main.async { notice(message, failed ? .error : .success) }
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
                MenuButton(items: {
                    InboxSort.allCases.map { option in
                        .action(option.title, checked: option == sort) {
                            HubMainBusy.measure("inbox.sort")
                            sortKey = option.rawValue
                        }
                    }
                }) {
                    Label(sort.title, systemImage: "arrow.up.arrow.down")
                        .font(.system(size: 11.5))
                        .foregroundColor(ReviewPalette.dim)
                }
                .fixedSize()
                .instantTooltip("Order the waiting sessions")
                Spacer()
                // A fixed slot, so the controls before it stay put while the list loads.
                ZStack {
                    if inbox.loading {
                        ProgressView().controlSize(.small)
                    }
                }
                .frame(width: 16, height: 16)
            }
            .padding(.horizontal, 14)
            .padding(.bottom, 6)
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 2) {
                    if rows.isEmpty, inbox.loading {
                        SkeletonRows(count: 6, leading: .avatar)
                            .skeletonShimmer()
                            .accessibilityElement(children: .ignore)
                            .accessibilityLabel("Looking for waiting sessions")
                    } else if rows.isEmpty, let failure = inbox.error {
                        InboxLoadFailure(raw: failure) { inbox.load() }
                            .padding(14)
                    } else if rows.isEmpty, !inbox.sessions.isEmpty, !model.filter.trimmed.isEmpty {
                        EmptyState(
                            text: "No session matches “\(model.filter)”",
                            actionTitle: "Clear filter"
                        ) { model.filter = "" }
                    }
                    // An empty Inbox says so once, in the main pane, with the header's one reload (P6).
                    let older = rows.filter(\.isStale)
                    ForEach(rows.filter { !$0.isStale }) { session in
                        InboxSessionRow(session: session, selected: session.id == inbox.selectedID)
                            .rowButton { inbox.selectedID = session.id }
                            .accessibilityAddTraits(session.id == inbox.selectedID ? .isSelected : [])
                    }
                    if !older.isEmpty {
                        // The header alone is the disclosure, inset like the rows; the rows keep their own insets.
                        GenDisclosure(isExpanded: $inbox.showsQuiet, accessibilityTitle: "Sessions quiet for three days or more") {
                            EmptyView()
                        } label: {
                            Text(verbatim: "\(Plural.count(older.count, "session")) quiet for 3+ days")
                                .font(.system(size: 11.5, weight: .semibold))
                                .foregroundColor(ReviewPalette.dim)
                        }
                        .padding(.horizontal, 16)
                        .padding(.top, 8)
                        .instantTooltip("Nothing moved in these sessions for three days. Their questions stay answerable here; they no longer count as waiting.")
                        if inbox.showsQuiet {
                            ForEach(older) { session in
                                InboxSessionRow(session: session, selected: session.id == inbox.selectedID)
                                    .rowButton { inbox.selectedID = session.id }
                                    .accessibilityAddTraits(session.id == inbox.selectedID ? .isSelected : [])
                            }
                        }
                    }
                }
                .padding(.bottom, 12)
            }
            // Sessions quiet for three days fold under one row; a pick of one of them (a link) opens the fold. Keyed on
            // the selected row being a quiet one, not on the selection alone: a reveal can select a session before the
            // load that lists it lands, and the fold must open when the row arrives too.
            .onChange(of: rows.contains { $0.id == inbox.selectedID && $0.isStale } ? inbox.selectedID : nil, initial: true) { _, id in
                if id != nil { inbox.showsQuiet = true }
            }
        }
    }
}

/// A failed load of the Inbox: one sentence and a retry; the raw failure sits behind Details.
private struct InboxLoadFailure: View {
    let raw: String
    let retry: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            NoticePill(text: "Could not load the waiting sessions.", more: raw, tone: .error)
            GhostButton("Try again", symbol: "arrow.clockwise", tooltip: "Look for waiting sessions again", action: retry)
        }
    }
}

private struct InboxSessionRow: View {
    let session: InboxSession
    let selected: Bool

    /// What the badge counts: questions that wait for the user's answer, never "answers waiting" (F13).
    private var waitingText: String {
        session.isStale
            ? "\(Plural.count(session.waiting, "open question")), quiet for three days: not counted as waiting"
            : WidgetWords.waiting(session.waiting)
    }

    /// Decisions staged here and not sent: blue, the widget's colour for Staged (F2).
    private var staged: Int { session.draftedItems.count }

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
                    LiveAgo(date: session.date, style: .brief).fixedSize()
                }
                .font(.system(size: 10.5))
                .foregroundColor(ReviewPalette.dim)
                .lineLimit(1)
                if staged > 0 {
                    Text(verbatim: "\(staged) staged")
                        .font(.system(size: 10.5, weight: .semibold))
                        .foregroundColor(SessionPalette.blue)
                        .instantTooltip("\(Plural.count(staged, "decision")) staged here and not sent yet")
                }
            }
            if session.waiting > 0 {
                // Filled orange means "waiting for you" and nothing else; a quiet session's count is grey.
                Text(verbatim: "\(session.waiting)")
                    .font(.system(size: 10.5, weight: .bold, design: .monospaced))
                    .foregroundColor(session.isStale ? ReviewPalette.dim : .black)
                    .frame(minWidth: 18, minHeight: 18)
                    .background(Capsule().fill(session.isStale ? Color.white.opacity(0.08) : InboxStyle.accent))
                    .instantTooltip(waitingText)
                    .accessibilityElement(children: .ignore)
                    .accessibilityLabel(Text(waitingText))
            } else {
                Badge("Waiting to send", color: ReviewPalette.modified, look: .filled)
                    .instantTooltip("Answered and not delivered yet. Nothing waits for you here.")
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
    /// The list has the keyboard: Up and Down move the key card, 1 to 9 pick its options, Return opens its note (F8).
    @FocusState private var keysFocused: Bool
    @GenReduceMotion private var reduceMotion

    var body: some View {
        let rows = inbox.sorted(InboxSort(rawValue: sortKey) ?? .recent, filter: model.filter)
        VStack(spacing: 0) {
            header(rows)
            // ⌘F: the shared find bar, wired around InboxMain (Hub/HubInboxFind.swift); draws nothing until opened.
            PanelFindBarSlot()
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 0) {
                        if rows.isEmpty, inbox.loading {
                            PaneSkeleton("Looking for waiting sessions")
                        } else if rows.isEmpty, let failure = inbox.error {
                            InboxLoadFailure(raw: failure) { inbox.load() }
                                .frame(maxWidth: .infinity)
                                .padding(.top, 40)
                        } else if rows.isEmpty, !inbox.sessions.isEmpty, !model.filter.trimmed.isEmpty {
                            EmptyState(
                                text: "No session matches “\(model.filter)”",
                                actionTitle: "Clear filter"
                            ) { model.filter = "" }
                            .padding(.top, 40)
                        } else if rows.isEmpty {
                            // One empty state and one reload: the header's refresh icon (P6).
                            EmptyState(symbol: "tray", text: "No session is waiting for an answer.")
                                .padding(.top, 40)
                        }
                        // Each header, card and Send bar is its own lazy element: a mode switch builds the cards on
                        // screen, not every card of the first session (16 cards, 52 option buttons, 435 to 640 ms, F1).
                        let hubSessions = Self.hubSessionIndex(model.sessions)
                        ForEach(InboxListRow.rows(rows)) { row in
                            listRow(row, hubSessions: hubSessions)
                        }
                    }
                    .padding(18)
                }
                .focusable()
                .focusEffectDisabled()
                .focused($keysFocused)
                // A click on the list (not into a note) gives it the keys; the note keeps them when it was clicked.
                .simultaneousGesture(TapGesture().onEnded {
                    DispatchQueue.main.async {
                        if !(NSApp.keyWindow?.firstResponder is NSTextView) { keysFocused = true }
                    }
                }, including: .all)
                .onKeyPress(phases: .down) { press in handleKey(press, rows: rows, proxy: proxy) }
                // A selection from the sidebar's arrow keys lands at once: a glide per key press read as lag (F20).
                .onChange(of: inbox.selectedID) { _, id in
                    guard let id else { return }
                    if let key = inbox.keyCardID, !(rows.first { $0.id == id }?.items.contains { $0.id == key } ?? false) {
                        inbox.keyCardID = nil
                    }
                    var instant = Transaction()
                    instant.disablesAnimations = true
                    withTransaction(instant) { proxy.scrollTo(id, anchor: .top) }
                }
                .onChange(of: inbox.focusRequest) { _, _ in
                    guard let id = inbox.focusedItemID else { return }
                    // The section first, so the lazy stack builds the card; then the card itself.
                    if let session = inbox.selectedID { proxy.scrollTo(session, anchor: .top) }
                    DispatchQueue.main.async {
                        withAnimation(reduceMotion ? nil : .easeOut(duration: 0.25)) { proxy.scrollTo(id, anchor: .top) }
                    }
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

    /// "3 waiting in 2 sessions · 2 staged · 1 waiting to send": what waits for the user, in how many sessions, what is
    /// staged and not sent (F2), and how many answers only wait for their session to take them.
    static func summary(_ rows: [InboxSession], staged: Int = 0) -> String {
        let waiting = rows.reduce(0) { $0 + $1.countedWaiting }
        let sessions = rows.filter { $0.countedWaiting > 0 }.count
        let older = rows.filter { $0.isStale && $0.waiting > 0 }.count
        let queued = rows.reduce(0) { $0 + ($1.queued ?? 0) }
        var parts: [String] = []
        if waiting > 0 {
            parts.append("\(waiting) waiting in \(Plural.count(sessions, "session"))")
        } else {
            parts.append("Nothing waiting")
        }
        if staged > 0 {
            parts.append("\(staged) staged")
        }
        if older > 0 {
            parts.append("\(Plural.count(older, "session")) quiet for 3+ days")
        }
        if queued > 0 {
            parts.append("\(queued) waiting to send")
        }
        return parts.joined(separator: " · ")
    }

    /// The main list's keys while it has the keyboard and no note does (F8): Up and Down move the key card across
    /// sessions, 1 to 9 pick its options (⇧ adds a letter, ⌥ does the other of stage and send, as ⌘ does on a click:
    /// ⌘-digit switches the hub's modes), Return puts the keyboard into its note.
    private func handleKey(_ press: KeyPress, rows: [InboxSession], proxy: ScrollViewProxy) -> KeyPress.Result {
        guard !(NSApp.keyWindow?.firstResponder is NSTextView),
              !press.modifiers.contains(.command), !press.modifiers.contains(.control)
        else { return .ignored }
        switch press.key {
        case .upArrow, .downArrow:
            guard let id = inbox.moveKeyCard(press.key == .upArrow ? -1 : 1, in: rows) else { return .ignored }
            var instant = Transaction()
            instant.disablesAnimations = true
            withTransaction(instant) { proxy.scrollTo(id, anchor: .center) }
            return .handled
        case .return:
            guard let card = inbox.keyCard(in: rows) else { return .ignored }
            inbox.focusNote(card.item.id)
            return .handled
        default:
            guard let digit = Self.digit(press), let card = inbox.keyCard(in: rows),
                  let choices = card.item.choices, digit <= choices.count
            else { return .ignored }
            if let sessionId = card.session.sessionId, inbox.sendingSessions.contains(sessionId) { return .handled }
            inbox.choose(card.item, in: card.session, letter: choices[digit - 1].id, note: inbox.noteTexts[card.item.id],
                         shift: press.modifiers.contains(.shift), command: press.modifiers.contains(.option))
            return .handled
        }
    }

    /// The digit 1 to 9 a key press means, by its character or, with ⇧ or ⌥ held or on a Czech keyboard (where the
    /// number row types letters), by its key code on the number row.
    static func digit(_ press: KeyPress) -> Int? {
        if let value = Int(press.characters), (1...9).contains(value) { return value }
        guard let event = NSApp.currentEvent, event.type == .keyDown else { return nil }
        return numberRow[event.keyCode]
    }

    /// The number row's key codes, 1 to 9.
    static let numberRow: [UInt16: Int] = [18: 1, 19: 2, 20: 3, 21: 4, 23: 5, 22: 6, 26: 7, 28: 8, 25: 9]

    /// In the window's title bar (`TitlebarHeader`): the list starts right under it.
    /// One element of the lazy list. A card gets its state as values and is compared with its last one, so a
    /// publish that changed nothing on it runs no card body (F3); the hub's session rows are indexed once per pass.
    @ViewBuilder
    private func listRow(_ row: InboxListRow, hubSessions: [String: HubSession]) -> some View {
        let hubSession = { (session: InboxSession) in session.sessionId.flatMap { hubSessions[$0] } }
        switch row {
        case .header(let session, let first):
            InboxSessionHeader(model: model, inbox: inbox, session: session, hubSession: hubSession(session))
                .findRow("session:\(session.id)")
                .padding(.top, first ? 0 : 22)
        case .queuedTitle:
            // Answered, not yet taken by the session: shown apart, so they never read as waiting.
            HStack(spacing: 8) {
                Image(systemName: "tray.and.arrow.down").foregroundColor(ReviewPalette.modified)
                    .accessibilityHidden(true)
                Text("Waiting to send")
                    .font(.system(size: 12.5, weight: .semibold))
                    .foregroundColor(Color.white.opacity(0.8))
                Text("Answered and not delivered yet. Nothing here waits for you.")
                    .font(.system(size: 11))
                    .foregroundColor(ReviewPalette.dim)
                    .lineLimit(1)
            }
            .padding(.top, 28)
        case .card(let session, let item):
            Group {
                if item.isForm {
                    InboxFormCard(inbox: inbox, item: item)
                } else {
                    InboxDecisionCard(model: model, inbox: inbox, session: session, item: item,
                                      keyed: keysFocused && inbox.keyCardID == item.id,
                                      state: inbox.cardState(for: item, in: session, hubSession: hubSession(session)))
                        .equatable()
                }
            }
            .attentionPulse(trigger: inbox.revealCounts[item.id] ?? 0,
                            style: revealFlash,
                            since: inbox.focusedItemID == item.id ? inbox.focusedAt : nil)
            .padding(.top, 10)
        case .sendBar(let session):
            InboxSendBar(model: model, inbox: inbox, session: session)
                .padding(.top, 10)
        }
    }

    /// The hub's session rows by session id: one pass over the list per body, not a search per card.
    static func hubSessionIndex(_ sessions: [HubSession]) -> [String: HubSession] {
        Dictionary(sessions.map { ($0.sessionId, $0) }, uniquingKeysWith: { first, _ in first })
    }

    /// A revealed card flashes its border for the widget's "Flash the session" time, then leaves nothing behind (F18:
    /// a 2 pt outline stayed until the next link). 0 seconds is off.
    private var revealFlash: AttentionPulseStyle {
        var style = AttentionPulseStyle.borderFlash(color: InboxStyle.accent, cornerRadius: 11)
        style.duration = WidgetAlerts.flashSeconds(inbox.preferences)
        style.period = 0.8
        style.fadeIn = 0.18
        style.fadeOut = 0.3
        // "Flash the session" at 0 seconds: no flash at all.
        if style.duration <= 0 { style.borderOpacity = 0 }
        return style
    }

    private func header(_ rows: [InboxSession]) -> some View {
        let staged = inbox.stagedCount
        return TitlebarHeader {
            HStack(spacing: 10) {
                Group {
                    Image(systemName: "tray.full").foregroundColor(InboxStyle.accent)
                        .accessibilityHidden(true)
                    Text("Waiting for you").font(.system(size: 14, weight: .semibold))
                    Text(verbatim: Self.summary(rows, staged: staged))
                        .font(.system(size: 12))
                        .foregroundColor(ReviewPalette.dim)
                }
                .titlebarLabel()
                Spacer()
                if let notice = model.headerNotice {
                    NoticePill(text: notice.text, tone: notice.tone) { model.headerNotice = nil }
                }
                if let missing = inbox.revealMissing {
                    // Not an error: the decision moved on. It names the decision and offers the way to it (F18).
                    NoticePill(text: missing, tone: .warning, fixes: revealFixes) {
                        inbox.revealMissing = nil
                        inbox.revealMissingTarget = nil
                    }
                }
                if staged > 0 {
                    Button {
                        inbox.sendAllStaged()
                    } label: {
                        Label("Send all staged (\(staged))", systemImage: "paperplane.fill")
                            .font(.system(size: 12))
                            .lineLimit(1)
                    }
                    .buttonStyle(.genPrimary())
                    .fixedSize()
                    .disabled(!inbox.sendingSessions.isEmpty && inbox.sessions.allSatisfy { session in
                        session.draftedItems.isEmpty || session.sessionId.map { inbox.sendingSessions.contains($0) } ?? true
                    })
                    // A note that has the keyboard keeps ⌘-Return for itself (stage or send that note).
                    .keyboardShortcut(inbox.noteFocusID == nil ? KeyboardShortcut(.return, modifiers: .command) : nil)
                    .instantTooltip("Send every staged decision of every session; each session gets one message (⌘↩)")
                    .accessibilityHint(Text("Command-Return"))
                }
                if let loadedAt = inbox.loadedAt {
                    LiveAgo(date: loadedAt) { "checked \($0)" }
                        .font(.system(size: 11))
                        .foregroundColor(ReviewPalette.dim)
                        .titlebarLabel()
                }
                IconButton(systemName: "arrow.clockwise", tooltip: "Look for waiting sessions again") { inbox.load() }
            }
        }
    }

    /// The way to a revealed decision that no longer waits: its place in the session's transcript, when the hub lists
    /// that session.
    private var revealFixes: [NoticeFix] {
        guard let target = inbox.revealMissingTarget,
              let hubSession = model.sessions.first(where: { $0.sessionId == target.sessionId })
        else { return [] }
        return [.button("Open in transcript", symbol: "text.bubble") {
            inbox.revealMissing = nil
            inbox.revealMissingTarget = nil
            model.transcriptQuery = "DECISION \(target.number)"
            model.openSession(hubSession)
        }]
    }
}

/// The Inbox list's elements, one per lazy row (`InboxMain`): a session's header, each of its cards, its Send bar,
/// and the "Waiting to send" title above the sessions whose answers only wait for delivery.
enum InboxListRow: Identifiable {
    case header(InboxSession, first: Bool)
    case card(InboxSession, InboxItem)
    case sendBar(InboxSession)
    case queuedTitle

    /// The scroll targets stay what they were: the session id on its header, the item id on its card.
    var id: String {
        switch self {
        case .header(let session, _): return session.id
        case .card(_, let item): return item.id
        case .sendBar(let session): return "send:\(session.id)"
        case .queuedTitle: return "inbox:queued-title"
        }
    }

    /// The waiting sessions first, then the queued-only ones under their title, each as header, cards, Send bar.
    static func rows(_ sessions: [InboxSession]) -> [InboxListRow] {
        var rows: [InboxListRow] = []
        func add(_ session: InboxSession) {
            rows.append(.header(session, first: rows.isEmpty))
            rows += session.items.map { .card(session, $0) }
            rows.append(.sendBar(session))
        }
        sessions.filter { !$0.isQueuedOnly }.forEach(add)
        let queued = sessions.filter(\.isQueuedOnly)
        if !queued.isEmpty {
            rows.append(.queuedTitle)
            queued.forEach(add)
        }
        return rows
    }
}

/// A session's header in the Inbox: provider, title, project, branch, the session's details, its cmux pane and its
/// transcript.
private struct InboxSessionHeader: View {
    @ObservedObject var model: HubModel
    @ObservedObject var inbox: HubInboxModel
    let session: InboxSession
    let hubSession: HubSession?
    @State private var showInfo = false

    var body: some View {
        HStack(spacing: 8) {
            ProviderBadge(provider: session.provider ?? "?")
            FindText(session.displayTitle, field: "title")
                .font(.system(size: 13.5, weight: .semibold))
                .lineLimit(1)
                .textSelection(.enabled)
                .instantTooltip(session.displayTitle)
            FindText(session.projectName, field: "project")
                .font(.system(size: 11.5))
                .foregroundColor(ReviewPalette.dim)
            if let branch = session.branch {
                FindText(branch, field: "branch")
                    .font(.system(size: 11, design: .monospaced))
                    .foregroundColor(ReviewPalette.dim)
                    .lineLimit(1)
                    .truncationMode(.middle)
                    .textSelection(.enabled)
                    .instantTooltip(branch)
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
            if let provider = session.provider, ["claude", "codex", "grok"].contains(provider) {
                IconButton(systemName: "terminal", tooltip: "Show this session's cmux pane") {
                    inbox.focusPane(session) { model.post($0, $1) }
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
/// both send the same way: every staged answer as one message through `tools question inbox send`.
struct InboxSendBar: View {
    @ObservedObject var model: HubModel
    @ObservedObject var inbox: HubInboxModel
    let session: InboxSession
    /// The Decisions pane shows one session's bar, whatever the Inbox has selected, so that bar takes ⌘↩.
    var claimsShortcut = false

    private var drafted: [InboxItem] { session.draftedItems }
    private var sending: Bool { session.sessionId.map { inbox.sendingSessions.contains($0) } ?? false }
    private var result: InboxDelivery? { session.sessionId.flatMap { inbox.sessionResults[$0] } }
    /// A send that takes longer than 10 s says what it waits for (F19).
    @State private var slow = false
    /// The Inbox's header owns ⌘-Return (Send all staged); only the Decisions pane's one bar takes it here. ⌘-Return in
    /// a decision's note is the note's own (send or stage it, as the widget's own answer does).
    private var ownsShortcut: Bool {
        claimsShortcut && !drafted.isEmpty && inbox.noteFocusID == nil
    }

    /// The message the Send button will type, previewed under it.
    static func preview(_ drafted: [InboxItem]) -> String {
        drafted.compactMap { item -> String? in
            guard let number = item.number else { return nil }
            let letters = (item.draftOption ?? "").map { "\($0)) " }.joined()
            let note = item.draft?.trimmed ?? ""
            // Most labels already start with their own "b) "; drop it so the letter is not written twice.
            let labels = (item.draftOption ?? "").compactMap { letter -> String? in
                (item.choices ?? []).first(where: { $0.id == String(letter) })?.shownLabel
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
                        // The widget's words (P3): "Send now", "Send 3 now"; the section names the session.
                        Label(sending ? "Sending…" : drafted.count == 1 ? "Send now" : "Send \(drafted.count) now",
                              systemImage: "paperplane.fill")
                            .font(.system(size: 12))
                            .lineLimit(1)
                    }
                    .buttonStyle(.genPrimary())
                    .fixedSize()
                    .disabled(drafted.isEmpty || sending || session.sessionId == nil)
                    .keyboardShortcut(ownsShortcut ? KeyboardShortcut(.return, modifiers: .command) : nil)
                    .instantTooltip("Send every staged decision of \(session.displayTitle) as one message"
                                    + (ownsShortcut ? " (⌘↩)" : ""))
                    .accessibilityHint(Text(ownsShortcut ? "Command-Return" : ""))
                    if sending {
                        ProgressView().controlSize(.small)
                    }
                    Spacer()
                }
                if slow {
                    Text("Still waiting for \(session.displayTitle) to take the answers. The send gives up after two minutes, and the answers stay staged.")
                        .font(.system(size: 11))
                        .foregroundColor(ReviewPalette.dim)
                        .fixedSize(horizontal: false, vertical: true)
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
                    if !result.resendIDs.isEmpty {
                        Button {
                            inbox.sendStaged(result.resendIDs, in: session, action: .resendAnswers)
                        } label: {
                            Label("Send again", systemImage: "arrow.clockwise")
                                .font(.system(size: 11.5))
                                .foregroundColor(ReviewPalette.renamed)
                        }
                        .buttonStyle(.genHoverPlain())
                        .disabled(sending)
                        .instantTooltip("Send these answers to the session again")
                    }
                    if result.isQueued || result.isError {
                        Button {
                            inbox.resumeFor = session
                        } label: {
                            Label("Resume this session elsewhere…", systemImage: "arrow.uturn.forward")
                                .font(.system(size: 11.5))
                                .foregroundColor(ReviewPalette.renamed)
                        }
                        .buttonStyle(.genHoverPlain())
                        .instantTooltip("Pick a pane to reopen this session; the answers go with its first prompt")
                    }
                }
            }
            .padding(.top, 2)
            .task(id: sending) {
                slow = false
                guard sending else { return }
                do { try await Task.sleep(for: .seconds(10)) } catch { return }
                slow = sending
            }
        }
    }
}

/// A delivery under a Send: what reached the agent, or a one-sentence reason nothing did. A failure
/// never shows a green check, and the raw tool output hides behind a Details disclosure.
struct InboxDeliveryLine: View {
    let delivery: InboxDelivery
    @State private var showsDetails = false

    var body: some View {
        let color = delivery.isError ? ReviewPalette.removed : delivery.isQueued ? ReviewPalette.modified : ReviewPalette.added
        HStack(alignment: .top, spacing: 7) {
            Image(systemName: delivery.isError ? "exclamationmark.triangle.fill" : delivery.isQueued ? "tray.and.arrow.down" : "checkmark.circle.fill")
                .foregroundColor(color)
            VStack(alignment: .leading, spacing: 2) {
                Text(delivery.summary).foregroundColor(color)
                if let raw = delivery.raw, !raw.isEmpty {
                    GenDisclosure(isExpanded: $showsDetails, minHeight: 20, spacing: 4, accessibilityTitle: "Details") {
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

/// What a decision card draws of the Inbox and hub models, as values (`HubInboxModel.cardState`).
struct InboxCardState: Equatable {
    var letters: String
    var heldDismiss: Bool
    var writing: Bool
    var sessionSending: Bool
    var writeError: String?
    var writeErrorDetail: String?
    var preferences: WidgetPreferences?
    /// The note-focus request's count while it names this card, nil otherwise: a change moves the keyboard into it.
    var noteFocusRequest: Int?
    /// The hub's row of the card's session, for "Open in transcript"; nil when the hub's list does not hold it.
    var hubSession: HubSession?
    /// The card the main list's keys act on, whether or not the list has the keyboard now: its controls stay live,
    /// so the keyboard can reach them (F1).
    var keyCard = false
}

/// One decision, with the context that led to it: the findings, the code it points at, each option
/// with its reason and a Recommended badge. A click and Return in the note answer as in the widget
/// (`DecisionAnswering`, the widget's Decision click and Return settings): they stage, or send at once,
/// and ⌘ does the other; ⇧-click stages another letter. The session's Send delivers every staged answer.
///
/// The card observes neither model: what it draws of them comes in `state`, and the models are only called for its
/// actions. A publish that changes nothing on a card (a reload, the session list's minute refresh, a navigation)
/// leaves its body alone instead of running every card on screen again (300 to 430 ms for a changed list, F3).
struct InboxDecisionCard: View, Equatable {
    let model: HubModel
    let inbox: HubInboxModel
    let session: InboxSession
    let item: InboxItem
    /// The card the main list's number keys act on, while the list has the keyboard: drawn with the focus ring (F8).
    let keyed: Bool
    let state: InboxCardState

    /// `state` nil reads it from the models now; a list that shows many cards passes it, with the hub session looked
    /// up once per list.
    init(model: HubModel, inbox: HubInboxModel, session: InboxSession, item: InboxItem, keyed: Bool = false,
         state: InboxCardState? = nil) {
        self.model = model
        self.inbox = inbox
        self.session = session
        self.item = item
        self.keyed = keyed
        self.state = state ?? inbox.cardState(for: item, in: session,
                                              hubSession: session.sessionId.flatMap { id in model.sessions.first { $0.sessionId == id } })
    }

    nonisolated static func == (lhs: Self, rhs: Self) -> Bool {
        lhs.item == rhs.item && lhs.session == rhs.session && lhs.keyed == rhs.keyed && lhs.state == rhs.state
    }
    @State private var note = ""
    @State private var noteSeeded = false
    /// The note was changed here since the store last held it: only then does a click send it along.
    @State private var noteDirty = false
    /// What Return in an empty note says ("Write a note first."): a quiet hint, gone on the next key (P12).
    @State private var noteHint: String?
    @State private var showContext = false
    /// The context is taller than its folded height: only then does it fade at the cut and offer "Show all".
    @State private var contextOverflows = false
    private static let contextFold: CGFloat = 150
    @State private var showAsk = false
    @State private var showReply = false
    @State private var showsDeliveryDetails = false
    /// The pointer is on the card.
    @State private var hovering = false
    @FocusState private var noteFocused: Bool
    /// ⌘F: when the current match is in this card's folded context, the context unfolds by itself.
    @Environment(\.panelFindHighlight) private var highlight
    @GenReduceMotion private var reduceMotion

    private var writing: Bool { state.writing }
    /// The card's options and footer are buttons with hover styles and tooltips only while the pointer is on it, it
    /// is the key card, or its note has the keyboard; otherwise the same labels, which VoiceOver still presses
    /// (`restingButton`). Each control is a responder that SwiftUI walks per changed accessibility node (F1).
    private var live: Bool { hovering || state.keyCard || noteFocused }
    private var sessionSending: Bool { state.sessionSending }
    private var pickable: Bool { item.isOpen && session.sessionId != nil }
    private var letters: String { state.letters }
    /// A pick or a note is staged and not sent: blue on the option, the card, its header and the sidebar (F2).
    private var staged: Bool {
        item.isOpen && !state.heldDismiss && (!letters.isEmpty || !(item.draft ?? "").trimmed.isEmpty)
    }
    /// What the card's state reads in its header: the widget's phrase for every state of the decision log (F7).
    private var statusPhrase: String { LiveWidgetView.statusPhrase(item.status, kind: "decision") }
    /// The colour of a closed card's state: green once it reached the session, orange while it waits to be sent, dim
    /// when it ended without an answer.
    private var closedTint: Color {
        switch item.status {
        case "sent", "acknowledged", "implemented": return ReviewPalette.added
        case "answered": return ReviewPalette.modified
        default: return ReviewPalette.dim
        }
    }
    private var contextRevealed: Bool {
        showContext || (highlight?.current?.row == item.id && highlight?.current?.field == "context")
    }

    static func confidenceColor(_ level: String) -> Color {
        switch level.lowercased() {
        case "high": return ReviewPalette.added
        case "low": return ReviewPalette.removed
        default: return ReviewPalette.modified
        }
    }

    private var heading: String {
        if let title = item.title, !title.trimmed.isEmpty { return title }
        return (item.prompt ?? "").split(separator: "\n").first.map(String.init) ?? WidgetWords.decision(item.number)
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
                ForEach(Array((item.choices ?? []).enumerated()), id: \.element.id) { index, choice in
                    optionRow(choice, index: index)
                }
            }
            if !item.isOpen, let answer = item.answerBeyondPick {
                answerBlock(answer)
            }
            if item.isOpen {
                noteField
            }
            footerRow
        }
        .padding(13)
        .background(RoundedRectangle(cornerRadius: 11).fill(Color.white.opacity(item.isOpen ? 0.045 : 0.025)))
        .overlay(RoundedRectangle(cornerRadius: 11).stroke(borderColor))
        // The main list's key card: the system's focus colour, as the widget's keyboard option draws it.
        .overlay(RoundedRectangle(cornerRadius: 11).strokeBorder(keyed ? Color(nsColor: .keyboardFocusIndicatorColor) : .clear,
                                                                 lineWidth: 1.5).allowsHitTesting(false))
        .onHover { inside in
            if hovering != inside { hovering = inside }
        }
        // A card that scrolls out from under a still pointer gets no exit event (`RowButtonStyle` does the same).
        .onDisappear { hovering = false }
        .findRow(item.id, cornerRadius: 11)
        .onAppear {
            if !noteSeeded {
                // A note typed here and not staged survives the lazy row and a reload (F3).
                note = inbox.noteTexts[item.id] ?? item.draft ?? ""
                noteDirty = inbox.noteTexts[item.id] != nil
                noteSeeded = true
            }
        }
        // A note staged in the widget or the session's sidebar shows here, unless one is being written here.
        .onChange(of: item.draft) { _, stored in
            if stored ?? "" == note {
                noteDirty = false
            } else if !noteFocused, !noteDirty {
                note = stored ?? ""
            }
        }
        // Return on the main list's key card puts the keyboard into this note.
        .onChange(of: state.noteFocusRequest) { _, request in
            if request != nil, pickable { noteFocused = true }
        }
        .sheet(isPresented: $showReply) {
            InboxReplySheet(title: heading, markdown: session.reply?.markdown ?? item.prompt ?? "")
        }
    }

    private var borderColor: Color {
        if !item.isOpen {
            return closedTint.opacity(0.3)
        }
        return staged ? SessionPalette.blue.opacity(0.7) : InboxStyle.accent.opacity(0.3)
    }

    private var headerRow: some View {
        HStack(spacing: 8) {
            // The decision's number in its session, outlined: a filled orange shape is the "waiting" count only.
            let tint = item.isOpen ? InboxStyle.accent : closedTint
            Text(verbatim: WidgetWords.decision(item.number))
                .font(.system(size: 10.5, weight: .semibold))
                .foregroundColor(tint)
                .padding(.horizontal, 5)
                .frame(minHeight: 20)
                .overlay(RoundedRectangle(cornerRadius: 5).stroke(tint.opacity(0.8), lineWidth: 1))
                .fixedSize()
            FindText(heading, field: "title")
                .font(.system(size: 13.5, weight: .semibold))
                .foregroundColor(Color.white.opacity(item.isOpen ? 0.95 : 0.7))
                .lineLimit(3)
                .textSelection(.enabled)
            if item.blocking == true && item.isOpen {
                Badge("Blocking", color: ReviewPalette.removed, look: .filled)
            }
            if let confidence = item.confidence {
                // Was a raw "[medium]" beside the title.
                Badge("\(confidence.capitalized) confidence", color: Self.confidenceColor(confidence), look: .filled)
                    .liveTooltip(live, "How sure the agent is of its recommended option")
            }
            if staged {
                Badge("Staged", color: SessionPalette.blue, look: .filled)
                    .liveTooltip(live, "Picked and not sent yet: Send now sends it, or Send all staged with the others")
            }
            Spacer(minLength: 8)
            if item.isOpen {
                Label { LiveAgo(date: item.date, style: .brief) } icon: { Image(systemName: "clock") }
                    .font(.system(size: 11))
                    .foregroundColor(ReviewPalette.dim)
            } else {
                // The widget's phrase and the letters it took: "Sent · b)", "Waiting to send · a) c)" (F7).
                let picks = (item.option ?? "").map { "\($0))" }.joined(separator: " ")
                Label(picks.isEmpty ? statusPhrase : "\(statusPhrase) · \(picks)",
                      systemImage: closedTint == ReviewPalette.dim ? "minus.circle" : "checkmark.circle.fill")
                    .font(.system(size: 11.5))
                    .foregroundColor(closedTint)
            }
        }
    }

    /// A closed decision's answer in its own words, under the picked options: who recorded it, then the text (F7).
    private func answerBlock(_ answer: String) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(WidgetAlerts.answeredViaText(item.answeredVia))
                .font(.system(size: 11, weight: .semibold))
                .foregroundColor(ReviewPalette.dim)
            Text(inlineMarkdown(answer))
                .font(.system(size: 12))
                .foregroundColor(Color.white.opacity(0.85))
                .textSelection(.enabled)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(.leading, 10)
        .overlay(alignment: .leading) { Rectangle().fill(ReviewPalette.added.opacity(0.5)).frame(width: 2) }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func askRow(_ ask: String) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            LiveButton(live: live, tooltip: "The prompt that led to this reply", pressable: true) {
                let opening = !showAsk
                GenMotion.perform(expanding: opening, reduceMotion: reduceMotion) { showAsk = opening }
            } label: {
                HStack(spacing: 5) {
                    Image(systemName: "quote.opening").font(.system(size: 9))
                    Text(verbatim: showAsk ? "Asked" : "Asked: \(ask)")
                        .font(.system(size: 11))
                        .lineLimit(showAsk ? nil : 1)
                }
                .foregroundColor(ReviewPalette.dim)
            }
            if showAsk, let full = session.reply?.askFull {
                Text(verbatim: full)
                    .font(.system(size: 11.5))
                    .foregroundColor(Color.white.opacity(0.7))
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .transition(.genReveal)
            }
        }
        .clipped()
    }

    private func contextSection(_ context: String) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 6) {
                Text("Context").font(.system(size: 10.5, weight: .semibold)).foregroundColor(ReviewPalette.dim)
                Spacer()
                if contextOverflows || showContext {
                    LiveButton(live: live, tooltip: nil, pressable: true) {
                        let revealing = !contextRevealed
                        GenMotion.perform(expanding: revealing, reduceMotion: reduceMotion) { showContext = revealing }
                    } label: {
                        Text(contextRevealed ? "Show less" : "Show all")
                    }
                        .font(.system(size: 10.5))
                        .foregroundColor(ReviewPalette.renamed)
                }
            }
            // Folded, a long context fades out at the cut instead of ending mid-line (H16).
            let faded = contextOverflows && !contextRevealed
            MarkdownContentView(markdown: context, style: contextStyle)
                .findField("context")
                .fixedSize(horizontal: false, vertical: true)
                .onGeometryChange(for: Bool.self, of: { $0.size.height > Self.contextFold + 1 }) { contextOverflows = $0 }
                .frame(maxHeight: contextRevealed ? nil : Self.contextFold, alignment: .top)
                .clipped()
                .mask {
                    VStack(spacing: 0) {
                        Rectangle()
                        LinearGradient(colors: [.black, .clear], startPoint: .top, endPoint: .bottom)
                            .frame(height: faded ? 36 : 0)
                    }
                }
        }
        // A plain block with a rule on its left, not a filled box inside the card (P8: a card in a card).
        .padding(.leading, 10)
        .overlay(alignment: .leading) { Rectangle().fill(Color.white.opacity(0.12)).frame(width: 2) }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var contextStyle: MarkdownStyle {
        var style = MarkdownStyle.hub
        style.bodySize = 12
        style.textColor = .white.opacity(0.82)
        style.blockSpacing = 6
        return style
    }

    private var excerptSection: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("Code").font(.system(size: 10.5, weight: .semibold)).foregroundColor(ReviewPalette.dim)
            ForEach(Array(item.excerptRefs.enumerated()), id: \.offset) { index, ref in
                InboxExcerptCard(ref: ref, cwd: session.cwd, field: "ref:\(index)", live: live)
            }
        }
    }

    private var noteField: some View {
        let keys = LiveWidgetView.ownAnswerKeys(ownAnswer: true,
                                                returnStages: DecisionAnswering.returnStages(state.preferences, command: false),
                                                commandSwaps: state.preferences?.decisionCommandSwaps ?? true)
        return VStack(alignment: .leading, spacing: 4) {
            TextField((item.choices ?? []).isEmpty ? "Your answer…" : "Write my own answer…", text: $note, axis: .vertical)
                .textFieldStyle(.plain)
                .font(.system(size: 12))
                .lineLimit(1...4)
                .padding(7)
                // The field's own edge: an input drawn as one (P8 keeps it; it is a control, not a box around content).
                .background(RoundedRectangle(cornerRadius: 7).stroke(Color.white.opacity(noteFocused ? 0.3 : 0.12)))
                .disabled(!pickable)
                .focused($noteFocused)
                .accessibilityHint(Text(keys.spoken))
                .onChange(of: noteFocused) { _, focused in
                    if focused {
                        inbox.noteFocusID = item.id
                        inbox.keyCardID = item.id
                    } else if inbox.noteFocusID == item.id {
                        inbox.noteFocusID = nil
                    }
                }
                // Return stages the note and ⌘-Return sends it with the pick, or the other way round (the widget's
                // "Return in an own answer"). Option-Return stays a new line.
                .onKeyPress(.return, phases: .down) { press in
                    guard pickable, !press.modifiers.contains(.option), !press.modifiers.contains(.shift) else { return .ignored }
                    submitNote(command: press.modifiers.contains(.command))
                    return .handled
                }
                // Esc puts the staged note back and leaves the field.
                .onKeyPress(.escape) {
                    note = item.draft ?? ""
                    inbox.noteTexts[item.id] = nil
                    noteDirty = false
                    noteHint = nil
                    noteFocused = false
                    return .handled
                }
                .onChange(of: note) { _, value in
                    // The stored note itself (its seeding, a re-seed after another surface staged one) is no edit.
                    guard noteSeeded else { return }
                    noteHint = nil
                    let stored = item.draft ?? ""
                    // Kept here and in the model, never written on a pause: nothing is staged until Return, ⌘-Return
                    // or Stage note, so typing neither stages the decision nor reloads the Inbox (F3).
                    inbox.noteTexts[item.id] = value == stored ? nil : value
                    noteDirty = value != stored
                }
            HStack(spacing: 8) {
                // The keys of the note, or what Return could not do: a quiet hint, never an error (P9, P12).
                Text(noteHint ?? keys.hint)
                    .font(.system(size: 11))
                    .foregroundColor(ReviewPalette.dim)
                    .lineLimit(1)
                    .accessibilityHidden(noteHint == nil)
                Spacer(minLength: 6)
                if noteDirty, pickable, !note.trimmed.isEmpty {
                    Button("Stage note") {
                        inbox.stageNote(item, in: session, note: note)
                        noteDirty = false
                    }
                    .buttonStyle(.genHoverPlain())
                    .font(.system(size: 11))
                    .foregroundColor(SessionPalette.blue)
                    .disabled(sessionSending)
                    .instantTooltip("Stage this note with the decision; nothing is sent yet")
                }
            }
            .frame(minHeight: 18)
        }
    }

    /// Return or ⌘-Return in the note: stage it or send it, as the widget's own answer does; a hint when there is
    /// nothing to stage or send.
    private func submitNote(command: Bool) {
        if let hint = inbox.submitNote(item, in: session, note: note, command: command) {
            noteHint = hint
            GenAnnounce.post(hint)
        } else {
            noteDirty = false
        }
    }

    private var footerRow: some View {
        VStack(alignment: .leading, spacing: 6) {
            if let failure = state.writeError {
                // One sentence; the tool's own words behind Details, never cut in the middle (F10).
                NoticePill(text: failure, more: state.writeErrorDetail, tone: .error)
            }
            if let record = item.delivery {
                VStack(alignment: .leading, spacing: 2) {
                    FindText(record.line, field: "delivery")
                        .font(.system(size: 11))
                        .foregroundColor(record.isQueued ? ReviewPalette.modified : ReviewPalette.dim)
                        .fixedSize(horizontal: false, vertical: true)
                    if let raw = record.raw, !raw.isEmpty {
                        GenDisclosure(isExpanded: $showsDeliveryDetails, minHeight: 20, spacing: 4,
                                      accessibilityTitle: "Delivery details") {
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
            HStack(spacing: 10) {
                // A staged decision sends from its own card, next to the pick, or leaves the staged list (F2).
                if staged, pickable {
                    Button {
                        inbox.sendNow(item, in: session, note: noteDirty ? note : nil)
                        noteDirty = false
                    } label: {
                        Label("Send now", systemImage: "paperplane.fill").font(.system(size: 12))
                    }
                    .buttonStyle(.genPrimary())
                    .fixedSize()
                    .disabled(sessionSending || writing)
                    .instantTooltip(sessionSending ? "This session's send is running" : "Send this staged decision alone, without the others")
                    LiveButton(live: live, tooltip: "Take the pick and the note off the staged list; the note stays here",
                               enabled: !(sessionSending || writing), pressable: true) {
                        inbox.unstage(item, in: session, keeping: note)
                        noteDirty = !note.isEmpty
                    } label: {
                        Text("Unstage")
                    }
                    .font(.system(size: 11.5))
                    .foregroundColor(ReviewPalette.renamed)
                }
                if writing {
                    ProgressView().controlSize(.small)
                }
                Spacer(minLength: 6)
                if session.reply != nil {
                    LiveButton(live: live, tooltip: nil, pressable: true) { showReply = true } label: {
                        Text("Open the whole reply")
                    }
                        .font(.system(size: 11))
                        .foregroundColor(ReviewPalette.renamed)
                }
                if let hubSession = state.hubSession {
                    LiveButton(live: live, tooltip: "Open the session and search the transcript for this decision",
                               pressable: true) {
                        model.transcriptQuery = "DECISION \(item.number ?? 0)"
                        model.openSession(hubSession)
                    } label: {
                        Text("Open in transcript")
                    }
                    .font(.system(size: 11))
                    .foregroundColor(ReviewPalette.renamed)
                }
                // The routine destructive action: quiet, last, apart from the send (P13).
                if item.isOpen, state.heldDismiss {
                    LiveButton(live: live, tooltip: "Keep this decision; nothing was written yet", pressable: true) {
                        inbox.undoDismiss(item)
                    } label: {
                        Text("Dismissed · Undo")
                    }
                        .font(.system(size: 11))
                        .foregroundColor(ReviewPalette.renamed)
                        .padding(.leading, 8)
                } else if item.isOpen {
                    LiveButton(live: live, tooltip: "Drop this decision without sending an answer; Undo stays for a few seconds",
                               pressable: true) {
                        inbox.dismiss(item, in: session)
                    } label: {
                        Text("Dismiss")
                    }
                        .font(.system(size: 11))
                        .foregroundColor(ReviewPalette.dim)
                        .padding(.leading, 8)
                }
            }
        }
    }

    private func optionRow(_ choice: InboxChoice, index: Int) -> some View {
        // An open card shows what is staged; a closed one shows what it took, in green (F7).
        let picked = item.isOpen ? letters.contains(choice.id) : (item.option ?? "").contains(choice.id)
        let stagedPick = picked && item.isOpen
        let answered = picked && !item.isOpen
        let preferences = state.preferences
        let stages = DecisionAnswering.clickStages(preferences, command: false)
        let recommended = choice.recommended == true || item.recommended == choice.id
        let shape = RoundedRectangle(cornerRadius: 8)
        // A second pick while the session's send runs would race it (P14).
        let enabled = pickable && !sessionSending
        let choose = {
            let flags = NSApp.currentEvent?.modifierFlags ?? NSEvent.modifierFlags
            inbox.choose(item, in: session, letter: choice.id, note: noteDirty ? note : nil,
                         shift: flags.contains(.shift), command: flags.contains(.command))
            noteDirty = false
        }
        let label = HStack(alignment: .top, spacing: 9) {
            // A staged letter is the widget's blue, never the green of "answered" (F2); the deep send blue keeps
            // the white letter at 4.5:1.
            Text(verbatim: "\(choice.id))")
                .font(.system(size: 12.5, weight: .bold, design: .monospaced))
                .foregroundColor(stagedPick ? .white : answered ? .black : Color.white.opacity(0.85))
                .frame(width: 26, height: 21)
                .background(RoundedRectangle(cornerRadius: 5).fill(
                    stagedPick ? GenPrimaryButtonStyle.blue : answered ? ReviewPalette.added : Color.white.opacity(0.08)))
            VStack(alignment: .leading, spacing: 2) {
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    FindText(inlineMarkdown(choice.shownLabel), field: "choice:\(choice.id)")
                        .font(.system(size: 12.5))
                        .foregroundColor(Color.white.opacity(item.isOpen || picked ? 0.92 : 0.55))
                        .frame(maxWidth: .infinity, alignment: .leading)
                    if recommended {
                        Badge("Recommended", color: ReviewPalette.added, look: .filled)
                    }
                    if stagedPick {
                        Text("Staged")
                            .font(.system(size: 11, weight: .semibold))
                            .foregroundColor(SessionPalette.blue)
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
        .background(stagedPick ? SessionPalette.blue.opacity(0.16) : Color.clear, in: shape)
        .overlay(shape.strokeBorder(stagedPick ? SessionPalette.blue.opacity(0.7) : .clear, lineWidth: 1))
        .contentShape(shape)
        return Group {
            if live {
                Button(action: choose) { label }
                    // The kit's row button: a soft fill in the row's own frame, not the white outline (P1).
                    .buttonStyle(RowButtonStyle(cornerRadius: 8))
                    .disabled(!enabled)
                    .instantTooltip(!item.isOpen
                        ? "This decision is closed: \(statusPhrase)"
                        : sessionSending ? "This session's send is running"
                        : DecisionAnswering.optionTooltip(choice.id, recommended: recommended, stages: stages, picked: stagedPick,
                                                          swaps: preferences?.decisionCommandSwaps ?? true,
                                                          key: index < 9 ? index + 1 : nil))
            } else {
                label.restingButton(enabled: enabled, action: choose)
            }
        }
        .accessibilityValue(stagedPick ? "Staged" : answered ? "Chosen" : "")
        .accessibilityAddTraits(picked ? .isSelected : [])
    }

    /// Toggles one letter in a pick string. Plain click replaces the set; ⇧-click adds or removes.
    nonisolated static func toggled(_ current: String, _ id: String, add: Bool) -> String {
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
    /// Its card is live: the path is a button with a tooltip only then (F1).
    let live: Bool

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
                if ref.missing == true {
                    // Nothing to open: a link here opened a guessed path that does not exist.
                    let note = ref.unresolvedNote
                    FindText(displayPath, field: field)
                        .font(.system(size: 11, design: .monospaced))
                        .foregroundColor(ReviewPalette.dim)
                    Spacer()
                    Label(note.label, systemImage: "questionmark.folder")
                        .font(.system(size: 10.5))
                        .foregroundColor(ReviewPalette.dim)
                        .liveTooltip(live, note.detail)
                } else {
                    LiveButton(live: live, tooltip: "Open \(absolute)\(ref.line.map { ":\($0)" } ?? "") in Cursor",
                               pressable: true) {
                        PathOpener.cursor(absolute, line: ref.line ?? 1)
                    } label: {
                        FindText(displayPath, field: field)
                            .font(.system(size: 11, design: .monospaced))
                            .foregroundColor(Color(red: 0.55, green: 0.7, blue: 1))
                    }
                    Spacer()
                }
            }
            if let excerpt = ref.excerpt, !excerpt.isEmpty {
                CodeBlockText(
                    block: CodeBlockBuilder.numbered(excerpt, start: ref.startLine ?? ref.line ?? 1, language: SyntaxLanguage.forPath(ref.path), focus: ref.line),
                    limit: nil,
                    cacheKey: "inbox-\(ref.path):\(ref.line ?? 0)"
                )
                .frame(maxWidth: .infinity, alignment: .leading)
                // The code reads as a block by its rule and its monospaced lines, not by a filled box (P8).
                .padding(.leading, 10)
                .overlay(alignment: .leading) { Rectangle().fill(Color.white.opacity(0.12)).frame(width: 2) }
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
                IconButton(systemName: "xmark", tooltip: "Close (Esc)") { dismiss() }
            }
            ScrollView {
                MarkdownContentView(markdown: markdown, style: .hub)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
        .padding(16)
        .frame(width: 680, height: 560)
        .background(Color(nsColor: ReviewPalette.background))
        // Esc closes the sheet (F16): a cancel-action key equivalent works with no focused view, and the exit command
        // covers a focused one.
        .background {
            Button("Close") { dismiss() }
                .keyboardShortcut(.cancelAction)
                .opacity(0)
                .allowsHitTesting(false)
                .accessibilityHidden(true)
        }
        .onExitCommand { dismiss() }
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
            if let last = hubSession?.lastActivity {
                HStack(alignment: .top, spacing: 8) {
                    Text("last activity").font(.system(size: 10.5)).foregroundColor(ReviewPalette.dim).frame(width: 84, alignment: .leading)
                    LiveAgo(date: last).font(.system(size: 11.5)).foregroundColor(Color.white.opacity(0.9))
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
            }
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
        guard let hubSession else { return }
        if let cached = HubSpend.cached(hubSession) {
            spend = cached
            return
        }
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
            let hubSession = inboxHubSession(session, in: model)
            if let hubSession {
                // Return does not resume here: a resume reopens the session and types the answers (F16). The picker's
                // own Cancel takes Esc.
                LaunchPicker(mode: .resume(hubSession), returnStarts: false) { outcome in
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
                // One Cancel: the picker brings its own, so this one shows only without a picker.
                if hubSession == nil {
                    Button("Cancel") { dismiss() }
                        .keyboardShortcut(.cancelAction)
                }
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
/// One image attached to a QA answer: written to a private temp file as soon as it is pasted or
/// picked, so it can be sent as `--image itemId=path` without ever crossing argv as base64.
private struct QaAttachedImage: Identifiable {
    let id = UUID()
    let path: String
    let thumbnail: NSImage

    enum Outcome {
        case staged(QaAttachedImage)
        case failed(String)
    }

    static let directory = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("gt-qa-images", isDirectory: true)
    /// A staged file older than this belongs to a card that went away mid-answer or a hub that quit.
    static let staleAge: TimeInterval = 24 * 3_600

    /// Off the main thread: PNG-encodes the image, refuses one over the server's cap, writes it to a
    /// private temp file and sweeps stale ones.
    static func stage(_ image: NSImage?) -> Outcome {
        guard let image, let tiff = image.tiffRepresentation, let rep = NSBitmapImageRep(data: tiff),
              let png = rep.representation(using: .png, properties: [:])
        else {
            return .failed("Could not read that image.")
        }

        guard png.count <= QaFormFields.maxImageBytes else {
            return .failed("That image is too large; the server keeps up to about 1.5 MB per image.")
        }

        let url = directory.appendingPathComponent("\(UUID().uuidString).png")
        do {
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            sweepStale()
            try png.write(to: url)
        } catch {
            return .failed("Could not save that image: \(error.localizedDescription)")
        }

        return .staged(QaAttachedImage(path: url.path, thumbnail: NSImage(data: png) ?? image))
    }

    static func remove(_ path: String) {
        do {
            try FileManager.default.removeItem(atPath: path)
        } catch {
            NSLog("[hub] could not remove staged QA image \(path): \(error.localizedDescription)")
        }
    }

    private static func sweepStale(now: Date = Date()) {
        let files = (try? FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: [.contentModificationDateKey])) ?? []
        for file in files where file.pathExtension == "png" {
            let modified = (try? file.resourceValues(forKeys: [.contentModificationDateKey]))?.contentModificationDate ?? now
            if now.timeIntervalSince(modified) > staleAge {
                remove(file.path)
            }
        }
    }
}

private struct InboxFormCard: View {
    @ObservedObject var inbox: HubInboxModel
    let item: InboxItem
    @State private var picked: [String: Set<String>] = [:]
    @State private var texts: [String: String] = [:]
    @State private var fileTagsText: [String: String] = [:]
    @State private var attachedImages: [String: [QaAttachedImage]] = [:]
    @State private var fieldError: [String: String] = [:]

    private var questions: [InboxQuestion] { item.questions ?? [] }
    private var sending: Bool { inbox.sending.contains(item.id) }

    /// One question, single choice, nothing else to attach, and the widget's Decision click sends at once: the click is
    /// the answer. While clicks stage, a form waits for Send answer too, as the widget's forms do (P10).
    private var oneClick: Bool {
        questions.count == 1
            && questions[0].multiple == false
            && !questions[0].choices.isEmpty
            && !questions[0].fileTags
            && !questions[0].imagePaste
            && !DecisionAnswering.clickStages(inbox.preferences, command: false)
    }

    private var complete: Bool {
        questions.allSatisfy { question in
            !question.required
                || !(picked[question.itemId] ?? []).isEmpty
                || !(texts[question.itemId]?.trimmed.isEmpty ?? true)
                || !(attachedImages[question.itemId] ?? []).isEmpty
                || !fileTags(for: question.itemId).isEmpty
        }
    }

    /// The `@file` tags for one item, the manual field split and capped the way the store is.
    private func fileTags(for itemId: String) -> [String] {
        Array(QaFormFields.splitFileTags(fileTagsText[itemId] ?? "").prefix(QaFormFields.maxFileTagsPerAnswer))
    }

    private func submit() {
        let fileTagsByItem = Dictionary(uniqueKeysWithValues: questions.compactMap { question -> (String, [String])? in
            let tags = fileTags(for: question.itemId)
            return tags.isEmpty ? nil : (question.itemId, tags)
        })
        let imagePathsByItem = Dictionary(uniqueKeysWithValues: attachedImages.compactMap { itemId, images -> (String, [String])? in
            images.isEmpty ? nil : (itemId, images.map(\.path))
        })
        inbox.answerForm(item, choices: picked, texts: texts, fileTags: fileTagsByItem, imagePaths: imagePathsByItem)
    }

    /// The form's attached images live in the model, not in this lazy card: a card scrolled out of view deleted them
    /// (F11). The model drops them with their files once the form is answered or no longer listed.
    private func setImages(_ images: [QaAttachedImage], for itemId: String) {
        attachedImages[itemId] = images
        inbox.formImages[item.id, default: [:]][itemId] = images
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 8) {
                Image(systemName: "questionmark.bubble.fill").foregroundColor(ReviewPalette.renamed)
                    .accessibilityHidden(true)
                Text("Question form").font(.system(size: 13, weight: .semibold))
                Spacer()
                Label { LiveAgo(date: item.date, style: .brief) } icon: { Image(systemName: "clock") }
                    .font(.system(size: 11))
                    .foregroundColor(ReviewPalette.dim)
                // The id is for a bug report, not for answering: an icon, not a chip of raw text (P10).
                IconButton(systemName: "number", tooltip: "Copy the form id") { PathOpener.copy(item.id) }
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
                    if question.fileTags {
                        fileTagField(question)
                    }
                    if question.imagePaste {
                        imageAttachField(question)
                    }
                    if let error = fieldError[question.itemId] {
                        Text(error).font(.system(size: 11)).foregroundColor(ReviewPalette.removed)
                            .fixedSize(horizontal: false, vertical: true)
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
                if !oneClick || questions.contains(where: { $0.freeText || $0.fileTags || $0.imagePaste }) {
                    Button {
                        submit()
                    } label: {
                        Label("Send answer", systemImage: "paperplane.fill").font(.system(size: 12))
                    }
                    .buttonStyle(.genPrimary())
                    .fixedSize()
                    .disabled(!complete || sending)
                    .instantTooltip(complete ? "Answer the form; the agent waiting on it continues" : "Every required question needs an answer first")
                }
            }
        }
        .padding(13)
        .background(RoundedRectangle(cornerRadius: 11).fill(Color.white.opacity(0.045)))
        .overlay(RoundedRectangle(cornerRadius: 11).stroke(ReviewPalette.renamed.opacity(0.3)))
        .findRow(item.id, cornerRadius: 11)
        .onAppear {
            // A card built again (scrolled back into view) gets its images back.
            if let kept = inbox.formImages[item.id] { attachedImages = kept }
        }
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
                submit()
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

    // MARK: - `@file` tags

    private func fileTagField(_ question: InboxQuestion) -> some View {
        let itemId = question.itemId
        let count = QaFormFields.splitFileTags(fileTagsText[itemId] ?? "").count
        return VStack(alignment: .leading, spacing: 3) {
            HStack(spacing: 6) {
                TextField("@file tags, space or comma separated", text: Binding(get: { fileTagsText[itemId] ?? "" }, set: { fileTagsText[itemId] = $0 }))
                    .textFieldStyle(.plain)
                    .font(.system(size: 12))
                    .padding(7)
                    .background(RoundedRectangle(cornerRadius: 7).stroke(Color.white.opacity(0.12)))
                Button("Browse…") { browseFileTag(question) }
                    .buttonStyle(.genHoverPlain())
                    .disabled((item.cwd ?? "").isEmpty)
                    .instantTooltip((item.cwd).map { "Choose a file inside \($0)" } ?? "This form has no cwd to browse")
            }
            if count > QaFormFields.maxFileTagsPerAnswer {
                Text("Only the first \(QaFormFields.maxFileTagsPerAnswer) tags are kept.")
                    .font(.system(size: 10))
                    .foregroundColor(ReviewPalette.dim)
            }
        }
    }

    private func browseFileTag(_ question: InboxQuestion) {
        guard let cwd = item.cwd, !cwd.isEmpty else { return }
        let panel = NSOpenPanel()
        panel.canChooseFiles = true
        panel.canChooseDirectories = false
        panel.allowsMultipleSelection = false
        panel.directoryURL = URL(fileURLWithPath: cwd)
        panel.prompt = "Attach"
        panel.message = "Choose a file inside \(cwd)"
        panel.begin { response in
            guard response == .OK, let url = panel.url else { return }
            guard let relative = QaFormFields.relativeFileTag(url.path, cwd: cwd) else {
                fieldError[question.itemId] = "That file is outside the form's folder (\(cwd))."
                return
            }
            fieldError[question.itemId] = nil
            let existing = fileTagsText[question.itemId] ?? ""
            let token = QaFormFields.fileTagToken(relative)
            fileTagsText[question.itemId] = existing.trimmed.isEmpty ? token : existing + " " + token
        }
    }

    // MARK: - Image paste / attach

    private func imageAttachField(_ question: InboxQuestion) -> some View {
        let itemId = question.itemId
        let images = attachedImages[itemId] ?? []
        return VStack(alignment: .leading, spacing: 6) {
            if !images.isEmpty {
                HStack(spacing: 6) {
                    ForEach(images) { image in
                        ZStack(alignment: .topTrailing) {
                            Image(nsImage: image.thumbnail)
                                .resizable()
                                .aspectRatio(contentMode: .fill)
                                .frame(width: 40, height: 40)
                                .clipShape(RoundedRectangle(cornerRadius: 5))
                            Button {
                                removeImage(itemId: itemId, id: image.id)
                            } label: {
                                Image(systemName: "xmark.circle.fill")
                                    .font(.system(size: 12))
                                    .foregroundColor(.white)
                                    .background(Circle().fill(Color.black.opacity(0.6)))
                            }
                            .buttonStyle(.genHoverPlain())
                            .offset(x: 4, y: -4)
                            .instantTooltip("Remove this image")
                            .accessibilityLabel(Text("Remove image"))
                        }
                    }
                }
            }
            HStack(spacing: 6) {
                Button("Choose image…") { chooseImage(itemId: itemId) }
                    .buttonStyle(.genHoverPlain())
                    .disabled(images.count >= QaFormFields.maxImagesPerAnswer)
                Text("or paste one here (\(images.count)/\(QaFormFields.maxImagesPerAnswer))")
                    .font(.system(size: 10))
                    .foregroundColor(ReviewPalette.dim)
            }
        }
        .padding(6)
        .background(RoundedRectangle(cornerRadius: 7).stroke(Color.white.opacity(0.12), style: StrokeStyle(lineWidth: 1, dash: [3, 3])))
        .onPasteCommand(of: [.image]) { providers in
            for provider in providers {
                _ = provider.loadObject(ofClass: NSImage.self) { image, _ in
                    guard let image = image as? NSImage else { return }
                    DispatchQueue.main.async { attachImage(itemId: itemId) { image } }
                }
            }
        }
    }

    private func chooseImage(itemId: String) {
        let panel = NSOpenPanel()
        panel.canChooseFiles = true
        panel.canChooseDirectories = false
        panel.allowsMultipleSelection = true
        panel.allowedContentTypes = [.image]
        panel.prompt = "Attach"
        panel.message = "Choose an image to attach"
        panel.begin { response in
            guard response == .OK else { return }
            for url in panel.urls {
                attachImage(itemId: itemId) { NSImage(contentsOf: url) }
            }
        }
    }

    /// Loads, converts, size-checks and writes the image on a background queue, so a large screenshot
    /// never stalls the hub, then adds it on the main queue against the latest count.
    private func attachImage(itemId: String, load: @escaping () -> NSImage?) {
        guard (attachedImages[itemId] ?? []).count < QaFormFields.maxImagesPerAnswer else {
            fieldError[itemId] = "Only \(QaFormFields.maxImagesPerAnswer) images per answer; remove one first."
            return
        }

        DispatchQueue.global(qos: .userInitiated).async {
            let outcome = QaAttachedImage.stage(load())
            DispatchQueue.main.async {
                switch outcome {
                case .failed(let message):
                    fieldError[itemId] = message
                case .staged(let image):
                    let current = attachedImages[itemId] ?? []
                    guard current.count < QaFormFields.maxImagesPerAnswer else {
                        QaAttachedImage.remove(image.path)
                        fieldError[itemId] = "Only \(QaFormFields.maxImagesPerAnswer) images per answer; remove one first."
                        return
                    }
                    fieldError[itemId] = nil
                    setImages(current + [image], for: itemId)
                }
            }
        }
    }

    private func removeImage(itemId: String, id: UUID) {
        guard var list = attachedImages[itemId] else { return }
        if let index = list.firstIndex(where: { $0.id == id }) {
            QaAttachedImage.remove(list[index].path)
            list.remove(at: index)
        }
        setImages(list, for: itemId)
    }
}

/// Bold, code and links in a prompt; anything that is not valid markdown stays plain text.
func inlineMarkdown(_ text: String) -> AttributedString {
    (try? AttributedString(markdown: text, options: AttributedString.MarkdownParsingOptions(interpretedSyntax: .inlineOnlyPreservingWhitespace)))
        ?? AttributedString(text)
}
