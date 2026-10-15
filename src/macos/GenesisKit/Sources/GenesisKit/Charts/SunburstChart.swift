import AppKit
import SwiftUI

/// A sunburst of a hierarchy (DaisyDisk's space map): the focused node is the centre disc, its children the first ring,
/// their children the next, up to `maxDepth` rings. Each top-level branch has its own hue, lighter with depth; arcs
/// too thin to see fold into one translucent "N smaller items" arc per parent.
///
/// The pointer lights an arc and its ancestors (the rest dims) and shows its name, size and share in a card beside
/// it; `onHover` reports the node. A click on an arc reports it through `onSelect` and, when it has children, makes it
/// the centre; a click on the centre goes back up one level. Each focus change moves every arc to its new place in
/// one 0.55 s transition on the `GenMotion` curve (at once under Reduce Motion). Nothing animates at rest.
///
/// The arcs redraw only when the data, the focus, the size or the hover change, not when the host's view updates for
/// another reason (a scan's progress).
///
/// Identifiers: `<identifier>` for the chart, `<identifier>.center` for the back button.
public struct SunburstChart: View {
    private let source: ChartSource
    @Binding private var focus: String?
    private let maxDepth: Int
    private let maxArcs: Int
    private let identifier: String
    private let valueText: (Double) -> String
    private let onHover: ((String?) -> Void)?
    private let onSelect: ((String) -> Void)?
    @State private var store = SunburstStore()
    @State private var viewport: SunburstViewport?
    @GenReduceMotion private var reduceMotion

    /// - Parameters:
    ///   - focus: the id of the node in the centre; nil is the root. The chart writes it on a drill or a back click.
    ///   - maxArcs: the most children one parent shows as their own arcs; the rest fold into "N smaller items".
    ///   - valueText: a node's size as text (`{ ByteFormat.file(Int64($0)) }`).
    public init(
        root: ChartNode, focus: Binding<String?>, maxDepth: Int = 4, maxArcs: Int = 14, identifier: String = "sunburst",
        valueText: @escaping (Double) -> String = { String(format: "%.0f", $0) },
        onHover: ((String?) -> Void)? = nil, onSelect: ((String) -> Void)? = nil
    ) {
        self.init(
            source: .tree(root), focus: focus, maxDepth: maxDepth, maxArcs: maxArcs, identifier: identifier,
            valueText: valueText, onHover: onHover, onSelect: onSelect)
    }

    /// A chart of a partition the host built (once, off the main thread for a large tree, shared with a
    /// `TreemapView`). The same options as `init(root:...)`.
    public init(
        partition: ChartPartition, focus: Binding<String?>, maxDepth: Int = 4, maxArcs: Int = 14,
        identifier: String = "sunburst", valueText: @escaping (Double) -> String = { String(format: "%.0f", $0) },
        onHover: ((String?) -> Void)? = nil, onSelect: ((String) -> Void)? = nil
    ) {
        self.init(
            source: .partition(partition), focus: focus, maxDepth: maxDepth, maxArcs: maxArcs, identifier: identifier,
            valueText: valueText, onHover: onHover, onSelect: onSelect)
    }

    private init(
        source: ChartSource, focus: Binding<String?>, maxDepth: Int, maxArcs: Int, identifier: String,
        valueText: @escaping (Double) -> String, onHover: ((String?) -> Void)?, onSelect: ((String) -> Void)?
    ) {
        self.source = source
        _focus = focus
        self.maxDepth = maxDepth
        self.maxArcs = maxArcs
        self.identifier = identifier
        self.valueText = valueText
        self.onHover = onHover
        self.onSelect = onSelect
    }

