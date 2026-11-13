import Foundation

/// How a path is shown in a label or a toast: the home folder as `~`.
public enum PathDisplay {
    public static func tilde(_ path: String) -> String {
        let home = FileManager.default.homeDirectoryForCurrentUser.path
        if path == home {
            return "~"
        }

        // Only below the home folder: a sibling such as `/Users/mean` keeps its full path.
        return path.hasPrefix(home + "/") ? "~" + path.dropFirst(home.count) : path
    }

    /// Every mention of the user's home in `text` as `~`: `/Users/<user>` (macOS), `/home/<user>` (Linux),
    /// `<drive>:\Users\<user>` with either slash and any case (Windows), and the home itself wherever it is. The rest of
    /// each path stays as it was. For a text a person posts or pastes (a failure report, its log, an issue body), where a
    /// path sits inside a sentence or a stack trace; `tilde(_:)` is for one path. The same rule as `shortenHomePaths`
    /// in src/utils/paths.ts. `home` is a test seam.
    public static func shortenHome(in text: String,
                                   home: String = FileManager.default.homeDirectoryForCurrentUser.path) -> String {
        let separators: (Character) -> Bool = { $0 == "/" || $0 == "\\" }
        let parts = home.split(omittingEmptySubsequences: false, whereSeparator: separators)
            .map(String.init)
        let trimmed = Array(parts.reversed().drop(while: \.isEmpty).reversed())
        guard !text.isEmpty, let user = trimmed.last, !user.isEmpty else { return text }
        let slash = #"[\\/]+"#
        let name = NSRegularExpression.escapedPattern(for: user)
        let homes = [
            trimmed.map { NSRegularExpression.escapedPattern(for: $0) }.joined(separator: slash),
            "/Users/\(name)",
            "/home/\(name)",
            "[A-Za-z]:\(slash)Users\(slash)\(name)",
        ]
        let pattern = #"(?<![\w.-])(?:"# + homes.joined(separator: "|") + #")(?![\w.-])"#
        guard let regex = try? NSRegularExpression(pattern: pattern, options: [.caseInsensitive]) else { return text }
        let range = NSRange(text.startIndex..., in: text)
        return regex.stringByReplacingMatches(in: text, range: range, withTemplate: "~")
    }
}
