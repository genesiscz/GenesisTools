//
//  SourceFind.swift
//  GenesisKit
//
//  Find and replace over the markdown source, with the find bar's three
//  options (match case, whole word, regex) and an optional scope (find in
//  selection). Pure, so the walking and the replacing can be tested without a
//  text view. The rendered page runs the same rules in JavaScript
//  (`window.gnFind` in MarkdownWebView), so a toggle means the same thing in
//  both engines.
//

import Foundation

/// The find bar's match options. Remembered between launches by the model
/// (`markdownWindow.find.*`); find in selection is not, since a selection is
/// gone by the next launch.
struct MarkdownFindOptions: Equatable {
    /// "Aa": `Alpha` does not find `alpha`. Off = case-insensitive, as before.
    var matchCase = false
    /// Only whole words: `alpha` does not find `alphabet`. A word is letters,
    /// digits, combining marks and `_`, in any script, so `čaj` is one word.
    var wholeWord = false
    /// `.*`: the query is an ICU regular expression. `^` and `$` match at every
    /// line, as in an editor.
    var regex = false
}

enum SourceFind {
    /// What counts as part of a word on either side of a whole-word match.
    /// The page uses the same class (`\p{L}\p{N}\p{M}_`); `\b` would be
    /// ASCII-only in JavaScript and Czech words would split at every háček.
    static let wordCharacter = "[\\p{L}\\p{N}\\p{M}_]"

    /// The counter's text for a query that cannot run; nil = it can.
    static let invalidPattern = "invalid regex"

    /// nil when the query is a valid search (or empty), else why it is not.
    static func patternError(_ query: String, options: MarkdownFindOptions) -> String? {
        guard options.regex, !query.isEmpty else { return nil }
        return expression(for: query, options: options) == nil ? invalidPattern : nil
    }

    /// The query as one expression. A plain query is escaped, so `(b)` finds
    /// the three characters; a regex query is checked on its own first, so a
    /// stray `)` cannot pair up with the whole-word wrapper and pass.
    static func expression(for query: String, options: MarkdownFindOptions) -> NSRegularExpression? {
        guard !query.isEmpty else { return nil }
        var flags: NSRegularExpression.Options = []
        if !options.matchCase { flags.insert(.caseInsensitive) }
        var pattern: String
        if options.regex {
            flags.insert(.anchorsMatchLines)
            guard (try? NSRegularExpression(pattern: query, options: flags)) != nil else { return nil }
            pattern = query
        } else {
            pattern = NSRegularExpression.escapedPattern(for: query)
        }
        if options.wholeWord {
            pattern = "(?<!\(wordCharacter))(?:\(pattern))(?!\(wordCharacter))"
        }
        return try? NSRegularExpression(pattern: pattern, options: flags)
    }

    /// Every occurrence of `query`, in document order. `scope` limits the
    /// matches to that range (find in selection); the text around it still
    /// decides whole-word boundaries and `^`, so a scope never invents a word
    /// edge or a line start. Empty matches (`^`, `a*`) are skipped: there is
    /// nothing to select or mark.
    static func matches(
        in text: String,
        query: String,
        options: MarkdownFindOptions = MarkdownFindOptions(),
        within scope: NSRange? = nil
    ) -> [NSRange] {
        results(in: text, query: query, options: options, within: scope).map(\.range)
    }

    static func results(
        in text: String,
        query: String,
        options: MarkdownFindOptions,
        within scope: NSRange?
    ) -> [NSTextCheckingResult] {
        guard let regex = expression(for: query, options: options) else { return [] }
        let length = (text as NSString).length
        let range = clamp(scope, length: length) ?? NSRange(location: 0, length: length)
        return regex.matches(in: text, options: [.withTransparentBounds, .withoutAnchoringBounds], range: range)
            .filter { $0.range.length > 0 }
    }

    /// The match `delta` steps from the current one, wrapping at both ends.
    /// `current` is 1-based, as the counter shows it; 0 means nothing chosen.
    static func step(count: Int, current: Int, delta: Int) -> Int {
        guard count > 0 else { return 0 }
        if current == 0 { return delta >= 0 ? 1 : count }
        let zero = current - 1 + delta
        return ((zero % count) + count) % count + 1
    }

