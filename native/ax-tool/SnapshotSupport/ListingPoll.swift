import Foundation

/// The pause between two listings of the windows while one is still missing.
public let listingPause: TimeInterval = 0.1

/// How long one ScreenCaptureKit call may take: a listing's first answer, or one stream update. The live display
/// switch's deadline (`liveSwitchDeadline`) is built from it, so the two cannot drift apart.
public let streamCallBudget: TimeInterval = 5

/// A listing that did not answer within its budget (`answer(within:_:)`).
public struct ListingTimedOut: LocalizedError, Equatable {
    public let seconds: TimeInterval

    public init(seconds: TimeInterval) {
        self.seconds = seconds
    }

    public var errorDescription: String? {
        "screen capture did not list the windows within \(String(format: "%.1f", seconds)) s"
    }
}

/// Hands the first answer on to the waiting caller, once, and then cancels the budget's timer.
private final class AnswerRace<T>: @unchecked Sendable {
    private let lock = NSLock()
    private var waiting: CheckedContinuation<T, Error>?
    private var timer: Task<Void, Never>?

    init(_ waiting: CheckedContinuation<T, Error>) {
        self.waiting = waiting
    }

    /// Keeps the budget's `timer` to cancel at the first answer; an answer that already came cancels it at once.
    func arm(_ timer: Task<Void, Never>) {
        lock.lock()
        let answered = waiting == nil
        if !answered {
            self.timer = timer
        }
        lock.unlock()
        if answered {
            timer.cancel()
        }
    }

    /// False when the other side already answered.
    @discardableResult
    func finish(_ result: Result<T, Error>) -> Bool {
        lock.lock()
        let continuation = waiting
        waiting = nil
        let timer = self.timer
        self.timer = nil
        lock.unlock()
        guard let continuation else { return false }
        // An answer within the budget ends the timer's sleep, so it does not hold the race for the rest of the budget.
        timer?.cancel()
        continuation.resume(with: result)
        return true
    }
}

/// `operation`'s answer, or `ListingTimedOut` once `seconds` pass without one. The operation runs in a task of its own,
/// so a call that never answers (an XPC call to the window server) does not hold the caller: past the budget it is
/// cancelled and its late answer is dropped. A task group cannot do this, since it waits for every child to end.
public func answer<T>(within seconds: TimeInterval, _ operation: @escaping () async throws -> T) async throws -> T {
    try await withCheckedThrowingContinuation { continuation in
        let race = AnswerRace(continuation)
        let work = Task {
            do {
                race.finish(.success(try await operation()))
            } catch {
                race.finish(.failure(error))
            }
        }
        race.arm(Task {
            try? await Task.sleep(nanoseconds: UInt64(max(0, seconds) * 1_000_000_000))
            if race.finish(.failure(ListingTimedOut(seconds: seconds))) {
                work.cancel()
            }
        })
    }
}

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
///
/// No event says that the window server lists a window, so this asks again; `listingPause` apart, since each ask is a
/// full listing of every window (the house rule: no poll under 100 ms).
public func pollListing<T>(
    timeout: TimeInterval,
    pause: TimeInterval = listingPause,
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
///
/// Every ask is bounded (`answer(within:_:)`): the first by `firstAnswer`, since without an answer there is nothing to
/// judge and its `ListingTimedOut` is thrown; each retry by the time left before the deadline, and a retry that does not
/// answer in it ends the wait with `UnresolvedExclusions` for the last answer. Before this, a listing that stalled held a
/// display switch or a restart with no outcome at all.
public func awaitExclusionsListed<T>(
    timeout: TimeInterval,
    firstAnswer: TimeInterval,
    pause: TimeInterval = listingPause,
    now: () -> Date = { Date() },
    sleep: (TimeInterval) async throws -> Void,
    fetch: @escaping () async throws -> T,
    unresolved: (T) -> [UInt32]
) async throws -> T {
    let deadline = now().addingTimeInterval(timeout)
    var value = try await answer(within: firstAnswer, fetch)

    while true {
        let missing = unresolved(value)
        if missing.isEmpty {
            return value
        }

        let left = deadline.timeIntervalSince(now())
        if left <= 0 {
            throw UnresolvedExclusions(ids: missing)
        }

        try await sleep(min(pause, left))
        let budget = deadline.timeIntervalSince(now())
        if budget <= 0 {
            throw UnresolvedExclusions(ids: missing)
        }

        do {
            value = try await answer(within: budget, fetch)
        } catch is ListingTimedOut {
            throw UnresolvedExclusions(ids: missing)
        }
    }
}

/// Which live display switch owns the stream. A switch that passes its deadline loses it, so its late completion cannot
/// adopt the display it was going to: `end` is called by both the switch and its deadline, and only the first wins.
public final class LiveSwitchOwner: @unchecked Sendable {
    private let lock = NSLock()
    private var latest = 0
    private var open = false

    public init() {}

    private func locked<R>(_ body: () -> R) -> R {
        lock.lock()
        defer { lock.unlock() }
        return body()
    }

    /// Starts a switch and returns its token; a switch still open loses the stream to it.
    public func begin() -> Int {
        locked {
            latest += 1
            open = true
            return latest
        }
    }

    /// True while `token` is the open switch.
    public func owns(_ token: Int) -> Bool {
        locked { open && latest == token }
    }

    /// Ends the switch `token`. True for the first caller while it owns the stream; false once it ended or expired.
    public func end(_ token: Int) -> Bool {
        locked {
            guard open, latest == token else { return false }
            open = false
            return true
        }
    }

    /// True when no switch began after `token`: what `token` changed on the stream is still its own to undo.
    public func isLatest(_ token: Int) -> Bool {
        locked { latest == token }
    }
}
