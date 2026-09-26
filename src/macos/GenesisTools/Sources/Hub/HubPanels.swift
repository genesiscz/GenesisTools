import AppKit
import SwiftUI

// MARK: - Live resize

/// On while something resizes the hub: a panel handle, the window edge, or a pane divider.
///
/// Measured 2026-09-24 (`--bench`, transcript pane only): a sidebar drag cost 395 ms of main thread
/// per step and a window resize 363 ms, almost all of it the transcript list re-measuring every row
/// for each new width. Heavy panes read this and keep the width they had when the drag began
/// (`freezesWidthWhileResizing`), then lay out once when it ends.
@MainActor
final class HubLiveResize: ObservableObject {
    static let shared = HubLiveResize()

    @Published private(set) var active = false
    /// Only a pane divider is moving. Light panes follow it live; only the transcript list holds.
    @Published private(set) var splitOnly = false
    private var sources: Set<String> = []
    private var observers: [NSObjectProtocol] = []

    func begin(_ source: String) {
        sources.insert(source)
        if !active { active = true }
        updateSplitOnly()
    }

    func end(_ source: String) {
        sources.remove(source)
        if sources.isEmpty, active { active = false }
        updateSplitOnly()
    }

    private func updateSplitOnly() {
        let value = sources == ["split"]
        if splitOnly != value { splitOnly = value }
    }

    /// The window's own live resize, and a pane divider dragged with the mouse (NSSplitView reports
    /// each step but no start or end, so the end is the mouse-up).
    func watch(_ window: NSWindow) {
        let center = NotificationCenter.default
        observers = [
            center.addObserver(forName: NSWindow.willStartLiveResizeNotification, object: window, queue: .main) { _ in
                MainActor.assumeIsolated { HubLiveResize.shared.begin("window") }
            },
            center.addObserver(forName: NSWindow.didEndLiveResizeNotification, object: window, queue: .main) { _ in
                MainActor.assumeIsolated { HubLiveResize.shared.end("window") }
            },
            center.addObserver(forName: NSSplitView.willResizeSubviewsNotification, object: nil, queue: .main) { note in
                MainActor.assumeIsolated {
                    guard (note.object as? NSView)?.window === window, NSEvent.pressedMouseButtons & 1 != 0 else { return }
                    HubLiveResize.shared.beginUntilMouseUp("split")
                }
            },
        ]
    }

    /// NSSplitView drags the divider in its own tracking loop, which swallows the mouse-up: a local
    /// event monitor never saw it, so the panes stayed frozen until the next click anywhere
    /// (recording 2026-09-24 15:09). A timer in the common modes runs inside that loop too.
    private func beginUntilMouseUp(_ source: String) {
        guard !sources.contains(source) else { return }
        begin(source)
        let timer = Timer(timeInterval: 0.05, repeats: true) { timer in
            guard NSEvent.pressedMouseButtons & 1 == 0 else { return }
            timer.invalidate()
            MainActor.assumeIsolated { HubLiveResize.shared.end(source) }
        }
        RunLoop.main.add(timer, forMode: .common)
    }
}

/// Keeps a heavy pane at the size it had when a live resize began; it reflows once, at the end.
/// Smaller meanwhile: clipped. Larger: the pane background shows at the trailing and bottom edges.
/// The height is held too: any frame change of a focusable list makes SwiftUI rebuild the window's
/// key view loop, which walks every row of the transcript.
private struct FreezeWidthWhileResizing: ViewModifier {
    /// A heavy pane (the transcript list) also holds during a pane-divider drag. A light one follows
    /// the divider: frozen, it left a dark gap beside the divider until release (recording 15:09).
    let heavy: Bool
    @ObservedObject private var live = HubLiveResize.shared
    @State private var size: CGSize = .zero
    @State private var frozen: CGSize?

