import Foundation

/// The transcript's "N files changed" rows: every tool row that asks within 100 ms of the first shares
/// one `tools agents changes <session> --tools a,b,c --json` run, one run at a time.
///
/// `CLIToolChangeSource` starts one `tools agents changes --tool` process per row, and each process reads
/// the whole session (0.25 s for a 16 MB session, 0.7 s for 136 MB). Opening a transcript started 44 of
/// them, 11 at once, 13.6 CPU seconds (GenesisTools, measured 2026-09-24). A row that leaves the screen
/// before its batch starts is dropped from the queue; an answer is kept for the life of the source (one per
/// open session), so scrolling back asks nothing.
public final class BatchedToolChangeSource: ToolChangeSource, @unchecked Sendable {
    /// Called when a batch run starts with its call count; the returned closure ends it with a note
    /// ("3 files", "failed"). GenesisTools passes its hub span; nil writes a `toolChanges.batch` span.
    public typealias Trace = @Sendable (_ calls: Int) -> @Sendable (_ note: String) -> Void

    private let cli: CLIToolChangeSource
    private let batcher: ToolChangeBatcher
    private let binary: String?
    private let unstored = UnstoredBlobs()

    /// `server`: the resident `tools` server, asked first. It keeps the session's transcript folded between asks, so a
    /// batch costs ~0.2 s instead of a process reading the whole session (~1.5 s CPU on a 223 MB session, 2026-10-08).
    /// A server answer carries every diff but writes no blobs (a server door never writes): the first "more context"
    /// on such a file stores its call's blobs with one process run, then reads them.
    public init(toolsBinary: String?, server: ToolsServerClient? = nil, trace: Trace? = nil) {
        let cli = CLIToolChangeSource(toolsBinary: toolsBinary)
        self.cli = cli
        let binary = cli.binaryPath
        self.binary = binary
        let trace = trace ?? Self.defaultTrace
        let unstored = unstored
        batcher = ToolChangeBatcher { sessionId, toolIds in
            guard let binary else { return nil }
            return await Self.fetch(
                binary: binary, sessionId: sessionId, toolIds: toolIds, cli: cli, server: server, unstored: unstored, trace: trace
            )
        }
    }

    public func changes(sessionId: String, toolUseId: String) async -> [ToolFileChange] {
        await batcher.request(sessionId: sessionId, toolUseId: toolUseId)
    }

    public func expandedDiff(for change: ToolFileChange, context: Int) async -> String? {
        if let diff = await cli.expandedDiff(for: change, context: context) {
            return diff
        }

        guard let binary, let owner = unstored.take(change) else { return nil }
        let argv = ["agents", "changes", owner.sessionId, "--tool", owner.toolUseId, "--json", "--store-blobs"]
        guard await CLIToolChangeSource.run(binary, argv, timeout: 30) != nil else { return nil }
        return await cli.expandedDiff(for: change, context: context)
    }

    /// Runs started so far, for tests and benches.
    public var runs: Int {
        get async { await batcher.runs }
    }

    private static let defaultTrace: Trace = { calls in
        let start = CFAbsoluteTimeGetCurrent()
        return { note in
            let ms = (CFAbsoluteTimeGetCurrent() - start) * 1000
            PerfLog.mark(String(format: "toolChanges.batch %.1fms: %d calls, %@", ms, calls, note))
        }
    }

    /// One run for several calls; nil when it failed (nothing is cached then, a later row asks again).
    private static func fetch(
        binary: String, sessionId: String, toolIds: [String], cli: CLIToolChangeSource, server: ToolsServerClient?,
        unstored: UnstoredBlobs, trace: Trace
    ) async -> [String: [ToolFileChange]]? {
        let end = trace(toolIds.count)
        let ask = ["agents", "changes", sessionId, "--tools", toolIds.joined(separator: ","), "--json"]
        var output: String?
        var fromServer = false
        if let answer = await server?.call(argv: ask, timeoutSeconds: 30), answer.exitCode == 0 {
            output = answer.stdout
            fromServer = true
        } else if !Task.isCancelled {
            // `--store-blobs`: `expandedDiff` reads the blobs from the object store, and `changes` writes them only
            // when asked.
            output = await CLIToolChangeSource.run(binary, ask + ["--store-blobs"], timeout: 30)
        }
        guard let output else {
            end("failed")
            return nil
        }

        var result = decode(output)
        if fromServer {
            for (tool, files) in result {
                unstored.add(files, sessionId: sessionId, toolUseId: tool)
            }
        }
        for (tool, files) in result {
            var filled = files
            // The same fill `CLIToolChangeSource` does: a file with blobs but no diff text gets one.
            for index in filled.indices where filled[index].unifiedDiff == nil && filled[index].skipReason == nil {
                filled[index].unifiedDiff = await cli.expandedDiff(for: filled[index], context: 3)
            }
            result[tool] = filled
        }
        end("\(result.values.reduce(0) { $0 + $1.count }) files")
        return result
    }

    /// `{ tools: [{ toolUseId, files }] }`: each entry's files through `CLIToolChangeSource.decode`, so
    /// both sources read a file the same way.
    public static func decode(_ text: String) -> [String: [ToolFileChange]] {
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

/// The queue behind `BatchedToolChangeSource`: callers wait on a key (session and tool call), keys are
/// sent in batches of at most `maxBatch`, one batch at a time, and a caller whose task is cancelled
/// (its row scrolled away) stops waiting; a key nobody waits for any more is not sent.
public actor ToolChangeBatcher {
    public typealias Fetch = @Sendable (_ sessionId: String, _ toolIds: [String]) async -> [String: [ToolFileChange]]?

    public static let maxBatch = 40
    /// How long the first request waits for the rows that appear with it.
    public static let gather: Duration = .milliseconds(100)

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
    public private(set) var runs = 0

    public init(fetch: @escaping Fetch) {
        self.fetch = fetch
    }

    public func request(sessionId: String, toolUseId: String) async -> [ToolFileChange] {
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

/// Blobs of answers the server gave (it stores none), by object id: whose call stores them when a diff needs them.
final class UnstoredBlobs: @unchecked Sendable {
    struct Owner: Equatable {
        let sessionId: String
        let toolUseId: String
    }

    private let lock = NSLock()
    private var owners: [String: Owner] = [:]

    func add(_ files: [ToolFileChange], sessionId: String, toolUseId: String) {
        let owner = Owner(sessionId: sessionId, toolUseId: toolUseId)
        lock.withLock {
            for file in files {
                for oid in [file.beforeBlob, file.afterBlob].compactMap({ $0 }) {
                    owners[oid] = owner
                }
            }
        }
    }

    /// The call whose run stores this file's blobs; nil when they are stored already (or were asked once).
    func take(_ change: ToolFileChange) -> Owner? {
        lock.withLock {
            let owner = [change.afterBlob, change.beforeBlob].compactMap { $0 }.lazy.compactMap { self.owners[$0] }.first
            guard let owner else { return nil }
            owners = owners.filter { $0.value != owner }
            return owner
        }
    }
}
