import Foundation

/// One read in flight per key, shared by every caller that the read can answer. A caller names when the change it must
/// see happened (`changedAt`): a read that started at or after that moment answers it, so a caller joins it; an older
/// read cannot, so the caller waits for it to end and then joins, or starts, the next one. Many callers during one read
/// therefore cost at most one more read, whichever window model or event asked.
@MainActor
final class MeetingsSharedRead<Key: Hashable, Value: Sendable> {
    private struct Flight {
        let started: ContinuousClock.Instant
        let task: Task<Value, Error>
    }

    private var flights: [Key: Flight] = [:]

    func value(for key: Key, changedAt: ContinuousClock.Instant,
               run: @escaping @MainActor () async throws -> Value) async throws -> Value {
        while let flight = flights[key] {
            if flight.started >= changedAt {
                return try await flight.task.value
            }

            _ = try? await flight.task.value
            if flights[key]?.task == flight.task {
                flights[key] = nil
            }
        }

        let task = Task { @MainActor in try await run() }
        flights[key] = Flight(started: .now, task: task)
        defer {
            if flights[key]?.task == task { flights[key] = nil }
        }
        return try await task.value
    }
}