    func body(content: Content) -> some View {
        content
            .frame(width: frozen?.width, height: frozen?.height, alignment: .topLeading)
            // Explicit zero minimums: without them the flexible frame takes the frozen child's size
            // as its minimum, and a shrinking window pushed the whole root off its left edge.
            .frame(minWidth: 0, maxWidth: .infinity, minHeight: 0, maxHeight: .infinity, alignment: .topLeading)
            .clipped()
            .onGeometryChange(for: CGSize.self, of: \.size) { size = $0 }
            .onChange(of: live.active && (heavy || !live.splitOnly)) { _, hold in
                var transaction = Transaction()
                transaction.disablesAnimations = true
                withTransaction(transaction) { frozen = hold && size.width > 0 ? size : nil }
            }
    }
}

extension View {
    func freezesWidthWhileResizing(heavy: Bool = true) -> some View { modifier(FreezeWidthWhileResizing(heavy: heavy)) }
}

// MARK: - Resizable side panel

enum SidePanelEdge { case leading, trailing }

/// A side panel you drag to any width. Released below `minWidth`, it collapses to a rail at the edge
/// (the content dims while you drag past that point, so the collapse never surprises). The rail
/// opens it again. Width and collapsed state persist per `key`; the width is written once, on
/// release, never per drag step.
///
/// `maxWidth` is what the parent can give without clipping its other content; the panel never
/// renders wider. `autoCollapse` is the parent saying there is no room at all (a narrow window):
/// the panel shows its rail without forgetting that it was open, and the rail opens it as a drawer
/// over the content instead.
///
/// `fitWidth` is the width the content asks to open at (the file list's widest row). The panel uses
/// it, never narrower than `minWidth`, until the reader drags this panel in this window; from then on
/// the dragged width stays, as for any other panel.
struct ResizableSidePanel<Content: View>: View {
    typealias Edge = SidePanelEdge

    let key: String
    let edge: Edge
    var title = "panel"
    var defaultWidth: CGFloat = 300
    var minWidth: CGFloat = 180
    var maxWidth: CGFloat = 900
    var autoCollapse = false
    var fitWidth: CGFloat?
    @ViewBuilder let content: () -> Content

    @AppStorage private var width: Double
    @AppStorage private var collapsed: Bool
    @State private var liveWidth: Double?
    @State private var dragStart: Double?
    @GestureState private var dragging = false
    @State private var hovering = false
    @State private var drawerOpen = false

    static var railWidth: CGFloat { 28 }

    init(key: String, edge: Edge, title: String = "panel", defaultWidth: CGFloat = 300, minWidth: CGFloat = 180,
         maxWidth: CGFloat = 900, autoCollapse: Bool = false, fitWidth: CGFloat? = nil, @ViewBuilder content: @escaping () -> Content) {
        self.key = key
        self.edge = edge
        self.title = title
        self.defaultWidth = defaultWidth
        self.minWidth = minWidth
        self.maxWidth = maxWidth
        self.autoCollapse = autoCollapse
        self.fitWidth = fitWidth
        self.content = content
        _width = AppStorage(wrappedValue: Double(defaultWidth), "panel.\(key).width")
        _collapsed = AppStorage(wrappedValue: false, "panel.\(key).collapsed")
    }

    /// The fitted width until the reader drags this panel in this window, then the saved one.
    private var baseWidth: Double {
        guard let fitWidth, !SidePanelSizing.resized.contains(key) else { return width }
        return Double(max(minWidth, fitWidth))
    }
    /// The width being drawn: the drag's live value, else the base one, never more than the room.
    private var shownWidth: CGFloat { min(CGFloat(liveWidth ?? baseWidth), max(minWidth, maxWidth)) }
    private var willCollapse: Bool { liveWidth.map { $0 < Double(minWidth) } ?? false }
    /// While a drag runs, the layout keeps the width the drag began with and the panel draws over its
    /// neighbour (or leaves a gap); everything reflows once, on release. Moving the neighbour made
    /// SwiftUI rebuild the window's key view loop on every step, which walks every transcript row:
    /// 82 ms of main thread per step, 23 ms with the layout held (`--bench`, 2026-09-24).
    private var slotWidth: CGFloat { min(CGFloat(dragStart ?? baseWidth), max(minWidth, maxWidth)) }
    private var dragShift: CGFloat {
        guard dragStart != nil else { return 0 }
        return (edge == .leading ? 1 : -1) * (shownWidth - slotWidth)
    }

