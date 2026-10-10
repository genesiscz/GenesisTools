import Foundation

/// A count with its noun: "1 file", "3 files", "2 replies", "1 open item". One helper, so no view prints "1 files"
/// or "1 commits" again (hub inventory H10, 2026-10-10: five places did).
///
///     Plural.count(files.count, "file")          // "1 file", "4 files"
///     Plural.count(n, "reply")                   // "2 replies"
///     Plural.count(n, "person", "people")        // an irregular noun names its plural
///     Plural.word(n, "agent")                    // the noun alone, for "\(n) sub-\(word)"
public enum Plural {
    public static func count(_ count: Int, _ singular: String, _ plural: String? = nil) -> String {
        "\(count) \(word(count, singular, plural))"
    }

    public static func word(_ count: Int, _ singular: String, _ plural: String? = nil) -> String {
        count == 1 ? singular : (plural ?? regular(singular))
    }

    /// English regular plurals of the last word: "reply" → "replies", "match" → "matches", "key" → "keys".
    static func regular(_ singular: String) -> String {
        let lower = singular.lowercased()
        if lower.hasSuffix("y"), let before = lower.dropLast().last, !"aeiou".contains(before) {
            return String(singular.dropLast()) + "ies"
        }
        if ["s", "x", "z", "ch", "sh"].contains(where: { lower.hasSuffix($0) }) {
            return singular + "es"
        }
        return singular + "s"
    }
}
