import Foundation

/// Follows the open transcript with ONE `tools ai sessions tail <query> --live --offset <n>` process
/// for as long as the detail shows it (src/utils/ai/transcripts/live.ts). Each stdout line is a turn
/// with its session-wide `index`, sent again whenever it changes, or a `totals` line after a change;
/// the lines of one chunk arrive together as a `Batch`. No timer and no file watcher here: the child
/// watches the file, and a process per growth (about 150 ms each, most of them finding nothing) is gone.
///
/// An exit we did not ask for starts the follow once more from the last turn it saw; a second one
/// stays down and is logged with its stderr.
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
    private var offset: Int
    private var restarted = false
    private var stopped = false

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
    }

    private func start() {
        let args = ["sessions", "tail", query, "--live", "--offset", String(max(0, offset))]
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
        let stderr = exit.stderr.trimmingCharacters(in: .whitespacesAndNewlines).suffix(600)
        HubPerf.log("transcript.follow exited \(exit.status) \(query.suffix(24)): \(stderr.isEmpty ? "(no stderr)" : String(stderr))")
        stream = nil
        guard !restarted else { return }
        restarted = true
        start()
    }
}