    /// The first match at or after `offset`, so a fresh search starts from
    /// where the reader is rather than from the top of the file.
    static func firstMatch(after offset: Int, in matches: [NSRange]) -> Int {
        guard !matches.isEmpty else { return 0 }
        for (i, range) in matches.enumerated() where range.location >= offset {
            return i + 1
        }
        return 1
    }

    /// One replacement, and the text plus the range it left behind.
    static func replace(in text: String, match: NSRange, with replacement: String) -> (text: String, next: Int) {
        let ns = NSMutableString(string: text)
        ns.replaceCharacters(in: match, with: replacement)
        return (ns as String, match.location + (replacement as NSString).length)
    }

    /// What one match is replaced with. With regex on, the replacement is a
    /// template (`$1` is the first group), as in Cursor; otherwise it is
    /// inserted as typed, `$` included.
    static func replacement(
        for match: NSRange,
        in text: String,
        query: String,
        options: MarkdownFindOptions,
        template: String
    ) -> String {
        guard options.regex, let regex = expression(for: query, options: options),
              let hit = regex.firstMatch(in: text, options: [.withTransparentBounds, .withoutAnchoringBounds], range: match),
              hit.range == match else { return template }
        return regex.replacementString(for: hit, in: text, offset: 0, template: template)
    }

    /// Every occurrence at once (inside `scope` when given). Returns the text
    /// and how many were replaced.
    static func replaceAll(
        in text: String,
        query: String,
        options: MarkdownFindOptions = MarkdownFindOptions(),
        within scope: NSRange? = nil,
        with replacement: String
    ) -> (text: String, count: Int) {
        guard let regex = expression(for: query, options: options) else { return (text, 0) }
        let hits = results(in: text, query: query, options: options, within: scope)
        guard !hits.isEmpty else { return (text, 0) }
        let ns = NSMutableString(string: text)
        for hit in hits.reversed() {
            let value = options.regex
                ? regex.replacementString(for: hit, in: text, offset: 0, template: replacement)
                : replacement
            ns.replaceCharacters(in: hit.range, with: value)
        }
        return (ns as String, hits.count)
    }

    /// The query ⌘F takes from a selection: one line of real text, not a
    /// paragraph (that is what find in selection is for). With regex on it is
    /// escaped, so a selected `a.b` finds itself and not `axb`.
    static func seed(from selected: String, regex: Bool) -> String? {
        guard !selected.isEmpty, selected.count <= 200,
              !selected.contains(where: \.isNewline),
              !selected.allSatisfy(\.isWhitespace) else { return nil }
        return regex ? NSRegularExpression.escapedPattern(for: selected) : selected
    }

    /// The line around `match`, trimmed and cut to about `width` characters
    /// with the match kept in view, and where the match sits in the result.
    /// The "find in all open tabs" list shows it under each file's name.
    static func snippet(in text: String, around match: NSRange, width: Int = 72) -> (text: String, match: NSRange) {
        let ns = text as NSString
        let line = ns.lineRange(for: NSRange(location: match.location, length: 0))
        var start = line.location
        var end = NSMaxRange(line)
        // Leading indentation and the newline say nothing.
        while start < match.location, let c = Unicode.Scalar(ns.character(at: start)), CharacterSet.whitespaces.contains(c) {
            start += 1
        }
        while end > NSMaxRange(match), let c = Unicode.Scalar(ns.character(at: end - 1)), CharacterSet.whitespacesAndNewlines.contains(c) {
            end -= 1
        }
        let matchEnd = min(NSMaxRange(match), end)
        var prefix = ""
        var suffix = ""
        if end - start > width {
            // A third of the room before the match, the rest after it.
            let before = max(0, (width - (matchEnd - match.location)) / 3)
            let cutStart = max(start, match.location - before)
            if cutStart > start { start = cutStart; prefix = "…" }
            if end - start > width {
                end = max(matchEnd, start + width)
                suffix = "…"
            }
        }
        let body = ns.substring(with: NSRange(location: start, length: end - start))
        let location = (prefix as NSString).length + (match.location - start)
        return (prefix + body + suffix, NSRange(location: location, length: max(0, matchEnd - match.location)))
    }

    private static func clamp(_ scope: NSRange?, length: Int) -> NSRange? {
        guard let scope else { return nil }
        let start = min(max(0, scope.location), length)
        let end = min(max(start, NSMaxRange(scope)), length)
        return NSRange(location: start, length: end - start)
    }
}
