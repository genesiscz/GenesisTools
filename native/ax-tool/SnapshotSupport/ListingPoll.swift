import Foundation

/// Why `pollListing` returned its answer.
public enum ListingPollEnd: Equatable {
    /// The answer lists everything asked for.
    case listed
    /// The deadline passed with an answer that does not list everything.
    case deadline
    /// A retry failed or did not answer before the deadline; the last answer stands. Holds the retry's error text.
    case retryFailed(String)
}

/// Asks `fetch` until `isListed` accepts its answer, for at most `timeout` seconds.
///
/// The first ask gets `fetch`'s own deadline (`remaining` is nil): without an answer there is nothing to return, so its
/// error is thrown. Each retry gets the time left before the deadline, and a retry that fails or stalls ends the poll
/// with the last answer. Before this, a retry that stalled waited the full 30 s of `awaitResult` and then threw, so a
/// recording failed although the first answer could have made it.
public func pollListing<T>(
    timeout: TimeInterval,
    pause: TimeInterval = 0.05,
    now: () -> Date = { Date() },
    wait: (TimeInterval) -> Void,
    fetch: (_ remaining: TimeInterval?) throws -> T,
    isListed: (T) -> Bool
) throws -> (value: T, end: ListingPollEnd) {
    let deadline = now().addingTimeInterval(timeout)
    var value = try fetch(nil)

    while true {
        if isListed(value) {
            return (value, .listed)
        }

        let remaining = deadline.timeIntervalSince(now())
        if remaining <= 0 {
            return (value, .deadline)
        }

        wait(min(pause, remaining))
        let left = deadline.timeIntervalSince(now())
        if left <= 0 {
            return (value, .deadline)
        }

        do {
            value = try fetch(left)
        } catch {
            return (value, .retryFailed(error.localizedDescription))
        }
    }
}

/// The windows a caller asked the movie to leave out that the listing does not hold while they still exist, sorted.
///
/// A display filter can leave out only the windows the listing holds, so such a window would be filmed, also once it
/// becomes shareable after the start: the recording must refuse instead. A window that no longer exists cannot be
/// filmed, so it is no reason to refuse. The recording border's panels are best effort and are not passed here.
public func unresolvedExclusions(requested: Set<UInt32>, listed: Set<UInt32>, exists: (UInt32) -> Bool) -> [UInt32] {
    requested.subtracting(listed).filter(exists).sorted()
}

/// Windows a display filter must leave out that the listing still does not hold (`unresolvedExclusions`).
public struct UnresolvedExclusions: LocalizedError, Equatable {
    public let ids: [UInt32]

    public init(ids: [UInt32]) {
        self.ids = ids
    }

    public var errorDescription: String? {
        "windows \(ids.map(String.init).joined(separator: ",")) must be left out of the movie but screen capture does not list them yet"
    }
}

/// Asks `fetch` until `unresolved` finds no window in its answer, for at most `timeout` seconds, and throws
/// `UnresolvedExclusions` with the last answer's windows past the deadline. A window that just appeared, or came back
/// from another space, can be missing from one listing, so a display switch or a restart asks again before it refuses.
public func awaitExclusionsListed<T>(
    timeout: TimeInterval,
    pause: TimeInterval = 0.1,
    now: () -> Date = { Date() },
    sleep: (TimeInterval) async throws -> Void,
    fetch: () async throws -> T,
    unresolved: (T) -> [UInt32]
) async throws -> T {
    let deadline = now().addingTimeInterval(timeout)

    while true {
        let value = try await fetch()
        let missing = unresolved(value)
        if missing.isEmpty {
            return value
        }

        let left = deadline.timeIntervalSince(now())
        if left <= 0 {
            throw UnresolvedExclusions(ids: missing)
        }

        try await sleep(min(pause, left))
    }
}
