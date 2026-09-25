import Foundation

/// The transcript's "N files changed" rows for the hub: every tool row that asks within 100 ms of the
/// first shares one `tools agents changes <session> --tools a,b,c --json` run, one run at a time.
///
/// The stolen `CLIToolChangeSource` starts one `tools agents changes --tool` process per row, and
/// each process reads the whole session (0.25 s for a 16 MB session, 0.7 s for 136 MB). Opening a
/// transcript started 44 of them, 11 at once, 13.6 CPU seconds (measured 2026-09-24). A row that
/// leaves the screen before its batch starts is dropped from the queue; an answer is kept for the
/// life of the source (one per open session), so scrolling back asks nothing.
final class HubToolChangeSource: ToolChangeSource, @unchecked Sendable {
    private let cli: CLIToolChangeSource
    private let batcher: ToolChangeBatcher

    init(toolsBinary: String) {
        let cli = CLIToolChangeSource(toolsBinary: toolsBinary)
        self.cli = cli
        batcher = ToolChangeBatcher { sessionId, toolIds in
            await Self.fetch(binary: toolsBinary, sessionId: sessionId, toolIds: toolIds, cli: cli)
        }
    }

    func changes(sessionId: String, toolUseId: String) async -> [ToolFileChange] {
        await batcher.request(sessionId: sessionId, toolUseId: toolUseId)
    }

    func expandedDiff(for change: ToolFileChange, context: Int) async -> String? {
        await cli.expandedDiff(for: change, context: context)
    }

    /// One run for several calls; nil when it failed (nothing is cached then, a later row asks again).
    private static func fetch(binary: String, sessionId: String, toolIds: [String], cli: CLIToolChangeSource) async -> [String: [ToolFileChange]]? {
        let span = HubPerf.begin("toolChanges.batch", "\(toolIds.count) calls", awaits: true)
        // `--store-blobs`: `expandedDiff` below reads the blobs from the object store, and `changes`
        // writes them only when asked.
        let output = await CLIToolChangeSource.run(binary, ["agents", "changes", sessionId, "--tools", toolIds.joined(separator: ","), "--json", "--store-blobs"], timeout: 30)
        guard let output else {
            span.end("failed")
            return nil
        }

        var result = decode(output)
        for (tool, files) in result {
            var filled = files
            // The same fill the stolen source does: a file with blobs but no diff text gets one.
            for index in filled.indices where filled[index].unifiedDiff == nil && filled[index].skipReason == nil {
                filled[index].unifiedDiff = await cli.expandedDiff(for: filled[index], context: 3)
            }
            result[tool] = filled
        }
        span.end("\(result.values.reduce(0) { $0 + $1.count }) files")
        return result
    }

    /// `{ tools: [{ toolUseId, files }] }`: each entry's files through the stolen decoder, so both
    /// sources read a file the same way.
    static func decode(_ text: String) -> [String: [ToolFileChange]] {
        guard let start = text.firstIndex(of: "{"),
              let object = try? JSONSerialization.jsonObject(with: Data(text[start...].utf8)) as? [String: Any],
              let tools = object["tools"] as? [[String: Any]]
        else { return [:] }
        var result: [String: [ToolFileChange]] = [:]
        for entry in tools {
            guard let tool = entry["toolUseId"] as? String,
                  let data = try? JSONSerialization.data(withJSONObject: ["files": entry["files"] ?? []])
            else { continue }
            result[tool] = CLIToolChangeSource.decode(String(decoding: data, as: UTF8.self))
        }
        return result
    }
}

/// The queue behind `HubToolChangeSource`: callers wait on a key (session and tool call), keys are
/// sent in batches of at most `maxBatch`, one batch at a time, and a caller whose task is cancelled
/// (its row scrolled away) stops waiting; a key nobody waits for any more is not sent.
actor ToolChangeBatcher {
    typealias Fetch = @Sendable (_ sessionId: String, _ toolIds: [String]) async -> [String: [ToolFileChange]]?

    static let maxBatch = 40
    /// How long the first request waits for the rows that appear with it.
    static let gather: Duration = .milliseconds(100)

    private struct Key: Hashable {
        let sessionId: String
        let toolUseId: String
    }

    private let fetch: Fetch
    private var cache: [Key: [ToolFileChange]] = [:]
    private var waiters: [Key: [UUID: CheckedContinuation<[ToolFileChange], Never>]] = [:]
    private var queue: [Key] = []
    private var inFlight = Set<Key>()
    private var cancelledEarly = Set<UUID>()
    private var draining = false
    /// Runs started, for tests and the log.
    private(set) var runs = 0

    init(fetch: @escaping Fetch) {
        self.fetch = fetch
    }

    func request(sessionId: String, toolUseId: String) async -> [ToolFileChange] {
        let key = Key(sessionId: sessionId, toolUseId: toolUseId)
        if let cached = cache[key] {
            return cached
        }

        let token = UUID()
        return await withTaskCancellationHandler {
            await withCheckedContinuation { continuation in
                enqueue(key, token: token, continuation: continuation)
            }
        } onCancel: {
            Task { await self.cancel(key, token: token) }
        }
    }

    private func enqueue(_ key: Key, token: UUID, continuation: CheckedContinuation<[ToolFileChange], Never>) {
        if cancelledEarly.remove(token) != nil {
            continuation.resume(returning: [])
            return
        }

        waiters[key, default: [:]][token] = continuation
        if !inFlight.contains(key), !queue.contains(key) {
            queue.append(key)
        }

        if !draining {
            draining = true
            Task { await drain() }
        }
    }

    private func cancel(_ key: Key, token: UUID) {
        guard let continuation = waiters[key]?.removeValue(forKey: token) else {
            // The cancellation won the race with `enqueue`: answer that one at once when it arrives.
            cancelledEarly.insert(token)
            return
        }

        continuation.resume(returning: [])
        if waiters[key]?.isEmpty == true {
            waiters[key] = nil
        }
    }

    private func drain() async {
        try? await Task.sleep(for: Self.gather)
        while true {
            queue.removeAll { waiters[$0] == nil }
            guard let first = queue.first else { break }
            let batch = Array(queue.filter { $0.sessionId == first.sessionId }.prefix(Self.maxBatch))
            queue.removeAll { batch.contains($0) }
            inFlight.formUnion(batch)
            runs += 1
            let found = await fetch(first.sessionId, batch.map(\.toolUseId))
            inFlight.subtract(batch)
            for key in batch {
                // The CLI answers every call it was asked, with `files: []` for no change, so a call
                // missing from the answer (cut or unreadable output) is a failure and is not kept.
                let files = found?[key.toolUseId]
                if let files {
                    cache[key] = files
                }
                for continuation in (waiters.removeValue(forKey: key) ?? [:]).values {
                    continuation.resume(returning: files ?? [])
                }
            }
        }
        draining = false
    }
}
