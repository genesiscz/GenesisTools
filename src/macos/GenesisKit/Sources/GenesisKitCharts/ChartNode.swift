import Foundation
import GenesisKit

/// An sRGB colour a host gives a chart node (to colour by age or type instead of by branch). Plain numbers, so a node
/// stays `Sendable` and `Equatable`.
public struct ChartColor: Equatable, Hashable, Sendable {
    public let red: Double
    public let green: Double
    public let blue: Double

    public init(red: Double, green: Double, blue: Double) {
        self.red = red
        self.green = green
        self.blue = blue
    }
}

/// One node of the hierarchy a `SunburstChart` or a `TreemapView` draws: a folder and its subfolders, a category and
/// its parts. `value` is the node's own size; a node whose children add up to more is drawn at their sum. The space a
/// node has beyond its children (its own files, unaccounted bytes) stays empty in the next ring, so a gap means
/// "here, but not in a child".
public struct ChartNode: Identifiable, Equatable, Sendable {
    public let id: String
    public let name: String
    public let value: Double
    public let children: [ChartNode]
    /// Drawn grey whatever its branch: files, "other", unaccounted space.
    public let muted: Bool
    /// Overrides the branch colour (still lighter with depth); nil keeps the branch's hue.
    public let color: ChartColor?

    public init(
        id: String, name: String, value: Double, children: [ChartNode] = [], muted: Bool = false,
        color: ChartColor? = nil
    ) {
        self.id = id
        self.name = name
        self.value = value
        self.children = children
        self.muted = muted
        self.color = color
    }
}

/// A hierarchy flattened once for drawing: every node with a positive size gets its span of the root as `x0..<x1`
/// (fractions of the root), its depth, its parent and children, its top-level branch and its rank among its siblings.
/// Children are ordered by size, largest first, ties by id, so the same tree always lays out the same way. A node's
/// size is its value, or its positive children's sum when that is larger, so a folder of value 0 with files in it is
/// kept; a node whose size is zero or less is left out with its subtree.
///
/// Building it is one pass over the tree (sizes bottom-up, then spans top-down). It is `Sendable` and `Equatable`, so
/// a host with a large tree can build it once off the main thread and hand the same value to both `SunburstChart` and
/// `TreemapView` (their `partition:` initializers).
public struct ChartPartition: Sendable, Equatable {
    public struct Item: Sendable, Equatable {
        public let id: String
        public let name: String
        /// The node's size: its value, or its children's sum when that is larger.
        public let value: Double
        public let depth: Int
        public let x0: Double
        public let x1: Double
        public let parent: Int?
        public internal(set) var children: [Int]
        /// The index of the root's child this node descends from; -1 for the root.
        public let branch: Int
        /// Rank among its siblings, 0 for the largest.
        public let sibling: Int
        public let muted: Bool
        public let color: ChartColor?

        public var span: Double { x1 - x0 }
    }

    public let items: [Item]
    private let index: [String: Int]

    public static func == (lhs: ChartPartition, rhs: ChartPartition) -> Bool { lhs.items == rhs.items }

    /// A node with its size worked out, and its kept children in drawing order.
    private struct Sized {
        let node: ChartNode
        let total: Double
        let kids: [Sized]

        init(_ node: ChartNode) {
            var kids: [Sized] = []
            kids.reserveCapacity(node.children.count)
            var sum = 0.0
            for child in node.children {
                let sized = Sized(child)
                if sized.total > 0 {
                    kids.append(sized)
                    sum += sized.total
                }
            }
            kids.sort { left, right in
                if left.total != right.total { return left.total > right.total }
                return left.node.id < right.node.id
            }
            self.node = node
            self.kids = kids
            let own = node.value.isFinite ? node.value : 0
            total = max(own, sum)
        }
    }

    public init(root: ChartNode) {
        let sized = Sized(root)
        let rootTotal = sized.total
        guard rootTotal > 0 else {
            self.items = []
            self.index = [:]
            return
        }
        var items: [Item] = []
        var index: [String: Int] = [:]

        func add(_ sized: Sized, depth: Int, x0: Double, parent: Int?, branch: Int, sibling: Int) {
            let position = items.count
            let node = sized.node
            items.append(Item(
                id: node.id, name: node.name, value: sized.total, depth: depth, x0: x0, x1: x0 + sized.total / rootTotal,
                parent: parent, children: [], branch: branch, sibling: sibling, muted: node.muted, color: node.color))
            if index[node.id] == nil { index[node.id] = position }
            var cursor = x0
            for (rank, kid) in sized.kids.enumerated() {
                items[position].children.append(items.count)
                add(kid, depth: depth + 1, x0: cursor, parent: position, branch: depth == 0 ? rank : branch, sibling: rank)
                cursor += kid.total / rootTotal
            }
        }

        add(sized, depth: 0, x0: 0, parent: nil, branch: -1, sibling: 0)
        self.items = items
        self.index = index
    }

    /// A node's size: its value, or its positive children's sum when that is larger.
    static func total(_ node: ChartNode) -> Double { Sized(node).total }

    public var isEmpty: Bool { items.isEmpty }

    /// The item for a node id (the first, when ids repeat).
    public func position(of id: String?) -> Int? {
        guard let id else { return items.isEmpty ? nil : 0 }
        return index[id]
    }

    /// The item's ancestors from the root down to its parent.
    public func ancestors(of position: Int) -> [Int] {
        var chain: [Int] = []
        var cursor = items[position].parent
        while let next = cursor {
            chain.append(next)
            cursor = items[next].parent
        }
        return chain.reversed()
    }

    /// The deepest node both items descend from (one of them, when one contains the other).
    public func commonAncestor(_ a: Int, _ b: Int) -> Int {
        let left = Set(ancestors(of: a) + [a])
        var cursor: Int? = b
        while let next = cursor {
            if left.contains(next) { return next }
            cursor = items[next].parent
        }
        return 0
    }
}
