import Foundation

@MainActor
public final class SessionTranscriptCache {
    public struct Query: Hashable, Sendable {
        public let identity: String
        public let query: String
        public let provider: String
        public let limit: Int

        public init(identity: String, query: String, provider: String, limit: Int = 30) {
            self.identity = identity
            self.query = query
            self.provider = provider
            self.limit = min(80, max(1, limit))
        }
    }

    private struct Entry {
        var envelope: TranscriptEnvelope
        var loadedAt: Date
        var usedAt: UInt64
    }
    private struct Pending: Sendable {
        let id: UUID
        let query: Query
        let task: Task<TranscriptEnvelope, Error>
    }
    private var entries: [Query: Entry] = [:]
    private var accessOrder: UInt64 = 0
    private var pending: Pending?
    private let capacity: Int
    private let lifetime: TimeInterval
    private let now: () -> Date
    private let load: @Sendable (Query) async throws -> TranscriptEnvelope

    public init(capacity: Int = 3, lifetime: TimeInterval = 15, now: @escaping () -> Date = Date.init,
                load: @escaping @Sendable (Query) async throws -> TranscriptEnvelope) {
        self.capacity = max(1, capacity)
        self.lifetime = max(0, lifetime)
        self.now = now
        self.load = load
    }

    public convenience init(bridge: ToolsBridge) {
        self.init { query in
            let result = try await bridge.run(subcommand: "ai",
                args: SessionTranscriptClient.arguments(sessionId: query.query, limit: query.limit)
                    + ["--provider", query.provider], timeoutSeconds: 30)
            try Task.checkCancellation()
            guard result.exitCode == 0 else { throw ToolsBridgeError.refused(result.stderr) }
            return try SessionTranscriptClient.decode(Data(result.stdout.utf8))
        }
    }

    deinit { pending?.task.cancel() }

    public func prefetch(_ query: Query) {
        guard cached(query) == nil, pending?.query != query else { return }
        let flight = begin(query)
        Task { [weak self] in
            do {
                let envelope = try await flight.task.value
                self?.finish(flight, envelope: envelope)
            } catch {
                self?.failed(flight, error: error)
            }
        }
    }

    public func value(for query: Query) async throws -> TranscriptEnvelope {
        if let envelope = cached(query) {
            PerfLog.mark("transcript.cache hit turns=\(envelope.turns.count)")
            return envelope
        }
        let flight = begin(query)
        do {
            let envelope = try await flight.task.value
            guard !flight.task.isCancelled else { throw CancellationError() }
            finish(flight, envelope: envelope)
            try Task.checkCancellation()
            return envelope
        } catch {
            failed(flight, error: error)
            throw error
        }
    }

    public func cancelPending() {
        guard let pending else { return }
        pending.task.cancel()
        self.pending = nil
        PerfLog.mark("transcript.cache cancelled")
    }

    private func cached(_ query: Query) -> TranscriptEnvelope? {
        let time = now()
        entries = entries.filter { _, entry in
            let age = time.timeIntervalSince(entry.loadedAt)
            return age >= 0 && age < lifetime
        }
        guard let entry = entries[query] else { return nil }
        accessOrder &+= 1
        entries[query]?.usedAt = accessOrder
        return entry.envelope
    }

    private func begin(_ query: Query) -> Pending {
        if let pending, pending.query == query { return pending }
        cancelPending()
        let load = self.load
        let task = Task.detached(priority: .utility) {
            try await PerfLog.spanAsync("transcript.cache load") { try await load(query) }
        }
        let flight = Pending(id: UUID(), query: query, task: task)
        pending = flight
        PerfLog.mark("transcript.cache start")
        return flight
    }

    private func finish(_ flight: Pending, envelope: TranscriptEnvelope) {
        guard pending?.id == flight.id, !flight.task.isCancelled else { return }
        pending = nil
        accessOrder &+= 1
        entries[flight.query] = Entry(envelope: envelope, loadedAt: now(), usedAt: accessOrder)
        while entries.count > capacity, let oldest = entries.min(by: { $0.value.usedAt < $1.value.usedAt }) {
            entries.removeValue(forKey: oldest.key)
        }
        PerfLog.mark("transcript.cache prepared turns=\(envelope.turns.count) entries=\(entries.count)")
    }

    private func failed(_ flight: Pending, error: Error) {
        guard pending?.id == flight.id else { return }
        pending = nil
        if !(error is CancellationError) {
            PerfLog.mark("transcript.cache failed \(error.localizedDescription)")
        }
    }
}