    public var body: some View {
        let layout = store.layout(for: source, maxDepth: maxDepth, maxChildren: maxArcs)
        let focusIndex = layout.partition.position(of: focus) ?? 0
        let target = layout.partition.isEmpty
            ? SunburstViewport(x0: 0, x1: 1, depth: 0) : SunburstViewport(layout.partition.items[focusIndex])
        Group {
            if layout.partition.isEmpty {
                Text("Nothing to show").font(.system(size: 12)).foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                SunburstCanvas(
                    layout: layout, revision: store.revision, viewport: viewport ?? target, target: target,
                    focusIndex: focusIndex,
                    identifier: identifier, valueText: valueText, onHover: onHover,
                    activate: { arc in activate(arc, in: layout) },
                    goUp: { goUp(from: focusIndex, in: layout) })
            }
        }
        .onAppear {
            store.appliedFocus = focus
            viewport = target
        }
        .onChange(of: target) { _, next in
            let drilled = store.appliedFocus != focus
            store.appliedFocus = focus
            if drilled, !reduceMotion {
                withAnimation(.timingCurve(
                    Double(GenMotion.curve.0), Double(GenMotion.curve.1), Double(GenMotion.curve.2),
                    Double(GenMotion.curve.3), duration: 0.55)) { viewport = next }
            } else {
                var transaction = Transaction()
                transaction.disablesAnimations = true
                withTransaction(transaction) { viewport = next }
            }
        }
    }

    private func activate(_ arc: SunburstArc, in layout: SunburstLayout) {
        guard !arc.isAggregate else { return }
        onSelect?(arc.id)
        if !layout.partition.items[arc.item].children.isEmpty, focus != arc.id { focus = arc.id }
    }

    private func goUp(from position: Int, in layout: SunburstLayout) {
        guard let parent = layout.partition.items[position].parent else { return }
        let next: String? = parent == 0 ? nil : layout.partition.items[parent].id
        if focus != next { focus = next }
    }
}

/// What a chart draws: a tree it flattens itself, or a partition the host built.
enum ChartSource: Equatable {
    case tree(ChartNode)
    case partition(ChartPartition)

    var partition: ChartPartition {
        switch self {
        case .tree(let root): return ChartPartition(root: root)
        case .partition(let partition): return partition
        }
    }
}

/// The flattened tree, rebuilt only when the tree or the ring count changes, and the focus the viewport last moved to.
/// Comparing an unchanged tree is cheap: arrays that share storage compare equal at once.
final class SunburstStore {
    private var source: ChartSource?
    private var cached: SunburstLayout?
    var appliedFocus: String?
    /// Bumped on each rebuild, so the drawing knows the data changed without comparing it.
    private(set) var revision = 0

    func layout(for source: ChartSource, maxDepth: Int, maxChildren: Int) -> SunburstLayout {
        if let cached, cached.maxDepth == maxDepth, cached.maxChildren == maxChildren, self.source == source {
            return cached
        }
        let layout = SunburstLayout(partition: source.partition, maxDepth: maxDepth, maxChildren: maxChildren)
        self.source = source
        cached = layout
        revision += 1
        return layout
    }
}

/// The drawn sunburst. `viewport` is the animatable part: during a drill SwiftUI hands this view each intermediate
/// viewport and it draws the arcs for it; at rest it draws once per hover change.
struct SunburstCanvas: View, Animatable {
    let layout: SunburstLayout
    let revision: Int
    var viewport: SunburstViewport
    let target: SunburstViewport
    let focusIndex: Int
    let identifier: String
    let valueText: (Double) -> String
    let onHover: ((String?) -> Void)?
    let activate: (SunburstArc) -> Void
    let goUp: () -> Void
    @State private var hovered: String?
    @State private var centerHovered = false

    // Nonisolated: `Animatable` is not main-actor bound, and the viewport is a plain Sendable value.
    nonisolated var animatableData: AnimatablePair<AnimatablePair<Double, Double>, Double> {
        get { AnimatablePair(AnimatablePair(viewport.x0, viewport.x1), viewport.depth) }
        set { viewport = SunburstViewport(x0: newValue.first.first, x1: newValue.first.second, depth: newValue.second) }
    }

    private var animating: Bool { viewport != target }

