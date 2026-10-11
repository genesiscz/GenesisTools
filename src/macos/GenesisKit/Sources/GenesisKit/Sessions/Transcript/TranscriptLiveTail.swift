import Foundation

/// Follows an open transcript with ONE `tools ai sessions tail <query> --live --offset <n>` process for as
/// long as the screen shows it (src/utils/ai/transcripts/live.ts). Each stdout line is a turn with its
/// session-wide `index`, sent again whenever it changes, or a `totals` line after a change; the lines of
/// one chunk arrive together as a `Batch`. No timer and no file watcher here: the child watches the file,
/// and a process per growth (about 150 ms each, most of them finding nothing) is gone.
///
/// With a `server` (GenesisTools' resident `tools hub serve`) the follow runs inside it: no process at
/// all. Otherwise, or when the server refuses it, it is the `tools` process.
///
/// An exit we did not ask for starts the follow once more from the last turn it saw; a second one stays
/// down and is logged with its stderr. A server that goes away (a restart after a code change, a memory
/// cap, a dropped connection) does not spend that retry: the follow starts again at once, through the new
/// server or a process.
@MainActor
public final class TranscriptLiveTail {
    public struct Totals: Decodable, Equatable, Sendable {
        public var modelCalls: Int?
        public var inputTokens: Int?
        public var cacheReadTokens: Int?
        public var outputTokens: Int?
        public var reasoningTokens: Int?
        public var costUsd: Double?
        public var terminated: String?
        public var nextOffset: Int
        public var turnCount: Int?

        public var transcriptTotals: TranscriptTotals {
            TranscriptTotals(
                modelCalls: modelCalls,
                inputTokens: inputTokens,
                cacheReadTokens: cacheReadTokens,
                outputTokens: outputTokens,
                reasoningTokens: reasoningTokens,
                costUsd: costUsd
            )
        }
    }

    /// Turns carry their `index`; `totals` is the last totals line of the chunk, if any; `activity` the last
    /// activity line (sent only when the agent's activity changed).
    public struct Batch: Sendable {
        public var turns: [TranscriptTurn] = []
        public var totals: Totals?
        public var activity: TranscriptLiveActivity?

        public init(turns: [TranscriptTurn] = [], totals: Totals? = nil, activity: TranscriptLiveActivity? = nil) {
            self.turns = turns
            self.totals = totals
            self.activity = activity
        }
    }

    private let query: String
    private let provider: String?
    private let bridge: ToolsBridge
    private let server: ToolsServerClient?
    private let log: (String) -> Void
    private let onBatch: (Batch) -> Void
    private var stream: ToolsLineStream?
    private var subscription: ToolsServerClient.Subscription?
    private var offset: Int
    private var restarted = false
    private var serverRestarts = 0
    /// Subscribes the old server refused while it drained after a restart (see `serverEnded`).
    private var drainingRetries = 0
    private var stopped = false
    /// The server follow in flight, for its one perf line (ToolsCallTrace) when it ends.
    private var serverTrace: (id: String, argv: [String], started: Date, bytes: Int)?

    /// `query`: a session id, a worker name or an absolute transcript path (`provider` names the provider
    /// of a path outside the known roots). `log` gets the `transcript.follow …` lines; nil writes them to
    /// the perf file as they are.
    public init(
        query: String,
        offset: Int,
        provider: String? = nil,
        bridge: ToolsBridge,
        server: ToolsServerClient? = nil,
        log: ((String) -> Void)? = nil,
        onBatch: @escaping (Batch) -> Void
    ) {
        self.query = query
        self.offset = offset
        self.provider = provider
        self.bridge = bridge
        self.server = server
        self.log = log ?? { PerfLog.mark($0) }
        self.onBatch = onBatch
        start()
    }

    public func stop() {
        stopped = true
        stream?.stop()
        stream = nil
        subscription?.stop()
        subscription = nil
        recordServerFollow(exit: 0, stderr: "", reason: "stopped")
    }

    private func recordServerFollow(exit: Int32, stderr: String, reason: String) {
        guard let trace = serverTrace else { return }
        serverTrace = nil
        ToolsCallTrace.record(
            traceId: trace.id, via: "server-follow(\(reason))", argv: trace.argv, started: trace.started,
            exit: exit, outBytes: trace.bytes, stderr: stderr
        )
    }

    private var args: [String] {
        var args = ["sessions", "tail", query, "--live", "--offset", String(max(0, offset))]
        if let provider {
            args += ["--provider", provider]
        }
        return args
    }

