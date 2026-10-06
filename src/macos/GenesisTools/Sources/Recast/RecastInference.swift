import AppKit
import Foundation

struct RecastInferenceCheckpoint: Equatable {
    var documentId: String
    var revision: Int
}

actor RecastInferenceSlots {
    static let shared = RecastInferenceSlots()
    private struct Waiting {
        var id: UUID
        var continuation: CheckedContinuation<UUID, Error>
        var deadline: Task<Void, Never>
    }
    private let limit: Int
    private let timeoutNanoseconds: UInt64
    private var active = Set<UUID>()
    private var waiting: [Waiting] = []
    var activeCount: Int { active.count }

    init(limit: Int = 2, timeoutNanoseconds: UInt64 = 60_000_000_000) {
        self.limit = max(1, limit); self.timeoutNanoseconds = timeoutNanoseconds
    }
    func acquire() async throws -> UUID {
        try Task.checkCancellation()
        let id = UUID()
        return try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { continuation in
                if Task.isCancelled { continuation.resume(throwing: CancellationError()); return }
                if active.count < limit { active.insert(id); continuation.resume(returning: id); return }
                let deadline = Task {
                    do { try await Task.sleep(nanoseconds: timeoutNanoseconds) }
                    catch is CancellationError { return }
                    catch { HubPerf.log("recast: inference slot deadline failed: \(error)"); return }
                    expire(id, error: recastError("Two interpretation jobs are already running. Try again when one finishes."))
                }
                waiting.append(Waiting(id: id, continuation: continuation, deadline: deadline))
            }
        } onCancel: { Task { await self.expire(id, error: CancellationError()) } }
    }
    private func expire(_ id: UUID, error: Error) {
        guard let index = waiting.firstIndex(where: { $0.id == id }) else { return }
        let entry = waiting.remove(at: index)
        entry.deadline.cancel()
        entry.continuation.resume(throwing: error)
    }
    func release(_ id: UUID) {
        guard active.remove(id) != nil else { return }
        if !waiting.isEmpty {
            let next = waiting.removeFirst()
            next.deadline.cancel(); active.insert(next.id); next.continuation.resume(returning: next.id)
        }
    }
}

@MainActor
private final class RecastAutosaveCompletion {
    var continuation: CheckedContinuation<Void, Error>?
    var deadline: Task<Void, Never>?
    func finish(_ error: Error?) {
        guard let continuation else { return }
        self.continuation = nil; deadline?.cancel(); deadline = nil
        if let error { continuation.resume(throwing: error) }
        else { continuation.resume() }
    }
}

extension RecastDocument {
    func persistBeforeInference() async throws {
        let span = HubPerf.begin("recast.autosave", "Before interpretation")
        defer { span.end() }
        let completion = RecastAutosaveCompletion()
        try await withCheckedThrowingContinuation { continuation in
            completion.continuation = continuation
            completion.deadline = Task { @MainActor in
                do { try await Task.sleep(nanoseconds: 60_000_000_000) }
                catch is CancellationError { return }
                catch { completion.finish(error); return }
                completion.finish(recastError("Saving took longer than sixty seconds. Interpretation did not start; your edits remain in the window."))
            }
            autosave(withImplicitCancellability: false) { error in
                Task { @MainActor in completion.finish(error) }
            }
        }
        guard fileURL != nil || autosavedContentsFileURL != nil else {
            throw recastError("Save this conversion before interpreting its sources.")
        }
    }
}
