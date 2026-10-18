import Foundation
import SwiftUI

// PR/MR descriptions with their references as links: `#12` / `!12` (and `owner/repo#12`), and the
// branch names the text mentions. Every URL is built from `ForgeWeb`; nothing here asks the host
// whether a number or a branch exists. A PR the hub already lists opens in the hub, with a ↗ beside
// it for the browser.

/// What the linker knows about the PR's project.
struct PRLinkContext {
    var forge: ForgeWeb?
    /// Branch names known to exist: the hub list's head and base branches of this project, and the
    /// description's names that `tools hub pr show` found among the checkout's refs.
    var branches: Set<String> = []
    /// The hub's id of this project's PR/MR `n`, when the hub lists it.
    var inApp: (Int) -> String? = { _ in nil }

    /// `feat`, `fix`, … : the first segment of every known branch with a slash. A token with one of
    /// these prefixes follows the repository's branch naming even when no ref names it locally.
    var branchPrefixes: Set<String> {
        Set(branches.compactMap { name in
            let parts = name.split(separator: "/", maxSplits: 1)
            return parts.count == 2 ? String(parts[0]) : nil
        })
    }
}

enum PRDescriptionLinker {
    /// `genesistools-hub://pr?id=<hub PR id>`: the description view opens these in the hub.
    static let scheme = "genesistools-hub"

    static func inAppURL(prID: String) -> URL? {
        var components = URLComponents()
        components.scheme = scheme
        components.host = "pr"
        components.queryItems = [URLQueryItem(name: "id", value: prID)]
        return components.url
    }

    /// The hub PR id of an `inAppURL`, nil for any other URL.
    static func prID(from url: URL) -> String? {
        guard url.scheme == scheme, url.host == "pr" else { return nil }
        return URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems?.first { $0.name == "id" }?.value
    }

    /// Code spans, markdown links, autolinks and bare URLs: text the linker never rewrites inside
    /// (a code span that is exactly a branch name becomes a link as a whole).
    private static let protected = try! NSRegularExpression(
        pattern: #"`[^`\n]+`|\[[^\]\n]*\]\([^)\n]*\)|<https?://[^>\s]+>|https?://[^\s<>()\]]+"#
    )

    /// Group 1: an optional `owner/repo` (GitLab: `group/sub/project`); 2: `#` or `!`; 3: the number.
    /// Group 4: a slash token that may be a branch.
    private static let token = try! NSRegularExpression(
        pattern: #"(?<![\w/#&!.\-])(?:([A-Za-z0-9_.\-]+/[A-Za-z0-9_./\-]*[A-Za-z0-9_\-]))?([#!])(\d+)(?![\w])|(?<![\w./\-])([A-Za-z0-9._\-]+(?:/[A-Za-z0-9._\-]+)+)"#
    )