    private func start() {
        if subscribe() {
            return
        }

        startProcess()
    }

    private func subscribe() -> Bool {
        let argv = ["ai"] + args
        let traceId = ToolsCallTrace.newId()
        guard let server,
              let subscription = server.subscribe(
                  argv: argv,
                  traceId: traceId,
                  onLines: { [weak self] lines in
                      self?.serverTrace?.bytes += lines.reduce(0) { $0 + $1.utf8.count + 1 }
                      self?.receive(lines)
                  },
                  onEnd: { [weak self] end in self?.serverEnded(end) }
              )
        else { return false }

        self.subscription = subscription
        serverTrace = (traceId, argv, Date(), 0)
        log("transcript.follow started via server \(query.suffix(24)) offset=\(offset)")
        return true
    }

    /// After a server restart the new one is a second or so away (the hub starts it on its next call). Try
    /// again every 500 ms for 5 s before the follow falls back to a process for the rest of this screen.
    private func resubscribe(attempt: Int = 0) {
        guard !stopped else { return }
        if subscribe() {
            return
        }

        guard attempt < 10 else {
            startProcess()
            return
        }

        Task { @MainActor [weak self] in
            try? await Task.sleep(nanoseconds: 500_000_000)
            self?.resubscribe(attempt: attempt + 1)
        }
    }

    private func serverEnded(_ end: ToolsServerClient.End) {
        subscription = nil
        recordServerFollow(exit: end.exit, stderr: end.stderr, reason: end.reason)
        guard !stopped, end.reason != "cancelled" else { return }
        log("transcript.follow server ended (\(end.reason)) \(query.suffix(24)) offset=\(offset)")
        switch end.reason {
        case "restart", "disconnected":
            // A server going away is not this follow's failure; three in one screen means stay on a process.
            serverRestarts += 1
            if serverRestarts <= 3 {
                resubscribe()
            } else {
                startProcess()
            }
        case "draining" where serverRestarts > 0 && drainingRetries < 10:
            // Right after a restart the old server still holds the connection while it drains, and it
            // refuses the new subscribe. The successor is a moment away: ask again, not a process.
            drainingRetries += 1
            Task { @MainActor [weak self] in
                try? await Task.sleep(nanoseconds: 500_000_000)
                self?.resubscribe(attempt: 1)
            }
        case "unsupported", "draining":
            startProcess()
        default:
            ended(status: end.exit, stderr: end.stderr)
        }
    }

    private func startProcess() {
        do {
            let stream = try ToolsLineStream(
                bridge: bridge,
                subcommand: "ai",
                args: args,
                onLines: { [weak self] lines in self?.receive(lines) },
                onExit: { [weak self] exit in self?.exited(exit) }
            )
            self.stream = stream
            log("transcript.follow started pid=\(stream.processIdentifier) \(query.suffix(24)) offset=\(offset)")
        } catch {
            log("transcript.follow cannot start: \(error.localizedDescription)")
        }
    }

    private func receive(_ lines: [String]) {
        guard !stopped else { return }
        let batch = Self.batch(of: lines, log: log)
        for turn in batch.turns {
            if let index = turn.index {
                offset = max(offset, index)
            }
        }
        guard !batch.turns.isEmpty || batch.totals != nil || batch.activity != nil else { return }
        onBatch(batch)
    }

    /// The lines of one chunk as a batch: turns in order, the last totals line, the last activity line.
    nonisolated public static func batch(of lines: [String], log: (String) -> Void = { _ in }) -> Batch {
        let decoder = JSONDecoder()
        var batch = Batch()
        for line in lines {
            let data = Data(line.utf8)
            if line.hasPrefix("{\"kind\":\"totals\"") {
                if let totals = try? decoder.decode(Totals.self, from: data) {
                    batch.totals = totals
                }
                continue
            }

            if line.hasPrefix("{\"kind\":\"activity\"") {
                do {
                    batch.activity = try decoder.decode(TranscriptLiveActivity.self, from: data)
                } catch {
                    log("transcript.follow unreadable activity line: \(error.localizedDescription)")
                }
                continue
            }

            do {
                batch.turns.append(try decoder.decode(TranscriptTurn.self, from: data))
            } catch {
                log("transcript.follow unreadable line (\(line.count) chars): \(error.localizedDescription)")
            }
        }
        return batch
    }

