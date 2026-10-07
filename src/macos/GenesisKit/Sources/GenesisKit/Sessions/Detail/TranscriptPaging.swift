import Foundation

/// How a session screen pages its transcript (`tools ai sessions tail --offset --limit`).
public enum TranscriptPaging {
    /// Turns per "Load earlier turns" page, and the room a refresh adds past the loaded window.
    public static let pageSize = 150

    /// Viewport first: the newest turns only, so the first layout (which scrolls to the last row and so
    /// measures every row above it) handles a screenful instead of `pageSize` turns. A 172 MB session
    /// stalled the main thread 0.9 to 1.5 s at open with the whole window in one go (GenesisTools,
    /// 2026-10-01). `GENESIS_TRANSCRIPT_FIRST_PAGE=<n>` (or GenesisTools' older `GENESIS_HUB_FIRST_PAGE`)
    /// sets it, for A/B measurements: 150 restores the old one-shot window.
    public static let firstPage = firstPage(in: ProcessInfo.processInfo.environment)

    public static func firstPage(in environment: [String: String]) -> Int {
        let raw = environment["GENESIS_TRANSCRIPT_FIRST_PAGE"] ?? environment["GENESIS_HUB_FIRST_PAGE"]
        return raw.flatMap(Int.init).flatMap { $0 > 0 ? $0 : nil } ?? 12
    }

    /// The limit for a refresh that keeps every loaded page: from the window start to past the end.
    public static func refreshLimit(loaded: Int) -> Int {
        max(pageSize, loaded + pageSize)
    }

    /// The limit for another fetch from `start`, or nil when `fetched` already reaches the latest turn.
    /// With the transcript's turn count, exactly the room still missing. Without it (an older `tools`),
    /// twice the limit whenever the answer came back full, since a full answer may have stopped short.
    public static func refetchLimit(after fetched: TranscriptEnvelope, start: Int, limit: Int) -> Int? {
        if let count = fetched.turnCount {
            return fetched.nextOffset < count ? count - start : nil
        }
        return fetched.turns.count >= limit ? limit * 2 : nil
    }

    /// Fetches a window and, when it starts at `offset` and must reach the latest turn (`throughEnd`, a
    /// refresh that keeps the earlier pages), fetches again from the same offset while it stopped short.
    /// Bounded to three more tries: a live session can grow between two fetches. `isCurrent` false stops
    /// early (a newer load started); the last answer is returned either way.
    public static func fetchWindow(
        using bridge: ToolsBridge,
        sessionId: String,
        offset: Int?,
        limit: Int,
        throughEnd: Bool,
        isCurrent: @MainActor () -> Bool = { true }
    ) async throws -> TranscriptEnvelope {
        var limit = limit
        var fetched = try await SessionTranscriptClient.fetch(using: bridge, sessionId: sessionId, limit: limit, offset: offset)
        var tries = 0
        while throughEnd, let start = offset, tries < 3, let next = refetchLimit(after: fetched, start: start, limit: limit) {
            guard await isCurrent() else { break }
            tries += 1
            limit = next
            fetched = try await SessionTranscriptClient.fetch(using: bridge, sessionId: sessionId, limit: limit, offset: start)
        }
        return fetched
    }
}
