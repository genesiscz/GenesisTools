import AppKit
import SwiftUI

// The resize engine every resizable panel uses: one grip, one edge handle, one drag timer and one overlap look.
//
// The model (Martin, 2026-10-29): while a drag runs, only the panel being resized changes. It draws over its
// neighbour, on an opaque backing with a shadow at its moving edge, and the neighbours keep their layout. On release
// the layout animates to the new size once. Moving the neighbours on every step re-laid out a whole window per step
// (30 to 45 ms with an accessibility client in the GenesisTools hub, a blank web view while it resized).

// MARK: - Grip

/// The blue capsule in the middle of a resize edge. Bright under the pointer and while it drags; at rest it shows
/// faintly when `atRest`, else not at all.
public struct GenResizeGrip: View {
    /// `.horizontal`: a vertical edge dragged sideways (a side panel). `.vertical`: a horizontal edge (a list's bottom).
    public let axis: Axis
    public let hot: Bool
    public var tint: Color
    public var atRest: Bool

    public init(axis: Axis, hot: Bool, tint: Color = .accentColor, atRest: Bool = false) {
        self.axis = axis
        self.hot = hot
        self.tint = tint
        self.atRest = atRest
    }

    public var body: some View {
        let shown = hot || atRest
        Capsule()
            .fill(tint)
            .frame(width: axis == .horizontal ? 4 : 36, height: axis == .horizontal ? 36 : 4)
            .shadow(color: tint.opacity(hot ? 0.6 : 0), radius: 6)
            .opacity(hot ? 1 : atRest ? 0.5 : 0)
            .scaleEffect(x: axis == .vertical ? (shown ? 1 : 0.4) : 1, y: axis == .horizontal ? (shown ? 1 : 0.4) : 1)
            .accessibilityHidden(true)
    }
}

// MARK: - Edge handle

/// A resize edge: a 1 pt line with the grip in its middle, a 10 pt target on the resized panel's own side (the
/// neighbour can be a web view, an AppKit view SwiftUI's hit testing does not reach over), the resize cursor, a drag
/// in global coordinates (the handle moves with the edge, so a translation in its own space would include that move
/// and the edge would trail the pointer), and the same resize for VoiceOver and `tools control` as an adjustable
/// element. Place it above the panel's content (`zIndex`), or the content takes the presses on its grab area.
public struct GenResizeHandle: View {
    public enum Side { case before, after }

    public let axis: Axis
    /// Where the resized panel lies: `.before` is above or to the left of the edge.
    public let panelSide: Side
    public var dragging: Bool
    public var tint: Color
    public var line: Color
    public var gripAtRest: Bool
    /// The line reaches up through a full-size title bar like the surfaces beside it (a side panel's edge).
    public var throughTitlebar: Bool
    public var tooltip: String
    public var accessibilityLabel: String
    public var accessibilityValue: String
    public var onAdjust: (Bool) -> Void
    public var onChanged: (CGFloat) -> Void
    public var onEnded: () -> Void

    @State private var hovering = false
    @GestureState private var pressed = false

    public init(axis: Axis, panelSide: Side, dragging: Bool, tint: Color, line: Color, gripAtRest: Bool = false,
                throughTitlebar: Bool = false, tooltip: String, accessibilityLabel: String, accessibilityValue: String,
                onAdjust: @escaping (Bool) -> Void, onChanged: @escaping (CGFloat) -> Void, onEnded: @escaping () -> Void) {
        self.axis = axis
        self.panelSide = panelSide
        self.dragging = dragging
        self.tint = tint
        self.line = line
        self.gripAtRest = gripAtRest
        self.throughTitlebar = throughTitlebar
        self.tooltip = tooltip
        self.accessibilityLabel = accessibilityLabel
        self.accessibilityValue = accessibilityValue
        self.onAdjust = onAdjust
        self.onChanged = onChanged
        self.onEnded = onEnded
    }

    public var body: some View {
        let hot = hovering || dragging
        let lineFill = hot ? tint.opacity(0.55) : line
        let towardPanel: CGFloat = panelSide == .before ? -4.5 : 4.5
        let horizontal = axis == .horizontal
        GenResizeGrip(axis: axis, hot: hot, tint: tint, atRest: gripAtRest)
            .frame(width: horizontal ? 1 : nil, height: horizontal ? nil : 1)
            .frame(maxWidth: horizontal ? nil : .infinity, maxHeight: horizontal ? .infinity : nil)
            .background {
                if throughTitlebar {
                    Color.clear.titlebarBackground(Rectangle().fill(lineFill))
                } else {
                    Rectangle().fill(lineFill)
                }
            }
            .overlay(
                Color.clear
                    .frame(width: horizontal ? 10 : nil, height: horizontal ? nil : 10)
                    .contentShape(Rectangle())
                    .offset(x: horizontal ? towardPanel : 0, y: horizontal ? 0 : towardPanel))
            .animation(.easeOut(duration: 0.14), value: hot)
            .animation(.easeOut(duration: 0.14), value: tint)
            .onHover { inside in
                if inside != hovering { hovering = inside }
            }
            .genHoverCursor(horizontal ? .resizeLeftRight : .resizeUpDown)
            // A handle that goes away under the pointer (a collapse on release) never sees the hover end.
            .onDisappear {
                if hovering { NSCursor.arrow.set() }
                hovering = false
            }
            .gesture(
                DragGesture(minimumDistance: 1, coordinateSpace: .global)
                    .updating($pressed) { _, state, _ in state = true }
                    .onChanged { value in onChanged(horizontal ? value.translation.width : value.translation.height) }
                    .onEnded { _ in onEnded() }
            )
            // A cancelled gesture (the window lost the mouse mid-drag) never calls onEnded.
            .onChange(of: pressed) { _, active in
                if !active, dragging { onEnded() }
            }
            .instantTooltip(tooltip)
            .accessibilityElement()
            .accessibilityLabel(Text(accessibilityLabel))
            .accessibilityValue(Text(verbatim: accessibilityValue))
            .accessibilityAdjustableAction { direction in onAdjust(direction == .increment) }
    }
}

