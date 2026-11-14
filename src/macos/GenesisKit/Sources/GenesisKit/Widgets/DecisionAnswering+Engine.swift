import Foundation

/// One decision as a write addresses it: its row id in the decision log (also the id a send takes), its session, and
/// what the hub's own write path needs to find or harvest the row (number, revision, provider, folder).
public struct DecisionAddress: Equatable, Sendable {
    public var id: String
    public var sessionId: String
    public var number: Int?
    public var revision: Int?
    public var provider: String?
    public var cwd: String?

    public init(id: String, sessionId: String, number: Int? = nil, revision: Int? = nil, provider: String? = nil,
                cwd: String? = nil) {
        self.id = id
        self.sessionId = sessionId
        self.number = number
        self.revision = revision
        self.provider = provider
        self.cwd = cwd
    }
}

/// The decision action set: every write a surface asks of the decision log. Undo writes nothing (a held Dismiss is
/// dropped before it is written), so it is the engine's own (`DecisionAnswering.Engine.undo`).
public enum DecisionAction: Equatable, Sendable {
    /// Stages a pick (the letters; `""` clears it, nil keeps the stored one) and a note (nil keeps it, `""` clears it).
    case stage(DecisionAddress, option: String?, note: String?)
    /// Takes staged decisions out of every send.
    case unstage([DecisionAddress])
    /// Drops a decision that no longer matters, without sending anything.
    case dismiss(DecisionAddress)
    /// Sends staged decisions, or answered ones again (`DecisionAnswering.sendRequest`).
    case send(DecisionAnswering.SendAction, ids: [String], targets: [String: DecisionAnswering.Target])

    /// A note-only stage queued behind an earlier stage keeps that stage's letters: it replaces the queued write, and
    /// the running one may still fail. A newer pick wins, and nothing else takes letters.
    func keepingPick(from earlier: DecisionAction?) -> DecisionAction {
        guard case .stage(let ref, let option, let note) = self, option == nil,
              case .stage(_, let earlierOption, _)? = earlier, let kept = earlierOption else { return self }
        return .stage(ref, option: kept, note: note)
    }
}

/// What the decision log answered to one action.
public enum DecisionLogAnswer: Equatable, Sendable {
    case done(WidgetJSON)
    /// Refused, with a sentence for the surface and the raw words behind Details.
    case refused(String, detail: String?)
    /// No answer within `seconds`: the write may still land.
    case unanswered(seconds: Int)
}

/// One surface's door to the decision log. The widget's runs the action on its live connection (`WidgetModel.action`);
/// the hub's Inbox runs `tools` (`HubInboxDecisionLog`).
@MainActor
public protocol DecisionLog: AnyObject {
    func run(_ action: DecisionAction) async -> DecisionLogAnswer
}

extension DecisionAnswering {
    /// The staging half every surface that answers a decision shares: the pick and note staged a moment ago, one write
    /// queue per decision, the Dismiss held for its Undo, and the confirmation. A pick made here carries a version and
    /// shows until a snapshot that contains it confirms it (the widget's model, chosen for both surfaces: the phone can
    /// answer the same decision meanwhile, and a reload after a write cannot tell "my write landed" from "another write
    /// landed"). The writes go through `log`, so the hub and the widget differ only in their adapter.
    @MainActor
    public final class Engine: ObservableObject {
        /// A pick or note staged here that no snapshot has confirmed yet.
        public struct Pending: Equatable {
            /// The letters staged here (`""`: the pick was cleared); nil when only a note was staged.
            public var option: String?
            public var note: String?
            let version: UUID
            let askedAt: TimeInterval
            /// When the log took the write; the confirmation clock starts here.
            var doneAt: TimeInterval?
            /// The log never answered the write: the pick stays here until the user tries again.
            public var unsaved = false
        }

        /// Why the last write of a decision failed, until its next write starts.
        public struct WriteError: Equatable {
            public let text: String
            public let detail: String?
        }