    private static let htmlComment = try! NSRegularExpression(pattern: #"<!--[\s\S]*?-->\n?"#)

    /// The markdown with references and branch names as links, and HTML comments (bot markers such
    /// as "This is an auto-generated comment") removed. Fenced code blocks stay as they are.
    static func linkify(_ markdown: String, context: PRLinkContext) -> String {
        let stripped = replace(htmlComment, in: markdown) { _ in "" }
        var inFence = false
        return stripped.components(separatedBy: "\n").map { line in
            if line.trimmingCharacters(in: .whitespaces).hasPrefix("```") {
                inFence.toggle()
                return line
            }

            return inFence ? line : linkifyLine(line, context: context)
        }.joined(separator: "\n")
    }

    private static func linkifyLine(_ line: String, context: PRLinkContext) -> String {
        let ns = line as NSString
        var output = ""
        var cursor = 0
        for match in protected.matches(in: line, range: NSRange(location: 0, length: ns.length)) {
            output += linkifyPlain(ns.substring(with: NSRange(location: cursor, length: match.range.location - cursor)), context: context)
            let span = ns.substring(with: match.range)
            if span.hasPrefix("`"), let url = branchURL(String(span.dropFirst().dropLast()), context: context, codeSpan: true) {
                output += "[\(span)](<\(url.absoluteString)>)"
            } else {
                output += span
            }
            cursor = match.range.location + match.range.length
        }
        output += linkifyPlain(ns.substring(from: cursor), context: context)
        return output
    }

    private static func linkifyPlain(_ text: String, context: PRLinkContext) -> String {
        replace(token, in: text) { match in
            let whole = match.string
            if let marker = match.group(2), let number = match.group(3).flatMap({ Int($0) }) {
                return reference(whole, owner: match.group(1), marker: marker, number: number, context: context) ?? whole
            }

            // A ref never starts with a dot, so "../feat/x" or ".feat/x" is a path, not a branch.
            guard let candidate = match.group(4), !candidate.hasPrefix(".") else { return whole }
            // "feat/x." at the end of a sentence: the trailing periods are prose, not part of the name.
            var trimmed = Substring(candidate)
            while trimmed.last == "." {
                trimmed = trimmed.dropLast()
            }
            let name = String(trimmed)
            let tail = String(candidate.dropFirst(name.count))
            guard let url = branchURL(name, context: context, codeSpan: false) else { return whole }
            return "[\(name)](<\(url.absoluteString)>)\(tail)"
        }
    }

    private static func reference(_ text: String, owner: String?, marker: String, number: Int, context: PRLinkContext) -> String? {
        guard let forge = context.forge else { return nil }
        // GitHub has no `!n`; a GitLab `#n` is an issue, never an MR.
        let isChange = forge.kind == .gitlab ? marker == "!" : true
        if forge.kind == .github, marker == "!" { return nil }
        let target: ForgeWeb?
        if let owner {
            target = forge.sibling(owner)
        } else {
            target = forge
        }
        guard let target else { return nil }
        let web = forge.kind == .gitlab
            ? (isChange ? target.pullRequest(number) : target.issue(number))
            : target.issue(number)
        guard let web else { return nil }
        if owner == nil, isChange, let id = context.inApp(number), let app = inAppURL(prID: id) {
            return "[\(text)](<\(app.absoluteString)>)[↗](<\(web.absoluteString)>)"
        }

        return "[\(text)](<\(web.absoluteString)>)"
    }

    /// A branch page for `name` when it is a known branch, or (outside a code span, and with a
    /// slash) when its first segment is one of the repository's branch prefixes. A slash-less name
    /// counts only in a code span: "develop" in a sentence is a verb.
    static func branchURL(_ name: String, context: PRLinkContext, codeSpan: Bool) -> URL? {
        guard let forge = context.forge, !name.isEmpty, !name.contains(" ") else { return nil }
        let known = context.branches.contains(name)
        let hasSlash = name.contains("/")
        if known, hasSlash || codeSpan {
            return forge.branch(name)
        }

        guard hasSlash, let prefix = name.split(separator: "/").first, context.branchPrefixes.contains(String(prefix)) else { return nil }
        return forge.branch(name)
    }

    private static func replace(_ regex: NSRegularExpression, in text: String, with transform: (RegexMatch) -> String) -> String {
        let ns = text as NSString
        var output = ""
        var cursor = 0
        for match in regex.matches(in: text, range: NSRange(location: 0, length: ns.length)) {
            output += ns.substring(with: NSRange(location: cursor, length: match.range.location - cursor))
            output += transform(RegexMatch(result: match, source: ns))
            cursor = match.range.location + match.range.length
        }
        output += ns.substring(from: cursor)
        return output
    }

    fileprivate struct RegexMatch {
        let result: NSTextCheckingResult
        let source: NSString

        var string: String { source.substring(with: result.range) }

        func group(_ index: Int) -> String? {
            let range = result.range(at: index)
            return range.location == NSNotFound ? nil : source.substring(with: range)
        }
    }
}

// MARK: - State colors

/// One look per PR/MR state, shared by the list icon, the header pill and state-like labels:
/// open green, draft grey, merged purple, closed red.
enum PRStateTone: Equatable {
    case open
    case draft
    case merged
    case closed
    /// A label that claims a state the PR has not reached ("NOT merged into develop").
    case pending

    static let mergedColor = Color(red: 0.66, green: 0.5, blue: 1)

    init(pr: HubPR) {
        if pr.draft {
            self = .draft
        } else {
            switch pr.state {
            case "MERGED": self = .merged
            case "CLOSED": self = .closed
            default: self = .open
            }
        }
    }

    /// The tone of a label that names a state, nil for any other label ("ui", "backend").
    init?(label: String) {
        let text = label.lowercased()
        func has(_ pattern: String) -> Bool { text.range(of: pattern, options: .regularExpression) != nil }
        if has(#"\b(not|un)[\s-]*merged\b"#) {
            self = .pending
        } else if has(#"\bmerged\b"#) {
            self = .merged
        } else if has(#"\b(closed|rejected|declined|abandoned|won'?t[\s-]?fix)\b"#) {
            self = .closed
        } else if has(#"\b(draft|wip|work in progress)\b"#) {
            self = .draft
        } else if has(#"\b(open|ready|approved)\b"#) {
            self = .open
        } else {
            return nil
        }
    }

    var color: Color {
        switch self {
        case .open: return ReviewPalette.added
        case .draft: return ReviewPalette.dim
        case .merged: return Self.mergedColor
        case .closed: return ReviewPalette.removed
        case .pending: return ReviewPalette.modified
        }
    }

    var symbol: String {
        switch self {
        case .open: return "arrow.triangle.pull"
        case .draft: return "circle.dashed"
        case .merged: return "arrow.triangle.merge"
        case .closed: return "xmark.circle"
        case .pending: return "clock"
        }
    }

    var title: String {
        switch self {
        case .open: return "Open"
        case .draft: return "Draft"
        case .merged: return "Merged"
        case .closed: return "Closed"
        case .pending: return "Pending"
        }
    }
}
