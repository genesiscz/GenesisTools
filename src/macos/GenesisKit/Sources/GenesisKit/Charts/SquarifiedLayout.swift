import CoreGraphics
import Foundation

/// Squarified treemap layout (Bruls, Huizing and van Wijk, "Squarified Treemaps", 2000): rectangles whose areas are
/// proportional to the values and whose sides stay as close to square as the values allow.
///
/// Values are placed largest first (ties by their position), in rows along the shorter side of the space left; a
/// value joins the current row only while that does not make the row's worst aspect ratio worse. The same input
/// always gives the same output.
public enum SquarifiedLayout {
    /// One rectangle per value, in the order of `values`; a value that is zero, negative or not finite gets nil and
    /// takes no room. The rectangles tile `rect` exactly. A value far too small next to the others (`[1e20, 1]`) still
    /// gets a rectangle, which can be empty (zero width or height); `TreemapLayout` folds such values first.
    public static func layout(_ values: [Double], in rect: CGRect) -> [CGRect?] {
        var result = [CGRect?](repeating: nil, count: values.count)
        let order = values.indices
            .filter { values[$0].isFinite && values[$0] > 0 }
            .sorted { values[$0] != values[$1] ? values[$0] > values[$1] : $0 < $1 }
        guard !order.isEmpty, rect.width > 0, rect.height > 0 else { return result }
        let total = order.reduce(0) { $0 + values[$1] }
        let scale = Double(rect.width) * Double(rect.height) / total
        var remaining = (x: Double(rect.minX), y: Double(rect.minY), w: Double(rect.width), h: Double(rect.height))

        var row: [Int] = []
        var rowArea = 0.0
        var rowMin = Double.infinity
        var rowMax = 0.0
        var cursor = 0
        while cursor < order.count {
            let index = order[cursor]
            let area = values[index] * scale
            let side = min(remaining.w, remaining.h)
            let current = worst(smallest: rowMin, largest: rowMax, sum: rowArea, side: side)
            let candidate = worst(smallest: min(rowMin, area), largest: max(rowMax, area), sum: rowArea + area, side: side)
            if row.isEmpty || candidate <= current {
                row.append(index)
                rowArea += area
                rowMin = min(rowMin, area)
                rowMax = max(rowMax, area)
                cursor += 1
            } else {
                place(row, area: rowArea, scale: scale, values: values, in: &remaining, last: false, into: &result)
                row = []
                rowArea = 0
                rowMin = .infinity
                rowMax = 0
            }
        }
        place(row, area: rowArea, scale: scale, values: values, in: &remaining, last: true, into: &result)
        return result
    }

    /// The worst aspect ratio (always ≥ 1) of a row of `areas` summing to `sum`, laid along a side of length `side`.
    public static func worst(_ areas: [Double], sum: Double, side: Double) -> Double {
        guard let largest = areas.max(), let smallest = areas.min() else { return .infinity }
        return worst(smallest: smallest, largest: largest, sum: sum, side: side)
    }

    static func worst(smallest: Double, largest: Double, sum: Double, side: Double) -> Double {
        guard sum > 0, side > 0, smallest > 0, smallest.isFinite else { return .infinity }
        let side2 = side * side
        let sum2 = sum * sum
        return max(side2 * largest / sum2, sum2 / (side2 * smallest))
    }

    /// The aspect ratio of a rectangle, ≥ 1.
    public static func aspect(_ rect: CGRect) -> Double {
        let w = Double(rect.width)
        let h = Double(rect.height)
        guard w > 0, h > 0 else { return .infinity }
        return max(w / h, h / w)
    }

    /// Lays one row along the shorter side of `remaining` and takes its strip out of it. The last row fills what is
    /// left exactly, so rounding never leaves a sliver.
    private static func place(
        _ row: [Int], area: Double, scale: Double, values: [Double],
        in remaining: inout (x: Double, y: Double, w: Double, h: Double), last: Bool, into result: inout [CGRect?]
    ) {
        guard !row.isEmpty else { return }
        if remaining.w >= remaining.h {
            // A column on the left, as tall as the space.
            let width = last ? remaining.w : area / remaining.h
            var y = remaining.y
            for (offset, index) in row.enumerated() {
                let height = offset == row.count - 1 ? remaining.y + remaining.h - y : values[index] * scale / width
                result[index] = CGRect(x: remaining.x, y: y, width: width, height: height)
                y += height
            }
            remaining.x += width
            remaining.w -= width
        } else {
            // A row along the top, as wide as the space.
            let height = last ? remaining.h : area / remaining.w
            var x = remaining.x
            for (offset, index) in row.enumerated() {
                let width = offset == row.count - 1 ? remaining.x + remaining.w - x : values[index] * scale / height
                result[index] = CGRect(x: x, y: remaining.y, width: width, height: height)
                x += width
            }
            remaining.y += height
            remaining.h -= height
        }
    }
}

