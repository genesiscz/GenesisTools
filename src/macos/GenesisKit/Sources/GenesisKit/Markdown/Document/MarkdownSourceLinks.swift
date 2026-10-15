//
//  MarkdownSourceLinks.swift
//  GenesisKit
//
//  What a ⌘-click in the markdown source is pointing at. The reading view has
//  had clickable links since the start; the source did not, so following a
//  reference between two notes meant switching to the reading view first.
//

import Foundation

enum MarkdownSourceLinks {
    /// The link target under `offset`, or nil when the click was on plain text.
    /// Handles `[[note|alias]]`, `[label](target)` (with or without angle
    /// brackets) and a bare URL.
    static func target(in text: String, at offset: Int) -> String? {
        let ns = text as NSString
        guard offset >= 0, offset <= ns.length else { return nil }
        let line = ns.lineRange(for: NSRange(location: min(offset, max(0, ns.length - 1)), length: 0))
        let body = ns.substring(with: line)
        let local = offset - line.location

        for (pattern, group) in patterns {
            for match in matches(pattern, in: body) where NSLocationInRange(local, match.range) {
                let range = match.range(at: group)
                guard range.location != NSNotFound else { continue }
                let raw = (body as NSString).substring(with: range).trimmingCharacters(in: .whitespaces)
                return clean(raw)
            }
        }
        return nil
    }

    /// Ordered: the outer form wins, so the `[label](target)` around a bare URL
    /// is what a click reports.
    private static let patterns: [(String, Int)] = [
        (#"!?\[\[([^\]\|#]+)(?:#[^\]\|]+)?(?:\|[^\]]+)?\]\]"#, 1),
        (#"\[[^\]]*\]\(([^)]+)\)"#, 1),
        (#"\[[^\]]*\]\[([^\]]+)\]"#, 1),
        (#"(?:https?|obsidian|genesis)://[^\s<>\)\]]+"#, 0),
    ]

    private static func matches(_ pattern: String, in body: String) -> [NSTextCheckingResult] {
        guard let regex = try? NSRegularExpression(pattern: pattern) else { return [] }
        return regex.matches(in: body, range: NSRange(location: 0, length: (body as NSString).length))
    }

    /// Drops angle brackets and a trailing `"title"` from a link destination.
    private static func clean(_ raw: String) -> String? {
        var value = raw
        if let space = value.range(of: " \""), value.hasSuffix("\"") {
            value = String(value[..<space.lowerBound])
        }
        if value.hasPrefix("<"), value.hasSuffix(">") {
            value = String(value.dropFirst().dropLast())
        }
        value = value.trimmingCharacters(in: .whitespaces)
        return value.isEmpty ? nil : value
    }

    /// The definition line of a reference link (`[label]: ./target.md`), so a
    /// click on `[text][label]` can follow it.
    static func reference(_ label: String, in text: String) -> String? {
        let pattern = "(?m)^\\s*\\[\(NSRegularExpression.escapedPattern(for: label))\\]:\\s*(\\S+)"
        guard let regex = try? NSRegularExpression(pattern: pattern, options: [.caseInsensitive]),
              let match = regex.firstMatch(in: text, range: NSRange(location: 0, length: (text as NSString).length)),
              match.range(at: 1).location != NSNotFound else { return nil }
        return clean((text as NSString).substring(with: match.range(at: 1)))
    }
}
