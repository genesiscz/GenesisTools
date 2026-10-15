import AppKit
import SwiftUI
import GenesisKit

/// One slice of a `SegmentedDonut`.
public struct DonutSegment: Identifiable, Equatable {
    public let id: String
    public let value: Double
    public let color: Color
    public let label: String

    public init(id: String, value: Double, color: Color, label: String) {
        self.id = id
        self.value = value
        self.color = color
        self.label = label
    }
}

/// The angles of a donut's slices: radians clockwise from twelve o'clock, a `gap` between neighbours, nothing for a
/// slice of zero or negative value. One slice alone is a whole ring with no gap.
public enum DonutLayout {
    static func visibleSegments(_ segments: [DonutSegment]) -> [DonutSegment] {
        segments.filter { $0.value.isFinite && $0.value > 0 }
    }

    static func drawableID(_ id: String?, in segments: [DonutSegment]) -> String? {
        guard let id, segments.contains(where: { $0.id == id && $0.value.isFinite && $0.value > 0 }) else { return nil }
        return id
    }

    static func reconcileHover(_ id: inout String?, in segments: [DonutSegment], onHover: ((String?) -> Void)?) {
        let valid = drawableID(id, in: segments)
        guard id != valid else { return }
        id = valid
        onHover?(valid)
    }

    static func total(_ segments: [DonutSegment]) -> Double {
        visibleSegments(segments).reduce(0) { $0 + $1.value }
    }

    public struct Arc: Equatable, Sendable {
        public let index: Int
        public let startAngle: Double
        public let endAngle: Double
    }

    public static func arcs(_ values: [Double], gap: Double) -> [Arc] {
        let kept = values.indices.filter { values[$0].isFinite && values[$0] > 0 }
        let total = kept.reduce(0) { $0 + values[$1] }
        guard total > 0 else { return [] }
        let full = 2 * Double.pi
        if kept.count == 1 { return [Arc(index: kept[0], startAngle: 0, endAngle: full)] }
        // A gap never eats a whole slice: it shrinks when slices are many or thin.
        let effectiveGap = min(max(0, gap), full / Double(kept.count) * 0.25)
        let drawable = full - effectiveGap * Double(kept.count)
        var cursor = effectiveGap / 2
        var result: [Arc] = []
        for index in kept {
            let sweep = values[index] / total * drawable
            result.append(Arc(index: index, startAngle: cursor, endAngle: cursor + sweep))
            cursor += sweep + effectiveGap
        }
        return result
    }

    /// The slice under `point` (relative to the centre, y down) when it lies in the band between the radii.
    public static func hit(_ point: CGPoint, arcs: [Arc], inner: Double, outer: Double) -> Int? {
        let distance = (Double(point.x) * Double(point.x) + Double(point.y) * Double(point.y)).squareRoot()
        guard distance >= inner, distance <= outer else { return nil }
        let angle = SunburstLayout.angle(of: point)
        return arcs.first { angle >= $0.startAngle && angle < $0.endAngle }?.index
    }
}

/// A ring cut into slices: what fills a disk (apps, media, purgeable, snapshots, free), a day's posture minutes. Thin
/// gaps between slices, a soft inner shade on each, and the slice under the pointer stands out (the others dim)
/// with its label and value in the centre unless the host's `center` says otherwise. A click selects a slice, a
/// second click clears it; the selected slice stays raised.
///
/// Identifier: `<identifier>`; each slice is an accessibility child named by its label, with its value (through
/// `valueText` when given) and its share as the value. A `selection` that names no slice selects nothing.
public struct SegmentedDonut<Center: View>: View {
    private let segments: [DonutSegment]
    private let lineWidth: CGFloat
    private let gapAngle: Angle
    private let identifier: String
    @Binding private var selection: String?
    private let onHover: ((String?) -> Void)?
    private let valueText: ((Double) -> String)?
    private let center: (DonutSegment?) -> Center
    @State private var hovered: String?

    /// - Parameters:
    ///   - selection: the selected slice's id; the donut writes it on a click.
    ///   - center: what the middle shows for the slice under the pointer (or the selected one, or nil).
    public init(
        segments: [DonutSegment], lineWidth: CGFloat = 18, gapAngle: Angle = .degrees(1.6),
        identifier: String = "donut", selection: Binding<String?> = .constant(nil),
        onHover: ((String?) -> Void)? = nil, valueText: ((Double) -> String)? = nil,
        @ViewBuilder center: @escaping (DonutSegment?) -> Center
    ) {
        self.segments = segments
        self.lineWidth = lineWidth
        self.gapAngle = gapAngle
        self.identifier = identifier
        _selection = selection
        self.onHover = onHover
        self.valueText = valueText
        self.center = center
    }

