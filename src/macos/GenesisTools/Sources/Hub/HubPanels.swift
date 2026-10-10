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
    /// Only a pane divider, or a side panel that lays out live (`ResizableSidePanel.holdsLayout` off), is
    /// moving: its source starts with "split". Light panes follow it live; only the transcript list holds.
    @Published private(set) var splitOnly = false
    /// What resizes now: "window", "split" (a pane divider), "panel.<key>" (a side panel holding its
    /// layout), "split.panel.<key>" (a side panel laid out live).
    @Published private(set) var sources: Set<String> = []
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
        let value = !sources.isEmpty && sources.allSatisfy { $0 == "split" || $0.hasPrefix("split.") }
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
/// A rectangle that reaches far above its frame: clips the trailing and bottom edges only.
private struct OpenTopRectangle: Shape {
    func path(in rect: CGRect) -> Path {
        Path(CGRect(x: rect.minX, y: rect.minY - 10_000, width: rect.width, height: rect.height + 10_000))
    }
}

/// Clips a side panel's held content to the moving edge, only while it is held: open at the top like
/// `FreezeWidthWhileResizing`, so a row in the title bar strip still draws. One shape in both states:
/// an `if` here would rebuild the panel's content at each drag's start and end (its scroll position too).
private struct HeldContentClip: ViewModifier {
    let active: Bool

    func body(content: Content) -> some View {
        content.clipShape(HeldClipShape(active: active))
    }
}

private struct HeldClipShape: Shape {
    let active: Bool

    func path(in rect: CGRect) -> Path {
        guard active else { return Path(rect.insetBy(dx: -10_000, dy: -10_000)) }
        return Path(CGRect(x: rect.minX, y: rect.minY - 10_000, width: rect.width, height: rect.height + 10_000))
    }
}

private struct FreezeWidthWhileResizing: ViewModifier {
    /// A heavy pane (the transcript list) also holds during a pane-divider drag. A light one follows
    /// the divider: frozen, it left a dark gap beside the divider until release (recording 15:09).
    let heavy: Bool
    /// Set: holds only while that live side panel drags (`ResizableSidePanel.holdsLayout` off), and
    /// follows every other resize. A main view beside the hub sidebar outside Sessions mode.
    var panel: String?
    @ObservedObject private var live = HubLiveResize.shared
    @State private var size: CGSize = .zero
    @State private var frozen: CGSize?

    private var holds: Bool {
        if let panel { return live.sources.contains("split.panel.\(panel)") }
        return live.active && (heavy || !live.splitOnly)
    }

    func body(content: Content) -> some View {
        content
            .frame(width: frozen?.width, height: frozen?.height, alignment: .topLeading)
            // Explicit zero minimums: without them the flexible frame takes the frozen child's size
            // as its minimum, and a shrinking window pushed the whole root off its left edge.
            .frame(minWidth: 0, maxWidth: .infinity, minHeight: 0, maxHeight: .infinity, alignment: .topLeading)
            // Open at the top: a `TitlebarHeader` row sits above this frame, in the title bar strip. A plain
            // `.clipped()` cut it away, so the PR header (forge badge, title, Diff) never drew (2026-10-01).
            .clipShape(OpenTopRectangle())
            .onGeometryChange(for: CGSize.self, of: \.size) { size = $0 }
            .onChange(of: holds) { _, hold in
                var transaction = Transaction()
                transaction.disablesAnimations = true
                withTransaction(transaction) { frozen = hold && size.width > 0 ? size : nil }
            }
    }
}

extension View {
    func freezesWidthWhileResizing(heavy: Bool = true) -> some View { modifier(FreezeWidthWhileResizing(heavy: heavy)) }

