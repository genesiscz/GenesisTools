import AppKit
import Foundation

/// How a decision is answered, for every surface that answers one: the widget and the hub's Inbox (Martin,
/// 2026-10-27: "make sure the hub is using the same mechanism / model / engine"). One set of rules decides whether a
/// click or Return stages or sends, one request shape goes to the hub's `send-staged` and `resend-answers` actions
/// (`src/hub/lib/widget/actions.ts`, also `tools hub widget call`), and one outcome words what arrived.
public enum DecisionAnswering {
    /// The letters a click on `letter` stages over `current`: with ⇧ (`adding`) the letter joins the set or leaves it,
    /// a plain click picks it alone, and a click on the only picked letter clears the pick. Sorted ("ac"), nil for
    /// none. The hub's Inbox uses the same rule (`InboxDecisionCard.toggled`); the widget used to replace "ac" by "a".
    public static func nextPick(_ current: String?, _ letter: String, adding: Bool) -> String? {
        var set = Set((current ?? "").map(String.init))
        if adding {
            if set.contains(letter) { set.remove(letter) } else { set.insert(letter) }
        } else {
            set = set == [letter] ? [] : [letter]
        }
        let next = set.sorted().joined()
        return next.isEmpty ? nil : next
    }

    /// A staged answer in words for a sentence: "pick b)", "pick a) c) and note", "note".
    public static func pickWords(option: String?, note: String?) -> String {
        let letters = (option ?? "").map { "\($0))" }.joined(separator: " ")
        let hasNote = !(note ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        if letters.isEmpty { return "note" }
        return hasNote ? "pick \(letters) and note" : "pick \(letters)"
    }

    /// Whether an action stages: `stagesByDefault`, turned around while ⌘ is down and `swaps` is on.
    public static func stages(_ stagesByDefault: Bool, command: Bool, swaps: Bool) -> Bool {
        stagesByDefault != (swaps && command)
    }

    /// A click on a decision option (or its number key) stages it ("stage", the default) or sends it at once ("send"),
    /// turned around by ⌘ while "⌘ does the other" is on (`decisionClick`, `decisionCommandSwaps`).
    public static func clickStages(_ preferences: WidgetPreferences?, command: Bool) -> Bool {
        stages((preferences?.decisionClick ?? "stage") == "stage", command: command,
               swaps: preferences?.decisionCommandSwaps ?? true)
    }

    /// Return in a decision's own answer stages the text as its note ("stage", the default) or sends it, turned
    /// around by ⌘ the same way (`ownAnswerReturn`).
    public static func returnStages(_ preferences: WidgetPreferences?, command: Bool) -> Bool {
        stages((preferences?.ownAnswerReturn ?? "stage") == "stage", command: command,
               swaps: preferences?.decisionCommandSwaps ?? true)
    }

    /// Whether ⌘ is down for the click being handled.
    @MainActor public static var commandDown: Bool {
        (NSApp.currentEvent?.modifierFlags ?? NSEvent.modifierFlags).contains(.command)
    }

    /// An option's tooltip: what a click does now, and what ⌘-click does. `key` is its number key, if it has one.
    public static func optionTooltip(_ letter: String, recommended: Bool, stages: Bool, picked: Bool, swaps: Bool,
                                     key: Int? = nil) -> String {
        let keyText = key.map { " · key \($0)" } ?? ""
        if !stages {
            return "Answer \(letter)" + (recommended ? " (recommended)" : "") + keyText + (swaps ? " · ⌘-click stages it" : "")
        }
        return (picked ? "Staged; click again to unstage" : "Stage \(letter), sent later with your other staged decisions")
            + (recommended ? " (recommended)" : "") + keyText + (swaps ? " · ⌘-click sends it now" : "")
    }

    /// Where a session's answers go: its agent, the account home it runs under and its folder. An empty field is left
    /// out, so the hub takes the decision row's own.
    public struct Target: Equatable, Sendable {
        public var provider: String
        public var sourceHome: String
        public var cwd: String

        public init(provider: String, sourceHome: String = "", cwd: String = "") {
            self.provider = provider
            self.sourceHome = sourceHome
            self.cwd = cwd
        }

        var json: WidgetJSON {
            var fields: [String: WidgetJSON] = [:]
            if !provider.isEmpty { fields["provider"] = .string(provider) }
            if !sourceHome.isEmpty { fields["sourceHome"] = .string(sourceHome) }
            if !cwd.isEmpty { fields["cwd"] = .string(cwd) }
            return .object(fields)
        }
    }

    /// The hub request that sends the staged decisions `ids` ("send-staged") or sends answered ones again
    /// ("resend-answers"), one message per session; `targets` by session id.
    public static func sendRequest(_ action: SendAction, ids: [String], targets: [String: Target]) -> WidgetJSON {
        ["action": .string(action.rawValue), "ids": .array(ids.map { .string($0) }),
         "targets": .object(targets.mapValues(\.json))]
    }

    public enum SendAction: String, Sendable {
        case sendStaged = "send-staged"
        case resendAnswers = "resend-answers"
    }
}

/// What a decision send did, read from the hub's answer: how many went out, waited or failed, and why a session
/// took nothing.
public struct WidgetDecisionSendOutcome {
    public var sent = 0
    public var queued = 0
    public var failed = 0
    /// Sessions whose answers no receiver took: the session id, its title, the reason as one sentence, the hub's own
    /// words (for Details and the log), and whether anything delivers them later by itself (the decisions hook that
    /// injects queued answers, or a saved session-queue entry). A hub that does not say is read as "it does", the old
    /// wording.
    public var waiting: [(session: String, title: String, reason: String, detail: String?, later: Bool)] = []
    /// The hub's own words for each session whose send threw, as "<title>: <error>".
    public var failures: [String] = []