/// One rectangle of a `TreemapView`: a partition item, the parent's own space beyond its children (`isRemainder`),
/// or the parent's children too small to draw, folded into one (`folded` > 0).
public struct TreemapCell: Equatable, Sendable {
    public let item: Int
    public let rect: CGRect
    /// 1 for the focus's children, 2 for theirs.
    public let level: Int
    /// The cell draws its children inside and its name in a strip along the top.
    public let isGroup: Bool
    public let isRemainder: Bool
    /// How many small children this cell stands for; 0 for a real node.
    public let folded: Int
    /// Their combined size, when `folded` > 0.
    public let foldedValue: Double

    public init(
        item: Int, rect: CGRect, level: Int, isGroup: Bool, isRemainder: Bool, folded: Int = 0, foldedValue: Double = 0
    ) {
        self.item = item
        self.rect = rect
        self.level = level
        self.isGroup = isGroup
        self.isRemainder = isRemainder
        self.folded = folded
        self.foldedValue = foldedValue
    }

    /// A cell that stands for a node: neither the parent's own space nor folded small children.
    public var isNode: Bool { !isRemainder && folded == 0 }
}

/// The cells of a treemap: the focused node's children squarified into the bounds, and, for `levels` 2, each child
/// big enough to hold them gets its own children inside, under a title strip.
public enum TreemapLayout {
    /// Height of a group's title strip.
    public static let header: CGFloat = 17
    /// Gap between a group's edge and its children.
    public static let inset: CGFloat = 2

    /// A child whose share of its parent's rectangle is smaller than this many square points is folded.
    public static let minimumArea: CGFloat = 48

    public static func cells(_ partition: ChartPartition, focus: Int, in bounds: CGRect, levels: Int = 2) -> [TreemapCell] {
        guard !partition.isEmpty, partition.items.indices.contains(focus) else { return [] }
        var cells: [TreemapCell] = []

        func fill(_ parent: Int, in rect: CGRect, level: Int) {
            let node = partition.items[parent]
            guard node.value > 0, rect.width > 0, rect.height > 0 else { return }
            let scale = Double(rect.width * rect.height) / node.value
            // Children are ordered largest first, so the ones too small to see are the tail.
            let shown = node.children.filter { partition.items[$0].value * scale >= Double(minimumArea) }
            let small = node.children.dropFirst(shown.count)
            let foldedValue = small.reduce(0) { $0 + partition.items[$1].value }
            let used = node.children.reduce(0) { $0 + partition.items[$1].value }
            let remainder = node.value - used
            var values = shown.map { partition.items[$0].value }
            let foldedSlot = values.count
            if !small.isEmpty { values.append(foldedValue) }
            let remainderSlot = values.count
            // The parent's own space keeps its share, so every child is drawn to the same scale.
            if remainder > node.value * 1e-6 { values.append(remainder) }
            let rects = SquarifiedLayout.layout(values, in: rect)
            for (offset, frame) in rects.enumerated() {
                guard let frame else { continue }
                if offset == remainderSlot {
                    cells.append(TreemapCell(item: parent, rect: frame, level: level, isGroup: false, isRemainder: true))
                    continue
                }
                if !small.isEmpty, offset == foldedSlot {
                    cells.append(TreemapCell(
                        item: parent, rect: frame, level: level, isGroup: false, isRemainder: false,
                        folded: small.count, foldedValue: foldedValue))
                    continue
                }
                let children = shown
                let child = children[offset]
                let canNest = level < levels && !partition.items[child].children.isEmpty
                    && frame.width >= 48 && frame.height >= header + 26
                cells.append(TreemapCell(item: child, rect: frame, level: level, isGroup: canNest, isRemainder: false))
                if canNest {
                    let inner = CGRect(
                        x: frame.minX + inset, y: frame.minY + header, width: frame.width - inset * 2,
                        height: frame.height - header - inset)
                    fill(child, in: inner, level: level + 1)
                }
            }
        }

        fill(focus, in: bounds, level: 1)
        return cells
    }

    /// The deepest cell under `point`.
    public static func hit(_ point: CGPoint, cells: [TreemapCell]) -> TreemapCell? {
        cells.last { $0.rect.contains(point) }
    }
}