    /// Holds only while the live side panel `key` drags; it moves with the panel's edge at once and
    /// reflows on release.
    func freezesWidthWhileDragging(panel key: String) -> some View {
        modifier(FreezeWidthWhileResizing(heavy: false, panel: key))
    }
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
/// `holdsLayout` off: the neighbour follows the drag on every step (the PRs list beside a PR). On, the
/// default: the layout keeps its start width until release (the transcript beside the session list).
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
    var holdsLayout = true
    /// The panel's own content keeps the width the drag began with and lays out once, on release; the
    /// edge still moves with the pointer (the content is clipped, or the surface fills the rest). For
    /// content that re-wraps: the PR list's two-line titles and its toolbar re-laid out on every step,
    /// so the rows jumped under the pointer for the whole drag (2026-10-04).
    var holdsContent = false
    /// Controls drawn in the folded rail under its title, live while the panel is folded: the hub's mode
    /// switch, so a narrow window still reaches every mode in one click (H13).
    var railAccessory: AnyView?
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
         maxWidth: CGFloat = 900, autoCollapse: Bool = false, fitWidth: CGFloat? = nil, holdsLayout: Bool = true,
         holdsContent: Bool = false, railAccessory: AnyView? = nil, @ViewBuilder content: @escaping () -> Content) {
        self.key = key
        self.edge = edge
        self.title = title
        self.defaultWidth = defaultWidth
        self.minWidth = minWidth
        self.maxWidth = maxWidth
        self.autoCollapse = autoCollapse
        self.fitWidth = fitWidth
        self.holdsLayout = holdsLayout
        self.holdsContent = holdsContent
        self.railAccessory = railAccessory
        self.content = content
        _width = AppStorage(wrappedValue: Double(defaultWidth), "panel.\(key).width")
        _collapsed = AppStorage(wrappedValue: false, "panel.\(key).collapsed")
    }

    /// The fitted width until the reader drags this panel in this window, then the saved one.
    private var baseWidth: Double {
        guard let fitWidth, !SidePanelSizing.resized.contains(key) else { return width }
        // Capped like the shown width: the narrow-window drawer uses this one as it is.
        return Double(min(max(minWidth, fitWidth), max(minWidth, maxWidth)))
    }
    /// The width being drawn: the drag's live value, else the base one, never more than the room.
    private var shownWidth: CGFloat { min(CGFloat(liveWidth ?? baseWidth), max(minWidth, maxWidth)) }
    private var willCollapse: Bool { liveWidth.map { $0 < Double(minWidth) } ?? false }
    /// While a drag runs, the layout keeps the width the drag began with and the panel draws over its
    /// neighbour (or leaves a gap); everything reflows once, on release. Moving the neighbour made
    /// SwiftUI rebuild the window's key view loop on every step, which walks every transcript row:
    /// 82 ms of main thread per step, 23 ms with the layout held (`--bench`, 2026-09-24). Beside the PR
    /// detail the held slot read as the pane lagging behind the divider with a dark gap, then jumping on
    /// release (recording 2026-09-30). With `holdsLayout` off the neighbour moves with the edge on every
    /// step instead, and keeps its content's size until release (`freezesWidthWhileDragging(panel:)`).
    private var slotWidth: CGFloat {
        guard holdsLayout else { return shownWidth }
        return min(CGFloat(dragStart ?? baseWidth), max(minWidth, maxWidth))
    }
    /// The content's own width: the drag's start width while `holdsContent` holds it, else the shown one.
    private var contentWidth: CGFloat {
        guard holdsContent, let dragStart else { return shownWidth }
        return min(CGFloat(dragStart), max(minWidth, maxWidth))
    }
    /// A live layout still has the light panes follow instead of freezing (`HubLiveResize.splitOnly`).
    private var resizeSource: String { holdsLayout ? "panel.\(key)" : "split.panel.\(key)" }
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
                    .frame(width: max(0, contentWidth))
                    .frame(width: max(0, shownWidth), alignment: edge == .leading ? .leading : .trailing)
                    .modifier(HeldContentClip(active: holdsContent && dragStart != nil))
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
            .titlebarBackground(Rectangle().fill(ReviewPalette.hairline))
    }

    private var rail: some View {
        // The whole rail opens the panel; the accessory's own controls sit on top and keep their clicks.
        ZStack(alignment: .top) {
            Button {
                if autoCollapse, !collapsed {
                    withAnimation(.snappy(duration: 0.25)) { drawerOpen.toggle() }
                } else {
                    withAnimation(.snappy(duration: 0.25)) { collapsed = false }
                }
            } label: {
                Color.clear
                    .frame(width: Self.railWidth)
                    .frame(maxHeight: .infinity)
                    .contentShape(Rectangle())
            }
            .buttonStyle(RowButtonStyle(cornerRadius: 0))
            .instantTooltip(autoCollapse && !collapsed ? "Show \(title) over the content (the window is too narrow to fit it)" : "Show \(title)")
            .accessibilityLabel(Text("Show \(title)"))
            VStack(spacing: 10) {
                Group {
                    Image(systemName: edge == .leading ? "sidebar.left" : "sidebar.right")
                        .font(.system(size: 12, weight: .medium))
                    Text(title)
                        .font(.system(size: 11, weight: .semibold))
                        .fixedSize()
                        .rotationEffect(.degrees(edge == .leading ? -90 : 90))
                        .frame(width: 14, height: 80)
                }
                .foregroundColor(ReviewPalette.dim)
                .allowsHitTesting(false)
                .accessibilityHidden(true)
                if let railAccessory {
                    Rectangle().fill(ReviewPalette.hairline).frame(width: 16, height: 1)
                    railAccessory
                }
            }
            .padding(.top, 44)
            .frame(width: Self.railWidth)
        }
        .frame(width: Self.railWidth)
        .frame(maxHeight: .infinity)
        .hubSurface(.chrome)
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
            // A background, so the line can reach up through the title bar like the surfaces on both
            // sides of it; the hit target below stays out of the title bar.
            .titlebarBackground(Rectangle().fill(hot ? tint.opacity(0.55) : ReviewPalette.hairline))
        .overlay(Color.clear.frame(width: 10).contentShape(Rectangle()))
        .animation(.easeOut(duration: 0.14), value: hot)
        .animation(.easeOut(duration: 0.14), value: willCollapse)
        .onHover { inside in
            if inside != hovering { hovering = inside }
        }
        .hoverCursor(.resizeLeftRight)
        // Released below the minimum, the handle goes away under the pointer and never sees the
        // hover end: without this the resize cursor stayed until another view set its own.
        .onDisappear {
            if hovering { NSCursor.arrow.set() }
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
            HubLiveResize.shared.begin(resizeSource)
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
        HubLiveResize.shared.end(resizeSource)
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
        .buttonStyle(RowButtonStyle(cornerRadius: 0))
        .hubSurface(.chrome)
        .instantTooltip(open ? "Hide \(tab.title)" : "Show \(tab.title) over the other panes (the window is too narrow to fit it beside them)")
        .accessibilityLabel(Text(open ? "Hide \(tab.title)" : "Show \(tab.title)"))
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
        // A surface that reaches the window's top edge also paints the transparent title bar above it.
        // Without this the title bar strip kept the window's own colour, a band of a third grey over the
        // sidebar (screenshot 2026-09-24 19:41). A surface lower down touches no safe area, so this
        // changes nothing for it. The strip's clicks stay with `.titlebarZone()` (WindowTitlebar.swift).
        content.titlebarBackground(fill)
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

// MARK: - Cursors

/// Shows `cursor` while the pointer is over the view, set again on every move. A push on hover lost to
/// the text and web views underneath, which reset the cursor on their next mouse move, and a push
/// without its pop (a hover that never ended) left a stale cursor behind for the whole window. A view
/// swapped out under the pointer (a link that becomes a label) gets no `.ended`, so it resets on disappear.
private struct HoverCursor: ViewModifier {
    let cursor: NSCursor
    @State private var hovering = false

    func body(content: Content) -> some View {
        content
            .onContinuousHover { phase in
                switch phase {
                case .active:
                    if !hovering {
                        hovering = true
                    }

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

extension View {
    func hoverCursor(_ cursor: NSCursor) -> some View { modifier(HoverCursor(cursor: cursor)) }
}

// MARK: - Pane divider grips

/// The hub's panes sit in an `HSplitView`, so their dividers are AppKit's bare 1 pt NSSplitView ones: no
/// grip, a one-pixel target, and a cursor the neighbouring text and web views take over. This view lies
/// over the split and gives each divider what the side panels have (`ResizableSidePanel.handle`): a
/// 10 pt target, the resize cursor and the glowing grip, and it moves the divider itself.
struct PaneDividerGrips: NSViewRepresentable {
    func makeNSView(context: Context) -> PaneDividerGripView { PaneDividerGripView() }
    func updateNSView(_ view: PaneDividerGripView, context: Context) {}
}

/// Lets every event through except within `reach` of a divider, and keeps no SwiftUI state, so hovering
/// and dragging re-render nothing. A drag calls `setPosition(_:ofDividerAt:)`, which posts the same
/// `willResizeSubviews` notification a divider drag does, so `HubLiveResize` holds the heavy panes.
final class PaneDividerGripView: NSView {
    private static let reach: CGFloat = 5
    private weak var split: NSSplitView?
    private var splitObserver: NSObjectProtocol?
    private var hot: Int? {
        didSet { if hot != oldValue { needsDisplay = true } }
    }
    private var drag: (index: Int, startX: CGFloat, startPosition: CGFloat)?

    override var isFlipped: Bool { true }

    deinit {
        if let splitObserver { NotificationCenter.default.removeObserver(splitObserver) }
    }

    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        split = nil
    }

    /// The vertical NSSplitView under this view: the one that fills the same rectangle of the window.
    private func resolvedSplit() -> NSSplitView? {
        if let split, split.window === window { return split }
        guard let root = window?.contentView else { return nil }
        let mine = convert(bounds, to: nil)
        let found = Self.splitViews(in: root).first { candidate in
            let theirs = candidate.convert(candidate.bounds, to: nil)
            return candidate.isVertical && abs(theirs.minX - mine.minX) < 2 && abs(theirs.minY - mine.minY) < 2
                && abs(theirs.width - mine.width) < 2
        }
        split = found
        if let splitObserver { NotificationCenter.default.removeObserver(splitObserver) }
        splitObserver = found.map { split in
            NotificationCenter.default.addObserver(forName: NSSplitView.didResizeSubviewsNotification, object: split, queue: .main) { [weak self] _ in
                MainActor.assumeIsolated {
                    guard let self else { return }
                    self.window?.invalidateCursorRects(for: self)
                    if self.hot != nil { self.needsDisplay = true }
                }
            }
        }
        return found
    }

    private static func splitViews(in view: NSView) -> [NSSplitView] {
        var found: [NSSplitView] = []
        for child in view.subviews {
            if let split = child as? NSSplitView { found.append(split) }
            found += splitViews(in: child)
        }
        return found
    }

    /// Each divider's centre, in this view's coordinates.
    private func dividerXs() -> [CGFloat] {
        guard let split = resolvedSplit() else { return [] }
        let panes = split.arrangedSubviews
        guard panes.count > 1 else { return [] }
        return (0 ..< panes.count - 1).map { index in
            let x = panes[index].frame.maxX + split.dividerThickness / 2
            return convert(NSPoint(x: x, y: 0), from: split).x
        }
    }

    private func divider(at point: NSPoint) -> Int? {
        let nearest = dividerXs().enumerated().min { abs($0.element - point.x) < abs($1.element - point.x) }
        guard let nearest, abs(nearest.element - point.x) <= Self.reach else { return nil }
        return nearest.offset
    }

    override func hitTest(_ point: NSPoint) -> NSView? {
        let local = convert(point, from: superview)
        guard bounds.contains(local), divider(at: local) != nil else { return nil }
        return self
    }

    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        trackingAreas.forEach(removeTrackingArea)
        addTrackingArea(NSTrackingArea(rect: .zero, options: [.mouseMoved, .mouseEnteredAndExited, .cursorUpdate, .activeInKeyWindow, .inVisibleRect], owner: self))
    }

    override func resetCursorRects() {
        for x in dividerXs() {
            addCursorRect(NSRect(x: x - Self.reach, y: 0, width: Self.reach * 2, height: bounds.height), cursor: .resizeLeftRight)
        }
    }

    override func cursorUpdate(with event: NSEvent) {
        if hot != nil || drag != nil { NSCursor.resizeLeftRight.set() } else { super.cursorUpdate(with: event) }
    }

    override func mouseMoved(with event: NSEvent) { track(event) }
    override func mouseEntered(with event: NSEvent) { track(event) }

    override func mouseExited(with event: NSEvent) {
        if drag == nil { hot = nil }
    }

    private func track(_ event: NSEvent) {
        guard drag == nil else { return }
        hot = divider(at: convert(event.locationInWindow, from: nil))
        if hot != nil { NSCursor.resizeLeftRight.set() }
    }

    override func mouseDown(with event: NSEvent) {
        guard let index = divider(at: convert(event.locationInWindow, from: nil)), let split = resolvedSplit() else {
            super.mouseDown(with: event)
            return
        }
        drag = (index, event.locationInWindow.x, split.arrangedSubviews[index].frame.maxX)
        hot = index
        NSCursor.resizeLeftRight.set()
    }

    override func mouseDragged(with event: NSEvent) {
        guard let drag, let split = resolvedSplit() else { return }
        split.setPosition(drag.startPosition + event.locationInWindow.x - drag.startX, ofDividerAt: drag.index)
        NSCursor.resizeLeftRight.set()
        needsDisplay = true
    }

    override func mouseUp(with event: NSEvent) {
        guard drag != nil else { return }
        drag = nil
        window?.invalidateCursorRects(for: self)
        track(event)
    }

    override func draw(_ dirtyRect: NSRect) {
        guard let index = drag?.index ?? hot else { return }
        let xs = dividerXs()
        guard xs.indices.contains(index) else { return }
        let x = xs[index]
        let tint = NSColor(ReviewPalette.renamed)
        tint.withAlphaComponent(0.55).setFill()
        NSRect(x: x - 0.5, y: 0, width: 1, height: bounds.height).fill()
        NSGraphicsContext.saveGraphicsState()
        let glow = NSShadow()
        glow.shadowColor = tint.withAlphaComponent(0.6)
        glow.shadowBlurRadius = 6
        glow.set()
        tint.setFill()
        NSBezierPath(roundedRect: NSRect(x: x - 2, y: bounds.midY - 18, width: 4, height: 36), xRadius: 2, yRadius: 2).fill()
        NSGraphicsContext.restoreGraphicsState()
    }
}