    public var body: some View {
        GeometryReader { proxy in
            let size = proxy.size
            let middle = CGPoint(x: size.width / 2, y: size.height / 2)
            let raise: CGFloat = 4
            let outer = Double(max(8, min(size.width, size.height) / 2 - raise - 1))
            let inner = max(1, outer - Double(lineWidth))
            let arcs = DonutLayout.arcs(segments.map(\.value), gap: gapAngle.radians)
            // A selection that names no slice (the data changed under it) selects nothing, rather than dimming all.
            let selected = DonutLayout.drawableID(selection, in: segments)
            let activeHover = DonutLayout.drawableID(hovered, in: segments)
            let focus = activeHover ?? selected
            let shown = segments.first { $0.id == focus }
            let total = DonutLayout.total(segments)
            ZStack {
                Canvas { context, _ in
                    for arc in arcs {
                        let segment = segments[arc.index]
                        let isFocus = segment.id == focus
                        let lift = segment.id == selected || segment.id == activeHover ? Double(raise) : 0
                        let path = Self.band(
                            center: middle, inner: inner + lift * 0.25, outer: outer + lift, start: arc.startAngle,
                            end: arc.endAngle)
                        let base = NSColor(segment.color)
                        let deep = Color(nsColor: base.blended(withFraction: 0.25, of: .black) ?? base)
                        context.opacity = focus == nil || isFocus ? 1 : 0.42
                        context.fill(path, with: .radialGradient(
                            Gradient(colors: [deep, segment.color]), center: middle, startRadius: inner,
                            endRadius: outer + lift))
                    }
                }
                center(shown)
                    .frame(width: max(0, inner * 2 * 0.78), height: max(0, inner * 2 * 0.78))
                    .position(middle)
                    .allowsHitTesting(false)
            }
            .contentShape(Rectangle())
            .onContinuousHover(coordinateSpace: .local) { phase in
                switch phase {
                case .active(let location):
                    let index = DonutLayout.hit(
                        CGPoint(x: location.x - middle.x, y: location.y - middle.y), arcs: arcs, inner: inner,
                        outer: outer + Double(raise))
                    setHovered(index.map { segments[$0].id })
                case .ended:
                    setHovered(nil)
                }
            }
            .gesture(SpatialTapGesture().onEnded { tap in
                let index = DonutLayout.hit(
                    CGPoint(x: tap.location.x - middle.x, y: tap.location.y - middle.y), arcs: arcs, inner: inner,
                    outer: outer + Double(raise))
                let id = index.map { segments[$0].id }
                selection = id == selection ? nil : id
            })
            .onChange(of: segments) { _, updated in
                DonutLayout.reconcileHover(&hovered, in: updated, onHover: onHover)
            }
            .pointerCursor(activeHover != nil)
            .accessibilityElement(children: .contain)
            .accessibilityChildren {
                ForEach(DonutLayout.visibleSegments(segments)) { segment in
                    let share = "\(Int((total > 0 ? segment.value / total * 100 : 0).rounded())) percent"
                    Text(verbatim: segment.label)
                        .accessibilityLabel(segment.label)
                        .accessibilityValue(valueText.map { "\($0(segment.value)), \(share)" } ?? share)
                        .accessibilityAddTraits(segment.id == selected ? [.isButton, .isSelected] : .isButton)
                        .accessibilityAction { selection = segment.id == selection ? nil : segment.id }
                }
            }
            .accessibilityIdentifier(identifier)
        }
    }

    private func setHovered(_ id: String?) {
        guard id != hovered else { return }
        hovered = id
        onHover?(id)
    }

    static func band(center: CGPoint, inner: Double, outer: Double, start: Double, end: Double) -> Path {
        var path = Path()
        let a0 = Angle(radians: start - Double.pi / 2)
        let a1 = Angle(radians: end - Double.pi / 2)
        path.addArc(center: center, radius: outer, startAngle: a0, endAngle: a1, clockwise: false)
        path.addArc(center: center, radius: inner, startAngle: a1, endAngle: a0, clockwise: true)
        path.closeSubpath()
        return path
    }
}

public extension SegmentedDonut where Center == DonutCenterLabel {
    /// A donut whose centre shows the focused slice's label and `valueText`, or `title` and the total.
    init(
        segments: [DonutSegment], lineWidth: CGFloat = 18, gapAngle: Angle = .degrees(1.6),
        identifier: String = "donut", selection: Binding<String?> = .constant(nil), title: String,
        valueText: @escaping (Double) -> String, onHover: ((String?) -> Void)? = nil
    ) {
        let total = DonutLayout.total(segments)
        self.init(
            segments: segments, lineWidth: lineWidth, gapAngle: gapAngle, identifier: identifier,
            selection: selection, onHover: onHover, valueText: valueText
        ) { segment in
            DonutCenterLabel(
                title: segment?.label ?? title, value: valueText(segment?.value ?? total),
                tint: segment?.color)
        }
    }
}

/// The default middle of a `SegmentedDonut`: a title over a large number.
public struct DonutCenterLabel: View {
    let title: String
    let value: String
    let tint: Color?

    public init(title: String, value: String, tint: Color? = nil) {
        self.title = title
        self.value = value
        self.tint = tint
    }

    public var body: some View {
        VStack(spacing: 3) {
            HStack(spacing: 5) {
                if let tint { Circle().fill(tint).frame(width: 6, height: 6) }
                Text(verbatim: title).font(.system(size: 11, weight: .medium)).foregroundStyle(.secondary)
                    .lineLimit(1)
            }
            Text(verbatim: value)
                .font(.system(size: 19, weight: .semibold, design: .rounded)).monospacedDigit()
                .lineLimit(1).minimumScaleFactor(0.6)
        }
    }
}
