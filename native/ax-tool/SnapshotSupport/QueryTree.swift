import ApplicationServices
import Foundation

/// A query-scoped observation: the window is walked in full, but only the elements that match,
/// their ancestors and the root become rows. A GitHub pull request or an open panel over
/// ~/Downloads exceeds the 4000-row snapshot limit, so a whole-window `see` refuses there, while
/// one button on it is still a small, exact target. The walk is deterministic (no row depends on
/// timing), so `act` re-walks the same query and gets the same rows, indexes and digest.
public struct TreeQuery: Codable, Equatable {
    public let text: String
    public let role: String?

    public init(text: String, role: String?) {
        self.text = text
        self.role = role
    }
}

/// What the query walk read and what it did not.
public struct QueryWalkReport: Equatable {
    public var walked = 0
    public var matches = 0
    /// Elements at the depth limit whose children were not read. A match below them is not seen.
    public var depthLimitedSubtrees = 0
    public var vanished = 0

    public var dictionary: [String: Any] {
        ["walked": walked, "matches": matches, "depthLimitedSubtrees": depthLimitedSubtrees, "vanished": vanished]
    }
}

public let queryWalkLimit = 60_000
public let queryMatchLimit = 200

/// Title, description, identifier and string value, case-insensitively; the role must be equal.
/// The same fields `computer.find` searches in a retained state.
private func queryMatches(_ element: AXUIElement, query: TreeQuery, source: HierarchySource) -> Bool {
    if let role = query.role, (source.attribute(element, "AXRole") as? String) != role {
        return false
    }
    let needle = query.text.lowercased()
    return ["AXTitle", "AXDescription", "AXIdentifier", "AXValue"].contains { key in
        (source.attribute(element, key) as? String)?.lowercased().contains(needle) == true
    }
}

/// Hands the tree builder only the kept elements, in their original order.
private struct KeptHierarchySource: HierarchySource {
    let base: HierarchySource
    let kept: SnapshotObjectSet

    func attribute(_ element: AXUIElement, _ name: String) -> Any? { base.attribute(element, name) }
    func children(of element: AXUIElement) throws -> [AXUIElement] {
        try base.children(of: element).filter { kept.contains($0) }
    }
    func actionNames(of element: AXUIElement) -> [String] { base.actionNames(of: element) }
    func isValueSettable(_ element: AXUIElement) -> Bool? { base.isValueSettable(element) }
}

public func buildQueryTree(root: AXUIElement, source: HierarchySource, depth: Int, query: TreeQuery,
                           expired: () -> Bool = { false }) throws -> (tree: ObservedTreeData, report: QueryWalkReport) {
    guard (1...50).contains(depth) else {
        throw ObservedTreeError("--depth must be between 1 and 50")
    }
    guard !query.text.trimmingCharacters(in: .whitespaces).isEmpty else {
        throw ObservedTreeError("a query scope needs a non-empty query")
    }
    var report = QueryWalkReport()
    var visited = SnapshotObjectSet()
    var kept = SnapshotObjectSet()
    _ = kept.insert(root)
    var path: [AXUIElement] = []
    func walk(_ element: AXUIElement, level: Int) throws {
        guard visited.insert(element) else { return }
        report.walked += 1
        guard report.walked <= queryWalkLimit else {
            throw ObservedTreeError("query walk exceeded \(queryWalkLimit) elements; narrow it with a role or pick a smaller window")
        }
        guard !expired() else {
            throw ObservedTreeError(observationBudgetMessage(walked: report.walked))
        }
        path.append(element)
        defer { path.removeLast() }
        if level > 0, queryMatches(element, query: query, source: source) {
            report.matches += 1
            guard report.matches <= queryMatchLimit else {
                throw ObservedTreeError("query matches more than \(queryMatchLimit) elements; narrow it with a role or a longer query")
            }
            for ancestor in path { _ = kept.insert(ancestor) }
        }
        let children: [AXUIElement]
        do {
            children = try source.children(of: element)
        } catch is VanishedElement {
            report.vanished += 1
            return
        }
        guard level < depth else {
            if !children.isEmpty { report.depthLimitedSubtrees += 1 }
            return
        }
        for child in children {
            try walk(child, level: level + 1)
        }
    }
    try walk(root, level: 0)
    let tree = try buildObservedTree(root: root, source: KeptHierarchySource(base: source, kept: kept), depth: depth,
                                     scope: "window", expired: expired)
    return (tree, report)
}
