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

        var matches: [Range<String.Index>] = []
        var searchStart = value.startIndex
        while searchStart < value.endIndex,
              let match = value.range(of: text, options: .literal, range: searchStart..<value.endIndex) {
            let before = value[..<match.lowerBound]
            let after = value[match.upperBound...]
            if (prefix == nil || before.hasSuffix(prefix!)) && (suffix == nil || after.hasPrefix(suffix!)) {
                matches.append(match)
            }
            searchStart = value.index(after: match.lowerBound)
        }

        guard matches.count == 1, let match = matches.first else {
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
