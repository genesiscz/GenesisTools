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
/// dropped before it is written), so it is the engine's own (`DecisionAnswering.Engine.undo`). A send is not here:
/// both surfaces already send through one request (`DecisionAnswering.sendRequest`), and `Engine.stage(then:)` makes
/// a send wait for its pick.
public enum DecisionLogAction: Equatable, Sendable {
    /// Stages a pick (the letters; `""` clears it, nil keeps the stored one) and a note (nil keeps it, `""` clears it).
    case stage(DecisionAddress, option: String?, note: String?)
    /// Takes staged decisions out of every send.
    case unstage([DecisionAddress])
    /// Drops a decision that no longer matters, without sending anything.
    case dismiss(DecisionAddress)
    /// Moves the decision log's item to `state` at the address's revision: the widget's Dismiss ("dismissed") and a
    /// task's Mark complete ("implemented"), both held for their Undo. The hub's Inbox only dismisses.
    case move(DecisionAddress, state: String)

    /// A note-only stage queued behind an earlier stage keeps that stage's letters: it replaces the queued write, and
    /// the running one may still fail. A newer pick wins, and nothing else takes letters.
    func keepingPick(from earlier: DecisionLogAction?) -> DecisionLogAction {
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

/// One surface's door to the decision log. The widget's runs the action in its own queue of hub writes
/// (`WidgetDecisionLog`); the hub's Inbox runs `tools` (`HubInboxDecisionLog`).
@MainActor
public protocol DecisionLog: AnyObject {
    func run(_ action: DecisionLogAction) async -> DecisionLogAnswer
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
        public var written: ((String, DecisionLogAction, DecisionLogAnswer) -> Void)?
        /// Called when the last queued write of a decision ended, before the work that waited for it.
        public var drained: ((String) -> Void)?
        /// The clock of `Pending.askedAt` and `doneAt`, in seconds since 1970; a test moves it.
        var now: () -> TimeInterval

        private struct Write {
            var action: DecisionLogAction
            /// The pending entry of each decision the write changes (its id to its version): a landed stage starts its
            /// confirmation clock, and a refused write takes the entries back, unless a newer change replaced them.
            var versions: [String: UUID] = [:]
            /// Work that waits for this write (a send at once waits for its pick); dropped when it fails.
            var then: [() -> Void] = []
            /// The answer to this write, for the surface that held it (`hold`) or cleared it (`unstage`).
            var ended: ((DecisionLogAnswer) -> Void)?
        }

        private let log: DecisionLog
        private let clock: any Clock<Duration>
        private var running: [String: Write] = [:]
        /// Writes waiting behind the running one, oldest first. A stage queued behind a waiting stage replaces it.
        private var queued: [String: [Write]] = [:]
        /// Work whose write landed, waiting for the decision's last write; a later failed write drops it too.
        private var afterWrites: [String: [() -> Void]] = [:]
        /// The newest change made here for each decision. It outlives the pending entry while a write of the decision
        /// runs or waits, so work that waited for a write can tell whether a newer change came meanwhile.
        private var versions: [String: UUID] = [:]
        private var holds: [String: (action: DecisionLogAction, task: Task<Void, Never>?,
                                     ended: ((DecisionLogAnswer) -> Void)?)] = [:]

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

        /// The version of the newest change made here for `id` (the one `stage` returned), while it shows as pending
        /// or a write of the decision runs. A surface compares it to tell its own change from a newer one.
        public func version(_ id: String) -> UUID? {
            versions[id]
        }

        /// Stages `option` and `note` for `ref`, shown at once, and returns the change's version. `then` runs once
        /// this write and every write of the decision before it landed (a send at once waits for its pick); a failed
        /// write drops it, so a send never sends what was stored before. Work of a write queued behind a failed one
        /// waits for its own write.
        @discardableResult
        public func stage(_ ref: DecisionAddress, option: String?, note: String?, then: (() -> Void)? = nil) -> UUID {
            let previous = pending[ref.id]
            let version = UUID()
            pending[ref.id] = Pending(option: option ?? previous?.option, note: note ?? previous?.note, version: version,
                                      askedAt: now())
            versions[ref.id] = version
            write(ref.id, Write(action: .stage(ref, option: option, note: note), versions: [ref.id: version],
                                then: then.map { [$0] } ?? []))
            return version
        }

        /// Takes `refs` out of every send at once. A clear (`""`) is pending until a snapshot shows it; a refused one
        /// shows the stored pick again. `ended` gets the log's answer.
        public func unstage(_ refs: [DecisionAddress], ended: ((DecisionLogAnswer) -> Void)? = nil) {
            guard let first = refs.first else { return }
            var cleared: [String: UUID] = [:]
            for ref in refs {
                let version = UUID()
                pending[ref.id] = Pending(option: "", note: "", version: version, askedAt: now())
                versions[ref.id] = version
                cleared[ref.id] = version
            }
            write(first.id, Write(action: .unstage(refs), versions: cleared, ended: ended))
        }

        /// The pick staged here as `version` went out with a send: it stops showing as pending. A newer one stays.
        public func forget(_ id: String, version: UUID) {
            guard versions[id] == version else { return }
            versions[id] = nil
            if pending[id] != nil { pending[id] = nil }
        }

        /// Holds `action` for `id` until `commit` writes it or `undo` drops it; with `seconds`, it is written then by
        /// itself. Nothing reaches the log meanwhile, so Undo needs no move back. `ended` gets the log's answer once
        /// the change was written.
        public func hold(_ id: String, _ action: DecisionLogAction, seconds: Double? = nil,
                         ended: ((DecisionLogAnswer) -> Void)? = nil) {
            guard holds[id] == nil else { return }
            let clock = self.clock
            let task = seconds.map { seconds in
                Task { [weak self] in
                    do { try await clock.sleep(for: .seconds(seconds)) } catch { return }
                    self?.commit(id)
                }
            }
            holds[id] = (action, task, ended)
            held.insert(id)
        }

        /// Writes the change held for `id` now (its Undo window ended). A held clear shows as cleared from now on, as
        /// `unstage` does.
        public func commit(_ id: String) {
            guard let hold = holds.removeValue(forKey: id) else { return }
            hold.task?.cancel()
            held.remove(id)
            if case .unstage(let refs) = hold.action {
                unstage(refs, ended: hold.ended)
                return
            }
            write(id, Write(action: hold.action, ended: hold.ended))
        }

        /// Undo of a held change: nothing was written, the decision is as it was.
        public func undo(_ id: String) {
            holds.removeValue(forKey: id)?.task?.cancel()
            held.remove(id)
        }

        /// The changes still held, for a surface that must send them itself (the app quits).
        public func heldActions() -> [String: DecisionLogAction] {
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
            versions = versions.filter { next[$0.key] != nil || isWriting($0.key) }
        }

        /// Runs `write` for `id` now, or after the writes running and waiting for it. A stage behind a waiting stage
        /// replaces it, since only the newest pick and note need writing; any other write keeps its place.
        private func write(_ id: String, _ write: Write) {
            guard let current = running[id] else {
                start(id, write, queued: false)
                return
            }
            var waiting = queued[id] ?? []
            var next = write
            next.action = write.action.keepingPick(from: (waiting.last ?? current).action)
            if case .stage = write.action, let last = waiting.last, case .stage = last.action {
                next.versions = last.versions.merging(write.versions) { _, newer in newer }
                next.then = last.then + write.then
                waiting[waiting.count - 1] = next
            } else {
                waiting.append(next)
            }
            queued[id] = waiting
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
            // The entries this write still owns: a newer change to a decision is its own write's.
            let current = write.versions.filter { pending[$0.key]?.version == $0.value }.map(\.key)
            switch answer {
            case .done:
                // A clear starts no clock: it waits for a snapshot, or for `unansweredLifetime`.
                if case .stage = write.action { for owned in current { pending[owned]?.doneAt = now() } }
                afterWrites[id, default: []] += write.then
            case .refused(let text, let detail):
                errors[id] = WriteError(text: text, detail: detail)
                afterWrites[id] = nil
                for owned in current { pending[owned] = nil }
            case .unanswered:
                for owned in current { pending[owned]?.unsaved = true }
                afterWrites[id] = nil
            }
            write.ended?(answer)
            written?(id, write.action, answer)
            if var waiting = queued.removeValue(forKey: id), !waiting.isEmpty {
                let next = waiting.removeFirst()
                if !waiting.isEmpty { queued[id] = waiting }
                start(id, next, queued: true)
                return
            }
            let waiting = afterWrites.removeValue(forKey: id) ?? []
            drained?(id)
            waiting.forEach { $0() }
            for owned in Set(write.versions.keys).union([id]) where pending[owned] == nil && !isWriting(owned) {
                versions[owned] = nil
            }
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