    var body: some View {
        HStack(spacing: 0) {
            if collapsed || autoCollapse {
                if edge == .trailing { railLine }
                rail
                if edge == .leading { railLine }
            } else {
                if edge == .trailing { handle.offset(x: dragShift) }
                content()
                    .frame(width: max(0, shownWidth))
                    .opacity(willCollapse ? 0.35 : 1)
                    .frame(width: dragStart != nil ? max(0, slotWidth) : nil, alignment: edge == .leading ? .leading : .trailing)
                    // Shrinking leaves part of the held slot uncovered: paint it as the neighbour, so it
                    // reads as the neighbour already growing instead of a stray strip (screenshot 15:08).
                    .overlay(alignment: edge == .leading ? .trailing : .leading) {
                        if dragStart != nil, slotWidth > shownWidth {
                            Color.clear
                                .frame(width: slotWidth - max(0, shownWidth))
                                .frame(maxHeight: .infinity)
                                .hubSurface(.content)
                        }
                    }
                    .overlay {
                        if willCollapse {
                            Label("Release to collapse", systemImage: edge == .leading ? "arrow.left.to.line" : "arrow.right.to.line")
                                .font(.system(size: 11.5, weight: .semibold))
                                .foregroundColor(ReviewPalette.modified)
                                .padding(.horizontal, 10)
                                .padding(.vertical, 6)
                                .background(Capsule().fill(Color.black.opacity(0.6)))
                                .fixedSize()
                        }
                    }
                if edge == .leading { handle.offset(x: dragShift) }
            }
        }
        .overlay(alignment: edge == .leading ? .topLeading : .topTrailing) {
            if autoCollapse, !collapsed, drawerOpen { drawer }
        }
        .zIndex(drawerOpen || dragStart != nil ? 1 : 0)
        .onChange(of: autoCollapse) { _, squeezed in
            if !squeezed { drawerOpen = false }
        }
    }

    // MARK: Rail and drawer

    private var railLine: some View {
        Color.clear
            .frame(width: 1)
            .background { Rectangle().fill(ReviewPalette.hairline).ignoresSafeArea(.container, edges: .top) }
    }

    private var rail: some View {
        Button {
            if autoCollapse, !collapsed {
                withAnimation(.snappy(duration: 0.25)) { drawerOpen.toggle() }
            } else {
                withAnimation(.snappy(duration: 0.25)) { collapsed = false }
            }
        } label: {
            VStack(spacing: 10) {
                Image(systemName: edge == .leading ? "sidebar.left" : "sidebar.right")
                    .font(.system(size: 12, weight: .medium))
                Text(title)
                    .font(.system(size: 11, weight: .semibold))
                    .fixedSize()
                    .rotationEffect(.degrees(edge == .leading ? -90 : 90))
                    .frame(width: 14, height: 80)
                Spacer()
            }
            .foregroundColor(ReviewPalette.dim)
            .padding(.top, 44)
            .frame(width: Self.railWidth)
            .frame(maxHeight: .infinity)
            .contentShape(Rectangle())
        }
        .buttonStyle(HubRowButtonStyle(cornerRadius: 0))
        .hubSurface(.chrome)
        .instantTooltip(autoCollapse && !collapsed ? "Show \(title) over the content (the window is too narrow to fit it)" : "Show \(title)")
        .accessibilityLabel(Text("Show \(title)"))
    }

    private var drawer: some View {
        content()
            .frame(width: max(minWidth, CGFloat(baseWidth)))
            .frame(maxHeight: .infinity)
            .hubSurface(.chrome)
            .background(Color(nsColor: ReviewPalette.background))
            .overlay(alignment: edge == .leading ? .trailing : .leading) {
                Rectangle().fill(ReviewPalette.hairline).frame(width: 1)
            }
            .shadow(color: .black.opacity(0.45), radius: 18, x: edge == .leading ? 6 : -6)
            .offset(x: edge == .leading ? Self.railWidth + 1 : -(Self.railWidth + 1))
            .transition(.move(edge: edge == .leading ? .leading : .trailing).combined(with: .opacity))
            .onExitCommand { withAnimation(.snappy(duration: 0.2)) { drawerOpen = false } }
    }

