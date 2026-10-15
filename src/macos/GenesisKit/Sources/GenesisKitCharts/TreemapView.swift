import AppKit
import SwiftUI
import GenesisKit

/// A squarified treemap of a hierarchy (GrandPerspective, WinDirStat): the focused node's children as rectangles
/// sized by value, and inside each big one its own children under a title strip. It shares `ChartNode`, the colours
/// and the focus binding with `SunburstChart`, so a host can switch between the two views of the same data.
///
/// Cells carry a soft light-to-shade gradient (a flat "cushion") and one-point gaps; a name and a size are drawn only
/// where they fit. The pointer outlines the cell under it and shows its name, size and share in a card; a click
/// reports the node through `onSelect` and, when it has children, makes it the focus, with a short cross-fade (none
/// under Reduce Motion). A parent's own space beyond its children is a grey cell.
///
/// The cells redraw only when the data, the focus, the size or the formatter's output change; a hover redraws only
/// the outline. Cells are known by node id, so new data that shifts the tree keeps the hover on the same node.
///
/// Identifier: `<identifier>` for the chart.
public struct TreemapView: View {
    /// How a cell is filled.
    public enum Shading: Sendable {
        /// A soft light-to-shade gradient with a lit top rim: a flat stand-in for van Wijk's cushions.
        case cushion
        /// One colour per cell.
        case flat
    }

    private let source: ChartSource
    @Binding private var focus: String?
    private let levels: Int
    private let shading: Shading
    private let identifier: String
    private let valueText: (Double) -> String
    private let onHover: ((String?) -> Void)?
    private let onSelect: ((String) -> Void)?
    @State private var store = TreemapStore()
    @GenReduceMotion private var reduceMotion

    /// - Parameters:
    ///   - focus: the id of the node whose children fill the map; nil is the root.
    ///   - levels: 1 draws only the focus's children; 2 also draws their children inside them.
    public init(
        root: ChartNode, focus: Binding<String?>, levels: Int = 2, shading: Shading = .cushion,
        identifier: String = "treemap",
        valueText: @escaping (Double) -> String = { String(format: "%.0f", $0) },
        onHover: ((String?) -> Void)? = nil, onSelect: ((String) -> Void)? = nil
    ) {
        self.init(
            source: .tree(root), focus: focus, levels: levels, shading: shading, identifier: identifier,
            valueText: valueText, onHover: onHover, onSelect: onSelect)
    }

    /// A map of a partition the host built (once, off the main thread for a large tree, shared with a
    /// `SunburstChart`). The same options as `init(root:...)`.
    public init(
        partition: ChartPartition, focus: Binding<String?>, levels: Int = 2, shading: Shading = .cushion,
        identifier: String = "treemap",
        valueText: @escaping (Double) -> String = { String(format: "%.0f", $0) },
        onHover: ((String?) -> Void)? = nil, onSelect: ((String) -> Void)? = nil
    ) {
        self.init(
            source: .partition(partition), focus: focus, levels: levels, shading: shading, identifier: identifier,
            valueText: valueText, onHover: onHover, onSelect: onSelect)
    }

    private init(
        source: ChartSource, focus: Binding<String?>, levels: Int, shading: Shading, identifier: String,
        valueText: @escaping (Double) -> String, onHover: ((String?) -> Void)?, onSelect: ((String) -> Void)?
    ) {
        self.source = source
        _focus = focus
        self.levels = max(1, min(2, levels))
        self.shading = shading
        self.identifier = identifier
        self.valueText = valueText
        self.onHover = onHover
        self.onSelect = onSelect
    }

    public var body: some View {
        let partition = store.partition(for: source)
        let revision = store.revision
        let focusIndex = partition.position(of: focus) ?? 0
        // Keyed by the node, not its position: new data that shifts the tree is not a drill.
        let focusID = partition.isEmpty ? "" : partition.items[focusIndex].id
        Group {
            if partition.isEmpty {
                Text("Nothing to show").font(.system(size: 12)).foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                TreemapCanvas(
                    partition: partition, revision: revision, focusIndex: focusIndex, levels: levels, shading: shading,
                    identifier: identifier,
                    valueText: valueText, onHover: onHover,
                    activate: { item in activate(item, in: partition) })
                    .id(focusID)
                    .transition(.opacity.combined(with: .scale(scale: 0.985)))
            }
        }
        .animation(reduceMotion ? nil : .easeOut(duration: 0.22), value: focusID)
    }

