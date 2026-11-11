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