        /// A decision row as a snapshot shows it, for the confirmation.
        public struct Row: Equatable {
            public var option: String
            public var note: String?
            /// Milliseconds since 1970 of the row's last change, when the snapshot says it.
            public var updatedAt: Double?

            public init(option: String?, note: String?, updatedAt: Double? = nil) {
                self.option = option ?? ""
                self.note = note
                self.updatedAt = updatedAt
            }
        }

        /// How long a pick shows after the log took it, before a snapshot confirms it: a few snapshots' time. After it
        /// the snapshot is the truth again, so a pick that never landed, or one sent elsewhere, stops showing.
        public nonisolated static let pendingLifetime: TimeInterval = 15
        /// The limit for a pick whose write never answered and is not waiting any more.
        public nonisolated static let unansweredLifetime: TimeInterval = 60

        @Published public private(set) var pending: [String: Pending] = [:]
        /// Decisions with a write running now.
        @Published public private(set) var writing: Set<String> = []
        @Published public private(set) var errors: [String: WriteError] = [:]
        /// Dismisses (or other changes) held for their Undo, by decision id.
        @Published public private(set) var held: Set<String> = []

        /// Called after each write with its action and the log's answer (a note's acknowledgement, a reload).
        public var written: ((String, DecisionAction, DecisionLogAnswer) -> Void)?
        /// Called when the last queued write of a decision ended, before the work that waited for it.
        public var drained: ((String) -> Void)?

        private struct Write {
            var action: DecisionAction
            var version: UUID?
        }

        private let log: DecisionLog
        private let clock: any Clock<Duration>
        private let now: () -> TimeInterval
        private var running: [String: Write] = [:]
        private var queued: [String: Write] = [:]
        /// Work waiting for a decision's writes to land (a send at once waits for its pick); dropped when one fails.
        private var afterWrites: [String: [() -> Void]] = [:]
        private var holds: [String: (action: DecisionAction, task: Task<Void, Never>?)] = [:]

        public init(log: DecisionLog, clock: any Clock<Duration> = ContinuousClock(),
                    now: @escaping () -> TimeInterval = { Date().timeIntervalSince1970 }) {
            self.log = log
            self.clock = clock
            self.now = now
        }

        /// The letters a card shows: the pick staged here a moment ago, else the stored one.
        public func letters(_ id: String, stored: String?) -> String {
            pending[id]?.option ?? stored ?? ""
        }

        /// The note a card shows as staged: the one staged here a moment ago, else the stored one.
        public func note(_ id: String, stored: String?) -> String? {
            pending[id]?.note ?? stored
        }

        /// Whether a write for `id` runs or waits.
        public func isWriting(_ id: String) -> Bool {
            running[id] != nil || queued[id] != nil
        }

        /// Stages `option` and `note` for `ref`, shown at once. `then` runs once every write of the decision landed
        /// (a send at once waits for its pick); a failed write drops it, so a send never sends what was stored before.
        public func stage(_ ref: DecisionAddress, option: String?, note: String?, then: (() -> Void)? = nil) {
            let previous = pending[ref.id]
            let version = UUID()
            pending[ref.id] = Pending(option: option ?? previous?.option, note: note ?? previous?.note, version: version,
                                      askedAt: now())
            if let then { afterWrites[ref.id, default: []].append(then) }
            write(ref.id, Write(action: .stage(ref, option: option, note: note), version: version))
        }

        /// Takes `refs` out of every send at once. A clear (`""`) is pending until a snapshot shows it.
        public func unstage(_ refs: [DecisionAddress]) {
            guard let first = refs.first else { return }
            for ref in refs {
                pending[ref.id] = Pending(option: "", note: "", version: UUID(), askedAt: now())
            }
            write(first.id, Write(action: .unstage(refs), version: nil))
        }

        /// Holds `action` for `id` until `commit` writes it or `undo` drops it; with `seconds`, it is written then by
        /// itself. Nothing reaches the log meanwhile, so Undo needs no move back.
        public func hold(_ id: String, _ action: DecisionAction, seconds: Double? = nil) {
            guard holds[id] == nil else { return }
            let clock = self.clock
            let task = seconds.map { seconds in
                Task { [weak self] in
                    do { try await clock.sleep(for: .seconds(seconds)) } catch { return }
                    self?.commit(id)
                }
            }
            holds[id] = (action, task)
            held.insert(id)
        }