    private func exited(_ exit: ToolsLineStream.Exit) {
        guard !stopped, !exit.stopped else { return }
        ended(status: exit.status, stderr: exit.stderr)
    }

    private func ended(status: Int32, stderr rawStderr: String) {
        let stderr = rawStderr.trimmingCharacters(in: .whitespacesAndNewlines).suffix(600)
        log("transcript.follow exited \(status) \(query.suffix(24)): \(stderr.isEmpty ? "(no stderr)" : String(stderr))")
        stream = nil
        guard !restarted else { return }
        restarted = true
        start()
    }
}

/// What the followed agent does now: the follow's `activity` line (src/utils/ai/transcripts/turn-state.ts,
/// `LiveActivity`). A transcript gets a record only when a message or a tool result is complete, so without it a
/// working agent looks idle until its rows land at once.
public struct TranscriptLiveActivity: Decodable, Equatable, Sendable {
    public enum Phase: String, Sendable {
        /// A turn runs and no tool call is open: the model thinks or writes.
        case thinking
        /// A tool call has no result yet.
        case tool
        /// A question or a plan waits for the user.
        case waiting
        /// The turn ended.
        case idle
        /// The user stopped the turn.
        case interrupted
    }

    public struct Tool: Decodable, Equatable, Sendable {
        public var id: String
        public var name: String
        /// One line: a Bash description, else the command, path, pattern or query.
        public var summary: String
        /// Epoch ms.
        public var startedAt: Double?

        public init(id: String, name: String, summary: String, startedAt: Double? = nil) {
            self.id = id
            self.name = name
            self.summary = summary
            self.startedAt = startedAt
        }
    }

    public var phase: Phase
    /// Epoch ms the phase began: the open call's start, else the newest turn record.
    public var since: Double?
    /// Epoch ms the turn's prompt arrived.
    public var turnStartedAt: Double?
    /// The oldest open call, or the question tool a waiting turn sits on.
    public var tool: Tool?
    /// Calls open at once.
    public var openTools: Int
    public var question: String?
    /// No transcript write for ten minutes while the turn runs: the agent may be gone.
    public var stalled: Bool
    public var lastEventAt: Double?

    public init(
        phase: Phase,
        since: Double? = nil,
        turnStartedAt: Double? = nil,
        tool: Tool? = nil,
        openTools: Int = 0,
        question: String? = nil,
        stalled: Bool = false,
        lastEventAt: Double? = nil
    ) {
        self.phase = phase
        self.since = since
        self.turnStartedAt = turnStartedAt
        self.tool = tool
        self.openTools = openTools
        self.question = question
        self.stalled = stalled
        self.lastEventAt = lastEventAt
    }

    private enum CodingKeys: String, CodingKey {
        case phase, since, turnStartedAt, tool, openTools, question, stalled, lastEventAt
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        // A phase a newer CLI adds reads as idle: no activity row rather than a dropped line.
        phase = Phase(rawValue: try container.decode(String.self, forKey: .phase)) ?? .idle
        since = try container.decodeIfPresent(Double.self, forKey: .since)
        turnStartedAt = try container.decodeIfPresent(Double.self, forKey: .turnStartedAt)
        tool = try container.decodeIfPresent(Tool.self, forKey: .tool)
        openTools = try container.decodeIfPresent(Int.self, forKey: .openTools) ?? 0
        question = try container.decodeIfPresent(String.self, forKey: .question)
        stalled = try container.decodeIfPresent(Bool.self, forKey: .stalled) ?? false
        lastEventAt = try container.decodeIfPresent(Double.self, forKey: .lastEventAt)
    }

    /// The model thinks or a tool runs. A think with no write for ten minutes is not work any more: a tool may run
    /// that long, a model call does not.
    public var isWorking: Bool { phase == .tool || (phase == .thinking && !stalled) }

    /// What the session header shows of the activity. Coarse on purpose: thinking and a running tool read the same
    /// there, so the many changes of one turn redraw the activity row and not the screen around it.
    public enum HeaderState: Equatable, Sendable {
        case working
        /// A turn that has written nothing for ten minutes with no tool running.
        case stalled
        case waiting(plan: Bool)
        case idle
        case interrupted
    }

    public var headerState: HeaderState {
        switch phase {
        case .thinking: return stalled ? .stalled : .working
        case .tool: return .working
        case .waiting: return .waiting(plan: tool?.name == "ExitPlanMode")
        case .idle: return .idle
        case .interrupted: return .interrupted
        }
    }

