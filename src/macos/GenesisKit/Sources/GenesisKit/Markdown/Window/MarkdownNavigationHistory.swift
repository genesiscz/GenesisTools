import Foundation

/// The notes the viewer showed, in order, for Back and Forward (⌘ with the two keys right of P, `MarkdownKeymap`).
/// A visit after going back drops the notes ahead, the way a browser does. An entry is a file path; one that no
/// longer exists is stepped over, not shown.
struct MarkdownNavigationHistory: Equatable {
    static let limit = 100

    private(set) var entries: [String] = []
    /// The entry shown now; -1 before the first visit.
    private(set) var index = -1

    var current: String? { entries.indices.contains(index) ? entries[index] : nil }

    /// Records `id` as the note shown now. Showing the current note again changes nothing.
    mutating func visit(_ id: String) {
        guard id != current else { return }
        if index + 1 < entries.count { entries.removeSubrange((index + 1)...) }
        entries.append(id)
        if entries.count > Self.limit { entries.removeFirst(entries.count - Self.limit) }
        index = entries.count - 1
    }

    /// Moves to the nearest earlier note `exists` accepts and returns it; nil (and no move) when there is none.
    mutating func back(where exists: (String) -> Bool) -> String? {
        step(by: -1, where: exists)
    }

    /// Moves to the nearest later note `exists` accepts and returns it; nil (and no move) when there is none.
    mutating func forward(where exists: (String) -> Bool) -> String? {
        step(by: 1, where: exists)
    }

    func canGoBack(where exists: (String) -> Bool) -> Bool {
        entries.indices.contains(index) && entries[..<index].contains(where: exists)
    }

    func canGoForward(where exists: (String) -> Bool) -> Bool {
        index + 1 < entries.count && entries[(index + 1)...].contains(where: exists)
    }

    /// A file renamed or moved: its entries follow it.
    mutating func rename(_ old: String, to new: String) {
        entries = entries.map { $0 == old ? new : $0 }
    }

    private mutating func step(by delta: Int, where exists: (String) -> Bool) -> String? {
        var candidate = index + delta
        while entries.indices.contains(candidate) {
            if entries[candidate] != current, exists(entries[candidate]) {
                index = candidate
                return entries[candidate]
            }
            candidate += delta
        }
        return nil
    }
}