    var body: some View {
        GeometryReader { proxy in
            let size = proxy.size
            let radius = max(10, Double(min(size.width, size.height)) / 2 - 2)
            let center = CGPoint(x: size.width / 2, y: size.height / 2)
            let arcs = layout.arcs(viewport, radius: radius)
            let hoveredArc = animating ? nil : arcs.first { $0.id == hovered }
            let lit = hoveredArc.map { Set(layout.partition.ancestors(of: $0.item) + [$0.item]) } ?? []
            ZStack {
                SunburstArcsLayer(
                    layout: layout, revision: revision, arcs: arcs, center: center, hovered: hoveredArc, lit: lit,
                    animating: animating)
                    .equatable()
                    .accessibilityElement(children: .contain)
                    .accessibilityLabel("Sunburst of \(layout.partition.items[focusIndex].name)")
                    .accessibilityChildren {
                        ForEach(arcs.filter { $0.ring == 1 && !$0.isAggregate }, id: \.id) { arc in
                            Text(verbatim: arc.name)
                                .accessibilityLabel(arc.name)
                                .accessibilityValue(valueText(arc.value))
                                .accessibilityAddTraits(.isButton)
                                .accessibilityAction { activate(arc) }
                        }
                    }
                centerDisc(radius: layout.centerRadius(radius))
                    .position(center)
                if let hoveredArc {
                    tooltip(hoveredArc, center: center, size: size)
                }
            }
            .contentShape(Rectangle())
            .onContinuousHover(coordinateSpace: .local) { phase in
                switch phase {
                case .active(let location):
                    let hit = layout.hit(CGPoint(x: location.x - center.x, y: location.y - center.y), radius: radius, arcs: arcs)
                    if case .arc(let arc) = hit { setHovered(arc) } else { setHovered(nil) }
                case .ended:
                    setHovered(nil)
                }
            }
            .gesture(SpatialTapGesture().onEnded { tap in
                guard !animating else { return }
                let hit = layout.hit(CGPoint(x: tap.location.x - center.x, y: tap.location.y - center.y), radius: radius, arcs: arcs)
                switch hit {
                case .arc(let arc): activate(arc)
                case .center: goUp()
                case .none: break
                }
            })
            .pointerCursor(hoveredArc.map { !$0.isAggregate && !layout.partition.items[$0.item].children.isEmpty } ?? false)
            // The arcs and the centre's back button stay two children, so VoiceOver reaches both.
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier(identifier)
        }
        // A drill or new data moves the arcs; the card must not keep describing what is no longer under the pointer.
        .onChange(of: target) { _, _ in setHovered(nil) }
        .onChange(of: revision) { _, _ in setHovered(nil) }
    }

    private func setHovered(_ arc: SunburstArc?) {
        let id = arc?.id
        guard id != hovered else { return }
        hovered = id
        onHover?(arc.flatMap { $0.isAggregate ? nil : $0.id })
    }

    // MARK: Centre and tooltip