        /// Writes the change held for `id` now (its Undo window ended).
        public func commit(_ id: String) {
            guard let hold = holds.removeValue(forKey: id) else { return }
            hold.task?.cancel()
            held.remove(id)
            write(id, Write(action: hold.action, version: nil))
        }

        /// Undo of a held change: nothing was written, the decision is as it was.
        public func undo(_ id: String) {
            holds.removeValue(forKey: id)?.task?.cancel()
            held.remove(id)
        }

        /// The changes still held, for a surface that must send them itself (the app quits).
        public func heldActions() -> [String: DecisionAction] {
            holds.mapValues(\.action)
        }

        /// A snapshot came: a pick it shows is confirmed and leaves `pending`; so does one that another surface wrote
        /// over after this write landed, and one no snapshot showed in time. A write still running, or one the log
        /// never answered, stays: the first ends with its write, the second waits for the user.
        public func reconcile(_ rows: [String: Row]) {
            let now = now()
            var next = pending
            for (id, entry) in pending {
                let row = rows[id]
                let confirmed = (entry.option.map { (row?.option ?? "") == $0 } ?? true)
                    && (entry.note.map { (row?.note ?? "") == $0 } ?? true)
                let overtaken = entry.doneAt.map { done in (row?.updatedAt ?? 0) / 1000 > done } ?? false
                let waiting = entry.unsaved || isWriting(id)
                let expired = entry.doneAt.map { now - $0 > Self.pendingLifetime }
                    ?? (!waiting && now - entry.askedAt > Self.unansweredLifetime)
                if confirmed || overtaken || expired { next[id] = nil }
            }
            if next != pending { pending = next }
        }

        /// Runs `write` for `id` now, or after the write running for it.
        private func write(_ id: String, _ write: Write) {
            guard running[id] == nil else {
                var next = write
                next.action = write.action.keepingPick(from: (queued[id] ?? running[id])?.action)
                queued[id] = next
                return
            }
            start(id, write, queued: false)
        }

        /// `queued`: a write that waited behind another one; it leaves the error alone, so a failure of the one
        /// before it stays readable.
        private func start(_ id: String, _ write: Write, queued: Bool) {
            running[id] = write
            writing.insert(id)
            if !queued, errors[id] != nil { errors[id] = nil }
            let log = self.log
            Task { [weak self] in
                let answer = await log.run(write.action)
                self?.finish(id, write, answer)
            }
        }

        private func finish(_ id: String, _ write: Write, _ answer: DecisionLogAnswer) {
            running[id] = nil
            writing.remove(id)
            let current = write.version.map { pending[id]?.version == $0 } ?? false
            switch answer {
            case .done:
                if current { pending[id]?.doneAt = now() }
            case .refused(let text, let detail):
                errors[id] = WriteError(text: text, detail: detail)
                afterWrites[id] = nil
                if current { pending[id] = nil }
            case .unanswered:
                if current { pending[id]?.unsaved = true }
                afterWrites[id] = nil
            }
            written?(id, write.action, answer)
            if let next = queued.removeValue(forKey: id) {
                start(id, next, queued: true)
                return
            }
            let waiting = afterWrites.removeValue(forKey: id) ?? []
            drained?(id)
            waiting.forEach { $0() }
        }
    }

    /// What a click on `letter` does with the staged `letters`: the pick it stores (`""` for none) and whether it is
    /// sent at once. ⇧ and a decision that takes any set (`multiple`) toggle the letter and never send.
    public static func clickPlan(letters: String, letter: String, shift: Bool, stages: Bool,
                                 multiple: Bool = false) -> (option: String, send: Bool) {
        if shift || multiple { return (nextPick(letters, letter, adding: true) ?? "", false) }
        return stages ? (nextPick(letters, letter, adding: false) ?? "", false) : (letter, true)
    }
}
