import AppKit
import Observation
import SwiftUI

// The resize engine every resizable panel uses: one drag state, one reveal, one grip, one edge handle, one drag
// timer and one overlap look.
//
// The model (Martin, 2026-10-29): while a drag runs, only the panel being resized changes. It draws over its
// neighbour, on an opaque backing with a shadow at its moving edge, and the neighbours keep their layout. On release
// the layout animates to the new size once. Moving the neighbours on every step re-laid out a whole window per step
// (30 to 45 ms with an accessibility client in the GenesisTools hub, a blank web view while it resized).
//
// The cost rule: a drag step changes one value, `GenResizeDrag.live`, and only `GenResizeReveal` reads it. The host
// builds its content, handle and overlays once; a step re-runs no body of theirs. When the host's own body read the
// live value, every step rebuilt the panel's content (closures and fresh `@State` objects compare unequal), re-ran
// the handle's gesture and accessibility modifiers, and re-resolved every row's text for the accessibility client:
// 50 ms a step in the hub's PR list, 35 ms with the content laid out in 12 pt buckets (2026-10-29).
//
// The same rule at the release: the host's body reads none of the drag's state and none of the saved length either.
// The rest length lives in `GenResizeDrag.rest` (the reveal reads it), the raised z order in `genResizeRaised`, the
// collapse hint in `genResizeCollapseHint` and the handle's collapse tint in `GenResizeHandle`, each a leaf that
// re-runs alone. A host whose body read the saved width and `releasing` ran three times per release and re-rendered
// its whole content each time: 175 ms for the hub's session list, 300 to 420 ms for the PR threads list (2026-10-29).

// MARK: - Drag state

/// The live state of one resize drag. `live` changes on every step: read it only in the view that applies it
/// (`GenResizeReveal`), since every reader runs again per step. `active`, `willCollapse` and `releasing` change at
/// the ends of a drag and when the pointer crosses the panel's minimum: read them in a leaf (`genResizeRaised`,
/// `genResizeCollapseHint`, the handle), never in the host's body, or the release re-renders the host's content.
@MainActor
@Observable
public final class GenResizeDrag {
    /// The length outside a drag: the saved one, which the host sets when it loads it, saves a release or adjusts
    /// it for VoiceOver. Only the reveal reads it, so a release re-runs no host body.
    public var rest: CGFloat
    /// The length under the pointer, clamped by the host; nil at rest.
    public private(set) var live: CGFloat?
    /// The length the drag began with; nil at rest.
    public private(set) var start: CGFloat?
    /// The pointer is past the panel's minimum: the panel folds on release.
    public private(set) var willCollapse = false
    /// The release animation runs: the panel still draws over its neighbours while its slot catches up.
    public private(set) var releasing = false
    @ObservationIgnored public let timer = GenResizeDragTimer()
    @ObservationIgnored private var releaseTask: Task<Void, Never>?

    public init(rest: CGFloat = 0) {
        self.rest = rest
    }

    public var active: Bool { start != nil }

    /// The first step: remembers where the drag began. A second call during the same drag changes nothing.
    public func begin(at length: CGFloat) {
        guard start == nil else { return }
        start = length
        live = length
        willCollapse = false
    }

    /// A step: the new live length, and whether a release now would fold the panel.
    public func move(to length: CGFloat, collapsing: Bool = false) {
        timer.step()
        live = length
        if willCollapse != collapsing { willCollapse = collapsing }
    }

    /// Ends the drag: one perf line for the drag (`GenResizeDragTimer`), the state back to rest. Call it inside the
    /// host's `withAnimation`, so the layout animates from the held slot to the new length; `settleAfter` is that
    /// animation's length, during which `releasing` stays set. Returns where the drag began and ended, or nil when
    /// none ran. `rest` is the host's to set from the result (a collapsing panel reopens at its pre-drag length).
    @discardableResult
    public func end(_ name: String, settleAfter duration: Double = 0) -> (start: CGFloat, final: CGFloat)? {
        guard let start else { return nil }
        let final = live ?? start
        timer.finish(name, from: start, to: final)
        self.start = nil
        live = nil
        willCollapse = false
        releaseTask?.cancel()
        if duration > 0 {
            releasing = true
            releaseTask = Task { [weak self] in
                try? await Task.sleep(for: .seconds(duration + 0.08))
                guard !Task.isCancelled else { return }
                self?.releasing = false
            }
        } else {
            releasing = false
        }
        return (start, final)
    }
}

// MARK: - Reveal