    public var queuedSessions: Set<String> { Set(waiting.map(\.session)) }
    /// Every answer reached a live receiver.
    public var delivered: Bool { waiting.isEmpty && failed == 0 && queued == 0 }
    /// The hub's raw reasons, one line per session, for Details and the log; nil when it gave none.
    public var details: String? {
        let lines = waiting.compactMap { entry in entry.detail.map { "\(entry.title): \($0)" } } + failures
        return lines.isEmpty ? nil : lines.joined(separator: "\n")
    }

    public init(_ result: WidgetJSON, titles: [String: String]) {
        guard case .object(let fields) = result else { return }
        if case .number(let value) = fields["sent"] { sent = Int(value) }
        if case .number(let value) = fields["queued"] { queued = Int(value) }
        if case .number(let value) = fields["failed"] { failed = Int(value) }
        guard case .array(let sessions) = fields["sessions"] else { return }
        for case .object(let entry) in sessions {
            guard case .string(let session) = entry["session"] else { continue }
            let title = titles[session] ?? "the session"
            if case .string(let error) = entry["error"], !error.isEmpty {
                failures.append("\(title): \(error)")
                continue
            }
            guard case .object(let answer) = entry["result"], answer["delivered"] != .bool(true) else { continue }
            var detail: String?
            if case .string(let text) = answer["detail"], !text.isEmpty { detail = text }
            let later = entry["deliversLater"].map { $0 == .bool(true) } ?? true
            waiting.append((session, title, Self.sentence(for: detail), detail, later))
        }
    }

    /// Why no receiver took the answers, in one sentence. The hub words its reasons for logs ("No native Claude
    /// receiver claims this session.", "no cmux pane runs this session"); the known ones are matched here, and
    /// anything else reads as the generic sentence with the hub's text behind Details (ux catalogue P24). The hub's
    /// reasons: `src/question/lib/decisions/deliver.ts` (`resolveDeliveryTarget`, `nativeWorkers`, `undelivered`)
    /// and `delivery-text.ts` (`deliverySentence`).
    public static func sentence(for detail: String?) -> String {
        let generic = "No running agent took them."
        guard let text = detail?.lowercased(), !text.isEmpty else { return generic }
        let known: [(needle: String, sentence: String)] = [
            ("worker is busy", "Its worker is busy with another turn."),
            ("worker session has not started", "Its worker has not started yet."),
            ("not ready for another turn", "Its worker is not ready for another turn."),
            ("claude terminals run this session",
             "Several Claude terminals run this session, so none was picked. Close the extra one, then send again."),
            ("no native claude receiver", "No open Claude terminal takes messages for this session."),
            ("receiver belongs to another source home", "Its Claude terminal runs under another account."),
            ("worker belongs to another source home", "Its worker runs under another account."),
            ("several owned workers match", "Several workers match this session, so none was picked."),
            ("worker runs this thread", "No Codex worker runs this conversation."),
            ("cmux is not running", "cmux is not running."),
            ("workspace of this session was closed", "Its cmux workspace was closed."),
            ("no cmux pane runs this session", "No cmux pane runs this session."),
            ("cmux panes match this session", "Several cmux panes match this session, so none was picked."),
            ("does not identify the exact recipient", "No cmux pane could be matched to this session for certain."),
            ("cmux send failed", "cmux could not type the answers."),
            ("too large to save for later", "The answers are too long to keep for a later delivery."),
            ("already saved this message", "An earlier send already saved them for this session."),
        ]
        return known.first { text.contains($0.needle) }?.sentence ?? generic
    }

