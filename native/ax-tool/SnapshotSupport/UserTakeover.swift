import CoreGraphics
import Foundation

/// Side, in points, of the square at the main display's top-left corner that stops synthetic input.
/// The menu-bar corner is the one place a user can hit blind: fling the pointer up and left and it
/// pins there. Same size as typesafe-computer-use's ABORT_CORNER_PX.
public let takeoverCornerSide: CGFloat = 4

/// True when the check is enabled and the pointer sits in the takeover square of the MAIN display,
/// the one CoreGraphics puts at the global origin. Only that display counts: with a second display
/// to the left, the pointer crosses x = 0 freely and the union's top-left corner is not a place a
/// flick lands.
public func userTookOver(pointer: CGPoint, displays: [CGRect], enabled: Bool) -> Bool {
    guard enabled, pointer.x.isFinite, pointer.y.isFinite,
          let main = displays.first(where: { $0.origin == .zero }) else {
        return false
    }

    return CGRect(x: main.minX, y: main.minY, width: takeoverCornerSide, height: takeoverCornerSide).contains(pointer)
}

/// `GENESIS_CONTROL_ABORT_CORNER=0` turns the corner check off. Anything else, including no value,
/// leaves it on: a guard that a typo disables is not a guard.
public func takeoverCornerEnabled(_ environment: [String: String]) -> Bool {
    guard let raw = environment["GENESIS_CONTROL_ABORT_CORNER"]?.trimmingCharacters(in: .whitespaces).lowercased() else {
        return true
    }

    return !["0", "false", "off", "no"].contains(raw)
}

/// The user took the machine back. Never retried: the caller stops and waits for the user.
public struct UserTakeoverError: Error, LocalizedError {
    /// True once this process had posted any synthetic event, so the command may have partly landed.
    public let dispatched: Bool

    public init(dispatched: Bool) {
        self.dispatched = dispatched
    }

    public var category: SnapshotRefusal { .userTakeover }

    public var errorDescription: String? {
        "the pointer is in the top-left corner of the main display, so the user took over; "
            + (dispatched ? "input stopped part way and every held key or button was released. " : "no input was sent. ")
            + "Wait for the user to move the pointer away before driving again "
            + "(GENESIS_CONTROL_ABORT_CORNER=0 turns this check off)"
    }
}

/// The one door every synthetic event of this process goes through.
///
/// Every post is preceded by the takeover check, a down is remembered until its up is posted, and
/// an up is NEVER checked: when the check fires, whatever is still held is released first, so a
/// stopped command cannot leave a button or a key down behind it.
public final class SyntheticInputGate {
    public struct Held: Equatable {
        fileprivate let id: Int
    }

    private let tookOver: () -> Bool
    private let sleeper: (TimeInterval) -> Void
    private var held: [(id: Int, release: () -> Void)] = []
    private var nextID = 0
    /// Events posted through this gate, releases included.
    public private(set) var posted = 0

    public init(tookOver: @escaping () -> Bool,
                sleeper: @escaping (TimeInterval) -> Void = { Thread.sleep(forTimeInterval: $0) }) {
        self.tookOver = tookOver
        self.sleeper = sleeper
    }

    /// Stop here when the user took over, after releasing anything still held (latest first).
    public func check() throws {
        guard tookOver() else {
            return
        }

        while let entry = held.popLast() {
            entry.release()
            posted += 1
        }
        throw UserTakeoverError(dispatched: posted > 0)
    }

    /// One event that holds nothing down: a move, a wheel step, a warp.
    public func post(_ send: () -> Void) throws {
        try check()
        send()
        posted += 1
    }

    /// A down event. Its release runs through `release(_:)`, or through `check()` if the user takes
    /// over first.
    @discardableResult
    public func press(_ send: () -> Void, release: @escaping () -> Void) throws -> Held {
        try check()
        send()
        posted += 1
        let id = nextID
        nextID += 1
        held.append((id, release))
        return Held(id: id)
    }

    /// Post the up for a held down. Unchecked on purpose: an up must always go out.
    public func release(_ input: Held) {
        guard let index = held.firstIndex(where: { $0.id == input.id }) else {
            return
        }

        let entry = held.remove(at: index)
        entry.release()
        posted += 1
    }

    /// An event whose check already ran in the caller's own verify step, such as a drag's moves and
    /// its closing release. Counted, never checked.
    public func deliver(_ send: () -> Void) {
        send()
        posted += 1
    }

    /// Sleep in slices of at most 0.1 s and check between them, so a long hold or dwell still stops
    /// within a tenth of a second of the user reaching the corner.
    public func sleepWatching(_ seconds: TimeInterval) throws {
        var remaining = seconds
        while remaining > 0 {
            try check()
            let slice = min(0.1, remaining)
            sleeper(slice)
            remaining -= slice
        }
        try check()
    }
}