    private func activate(_ item: Int, in partition: ChartPartition) {
        let node = partition.items[item]
        onSelect?(node.id)
        if !node.children.isEmpty, focus != node.id { focus = node.id }
    }
}

/// The flattened tree, rebuilt only when the tree changes.
final class TreemapStore {
    private var source: ChartSource?
    private var cached: ChartPartition?
    /// Bumped on each rebuild, so a cached layout of the old tree is never reused.
    private(set) var revision = 0

    func partition(for source: ChartSource) -> ChartPartition {
        if let cached, self.source == source { return cached }
        let partition = source.partition
        self.source = source
        cached = partition
        revision += 1
        return partition
    }
}

struct TreemapCanvas: View {
    let partition: ChartPartition
    let revision: Int
    let focusIndex: Int
    let levels: Int
    let shading: TreemapView.Shading
    let identifier: String
    let valueText: (Double) -> String
    let onHover: ((String?) -> Void)?
    let activate: (Int) -> Void
    /// The hovered cell's key (`key(of:)`), so a data refresh keeps it on the same node.
    @State private var hovered: String?
    @State private var layoutCache = TreemapLayoutCache()

    var body: some View {
        GeometryReader { proxy in
            let bounds = CGRect(origin: .zero, size: proxy.size)
            let cells = layoutCache.cells(partition, revision: revision, focus: focusIndex, bounds: bounds, levels: levels)
            let hoveredCell = hovered.flatMap { key in cells.first { self.key(of: $0) == key } }
            ZStack(alignment: .topLeading) {
                TreemapCellsLayer(
                    partition: partition, revision: revision, focusIndex: focusIndex, cells: cells, shading: shading,
                    valueText: valueText, formatProbe: valueText(1_234_567_890))
                    .equatable()
                if let hoveredCell {
                    RoundedRectangle(cornerRadius: hoveredCell.level == 1 ? 4 : 2.5, style: .continuous)
                        .strokeBorder(Color.white.opacity(0.9), lineWidth: 1.5)
                        .frame(width: max(0, hoveredCell.rect.width - 1), height: max(0, hoveredCell.rect.height - 1))
                        .offset(x: hoveredCell.rect.minX + 0.5, y: hoveredCell.rect.minY + 0.5)
                        .allowsHitTesting(false)
                        .accessibilityHidden(true)
                    tooltip(hoveredCell, size: proxy.size)
                }
            }
            .frame(width: proxy.size.width, height: proxy.size.height, alignment: .topLeading)
            .contentShape(Rectangle())
            .onContinuousHover(coordinateSpace: .local) { phase in
                switch phase {
                case .active(let location):
                    setHovered(cells.last { $0.rect.contains(location) })
                case .ended:
                    setHovered(nil)
                }
            }
            .gesture(SpatialTapGesture().onEnded { tap in
                guard let cell = TreemapLayout.hit(tap.location, cells: cells), cell.isNode else { return }
                activate(cell.item)
            })
            .pointerCursor(hoveredCell?.isNode ?? false)
            .accessibilityElement(children: .contain)
            .accessibilityLabel("Treemap of \(partition.items[focusIndex].name)")
            .accessibilityChildren {
                ForEach(cells.filter { $0.level == 1 && $0.isNode }, id: \.item) { cell in
                    let item = partition.items[cell.item]
                    Text(verbatim: item.name)
                        .accessibilityLabel(item.name)
                        .accessibilityValue(valueText(item.value))
                        .accessibilityAddTraits(.isButton)
                        .accessibilityAction { activate(cell.item) }
                }
            }
            .accessibilityIdentifier(identifier)
        }
    }

    /// A cell's identity across data refreshes: its node's id, with a suffix for a parent's own space and for its
    /// folded small children.
    private func key(of cell: TreemapCell) -> String { Self.key(of: cell, in: partition) }

    static func key(of cell: TreemapCell, in partition: ChartPartition) -> String {
        let id = partition.items[cell.item].id
        if cell.isRemainder { return id + "#own" }
        return cell.folded > 0 ? id + "#smaller" : id
    }

    private func setHovered(_ cell: TreemapCell?) {
        let next = cell.map(key(of:))
        guard next != hovered else { return }
        hovered = next
        onHover?(cell.flatMap { $0.isNode ? partition.items[$0.item].id : nil })
    }