    // MARK: Handle

    private var handle: some View {
        let hot = hovering || dragStart != nil
        let tint = willCollapse ? ReviewPalette.modified : ReviewPalette.renamed
        return Capsule()
            .fill(tint)
            .frame(width: 4, height: 36)
            .shadow(color: tint.opacity(0.6), radius: 6)
            .opacity(hot ? 1 : 0)
            .scaleEffect(y: hot ? 1 : 0.4)
            // A 10 pt target around a 1 pt line: the edge no longer has to be hit to the pixel.
            .frame(width: 1)
            .frame(maxHeight: .infinity)
            .background {
                // A background, so the line can reach up through the title bar like the surfaces on
                // both sides of it; the hit target below stays out of the title bar.
                Rectangle()
                    .fill(hot ? tint.opacity(0.55) : ReviewPalette.hairline)
                    .ignoresSafeArea(.container, edges: .top)
            }
        .overlay(Color.clear.frame(width: 10).contentShape(Rectangle()))
        .animation(.easeOut(duration: 0.14), value: hot)
        .animation(.easeOut(duration: 0.14), value: willCollapse)
        .onHover { inside in
            guard inside != hovering else { return }
            hovering = inside
            if inside { NSCursor.resizeLeftRight.push() } else { NSCursor.pop() }
        }
        // Released below the minimum, the handle goes away under the pointer and never sees the
        // hover end: without this pop the resize cursor stayed on for the rest of the window.
        .onDisappear {
            if hovering { NSCursor.pop() }
            hovering = false
        }
        .gesture(
            DragGesture(minimumDistance: 1)
                .updating($dragging) { _, state, _ in state = true }
                .onChanged { value in dragChanged(value.translation.width) }
                .onEnded { _ in dragEnded() }
        )
        // A cancelled gesture (the window lost the mouse mid-drag) never calls onEnded: without this
        // the panel kept its drag layout and every pane stayed frozen.
        .onChange(of: dragging) { _, active in
            if !active, dragStart != nil { dragEnded() }
        }
        .onReceive(NotificationCenter.default.publisher(for: HubBench.panelDrag)) { note in
            guard let drag = note.object as? HubBench.PanelDrag, drag.key == key else { return }
            switch drag.phase {
            case .change(let translation): dragChanged(translation)
            case .end: dragEnded()
            }
        }
        .instantTooltip("Drag to resize; drag past the minimum to collapse")
        // The same resize without a drag: VoiceOver's increment/decrement, and `tools control`
        // (a synthetic drag in a background window never reaches a SwiftUI DragGesture).
        .accessibilityElement()
        .accessibilityLabel(Text("Resize \(title)"))
        .accessibilityValue(Text(verbatim: "\(Int(baseWidth)) points"))
        .accessibilityAdjustableAction { direction in
            let step = direction == .increment ? 20.0 : -20.0
            width = max(Double(minWidth), min(Double(maxWidth), baseWidth + step))
            SidePanelSizing.resized.insert(key)
        }
        .accessibilityAction(named: Text("Collapse \(title)")) {
            collapsed = true
        }
    }

    private func dragChanged(_ translation: CGFloat) {
        if dragStart == nil {
            dragStart = min(baseWidth, Double(maxWidth))
            HubLiveResize.shared.begin("panel.\(key)")
        }
        let delta = edge == .leading ? translation : -translation
        // Past the room the parent has, the panel would clip the content next to it.
        liveWidth = max(0, min(Double(maxWidth), (dragStart ?? baseWidth) + delta))
    }

