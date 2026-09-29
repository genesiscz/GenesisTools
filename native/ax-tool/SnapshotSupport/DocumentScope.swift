import Foundation

/// The browser page inside an observed window: where its subtree starts, how many rows it spans,
/// and a digest of those rows with positions made relative to the page.
///
/// A browser's own chrome moves on its own: Brave's tab labels carry a live figure ("Extensions -
/// Memory usage - 166 MB") that changes every few seconds, so the whole-window digest refused every
/// act on a page element as "UI changed" seconds after `see`. A page target is checked against the
/// page instead. The page must be unchanged, row for row, and the target keeps its position in it.
public struct DocumentScope: Codable, Equatable {
    public let index: Int
    public let count: Int
    public let digest: String

    public init(index: Int, count: Int, digest: String) {
        self.index = index
        self.count = count
        self.digest = digest
    }
}

/// The one top-level web area (the shallowest AXWebArea with a URL) and its subtree; nil when
/// there is none or more than one, so the caller keeps the whole-window check.
public func documentScope(_ rows: [[String: Any]]) throws -> DocumentScope? {
    let webAreas = rows.indices.filter { rows[$0]["role"] as? String == "AXWebArea" && rows[$0]["AXURL"] is String }
    guard let top = webAreas.compactMap({ rows[$0]["depth"] as? Int }).min() else { return nil }
    let pages = webAreas.filter { rows[$0]["depth"] as? Int == top }
    guard pages.count == 1, let start = pages.first else { return nil }
    var end = start + 1
    while end < rows.count, (rows[end]["depth"] as? Int ?? 0) > top {
        end += 1
    }
    let relative = rows[start..<end].map { row -> [String: Any] in
        var copy = row.filter { $0.key != "identity" }
        copy["index"] = (row["index"] as? Int ?? 0) - start
        copy["depth"] = (row["depth"] as? Int ?? 0) - top
        return copy
    }
    return DocumentScope(index: start, count: end - start, digest: try snapshotDigest(relative))
}

/// The current index of an observed page target, or nil when the target is outside the page or
/// the page changed at all, in which case the whole-window refusal stands.
public func remapDocumentTarget(observedIndex: Int, observed: DocumentScope?, current: DocumentScope?) -> Int? {
    guard let observed, let current, observed.digest == current.digest, observed.count == current.count,
          observedIndex > observed.index, observedIndex < observed.index + observed.count else { return nil }
    return current.index + (observedIndex - observed.index)
}