/// The view a drag changes: `content` shown at the live length along `axis`, laid out at the length `layout` gives,
/// over a slot that keeps the length the drag began with. Its body is the only one that runs per step, and it returns
/// the same `content`, `handle` and `uncovered` values it was given, so none of their bodies run.
///
/// - `fixedEdge`: the edge that stays put (`.leading` for a sidebar whose trailing edge moves, `.top` for a list
///   whose bottom edge moves).
/// - `clamp`: the host's limits, applied to the live length and to `drag.rest`.
/// - `layout`: the length the content is laid out at during a drag, from the shown length. `{ $0 }` reflows the
///   content with the edge (a panel the reader wants to see more or less of). A constant maximum lays it out once
///   at the start and only the clip moves per step (a list of heavy rows).
/// - `handle`: placed on the moving edge of the shown length, so it follows the pointer.
/// - `uncovered`: paints the part of the slot a shrinking panel leaves, as the neighbour's surface, so it reads as
///   the neighbour growing instead of a stray strip.
public struct GenResizeReveal<Content: View, Handle: View, Uncovered: View>: View {
    let drag: GenResizeDrag
    let axis: Axis
    let fixedEdge: Edge
    let clamp: (CGFloat) -> CGFloat
    let layout: (CGFloat) -> CGFloat
    let accessibility: GenResizeAccessibility?
    let content: Content
    let handle: Handle
    let uncovered: Uncovered

    public init(drag: GenResizeDrag, axis: Axis, fixedEdge: Edge,
                clamp: @escaping (CGFloat) -> CGFloat, layout: @escaping (CGFloat) -> CGFloat,
                accessibility: GenResizeAccessibility? = nil,
                @ViewBuilder content: () -> Content, @ViewBuilder handle: () -> Handle,
                @ViewBuilder uncovered: () -> Uncovered) {
        self.drag = drag
        self.axis = axis
        self.fixedEdge = fixedEdge
        self.clamp = clamp
        self.layout = layout
        self.accessibility = accessibility
        self.content = content()
        self.handle = handle()
        self.uncovered = uncovered()
    }

    public var body: some View {
        let active = drag.live != nil
        let shown = max(0, drag.live.map(clamp) ?? clamp(drag.rest))
        let slot = active ? max(0, clamp(drag.start ?? shown)) : shown
        let laid = active ? max(shown, layout(shown)) : shown
        content
            .frame(width: along(laid), height: across(laid), alignment: fixedAlignment)
            .frame(width: along(shown), height: across(shown), alignment: fixedAlignment)
            // Open at the top: a surface may paint up into a transparent title bar.
            .clipShape(GenOpenTopClip())
            .genResizeOverlap(active && shown > slot + 0.5, edge: movingEdge)
            .overlay(alignment: movingAlignment) { handle }
            // The slot animates on release; the modifier sees every frame's value and paints the band a smaller
            // panel leaves between its edge and the slot's, during the drag and the release alike.
            .modifier(GenResizeSlot(slot: slot, shown: shown, axis: axis, fixedAlignment: fixedAlignment,
                                    movingAlignment: movingAlignment, uncovered: AnyView(uncovered)))
            // The resize for VoiceOver and `tools control`, on the slot's edge: it stays put during a drag. On the
            // moving handle, its node changed per step, and SwiftUI then re-resolved the focus responder with a walk
            // of the whole window's responders (15% of a sidebar drag, 2026-10-29).
            .overlay(alignment: movingAlignment) {
                if let accessibility {
                    Color.clear
                        .frame(width: along(10), height: across(10))
                        .accessibilityElement()
                        .accessibilityLabel(Text(accessibility.label))
                        .accessibilityValue(Text(verbatim: "\(Int(shown)) points"))
                        .accessibilityAdjustableAction { direction in accessibility.adjust(direction == .increment) }
                }
            }
    }

    private func along(_ length: CGFloat) -> CGFloat? { axis == .horizontal ? length : nil }
    private func across(_ length: CGFloat) -> CGFloat? { axis == .vertical ? length : nil }

    private var movingEdge: Edge {
        switch fixedEdge {
        case .leading: return .trailing
        case .trailing: return .leading
        case .top: return .bottom
        case .bottom: return .top
        }
    }

    private var fixedAlignment: Alignment { Self.alignment(of: fixedEdge) }
    private var movingAlignment: Alignment { Self.alignment(of: movingEdge) }

    private static func alignment(of edge: Edge) -> Alignment {
        switch edge {
        case .leading: return .leading
        case .trailing: return .trailing
        case .top: return .top
        case .bottom: return .bottom
        }
    }
}

