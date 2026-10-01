import Foundation

/// Follows the open transcript with ONE `tools ai sessions tail <query> --live --offset <n>` process
/// for as long as the detail shows it (src/utils/ai/transcripts/live.ts). Each stdout line is a turn
/// with its session-wide `index`, sent again whenever it changes, or a `totals` line after a change;
/// the lines of one chunk arrive together as a `Batch`. No timer and no file watcher here: the child
/// watches the file, and a process per growth (about 150 ms each, most of them finding nothing) is gone.
///
/// The follow runs inside the resident hub server when one answers (`HubSource.server`, src/hub/server): no
/// process at all. Otherwise, or when the server refuses it, it is the `tools` process as before.
///
/// An exit we did not ask for starts the follow once more from the last turn it saw; a second one
/// stays down and is logged with its stderr. A server that goes away (a restart after a code change, a
/// memory cap, a dropped connection) does not spend that retry: the follow starts again at once, through
/// the new server or a process.
@MainActor
final class HubTranscriptTail {
    struct Totals: Decodable, Equatable {
        var modelCalls: Int?
        var inputTokens: Int?
        var cacheReadTokens: Int?
        var outputTokens: Int?
        var reasoningTokens: Int?
        var costUsd: Double?
        var terminated: String?
        var nextOffset: Int
        var turnCount: Int?

        var transcriptTotals: TranscriptTotals {
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

    /// Turns carry their `index`; `totals` is the last totals line of the chunk, if any.
    struct Batch {
        var turns: [TranscriptTurn] = []
        var totals: Totals?
    }

    private let query: String
    private let onBatch: (Batch) -> Void
    private var stream: ToolsLineStream?
    private var subscription: ToolsServerClient.Subscription?
    private var offset: Int
    private var restarted = false
    private var serverRestarts = 0
    /// Subscribes the old server refused while it drained after a restart (see `serverEnded`).
    private var drainingRetries = 0
    private var stopped = false
    /// The server follow in flight, for its one app-perf.log line (ToolsCallTrace) when it ends.
    private var serverTrace: (id: String, argv: [String], started: Date, bytes: Int)?

    init(query: String, offset: Int, onBatch: @escaping (Batch) -> Void) {
        self.query = query
        self.offset = offset
        self.onBatch = onBatch
        start()
    }

    func stop() {
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
        ["sessions", "tail", query, "--live", "--offset", String(max(0, offset))]
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
        guard let server = HubSource.server,
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
        HubPerf.log("transcript.follow started via server \(query.suffix(24)) offset=\(offset)")
        return true
    }

    /// After a server restart the new one is a second or so away (the hub starts it on its next call). Try
    /// again every 500 ms for 5 s before the follow falls back to a process for the rest of this detail.
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
        HubPerf.log("transcript.follow server ended (\(end.reason)) \(query.suffix(24)) offset=\(offset)")
        switch end.reason {
        case "restart", "disconnected":
            // A server going away is not this follow's failure; three in one detail means stay on a process.
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
                bridge: HubSource.bridge,
                subcommand: "ai",
                args: args,
                onLines: { [weak self] lines in self?.receive(lines) },
                onExit: { [weak self] exit in self?.exited(exit) }
            )
            self.stream = stream
            HubPerf.log("transcript.follow started pid=\(stream.processIdentifier) \(query.suffix(24)) offset=\(offset)")
        } catch {
            HubPerf.log("transcript.follow cannot start: \(error.localizedDescription)")
        }
    }

    private func receive(_ lines: [String]) {
        guard !stopped else { return }
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

            do {
                let turn = try decoder.decode(TranscriptTurn.self, from: data)
                batch.turns.append(turn)
                if let index = turn.index {
                    offset = max(offset, index)
                }
            } catch {
                HubPerf.log("transcript.follow unreadable line (\(line.count) chars): \(error.localizedDescription)")
            }
        }
        guard !batch.turns.isEmpty || batch.totals != nil else { return }
        onBatch(batch)
    }

    private func exited(_ exit: ToolsLineStream.Exit) {
        guard !stopped, !exit.stopped else { return }
        ended(status: exit.status, stderr: exit.stderr)
    }

    private func ended(status: Int32, stderr rawStderr: String) {
        let stderr = rawStderr.trimmingCharacters(in: .whitespacesAndNewlines).suffix(600)
        HubPerf.log("transcript.follow exited \(status) \(query.suffix(24)): \(stderr.isEmpty ? "(no stderr)" : String(stderr))")
        stream = nil
        guard !restarted else { return }
        restarted = true
        start()
    }
}
