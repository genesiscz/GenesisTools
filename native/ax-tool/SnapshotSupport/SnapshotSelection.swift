import Foundation

public func snapshotSelection(
    in value: String,
    text: String?,
    range: String?,
    prefix: String?,
    suffix: String?,
    mode: String
) throws -> NSRange {
    guard ["text", "cursor_before", "cursor_after"].contains(mode) else {
        throw SnapshotError.invalid("selection mode is unsupported")
    }

    guard (text == nil) != (range == nil) else {
        throw SnapshotError.invalid("select requires exactly one of text or range")
    }

    if let text {
        guard !text.isEmpty else {
            throw SnapshotError.invalid("text selection requires nonempty text")
        }

        var selectedMatch: Range<String.Index>?
        var searchStart = value.startIndex
        while searchStart < value.endIndex,
              let match = value.range(of: text, options: .literal, range: searchStart..<value.endIndex) {
            let before = value[..<match.lowerBound]
            let after = value[match.upperBound...]
            if (prefix == nil || before.hasSuffix(prefix!)) && (suffix == nil || after.hasPrefix(suffix!)) {
                guard selectedMatch == nil else {
                    throw SnapshotError.invalid("text selection is absent or ambiguous")
                }
                selectedMatch = match
            }
            searchStart = value.index(after: match.lowerBound)
        }

        guard let match = selectedMatch else {
            throw SnapshotError.invalid("text selection is absent or ambiguous")
        }

        let selected = NSRange(match, in: value)
        switch mode {
        case "text":
            return selected
        case "cursor_before":
            return NSRange(location: selected.location, length: 0)
        case "cursor_after":
            return NSRange(location: selected.location + selected.length, length: 0)
        default:
            throw SnapshotError.invalid("selection mode is unsupported")
        }
    }

    guard let range else {
        throw SnapshotError.invalid("select requires exactly one of text or range")
    }

    let parts = range.split(separator: ",", omittingEmptySubsequences: false)
    guard parts.count == 2,
          let location = Int(parts[0]),
          let length = Int(parts[1]),
          location >= 0,
          length >= 0 else {
        throw SnapshotError.invalid("range must be utf16Start,length")
    }

    let count = value.utf16.count
    guard location <= count, length <= count - location else {
        throw SnapshotError.invalid("range is outside the text value")
    }

    let lowerUTF16 = value.utf16.index(value.utf16.startIndex, offsetBy: location)
    let upperUTF16 = value.utf16.index(lowerUTF16, offsetBy: length)
    guard String.Index(lowerUTF16, within: value) != nil,
          String.Index(upperUTF16, within: value) != nil else {
        throw SnapshotError.invalid("range splits a Unicode scalar")
    }

    switch mode {
    case "text":
        return NSRange(location: location, length: length)
    case "cursor_before":
        return NSRange(location: location, length: 0)
    case "cursor_after":
        return NSRange(location: location + length, length: 0)
    default:
        throw SnapshotError.invalid("selection mode is unsupported")
    }
}

/// One candidate a `--q` / `--text` lookup matched, reduced to what ranking needs.
public struct QueryCandidate {
    public let title: String?
    public let label: String?
    public let identifier: String?
    public let actions: [String]

    public init(title: String?, label: String?, identifier: String?, actions: [String]) {
        self.title = title
        self.label = label
        self.identifier = identifier
        self.actions = actions
    }
}

/// Which of the matched candidates should still be considered, by index.
///
/// 🛑 The walk that produces these matches is pre-order, so an ANCESTOR always arrives first. A
/// SwiftUI container that aggregates its children's labels therefore beat the button inside it:
/// reported 2026-09-21, `press --q "Previous range"` selected the window's root group, which
/// exposes no AXPress at all, performed nothing and reported success.
///
/// Order matters and is not interchangeable. An EXACT label match is applied first, so a container
/// that merely CONTAINS the words loses to the control actually named. Only then does the ability
/// to perform the verb decide, which breaks the remaining ancestor/descendant ties. Doing it the
/// other way round would let an unrelated but pressable element outrank the named button.
///
/// Each filter is skipped when it would empty the set: narrowing to nothing would turn a findable
/// element into "no match", which is a worse answer than an ambiguous one.
public func rankedQueryMatches(_ candidates: [QueryCandidate], query: String?,
                               requiredAction: String?) -> [Int] {
    var pool = Array(candidates.indices)

    if let query, pool.count > 1 {
        let exact = pool.filter { index in
            let candidate = candidates[index]
            return candidate.title == query || candidate.label == query || candidate.identifier == query
        }
        if !exact.isEmpty { pool = exact }
    }

    if let requiredAction, pool.count > 1 {
        let able = pool.filter { candidates[$0].actions.contains(requiredAction) }
        if !able.isEmpty { pool = able }
    }

    return pool
}