/// The slot of a reveal: the frame the layout gives the panel, which the neighbours are placed against. Animatable,
/// so a release's frames each paint the uncovered band at the right place.
private struct GenResizeSlot: ViewModifier, Animatable {
    var slot: CGFloat
    let shown: CGFloat
    let axis: Axis
    let fixedAlignment: Alignment
    let movingAlignment: Alignment
    let uncovered: AnyView

    var animatableData: CGFloat {
        get { slot }
        set { slot = newValue }
    }

    func body(content: Content) -> some View {
        let gap = slot - shown
        content
            .frame(width: axis == .horizontal ? slot : nil, height: axis == .vertical ? slot : nil, alignment: fixedAlignment)
            .overlay(alignment: movingAlignment) {
                if gap > 0.5 {
                    uncovered.frame(width: axis == .horizontal ? gap : nil, height: axis == .vertical ? gap : nil)
                }
            }
    }
}

extension GenResizeReveal where Uncovered == EmptyView {
    public init(drag: GenResizeDrag, axis: Axis, fixedEdge: Edge,
                clamp: @escaping (CGFloat) -> CGFloat, layout: @escaping (CGFloat) -> CGFloat,
                accessibility: GenResizeAccessibility? = nil,
                @ViewBuilder content: () -> Content, @ViewBuilder handle: () -> Handle) {
        self.init(drag: drag, axis: axis, fixedEdge: fixedEdge, clamp: clamp, layout: layout,
                  accessibility: accessibility, content: content, handle: handle, uncovered: { EmptyView() })
    }
}

/// The resize as an adjustable accessibility element: its label ("Resize Files"), the shown length as its value
/// ("320 points", from the reveal) and the step VoiceOver's increment and decrement take. `GenResizeReveal` places
/// it on the slot's edge.
public struct GenResizeAccessibility {
    public var label: String
    public var adjust: (Bool) -> Void

    public init(label: String, adjust: @escaping (Bool) -> Void) {
        self.label = label
        self.adjust = adjust
    }
}

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
/// and the edge would trail the pointer). `GenResizeReveal` places it on the moving edge, and the accessibility
/// element on the slot's edge (`GenResizeAccessibility`); the handle's body runs when the drag starts or ends, when
/// the pointer crosses the panel's minimum and when the host changes its look, never per step.
public struct GenResizeHandle: View {
    public enum Side { case before, after }

    public let drag: GenResizeDrag
    public let axis: Axis
    /// Where the resized panel lies: `.before` is above or to the left of the edge.
    public let panelSide: Side
    public var tint: Color
    /// The tint while a release would fold the panel (`drag.willCollapse`); nil keeps `tint`.
    public var collapseTint: Color?
    public var line: Color
    public var gripAtRest: Bool
    /// The line reaches up through a full-size title bar like the surfaces beside it (a side panel's edge).
    public var throughTitlebar: Bool
    public var tooltip: String
    public var onChanged: (CGFloat) -> Void
    public var onEnded: () -> Void

    @State private var hovering = false

    public init(drag: GenResizeDrag, axis: Axis, panelSide: Side, tint: Color, collapseTint: Color? = nil, line: Color,
                gripAtRest: Bool = false, throughTitlebar: Bool = false, tooltip: String,
                onChanged: @escaping (CGFloat) -> Void, onEnded: @escaping () -> Void) {
        self.drag = drag
        self.axis = axis
        self.panelSide = panelSide
        self.tint = tint
        self.collapseTint = collapseTint
        self.line = line
        self.gripAtRest = gripAtRest
        self.throughTitlebar = throughTitlebar
        self.tooltip = tooltip
        self.onChanged = onChanged
        self.onEnded = onEnded
    }

    public var body: some View {
        let dragging = drag.active
        let tint = drag.willCollapse ? (collapseTint ?? self.tint) : self.tint
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
            // The hit area is an AppKit view (`GenResizeDragSurface`), so a window-addressed drag reaches it too.
            .overlay(
                GenResizeDragSurface(axis: axis, onChanged: onChanged, onEnded: onEnded)
                    .frame(width: horizontal ? 10 : nil, height: horizontal ? nil : 10)
                    .offset(x: horizontal ? towardPanel : 0, y: horizontal ? 0 : towardPanel)
                    .onHover { inside in
                        if inside != hovering { hovering = inside }
                    }
                    .genHoverCursor(horizontal ? .resizeLeftRight : .resizeUpDown)
                    // A handle that goes away under the pointer (a collapse on release) never sees the hover end.
                    .onDisappear {
                        if hovering { NSCursor.arrow.set() }
                        hovering = false
                    }
                    .instantTooltip(tooltip))
            .animation(.easeOut(duration: 0.14), value: hot)
            .animation(.easeOut(duration: 0.14), value: tint)
            .accessibilityHidden(true)
    }
}