    private func dragEnded() {
        // Both onEnded and the gesture-state reset call this; only the first one counts.
        guard dragStart != nil else { return }
        let final = liveWidth ?? baseWidth
        HubPerf.log("panel.\(key) resized to \(Int(final))")
        SidePanelSizing.resized.insert(key)
        var transaction = Transaction()
        transaction.disablesAnimations = true
        withTransaction(transaction) {
            if final < Double(minWidth) {
                // Collapsed panels reopen at the width they had before this drag.
                width = max(Double(minWidth), dragStart ?? baseWidth)
                collapsed = true
            } else {
                width = final
            }
            liveWidth = nil
            dragStart = nil
        }
        HubLiveResize.shared.end("panel.\(key)")
    }
}

/// Side panels the reader resized in this process (one hub or review window each): they keep their
/// dragged width instead of their content's fitted one (`ResizableSidePanel.fitWidth`).
@MainActor
enum SidePanelSizing {
    static var resized = Set<String>()
}

// MARK: - Pane rail

/// A session pane with no room beside the others: the same rail a folded side panel shows, and a
/// click opens the pane as a drawer over its neighbours (`SessionDetailView`).
struct PaneRail: View {
    static let width = ResizableSidePanel<EmptyView>.railWidth

    let tab: HubTab
    let open: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            VStack(spacing: 10) {
                Image(systemName: open ? "chevron.right" : tab.symbol)
                    .font(.system(size: 12, weight: .medium))
                Text(tab.title)
                    .font(.system(size: 11, weight: .semibold))
                    .fixedSize()
                    .rotationEffect(.degrees(90))
                    .frame(width: 14, height: 80)
                Spacer()
            }
            .foregroundColor(open ? Color.white.opacity(0.85) : ReviewPalette.dim)
            .padding(.top, 14)
            .frame(width: Self.width)
            .frame(maxHeight: .infinity)
            .contentShape(Rectangle())
        }
        .buttonStyle(HubRowButtonStyle(cornerRadius: 0))
        .hubSurface(.chrome)
        .instantTooltip(open ? "Hide \(tab.title)" : "Show \(tab.title) over the other panes (the window is too narrow to fit it beside them)")
        .accessibilityLabel(Text(open ? "Hide \(tab.title)" : "Show \(tab.title)"))
    }
}

// MARK: - Row hover

/// The hover for list rows: a soft fill in the row's own shape, no outline, no lift. The shape is
/// the row's full frame, so the hover box and the selection box are the same box.
struct HubRowButtonStyle: ButtonStyle {
    var cornerRadius: CGFloat = 6

    func makeBody(configuration: Configuration) -> some View {
        HubRowButtonBody(configuration: configuration, cornerRadius: cornerRadius)
    }
}

private struct HubRowButtonBody: View {
    let configuration: ButtonStyleConfiguration
    let cornerRadius: CGFloat
    @State private var hovering = false

    var body: some View {
        configuration.label
            .background(
                RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
                    .fill(Color.white.opacity(configuration.isPressed ? 0.10 : (hovering ? 0.055 : 0)))
            )
            .contentShape(RoundedRectangle(cornerRadius: cornerRadius, style: .continuous))
            .onHover { hovering = $0 }
            // A row that scrolls out from under a still pointer gets no exit event; reset it when
            // the row leaves the screen so it does not come back highlighted.
            .onDisappear { hovering = false }
    }
}

// MARK: - Glass surfaces

extension EnvironmentValues {
    /// On when the hub's glass mode is (`HubGlass`): surfaces let the blurred desktop through.
    @Entry var hubGlass = false
}

enum HubSurfaceLevel {
    /// Sidebars, rails, headers: the most see-through.
    case chrome
    /// Content columns (diff, decisions): barely tinted, readability first.
    case content
    /// Sticky headers over scrolling rows: frosted, so the rows under it never show through sharp.
    case bar
}

extension View {
    /// The background of a hub surface: opaque normally, translucent over the window blur in glass mode.
    func hubSurface(_ level: HubSurfaceLevel) -> some View {
        modifier(HubSurface(level: level))
    }
}

private struct HubSurface: ViewModifier {
    let level: HubSurfaceLevel
    @Environment(\.hubGlass) private var glass

