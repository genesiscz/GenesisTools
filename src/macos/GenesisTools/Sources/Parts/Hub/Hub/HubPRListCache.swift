import Foundation

/// The last `tools hub pr list` / `tools hub pr show` answers, in GenesisKit's `DiskCache` under
/// `~/.genesis-tools/hub/cache/`. The PR list and detail paint them at once and refresh behind them;
/// the CLI itself always answers fresh.
enum PRListCache {
    private static let lists = DiskCache(folder: "hub", namespace: "prs")
    private static let details = DiskCache(folder: "hub", namespace: "pr")

    /// A list: its projects, state, mine and search.
    static func key(paths: [String], state: String, mine: Bool, query: String) -> String {
        "\(paths.sorted().joined(separator: "\n"))|\(state)|\(mine)|\(query)"
    }

    static func readList(_ key: String) -> Data? { lists.readData(key: key) }

    /// The last list written with these filters, whatever its projects: the project set follows the
    /// recent sessions, so the exact key misses after any new folder, and the old rows still paint.
    static func readLastList(state: String, mine: Bool, query: String) -> Data? {
        lists.readData(key: lastKey(state: state, mine: mine, query: query))
    }

    static func writeList(_ data: Data, key: String, limit: Int, state: String, mine: Bool, query: String) {
        lists.writeData(data, key: key)
        lists.writeData(data, key: lastKey(state: state, mine: mine, query: query))
        HubDefaults.store.set(limit, forKey: "hub.prs.limit.\(lists.url(for: key).lastPathComponent)")
    }

    private static func lastKey(state: String, mine: Bool, query: String) -> String {
        "last|\(state)|\(mine)|\(query)"
    }

    /// How many PRs per project the list held when it was cached ("Load more" raises it).
    static func limit(_ key: String) -> Int {
        HubDefaults.store.integer(forKey: "hub.prs.limit.\(lists.url(for: key).lastPathComponent)")
    }

    /// One PR's `tools hub pr show` answer, by the PR's id (its URL).
    static func readDetail(_ id: String) -> Data? { details.readData(key: id) }

    static func writeDetail(_ data: Data, id: String) { details.writeData(data, key: id) }
}

/// The sidebar filter read as a PR search: `author:<name>` (or `@<name>`), `#123` / `!123` ids, and
/// free text. A bare number is an id and text at once, since titles carry numbers ("Expo 57").
/// The same grammar goes to the forge as `tools hub pr list --query`.
struct PRQuery: Equatable {
    var author: String?
    var numbers: [Int] = []
    var text: [String] = []

    init(_ raw: String) {
        for token in raw.split(whereSeparator: \.isWhitespace).map(String.init) {
            let lower = token.lowercased()
            if lower.hasPrefix("author:"), lower.count > 7 {
                author = String(lower.dropFirst(7))
            } else if lower.hasPrefix("@"), lower.count > 1 {
                author = String(lower.dropFirst())
            } else if let first = lower.first, first == "#" || first == "!", let number = Int(lower.dropFirst()) {
                numbers.append(number)
            } else if let number = Int(lower) {
                numbers.append(number)
                text.append(lower)
            } else {
                text.append(lower)
            }
        }
    }

    var isEmpty: Bool { author == nil && numbers.isEmpty && text.isEmpty }

    func matches(_ pr: HubPR) -> Bool {
        if let author, !(pr.author ?? "").lowercased().contains(author) {
            return false
        }
        if numbers.contains(pr.number) {
            return true
        }
        let haystack = "\(pr.repo) \(pr.label) \(pr.title) \(pr.author ?? "") \(pr.headBranch)".lowercased()
        let words = text.filter { !haystack.contains($0) }
        // An id-only search ("!7412") matches by number alone.
        return words.isEmpty && !(text.isEmpty && !numbers.isEmpty)
    }
}