// MARK: - Overlap look

extension View {
    /// While `active`, the view draws over a neighbour: an opaque backing (a translucent surface let the neighbour's
    /// text show through) and a shadow just past its moving `edge`.
    public func genResizeOverlap(_ active: Bool, edge: Edge) -> some View {
        modifier(GenResizeOverlap(active: active, edge: edge))
    }

    /// The pointer becomes `cursor` while it is over the view, and the arrow again when it leaves or the view goes.
    public func genHoverCursor(_ cursor: NSCursor) -> some View {
        modifier(GenHoverCursor(cursor: cursor))
    }
}

private struct GenResizeOverlap: ViewModifier {
    let active: Bool
    let edge: Edge

    func body(content: Content) -> some View {
        content
            .background { if active { Color(nsColor: .windowBackgroundColor) } }
            .overlay(alignment: alignment) {
                if active {
                    LinearGradient(colors: [Color.black.opacity(0.32), .clear], startPoint: start, endPoint: end)
                        .frame(width: vertical ? nil : 12, height: vertical ? 12 : nil)
                        .offset(x: vertical ? 0 : (edge == .trailing ? 12 : -12), y: vertical ? (edge == .bottom ? 12 : -12) : 0)
                        .allowsHitTesting(false)
                }
            }
    }

    private var vertical: Bool { edge == .top || edge == .bottom }
    private var alignment: Alignment {
        switch edge {
        case .leading: return .leading
        case .trailing: return .trailing
        case .top: return .top
        case .bottom: return .bottom
        }
    }
    private var start: UnitPoint {
        switch edge {
        case .leading: return .trailing
        case .trailing: return .leading
        case .top: return .bottom
        case .bottom: return .top
        }
    }
    private var end: UnitPoint {
        switch edge {
        case .leading: return .leading
        case .trailing: return .trailing
        case .top: return .top
        case .bottom: return .bottom
        }
    }
}

private struct GenHoverCursor: ViewModifier {
    let cursor: NSCursor
    @State private var hovering = false

    func body(content: Content) -> some View {
        content
            .onContinuousHover { phase in
                switch phase {
                case .active:
                    if !hovering { hovering = true }
                    cursor.set()
                case .ended:
                    hovering = false
                    NSCursor.arrow.set()
                }
            }
            .onDisappear {
                if hovering {
                    hovering = false
                    NSCursor.arrow.set()
                }
            }
    }
}

// MARK: - Drag timing

/// Times one drag of a resize edge for the perf log: the steps and the gaps between them (a gap well over a frame is
/// a step the main thread was late for). A class, so a step changes no view state. `finish` logs one line through
/// `PerfSpans` and returns it, so a host can also measure the release's reflow.
@MainActor
public final class GenResizeDragTimer {
    private var started: CFAbsoluteTime?
    private var last: CFAbsoluteTime = 0
    private var gaps: [Double] = []

    public init() {}

    public func step() {
        let now = CFAbsoluteTimeGetCurrent()
        if started == nil {
            started = now
            gaps = []
        } else {
            gaps.append((now - last) * 1000)
        }
        last = now
    }

    @discardableResult
    public func finish(_ name: String, from: Double, to: Double) -> String? {
        guard let started else { return nil }
        self.started = nil
        let line = Self.summary(name, from: from, to: to, gaps: gaps, seconds: CFAbsoluteTimeGetCurrent() - started)
        PerfSpans.log(line)
        return line
    }

    /// Pure, so tests read it.
    public nonisolated static func summary(_ name: String, from: Double, to: Double, gaps: [Double], seconds: Double) -> String {
        let sorted = gaps.sorted()
        func percentile(_ share: Double) -> Int {
            guard !sorted.isEmpty else { return 0 }
            return Int(sorted[min(sorted.count - 1, Int(Double(sorted.count) * share))].rounded())
        }
        let late = gaps.filter { $0 > 33 }.count
        return "resize \(name) \(Int(from))->\(Int(to)) pt: \(gaps.count + 1) steps in \(String(format: "%.1f", seconds)) s, "
            + "step gap p50 \(percentile(0.5)) p95 \(percentile(0.95)) max \(Int((sorted.last ?? 0).rounded())) ms, \(late) over 33 ms"
    }
}
