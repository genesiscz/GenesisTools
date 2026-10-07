import Foundation

/// One builder plus one latest pending operation, for a session screen's document build. Builds overlap
/// (a fetch, the native scan, an earlier page, a live-tail append); with this queue at most one runs, and
/// of the ones that arrive meanwhile only the newest runs next, so a burst of appends costs two builds,
/// not one per append. Revisions are checked by the publisher.
public final class TranscriptBuildQueue {
    private var running: Task<Void, Never>?
    private var pending: (@MainActor () async -> Void)?

    public init() {}

    @MainActor
    public func submit(_ operation: @escaping @MainActor () async -> Void) async {
        pending = operation
        if running == nil {
            running = Task { @MainActor in
                while !Task.isCancelled, let next = pending {
                    pending = nil
                    await next()
                }
                pending = nil
                running = nil
            }
        }
        await running?.value
    }

    /// Drops the pending operation; the running one finishes and its publisher's revision check drops it.
    @MainActor
    public func cancel() {
        pending = nil
    }
}