    /// The session header's status, so it never says Idle while the activity row says the agent works.
    public struct Status: Equatable, Sendable {
        public var liveness: SessionLiveness
        /// Replaces the liveness label ("Waiting"); nil keeps it.
        public var label: String?
        /// The status tooltip; nil keeps the host's own note for the liveness.
        public var note: String?
    }

    /// `fallback` is the guess from the last write's age (`SessionLiveness.resolve`). A finished turn keeps an
    /// ended session ended; everything else follows the activity.
    public static func status(_ state: HeaderState, over fallback: SessionLiveness) -> Status {
        let rest: SessionLiveness = fallback == .ended ? .ended : .idle
        switch state {
        case .working:
            return Status(liveness: .running, note: "The agent is working on its turn")
        case .stalled:
            return Status(liveness: .idle, label: "Stalled", note: "No transcript write for over 10 minutes and no tool running: the agent may be gone")
        case .waiting(let plan):
            return Status(liveness: .idle, label: "Waiting", note: plan ? "Waiting for plan approval" : "Waiting for your answer")
        case .idle:
            return Status(liveness: rest)
        case .interrupted:
            return Status(liveness: rest, note: rest == .idle ? "The user stopped the turn" : nil)
        }
    }

    /// The row at the end of the transcript, or nil when the agent does not work on a turn (idle, interrupted).
    /// `finishedTools`: calls of this turn that already have their result.
    public func row(finishedTools: Int, now: Date = Date()) -> TranscriptActivity? {
        func date(_ ms: Double?) -> Date? { ms.map { Date(timeIntervalSince1970: $0 / 1000) } }
        let start = date(since) ?? date(turnStartedAt) ?? date(lastEventAt) ?? now
        switch phase {
        case .thinking:
            // Ten silent minutes after a result or a prompt is no longer a think: the time says since when.
            return TranscriptActivity(startedAt: start, label: stalled ? "No output" : "Thinking…", finishedTools: finishedTools, tone: stalled ? .stalled : .working)
        case .tool:
            let name = tool?.name ?? "tool"
            let detail = tool.map { TranscriptDocument.keyArgument($0.summary, kind: TranscriptToolKind.of($0.name)) }
            return TranscriptActivity(
                startedAt: start,
                label: "Running \(TranscriptDocument.displayName(name))",
                detail: detail,
                finishedTools: finishedTools,
                tone: stalled ? .stalled : .working,
                moreRunning: max(0, openTools - 1)
            )
        case .waiting:
            let plan = tool?.name == "ExitPlanMode"
            return TranscriptActivity(
                startedAt: start,
                label: plan ? "Waiting for plan approval" : "Waiting for your answer",
                detail: plan ? nil : question,
                finishedTools: finishedTools,
                tone: .waiting
            )
        case .idle, .interrupted:
            return nil
        }
    }
}

/// The live activity row's content, kept apart from the transcript list: what the agent does changes several times
/// per tool call, and each change redraws this one row only. Passed as a value (in the document or as a list input),
/// every change re-ran the list's body and SwiftUI walked every row again: 87 to 372 ms of main thread per second at
/// two changes a second in `testActivityCost`, against 18 ms through the feed (2026-10-11, debug build, load 30-48).
/// The list shows the row while a host passes the feed; the host passes it only while `row` is non-nil, so the row
/// appears and goes once per turn.
@MainActor
public final class TranscriptActivityFeed: ObservableObject {
    /// The row the list draws. Published only when it changes.
    @Published public private(set) var row: TranscriptActivity?
    /// The follow's last activity line.
    public private(set) var live: TranscriptLiveActivity?
    private var received = Date()
    private var finishedTools = 0

    public init() {}

    /// A new activity line, with the calls the turn already finished. True when the line differs from the last.
    @discardableResult
    public func receive(_ live: TranscriptLiveActivity?, finishedTools: Int, now: Date = Date()) -> Bool {
        guard live != self.live else {
            refresh(finishedTools: finishedTools)
            return false
        }
        self.live = live
        received = now
        self.finishedTools = finishedTools
        publish()
        return true
    }

    /// The turn's finished calls changed (a rebuilt document): the row's "N done".
    public func refresh(finishedTools: Int) {
        guard finishedTools != self.finishedTools else { return }
        self.finishedTools = finishedTools
        publish()
    }

    private func publish() {
        let next = live?.row(finishedTools: finishedTools, now: received)
        if next != row {
            row = next
        }
    }
}
