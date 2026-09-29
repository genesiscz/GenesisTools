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

/// How often `needle` occurs in `haystack`, without overlap.
public func textOccurrences(of needle: String, in haystack: String) -> Int {
    guard !needle.isEmpty else { return 0 }
    var count = 0
    var searched = haystack.startIndex..<haystack.endIndex
    while let found = haystack.range(of: needle, range: searched) {
        count += 1
        searched = found.upperBound..<haystack.endIndex
    }
    return count
}

/// An insertion has landed once the field holds one more occurrence of `text` than before. The
/// readback polls on this, not on containment: a field that already held the text contains it before
/// the keys arrive, and stopping there reads the unchanged value and reports `.notLanded`.
public func typedTextLanded(before: String?, after: String?, text: String) -> Bool {
    guard let after else { return false }
    return textOccurrences(of: text, in: after) > textOccurrences(of: text, in: before ?? "")
}

public func typedTextVerdict(element: String?, before: String?, after: String?, text: String,
                             replace: Bool) -> TypedTextVerdict {
    guard !text.isEmpty else { return .verified }
    guard let element else {
        return .unverifiable("the app reports no focused element")
    }
    guard let after else {
        return .unverifiable("the focused \(element) has no readable value")
    }
    if after == before, !(replace && after == text) {
        return .notLanded
    }
    if replace {
        return after == text ? .verified : .different(after)
    }
    // An insertion must add an occurrence. A field that already held the text and then changed for
    // another reason (autocomplete rewrote it) is no proof that these keys landed.
    return typedTextLanded(before: before, after: after, text: text) ? .verified : .different(after)
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