/// The handle's hit area as an AppKit view. A window-addressed drag (`tools control act --action drag
/// --background`: mouse events posted to the process, the pointer left where it is) reaches an NSView's `mouseDown`,
/// `mouseDragged` and `mouseUp` in a window that is not key, while a SwiftUI `DragGesture` in the same place never
/// started on one (2026-10-29, the hub's sidebar). The real pointer takes the same path. AppKit keeps sending a drag
/// to the view that took the mouse-down wherever the pointer goes, so the view may move with the edge.
struct GenResizeDragSurface: NSViewRepresentable {
    let axis: Axis
    let onChanged: (CGFloat) -> Void
    let onEnded: () -> Void

    func makeNSView(context: Context) -> SurfaceView { SurfaceView() }

    func updateNSView(_ view: SurfaceView, context: Context) {
        view.axis = axis
        view.onChanged = onChanged
        view.onEnded = onEnded
    }

    final class SurfaceView: NSView {
        var axis: Axis = .horizontal
        var onChanged: (CGFloat) -> Void = { _ in }
        var onEnded: () -> Void = {}
        private var origin: CGPoint?

        override var acceptsFirstResponder: Bool { false }
        /// A press in a window that is not key starts the drag at once.
        override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
        /// A handle through the title bar strip resizes, it never moves the window.
        override var mouseDownCanMoveWindow: Bool { false }

        override func mouseDown(with event: NSEvent) {
            origin = event.locationInWindow
        }

        override func mouseDragged(with event: NSEvent) {
            guard let origin else { return }
            let point = event.locationInWindow
            // Window coordinates grow upward; a SwiftUI translation grows downward.
            onChanged(axis == .horizontal ? point.x - origin.x : origin.y - point.y)
        }

        override func mouseUp(with event: NSEvent) {
            guard origin != nil else { return }
            origin = nil
            onEnded()
        }

        /// The view leaves its window mid-drag (a collapse, a closed window): the release never comes.
        override func viewWillMove(toWindow newWindow: NSWindow?) {
            super.viewWillMove(toWindow: newWindow)
            if newWindow == nil, origin != nil {
                origin = nil
                onEnded()
            }
        }
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

// MARK: - Leaves a host hangs the drag's ends on

extension View {
    /// Above its siblings while the drag runs and while the release animation plays (`drag.releasing`), so the
    /// panel draws over its neighbour the whole time; `or` raises it for a reason of the host's (an open drawer).
    /// A leaf: the host's body reads no drag state for it.
    public func genResizeRaised(_ drag: GenResizeDrag, or raised: Bool = false) -> some View {
        modifier(GenResizeRaised(drag: drag, raised: raised))
    }

    /// Dims the panel and shows `text` over it while a release would fold it (`drag.willCollapse`). A leaf.
    public func genResizeCollapseHint(_ drag: GenResizeDrag, text: String, systemImage: String, color: Color) -> some View {
        modifier(GenResizeCollapseHint(drag: drag, text: text, systemImage: systemImage, color: color))
    }
}

private struct GenResizeRaised: ViewModifier {
    let drag: GenResizeDrag
    let raised: Bool

    func body(content: Content) -> some View {
        content.zIndex(raised || drag.active || drag.releasing ? 1 : 0)
    }
}

private struct GenResizeCollapseHint: ViewModifier {
    let drag: GenResizeDrag
    let text: String
    let systemImage: String
    let color: Color

    func body(content: Content) -> some View {
        let folding = drag.willCollapse
        content
            .opacity(folding ? 0.35 : 1)
            .overlay {
                if folding {
                    Label(text, systemImage: systemImage)
                        .font(.system(size: 11.5, weight: .semibold))
                        .foregroundColor(color)
                        .padding(.horizontal, 10)
                        .padding(.vertical, 6)
                        .background(Capsule().fill(Color.black.opacity(0.6)))
                        .fixedSize()
                }
            }
    }
}

private struct GenOpenTopClip: Shape {
    func path(in rect: CGRect) -> Path {
        Path(CGRect(x: rect.minX, y: rect.minY - 10_000, width: rect.width, height: rect.height + 10_000))
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
