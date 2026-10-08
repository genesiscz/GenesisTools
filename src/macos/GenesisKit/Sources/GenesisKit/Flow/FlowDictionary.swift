// Copied from /Users/Martin/Tresors/Projects/GenesisPlayground/Genesis/apps/Genesis/Sources/Genesis/Flow/FlowDictionary.swift at 2026-10-08T05:04:08+02:00 at commit hash 7bd89a24c79510fb90ab0c2a0701c1d085f2023e
import AppKit
import Foundation

/// Text rewriting and the auto-learning dictionary.
///
/// Ported in spirit from BridgeVoice's `detection` module
/// (`analyzer` + `suggestions` + `wordlist`). The idea worth stealing: a
/// dictation dictionary that the user has to populate by hand stays empty, so
/// mine it from what the recogniser actually produces. Tokenise every
/// transcript, count what recurs, and when a token is not a common English
/// word but looks like a term, propose it.
enum FlowDictionary {

    // MARK: - Applying rules

    /// Apply enabled replacements, longest `from` first, in a SINGLE pass.
    ///
    /// Two things here are load-bearing and both were found by tests:
    ///
    /// 1. **One pass, not one pass per rule.** Replacing rule by rule lets a
    ///    later rule chew up an earlier rule's output: with `next js → Next.js`
    ///    and `js → JS`, the second rule matches the "js" inside the freshly
    ///    written "Next.js" and yields "Next.JS". Scanning once and skipping
    ///    past each replacement makes output text immune to later rules.
    /// 2. **Conditional word boundaries.** `\b` between `+` and a space does
    ///    not exist, so `\bc\+\+\b` never matches "c++". The anchor is only
    ///    added on an edge that is actually a word character.
    static func apply(_ rules: [FlowDictionaryRule], to text: String) -> String {
        let pairs = rules
            .filter { $0.enabled && !$0.from.isEmpty }
            .map { ($0.from, $0.to) }
        return replaceOnce(pairs, in: text)
    }

    /// Expand snippet triggers. Same single-pass semantics as `apply`.
    ///
    /// Snippet bodies may contain dynamic variables, resolved at expansion
    /// time. Wispr Flow's snippets are static text only — their docs say so
    /// outright — which makes the obvious uses (dating a note, pulling the
    /// clipboard into a reply) impossible. Supported:
    ///
    /// | Variable | Expands to |
    /// |---|---|
    /// | `{{date}}` | 2026-07-29 |
    /// | `{{time}}` | 14:32 |
    /// | `{{datetime}}` | 2026-07-29 14:32 |
    /// | `{{clipboard}}` | current pasteboard string |
    /// | `{{newline}}` | a line break |
    static func expand(_ snippets: [FlowSnippet], in text: String, now: Date = Date()) -> String {
        let pairs = snippets
            .filter { $0.enabled && !$0.trigger.isEmpty }
            .map { ($0.trigger, resolveVariables(in: $0.body, now: now)) }
        return replaceOnce(pairs, in: text)
    }

    private static let dateFormatter: DateFormatter = {
        let f = DateFormatter()
        f.dateFormat = "yyyy-MM-dd"
        return f
    }()

    private static let timeFormatter: DateFormatter = {
        let f = DateFormatter()
        f.dateFormat = "HH:mm"
        return f
    }()

    /// Substitute `{{…}}` placeholders. Unknown names are left alone rather
    /// than blanked, so a typo is visible in the output instead of silently
    /// deleting text the user dictated.
    static func resolveVariables(in body: String, now: Date = Date()) -> String {
        guard body.contains("{{") else { return body }
        var out = body
        out = out.replacingOccurrences(of: "{{date}}", with: dateFormatter.string(from: now))
        out = out.replacingOccurrences(of: "{{time}}", with: timeFormatter.string(from: now))
        out = out.replacingOccurrences(
            of: "{{datetime}}",
            with: "\(dateFormatter.string(from: now)) \(timeFormatter.string(from: now))"
        )
        out = out.replacingOccurrences(of: "{{newline}}", with: "\n")
        if out.contains("{{clipboard}}") {
            let clip = NSPasteboard.general.string(forType: .string) ?? ""
            out = out.replacingOccurrences(of: "{{clipboard}}", with: clip)
        }
        return out
    }

    /// Word-boundary anchors that survive terms ending in punctuation.
    private static func pattern(for needle: String) -> String {
        let escaped = NSRegularExpression.escapedPattern(for: needle)
        let leading = needle.first.map { $0.isLetter || $0.isNumber || $0 == "_" } ?? false
        let trailing = needle.last.map { $0.isLetter || $0.isNumber || $0 == "_" } ?? false
        return (leading ? "(?<!\\w)" : "") + escaped + (trailing ? "(?!\\w)" : "")
    }