    private func tooltip(_ cell: TreemapCell, size: CGSize) -> some View {
        let item = partition.items[cell.item]
        let focusValue = partition.items[focusIndex].value
        let value = cell.isRemainder
            ? item.value - item.children.reduce(0) { $0 + partition.items[$1].value }
            : (cell.folded > 0 ? cell.foldedValue : item.value)
        let share = focusValue > 0 ? value / focusValue * 100 : 0
        let name = cell.isRemainder
            ? "\(item.name), not in a subfolder"
            : (cell.folded > 0 ? "\(Plural.count(cell.folded, "smaller item")) in \(item.name)" : item.name)
        let width: CGFloat = 200
        let x = min(max(cell.rect.midX, width / 2 + 4), size.width - width / 2 - 4)
        let below = cell.rect.maxY + 34 < size.height
        let y = below ? min(cell.rect.maxY + 26, size.height - 26) : max(cell.rect.minY - 26, 26)
        return VStack(alignment: .leading, spacing: 3) {
            Text(verbatim: name).font(.system(size: 12, weight: .semibold)).lineLimit(1).truncationMode(.middle)
            HStack(spacing: 6) {
                Text(verbatim: valueText(value)).font(.system(size: 11, weight: .medium, design: .rounded)).monospacedDigit()
                Text(verbatim: String(format: "%.1f%%", share)).font(.system(size: 11, design: .rounded))
                    .monospacedDigit().foregroundStyle(.secondary)
                if cell.isNode, !item.children.isEmpty {
                    Text("Click to open").font(.system(size: 10)).foregroundStyle(.tertiary)
                }
            }
        }
        .padding(.horizontal, 10).padding(.vertical, 7)
        .frame(maxWidth: width, alignment: .leading)
        .background(Color(white: 0.08).opacity(0.94), in: RoundedRectangle(cornerRadius: 8, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 8, style: .continuous).strokeBorder(Color.white.opacity(0.12), lineWidth: 0.5))
        .shadow(color: .black.opacity(0.35), radius: 10, y: 4)
        .fixedSize()
        .position(x: x, y: y)
        .allowsHitTesting(false)
        .accessibilityHidden(true)
    }
}

/// The cells and their labels: one Canvas that redraws only when what it shows changes (`.equatable()`), not on a
/// hover or an unrelated update of the view around it. `formatProbe` is one value run through `valueText`, so a new
/// formatter (another unit) still redraws.
struct TreemapCellsLayer: View, Equatable {
    let partition: ChartPartition
    let revision: Int
    let focusIndex: Int
    let cells: [TreemapCell]
    let shading: TreemapView.Shading
    let valueText: (Double) -> String
    let formatProbe: String

    nonisolated static func == (lhs: TreemapCellsLayer, rhs: TreemapCellsLayer) -> Bool {
        lhs.revision == rhs.revision && lhs.focusIndex == rhs.focusIndex && lhs.shading == rhs.shading
            && lhs.formatProbe == rhs.formatProbe && lhs.cells == rhs.cells
    }

    var body: some View {
        Canvas { context, _ in draw(cells, in: &context) }
            .allowsHitTesting(false)
    }

    private func fill(of cell: TreemapCell) -> NSColor {
        let item = partition.items[cell.item]
        if !cell.isNode { return ChartPalette.shade(branch: -1, sibling: 0, ring: Double(cell.level), muted: true) }
        // The hue follows the level-1 cell the item sits in, so a drilled-in map still has several colours.
        var top = cell.item
        while let parent = partition.items[top].parent, parent != focusIndex { top = parent }
        let rank = partition.items[top].sibling
        let branch = focusIndex == 0 ? rank : item.branch + rank
        return ChartPalette.shade(
            branch: branch, sibling: cell.level == 1 ? 0 : item.sibling, ring: Double(cell.level), muted: item.muted,
            color: item.color)
    }

