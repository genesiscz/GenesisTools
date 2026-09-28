import Foundation

/// What a readback proves about typed keystrokes. `control type` promised a hard verify, but with
/// only `--app` it verified nothing and printed "typed 66 chars" while the text never reached the
/// open panel's field it was meant for. Every outcome that is not `.verified` must reach the
/// caller as something other than success.
public enum TypedTextVerdict: Equatable {
    case verified
    /// The keys were posted, but nothing could be read back to prove where they went.
    case unverifiable(String)
    /// The read element did not change: the keys went somewhere else, or nowhere.
    case notLanded
    /// The read element changed, but not into the typed text.
    case different(String)
}

public func typedTextVerdict(element: String?, before: String?, after: String?, text: String,
                             replace: Bool) -> TypedTextVerdict {
    guard let element else {
        return .unverifiable("the app reports no focused element")
    }
    guard let after else {
        return .unverifiable("the focused \(element) has no readable value")
    }
    if after == before, !(replace && after == text) {
        return .notLanded
    }
    if replace ? after != text : !after.contains(text) {
        return .different(after)
    }
    return .verified
}

/// Posts each item only while the target app still holds the front. The legacy `type` and
/// `hotkey` post to the global keyboard tap, so a focus change after the one activation check
/// (the user's terminal taking the front back, a cursor glide) sent the rest of the keys to
/// whatever app was in front. Returns how many items were posted before the front moved.
public func postWhileFrontmost<Item>(_ items: [Item], isTargetFront: () -> Bool, post: (Item) -> Void) -> Int {
    var posted = 0
    for item in items {
        guard isTargetFront() else { return posted }
        post(item)
        posted += 1
    }
    return posted
}