    /// Scan `text` once, replacing the longest matching needle at each point.
    private static func replaceOnce(_ pairs: [(String, String)], in text: String) -> String {
        guard !text.isEmpty, !pairs.isEmpty else { return text }
        let ordered = pairs.sorted { $0.0.utf8.count > $1.0.utf8.count }

        let alternation = ordered.map { pattern(for: $0.0) }.joined(separator: "|")
        guard let regex = try? NSRegularExpression(pattern: alternation, options: [.caseInsensitive]) else {
            return text
        }

        let ns = text as NSString
        let matches = regex.matches(in: text, options: [], range: NSRange(location: 0, length: ns.length))
        guard !matches.isEmpty else { return text }

        var out = ""
        var cursor = 0
        for match in matches {
            guard match.range.location >= cursor else { continue }   // overlapping: keep the first
            out += ns.substring(with: NSRange(location: cursor, length: match.range.location - cursor))
            let hit = ns.substring(with: match.range)
            // Longest-first ordering means the first needle that equals the hit
            // is the one the alternation preferred.
            let replacement = ordered.first { $0.0.compare(hit, options: .caseInsensitive) == .orderedSame }?.1
            out += replacement ?? hit
            cursor = match.range.location + match.range.length
        }
        out += ns.substring(from: cursor)
        return out
    }

    // MARK: - Tokenizing

    /// Split into lowercase word tokens, dropping punctuation and digits.
    static func tokenize(_ text: String) -> [String] {
        text.lowercased()
            .split(whereSeparator: { !$0.isLetter && $0 != "'" && $0 != "-" })
            .map(String.init)
            .filter { $0.utf8.count >= 3 }
    }

    /// Words common enough that seeing them proves nothing.
    ///
    /// Deliberately small and hand-picked rather than a full dictionary: the
    /// goal is only to filter the high-frequency English that would otherwise
    /// dominate every suggestion list. Anything not here is merely "not
    /// obviously common", which is exactly the signal we want.
    private static let commonWords: Set<String> = [
        "the", "and", "for", "are", "but", "not", "you", "all", "can", "her", "was", "one",
        "our", "out", "his", "has", "had", "how", "its", "may", "new", "now", "old", "see",
        "two", "way", "who", "did", "get", "him", "let", "put", "say", "she", "too", "use",
        "that", "this", "with", "have", "from", "they", "know", "want", "been", "good",
        "much", "some", "time", "very", "when", "come", "here", "just", "like", "long",
        "make", "many", "over", "such", "take", "than", "them", "well", "were", "what",
        "will", "your", "about", "after", "again", "could", "every", "first", "found",
        "great", "house", "large", "learn", "never", "other", "place", "plant", "point",
        "right", "small", "sound", "spell", "still", "study", "their", "there", "these",
        "thing", "think", "three", "water", "where", "which", "world", "would", "write",
        "because", "before", "between", "through", "should", "really", "actually",
        "something", "someone", "anything", "everything", "going", "doing", "need", "needs",
        "yeah", "okay", "sure", "then", "also", "into", "only", "back", "down", "even",
        "more", "most", "must", "same", "them", "used", "using", "give", "went", "look",
    ]

    static func isCommonWord(_ token: String) -> Bool {
        commonWords.contains(token)
    }

    /// Heuristic: does this look like a term worth a dictionary entry?
    ///
    /// True for things a general recogniser tends to mangle — long words, words
    /// with internal punctuation ("next.js" arrives as "next js"), and words
    /// with unusual letter patterns. Kept conservative: a false positive costs
    /// the user one dismissal, but a noisy suggester gets switched off.
    static func isLikelyTechnical(_ token: String) -> Bool {
        guard token.utf8.count >= 4 else { return false }
        if isCommonWord(token) { return false }
        if token.contains("-") { return true }

        let vowels = Set("aeiou")
        let letters = Array(token)
        let vowelCount = letters.filter { vowels.contains($0) }.count
        // Very low vowel density reads as an acronym or an identifier.
        if vowelCount == 0 { return true }
        let density = Double(vowelCount) / Double(letters.count)
        if density < 0.25 { return true }
        // Long and uncommon is enough on its own.
        return token.utf8.count >= 8
    }

    // MARK: - Learning

    /// Per-word counters. Persisted inside the suggestion store's lifetime
    /// only — this is a heuristic, not an archive.
    struct WordStats: Equatable {
        var occurrences: Int = 0
        var lastSeen: Date = Date()
    }

    /// Fold one transcript into `stats` and return suggestions worth raising.
    ///
    /// - Parameters:
    ///   - existingRules: already-accepted dictionary entries, so we never
    ///     re-suggest something the user has handled.
    ///   - dismissed: lowercase tokens the user rejected before.
    ///   - minimumOccurrences: how many times a token must appear across turns
    ///     before it is worth interrupting the user about.
    static func learn(
        from transcript: String,
        stats: inout [String: WordStats],
        existingRules: [FlowDictionaryRule],
        dismissed: Set<String>,
        minimumOccurrences: Int = 3
    ) -> [FlowSuggestion] {
        let known = Set(existingRules.map { $0.from.lowercased() })
        var raised: [FlowSuggestion] = []

        for token in tokenize(transcript) {
            var entry = stats[token] ?? WordStats()
            entry.occurrences += 1
            entry.lastSeen = Date()
            stats[token] = entry

            guard entry.occurrences == minimumOccurrences else { continue }
            guard !known.contains(token), !dismissed.contains(token) else { continue }
            guard isLikelyTechnical(token) else { continue }

            raised.append(
                FlowSuggestion(
                    heard: token,
                    suggested: token,
                    reason: .technicalTerm,
                    occurrences: entry.occurrences
                )
            )
        }
        return raised
    }
}