    private func centerDisc(radius: Double) -> some View {
        let item = layout.partition.items[focusIndex]
        let canGoUp = item.parent != nil
        let diameter = max(24, radius * 2 - 6)
        return Button(action: goUp) {
            ZStack {
                Circle()
                    .fill(RadialGradient(
                        colors: [Color(white: 0.17), Color(white: 0.10)], center: .top, startRadius: 0,
                        endRadius: diameter))
                Circle().strokeBorder(Color.white.opacity(centerHovered && canGoUp ? 0.28 : 0.10), lineWidth: 1)
                VStack(spacing: 3) {
                    if canGoUp {
                        Image(systemName: "chevron.up")
                            .font(.system(size: 9, weight: .bold))
                            .foregroundStyle(.secondary)
                    }
                    Text(verbatim: item.name)
                        .font(.system(size: 12, weight: .semibold))
                        .lineLimit(2).multilineTextAlignment(.center)
                        .minimumScaleFactor(0.8)
                    Text(verbatim: valueText(item.value))
                        .font(.system(size: 11, weight: .medium, design: .rounded)).monospacedDigit()
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
                .padding(.horizontal, diameter * 0.14)
            }
            .frame(width: diameter, height: diameter)
            .contentShape(Circle())
        }
        .buttonStyle(.genHoverPlain(brighten: canGoUp ? 0.08 : 0))
        .allowsHitTesting(canGoUp)
        .onHover { inside in if centerHovered != inside { centerHovered = inside } }
        .accessibilityLabel(canGoUp ? "Back to the parent of \(item.name)" : item.name)
        .accessibilityValue(valueText(item.value))
        .accessibilityIdentifier(identifier + ".center")
    }

    private func tooltip(_ arc: SunburstArc, center: CGPoint, size: CGSize) -> some View {
        let focusValue = layout.partition.items[focusIndex].value
        let share = focusValue > 0 ? arc.value / focusValue * 100 : 0
        let anchor = SunburstLayout.point(angle: arc.midAngle, radius: arc.outerRadius + 14)
        let onRight = anchor.x >= 0
        let width: CGFloat = 190
        let x = min(max(center.x + anchor.x + (onRight ? width / 2 : -width / 2), width / 2 + 4), size.width - width / 2 - 4)
        let y = min(max(center.y + anchor.y, 26), size.height - 26)
        let drillable = !arc.isAggregate && !layout.partition.items[arc.item].children.isEmpty
        return VStack(alignment: .leading, spacing: 3) {
            Text(verbatim: arc.name).font(.system(size: 12, weight: .semibold)).lineLimit(1).truncationMode(.middle)
            HStack(spacing: 6) {
                Text(verbatim: valueText(arc.value))
                    .font(.system(size: 11, weight: .medium, design: .rounded)).monospacedDigit()
                Text(verbatim: String(format: "%.1f%%", share))
                    .font(.system(size: 11, design: .rounded)).monospacedDigit()
                    .foregroundStyle(.secondary)
                if drillable {
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

/// The arcs and their labels: one Canvas that redraws only when what it shows changes (`.equatable()`), not on every
/// update of the view around it. `lit` follows from `hovered` and the data, so it is not compared.
struct SunburstArcsLayer: View, Equatable {
    let layout: SunburstLayout
    let revision: Int
    let arcs: [SunburstArc]
    let center: CGPoint
    let hovered: SunburstArc?
    let lit: Set<Int>
    let animating: Bool

    nonisolated static func == (lhs: SunburstArcsLayer, rhs: SunburstArcsLayer) -> Bool {
        lhs.revision == rhs.revision && lhs.center == rhs.center && lhs.hovered == rhs.hovered
            && lhs.animating == rhs.animating && lhs.arcs == rhs.arcs
    }

    var body: some View {
        Canvas { context, _ in
            draw(arcs, in: &context, center: center, hovered: hovered, lit: lit)
        }
    }

    private func draw(
        _ arcs: [SunburstArc], in context: inout GraphicsContext, center: CGPoint, hovered: SunburstArc?, lit: Set<Int>
    ) {
        var fills: [String: NSColor] = [:]
        for arc in arcs {
            let item = layout.partition.items[arc.item]
            let fill = arc.isAggregate
                ? ChartPalette.shade(branch: -1, sibling: 0, ring: arc.ring, muted: true)
                : ChartPalette.shade(
                    branch: item.branch, sibling: item.sibling, ring: arc.ring, muted: item.muted, color: item.color)
            fills[arc.id] = fill
            var alpha = arc.isAggregate ? 0.55 : 1.0
            if hovered != nil, !(lit.contains(arc.item) && !arc.isAggregate) && hovered?.id != arc.id { alpha *= 0.4 }
            // A ring overflowing the outermost one while a drill animates fades out instead of popping.
            if arc.ring > Double(layout.maxDepth) { alpha *= max(0, Double(layout.maxDepth) + 1 - arc.ring) }
            let path = Self.path(arc, center: center)
            let base = Color(nsColor: fill)
            let deep = Color(nsColor: fill.blended(withFraction: 0.22, of: .black) ?? fill)
            context.opacity = alpha
            context.fill(path, with: .radialGradient(
                Gradient(colors: [deep, base]), center: center, startRadius: arc.innerRadius,
                endRadius: arc.outerRadius))
            // The top edge of each band catches a little light.
            context.stroke(Self.outerEdge(arc, center: center), with: .color(.white.opacity(0.10)), lineWidth: 1)
        }
        context.opacity = 1
        // One-point gaps between arcs, cut out of the drawing so they show whatever lies behind the chart.
        var cut = context
        cut.blendMode = .destinationOut
        for arc in arcs {
            cut.stroke(Self.path(arc, center: center), with: .color(.black), lineWidth: 1)
        }
        if let hovered {
            context.stroke(Self.path(hovered, center: center), with: .color(.white.opacity(0.85)), lineWidth: 1.5)
        }
        guard !animating else { return }
        drawLabels(arcs, fills: fills, in: &context, center: center, hovered: hovered, lit: lit)
    }

    private func drawLabels(
        _ arcs: [SunburstArc], fills: [String: NSColor], in context: inout GraphicsContext, center: CGPoint,
        hovered: SunburstArc?, lit: Set<Int>
    ) {
        let candidates = arcs.filter { !$0.isAggregate && $0.endAngle - $0.startAngle > 0.07 && $0.thickness > 12 }
            .sorted { ($0.endAngle - $0.startAngle) * $0.midRadius > ($1.endAngle - $1.startAngle) * $1.midRadius }
            .prefix(72)
        for arc in candidates {
            let fill = fills[arc.id] ?? .gray
            var text = context.resolve(
                Text(verbatim: arc.name).font(.system(size: 10.5, weight: .semibold))
                    .foregroundColor(ChartPalette.ink(on: fill)))
            var size = text.measure(in: CGSize(width: 600, height: 40))
            var placement = SunburstLayout.labelPlacement(arc, size: size)
            if placement == nil, let short = Self.shortened(arc.name) {
                text = context.resolve(
                    Text(verbatim: short).font(.system(size: 10.5, weight: .semibold))
                        .foregroundColor(ChartPalette.ink(on: fill)))
                size = text.measure(in: CGSize(width: 600, height: 40))
                placement = SunburstLayout.labelPlacement(arc, size: size)
            }
            guard let placement else { continue }
            var label = context
            if hovered != nil, !lit.contains(arc.item) { label.opacity = 0.45 }
            label.translateBy(x: center.x + placement.center.x, y: center.y + placement.center.y)
            label.rotate(by: .radians(placement.rotation))
            label.draw(text, at: .zero, anchor: .center)
        }
    }

    /// A long name cut to its first 14 characters and an ellipsis, for a second try at fitting.
    static func shortened(_ name: String) -> String? {
        guard name.utf8.count > 16 else { return nil }
        return String(name.prefix(14)) + "…"
    }

    static func path(_ arc: SunburstArc, center: CGPoint) -> Path {
        var path = Path()
        let start = Angle(radians: arc.startAngle - Double.pi / 2)
        let end = Angle(radians: arc.endAngle - Double.pi / 2)
        path.addArc(center: center, radius: arc.outerRadius, startAngle: start, endAngle: end, clockwise: false)
        path.addArc(center: center, radius: arc.innerRadius, startAngle: end, endAngle: start, clockwise: true)
        path.closeSubpath()
        return path
    }

    static func outerEdge(_ arc: SunburstArc, center: CGPoint) -> Path {
        var path = Path()
        path.addArc(
            center: center, radius: arc.outerRadius - 0.5, startAngle: Angle(radians: arc.startAngle - Double.pi / 2),
            endAngle: Angle(radians: arc.endAngle - Double.pi / 2), clockwise: false)
        return path
    }

}