    /// The note: a plain summary when everything went out, else what did not and why.
    func notice(items: [WidgetInboxItem], staged: Bool) -> String {
        notice(summary: WidgetModel.stagedSummary(items, future: false) + ".", staged: staged)
    }

    /// The note, with `summary` for a send whose answer counted nothing ("1 decision was sent to 1 session.").
    public func notice(summary: String, staged: Bool) -> String {
        var parts: [String] = []
        if sent > 0 { parts.append(Plural.count(sent, "decision") + " delivered.") }
        if let first = waiting.first {
            // "Waits for its next prompt" only while something will deliver them then; on a Mac without the decisions
            // hook (`decisions.injectAnswers` off) nothing does, and the sentence promised a delivery that never came.
            let later = waiting.allSatisfy(\.later)
            if waiting.count == 1 {
                parts.append("Not delivered to \(first.title): \(first.reason) "
                             + (later ? "The answers wait for its next prompt."
                                      : "Nothing sends them by itself: Send again once the session is open."))
            } else {
                // One reason for all of them is worth saying; several differ per session and live behind Details.
                let why = Set(waiting.map(\.reason)).count == 1 ? first.reason + " " : ""
                parts.append("Not delivered to \(Plural.count(waiting.count, "session")): \(why)"
                             + (later ? "The answers wait for each session's next prompt."
                                      : "Nothing sends them by itself: Send again once the sessions are open."))
            }
        }
        if queued > 0, waiting.isEmpty {
            parts.append("\(Plural.count(queued, "decision")) waiting for the session queue.")
        }
        if failed > 0 {
            parts.append("\(Plural.count(failed, "decision")) could not be sent" + (staged ? " and stay staged." : "."))
        }
        return parts.isEmpty ? summary : parts.joined(separator: " ")
    }
}

/// The widget's preferences as its `state.json` holds them, for a surface outside the widget that follows the same
/// settings (the hub's Inbox: Decision click, ⌘ does the other, Return in an own answer). The parsed preferences are
/// kept only while the file's identity (inode, size, modification and change times, taken before the read) is the
/// same, so a newer write is always read; an unreadable file keeps the last good read, and nil means the defaults.
public final class WidgetPreferencesFile: @unchecked Sendable {
    public static let shared = WidgetPreferencesFile()

    struct Identity: Equatable {
        var inode: UInt64
        var size: Int64
        var modified: timespec
        var changed: timespec

        static func == (a: Identity, b: Identity) -> Bool {
            a.inode == b.inode && a.size == b.size && a.modified.tv_sec == b.modified.tv_sec
                && a.modified.tv_nsec == b.modified.tv_nsec && a.changed.tv_sec == b.changed.tv_sec
                && a.changed.tv_nsec == b.changed.tv_nsec
        }

        init?(path: String) {
            var info = stat()
            guard stat(path, &info) == 0 else { return nil }
            inode = UInt64(info.st_ino)
            size = Int64(info.st_size)
            modified = info.st_mtimespec
            changed = info.st_ctimespec
        }
    }

    private let path: String
    // Guards `cached`: the hub reads from a background load and from a click on the main thread.
    private let lock = NSLock()
    private var cached: (identity: Identity, preferences: WidgetPreferences)?

    /// `path`: a `state.json`; nil is the widget's own (`$GENESIS_TOOLS_HOME/.genesis-tools/hub/widget/state.json`).
    public init(path: String? = nil) {
        self.path = path ?? WidgetModel.widgetStateFile(stateRoot: nil)
    }

    public func current() -> WidgetPreferences? {
        let identity = Identity(path: path)
        lock.lock()
        defer { lock.unlock() }
        if let cached, let identity, cached.identity == identity { return cached.preferences }
        struct Stored: Decodable { let preferences: WidgetPreferences }
        do {
            let preferences = try JSONDecoder().decode(Stored.self, from: Data(contentsOf: URL(fileURLWithPath: path)))
                .preferences
            if let identity { cached = (identity, preferences) }
            return preferences
        } catch {
            PerfLog.mark("widget.preferences unreadable at \(path): \(error.localizedDescription)")
            return cached?.preferences
        }
    }
}