    func body(content: Content) -> some View {
        content.background {
            fill
                // A surface that reaches the window's top edge also paints the transparent title bar
                // above it. Without this the title bar strip kept the window's own colour, a band of a
                // third grey over the sidebar (screenshot 2026-09-24 19:41). A surface lower down
                // touches no safe area, so this changes nothing for it.
                .ignoresSafeArea(.container, edges: .top)
        }
    }

    @ViewBuilder
    private var fill: some View {
        switch level {
        case .chrome:
            (glass ? Color.black.opacity(0.18) : ReviewPalette.sidebar)
        case .content:
            Color(nsColor: ReviewPalette.background).opacity(glass ? 0.78 : 1)
        case .bar:
            if glass {
                Rectangle().fill(.regularMaterial)
            } else {
                ReviewPalette.sidebar
            }
        }
    }
}

// MARK: - Glass mode

/// The hub's glass mode (⌘⇧G, or the drop button by the mode picker): the window lets the blurred
/// desktop through, sidebars and headers go translucent, content columns stay nearly opaque for
/// reading, and on macOS 26 the floating controls get Liquid Glass. Persisted as `hub.glass`.
enum HubGlass {
    static let key = "hub.glass"

    /// The window's content: the SwiftUI root inside a behind-window blur. The hosting view states
    /// no sizes of its own (`sizingOptions = []`): deriving min, max and intrinsic size re-measured
    /// the whole tree on every layout pass, a third of the main thread while resizing (sampled
    /// 2026-09-24). `HubRootView` sets the window's minimum explicitly instead.
    static func makeContentView<Root: View>(root: Root) -> NSView {
        let hosting = NSHostingView(rootView: root)
        hosting.sizingOptions = []
        hosting.translatesAutoresizingMaskIntoConstraints = false
        let effect = NSVisualEffectView()
        effect.blendingMode = .withinWindow
        effect.material = .windowBackground
        effect.state = .inactive
        effect.addSubview(hosting)
        NSLayoutConstraint.activate([
            hosting.leadingAnchor.constraint(equalTo: effect.leadingAnchor),
            hosting.trailingAnchor.constraint(equalTo: effect.trailingAnchor),
            hosting.topAnchor.constraint(equalTo: effect.topAnchor),
            hosting.bottomAnchor.constraint(equalTo: effect.bottomAnchor),
        ])
        return effect
    }

    /// Idempotent: called on every root update, it changes the window only when the mode flips.
    @MainActor
    static func apply(to window: NSWindow, enabled: Bool) {
        guard let effect = window.contentView as? NSVisualEffectView else { return }
        let blending: NSVisualEffectView.BlendingMode = enabled ? .behindWindow : .withinWindow
        guard effect.blendingMode != blending || window.isOpaque == enabled else { return }
        effect.blendingMode = blending
        effect.material = enabled ? .underWindowBackground : .windowBackground
        effect.state = enabled ? .active : .inactive
        window.isOpaque = !enabled
        window.backgroundColor = enabled ? .clear : ReviewPalette.background
    }
}

/// The glass switch by the mode picker.
struct GlassToggle: View {
    @AppStorage(HubGlass.key) private var glass = false

    var body: some View {
        IconButton(systemName: glass ? "drop.fill" : "drop",
                   tooltip: glass ? "Glass is on: click for solid (⌘⇧G)" : "Glass: let the desktop show through (⌘⇧G)") {
            withAnimation(.easeInOut(duration: 0.25)) { glass.toggle() }
        }
        .foregroundColor(glass ? ReviewPalette.renamed : ReviewPalette.dim)
        .hubLiquidGlass(glass, in: Circle())
    }
}

extension View {
    /// Liquid Glass on a floating control while glass mode is on (macOS 26+); a no-op otherwise.
    @ViewBuilder
    func hubLiquidGlass<S: Shape>(_ enabled: Bool, in shape: S) -> some View {
        if #available(macOS 26, *), enabled {
            glassEffect(.regular, in: shape)
        } else {
            self
        }
    }
}
