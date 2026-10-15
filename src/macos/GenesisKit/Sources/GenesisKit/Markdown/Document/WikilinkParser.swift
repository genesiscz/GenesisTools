import Foundation

/// Obsidian wikilink / embed parser (mirrors @genesis/obsidian-model).
public enum WikilinkParser {
    public struct Link: Equatable, Sendable {
        public var raw: String
        public var target: String
        public var heading: String?
        public var block: String?
        public var alias: String?
        public var embed: Bool
        public var range: NSRange
    }

    private static let pattern =
        #"(!)?\[\[([^\]|#]+?)(?:#(?:\^([^\]]+?)|([^\]|]+)))?(?:\|([^\]]+))?\]\]"#

    public static func parse(_ markdown: String) -> [Link] {
        guard let re = try? NSRegularExpression(pattern: pattern, options: []) else { return [] }
        let ns = markdown as NSString
        let full = NSRange(location: 0, length: ns.length)
        return re.matches(in: markdown, options: [], range: full).compactMap { m in
            let raw = ns.substring(with: m.range)
            let embed = m.range(at: 1).location != NSNotFound
            guard m.range(at: 2).location != NSNotFound else { return nil }
            let target = ns.substring(with: m.range(at: 2)).trimmingCharacters(in: .whitespaces)
            guard !target.isEmpty else { return nil }
            var block: String?
            var heading: String?
            if m.range(at: 3).location != NSNotFound {
                block = ns.substring(with: m.range(at: 3)).trimmingCharacters(in: .whitespaces)
            }
            if m.range(at: 4).location != NSNotFound {
                heading = ns.substring(with: m.range(at: 4)).trimmingCharacters(in: .whitespaces)
            }
            var alias: String?
            if m.range(at: 5).location != NSNotFound {
                alias = ns.substring(with: m.range(at: 5)).trimmingCharacters(in: .whitespaces)
            }
            return Link(
                raw: raw,
                target: target,
                heading: heading,
                block: block,
                alias: alias,
                embed: embed,
                range: m.range
            )
        }
    }

    public static func extractTargets(_ markdown: String) -> [String] {
        var seen = Set<String>()
        var out: [String] = []
        for l in parse(markdown) {
            if seen.insert(l.target).inserted { out.append(l.target) }
        }
        return out
    }
}