    private func draw(_ cells: [TreemapCell], in context: inout GraphicsContext) {
        for cell in cells {
            let rect = cell.rect.insetBy(dx: 0.5, dy: 0.5)
            guard rect.width > 0.5, rect.height > 0.5 else { continue }
            let color = fill(of: cell)
            let radius: CGFloat = min(cell.level == 1 ? 4 : 2.5, min(rect.width, rect.height) / 3)
            let shape = Path(roundedRect: rect, cornerRadius: radius, style: .continuous)
            let light = Color(nsColor: color.blended(withFraction: 0.10, of: .white) ?? color)
            let shade = Color(nsColor: color.blended(withFraction: cell.isGroup ? 0.48 : 0.24, of: .black) ?? color)
            context.opacity = cell.isRemainder ? 0.5 : (cell.folded > 0 ? 0.7 : 1)
            switch shading {
            case .cushion:
                context.fill(shape, with: .linearGradient(
                    Gradient(colors: [light, shade]), startPoint: CGPoint(x: rect.minX, y: rect.minY),
                    endPoint: CGPoint(x: rect.maxX, y: rect.maxY)))
                context.opacity = 1
                // A hairline of light along the top edge gives each cushion its rim.
                var rim = Path()
                rim.move(to: CGPoint(x: rect.minX + radius, y: rect.minY + 0.5))
                rim.addLine(to: CGPoint(x: rect.maxX - radius, y: rect.minY + 0.5))
                context.stroke(rim, with: .color(.white.opacity(0.16)), lineWidth: 1)
            case .flat:
                let flat = cell.isGroup ? (color.blended(withFraction: 0.35, of: .black) ?? color) : color
                context.fill(shape, with: .color(Color(nsColor: flat)))
                context.opacity = 1
            }
            if !cell.isRemainder { drawLabel(cell, rect: rect, color: color, in: &context) }
        }
    }

    private func drawLabel(_ cell: TreemapCell, rect: CGRect, color: NSColor, in parent: inout GraphicsContext) {
        // Size checks come first: most cells of a big map are too small for text, and laying text out is the cost.
        if cell.isGroup {
            guard rect.width >= 28 else { return }
        } else {
            guard rect.width >= 34, rect.height >= 18 else { return }
        }
        // A label never paints outside its own cell.
        var context = parent
        context.clip(to: Path(rect))
        let item = partition.items[cell.item]
        let ink = ChartPalette.ink(on: cell.isGroup ? (color.blended(withFraction: 0.3, of: .black) ?? color) : color)
        let title = cell.folded > 0 ? Plural.count(cell.folded, "smaller item") : item.name
        let name = context.resolve(Text(verbatim: title).font(.system(size: 10.5, weight: .semibold)).foregroundColor(ink))
        // Measured unconstrained: a draw at a point uses the text's natural width.
        let nameSize = name.measure(in: CGSize(width: 2_000, height: 20))
        if cell.isGroup {
            // The title strip: the name on the left, the size on the right when both fit.
            let size = context.resolve(
                Text(verbatim: valueText(item.value)).font(.system(size: 10, weight: .medium)).monospacedDigit()
                    .foregroundColor(ink.opacity(0.7)))
            let sizeWidth = size.measure(in: CGSize(width: 200, height: 20)).width
            let room = rect.width - 12
            let y = rect.minY + TreemapLayout.header / 2
            context.draw(name, in: CGRect(x: rect.minX + 6, y: y - 7, width: min(nameSize.width, room), height: 14))
            if nameSize.width + sizeWidth + 10 <= room {
                context.draw(size, at: CGPoint(x: rect.maxX - 6, y: y), anchor: .trailing)
            }
            return
        }
        guard nameSize.width <= rect.width - 10 else { return }
        context.draw(name, at: CGPoint(x: rect.minX + 5, y: rect.minY + 4), anchor: .topLeading)
        guard rect.height >= 34 else { return }
        let size = context.resolve(
            Text(verbatim: valueText(cell.folded > 0 ? cell.foldedValue : item.value))
                .font(.system(size: 10, weight: .medium)).monospacedDigit()
                .foregroundColor(ink.opacity(0.72)))
        if size.measure(in: CGSize(width: 200, height: 20)).width <= rect.width - 10 {
            context.draw(size, at: CGPoint(x: rect.minX + 5, y: rect.minY + 18), anchor: .topLeading)
        }
    }
}

/// The cells for the last bounds and focus, so a hover does not lay the map out again.
final class TreemapLayoutCache {
    private var key: (revision: Int, focus: Int, bounds: CGRect, levels: Int)?
    private var cells: [TreemapCell] = []

    func cells(_ partition: ChartPartition, revision: Int, focus: Int, bounds: CGRect, levels: Int) -> [TreemapCell] {
        if let key, key.revision == revision, key.focus == focus, key.bounds == bounds, key.levels == levels {
            return cells
        }
        cells = TreemapLayout.cells(partition, focus: focus, in: bounds, levels: levels)
        key = (revision, focus, bounds, levels)
        return cells
    }
}
