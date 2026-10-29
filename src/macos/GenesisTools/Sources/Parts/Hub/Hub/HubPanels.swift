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
    /// Only a pane divider is moving: its source starts with "split". Light panes follow it live; only the
    /// transcript list holds. A side panel drag starts none of this: its neighbours keep their layout anyway.
    @Published private(set) var splitOnly = false
    /// What resizes now: "window", "split" (a pane divider), "panel.<key>" (a side panel holding its
    /// layout), "split.panel.<key>" (a side panel laid out live).
    @Published private(set) var sources: Set<String> = []
    /// A panel's release animation runs: its neighbour lays out once at its final size and holds it while the
    /// panel's slot animates (`PaneHold`), instead of reflowing on every frame (a sidebar release in PRs mode cost
    /// 200 to 330 ms of main thread, most of it the web diff resized per frame, 2026-10-29).
    @Published private(set) var release: Release?
    private var observers: [NSObjectProtocol] = []

    struct Release: Equatable {
        /// The released panel's key; the pane with `neighbourOf` that key holds.
        let neighbourOf: String
        /// How much the panel grew (positive) or shrank; the neighbour's final length is its current one less this.
        let shift: CGFloat
        /// The released panel's edge, as seen from its neighbour: `.leading` for a sidebar on the left, `.top` for a
        /// list above.
        let edge: Edge
        let id: UInt64
    }

    private var releaseSerial: UInt64 = 0

    /// A side panel or list released its edge: `shift` points of change over `duration` seconds.
    func release(of key: String, shift: CGFloat, edge: Edge, duration: Double) {
        guard abs(shift) > 0.5 else { return }
        releaseSerial += 1
        let next = Release(neighbourOf: key, shift: shift, edge: edge, id: releaseSerial)
        release = next
        DispatchQueue.main.asyncAfter(deadline: .now() + duration + 0.08) { [weak self] in
            guard let self, self.release == next else { return }
            self.release = nil
        }
    }

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

/// A pane that holds its size through a live resize (`heavy`, see `HubLiveResize`) and through the release
/// animation of the panel it neighbours (`neighbourOf`): at the release it lays out once at the size it will have
/// when the animation ends, aligned to the edge away from the panel, so its content slides as one block while the
/// panel's slot catches up and never reflows per frame.
private struct PaneHold: ViewModifier {
    /// nil: never holds through a live resize. A heavy pane (the transcript list) also holds during a pane-divider
    /// drag. A light one follows the divider: frozen, it left a dark gap beside the divider until release
    /// (recording 15:09).
    let heavy: Bool?
    let neighbourOf: String?
    @ObservedObject private var live = HubLiveResize.shared
    @State private var size: CGSize = .zero
    @State private var frozen: CGSize?
    @State private var alignment: Alignment = .topLeading

    private var holds: Bool {
        guard let heavy else { return false }
        return live.active && (heavy || !live.splitOnly)
    }

    private var release: HubLiveResize.Release? {
        guard let neighbourOf, let release = live.release, release.neighbourOf == neighbourOf else { return nil }
        return release
    }

    func body(content: Content) -> some View {
        content
            .frame(width: frozen?.width, height: frozen?.height, alignment: alignment)
            // Explicit zero minimums: without them the flexible frame takes the frozen child's size
            // as its minimum, and a shrinking window pushed the whole root off its left edge.
            .frame(minWidth: 0, maxWidth: .infinity, minHeight: 0, maxHeight: .infinity, alignment: alignment)
            // Open at the top: a `TitlebarHeader` row sits above this frame, in the title bar strip. A plain
            // `.clipped()` cut it away, so the PR header (forge badge, title, Diff) never drew (2026-10-01).
            .clipShape(OpenTopRectangle())
            .onGeometryChange(for: CGSize.self, of: \.size) { size = $0 }
            .onChange(of: holds) { _, _ in update() }
            .onChange(of: release) { _, _ in update() }
    }

    private func update() {
        var transaction = Transaction()
        transaction.disablesAnimations = true
        withTransaction(transaction) {
            guard size.width > 0 else { frozen = nil; return }
            if let release {
                switch release.edge {
                case .leading:
                    alignment = .topLeading
                    frozen = CGSize(width: max(0, size.width - release.shift), height: size.height)
                case .trailing:
                    alignment = .topTrailing
                    frozen = CGSize(width: max(0, size.width - release.shift), height: size.height)
                case .top:
                    alignment = .topLeading
                    frozen = CGSize(width: size.width, height: max(0, size.height - release.shift))
                case .bottom:
                    alignment = .bottomLeading
                    frozen = CGSize(width: size.width, height: max(0, size.height - release.shift))
                }
            } else if holds {
                alignment = .topLeading
                frozen = size
            } else {
                frozen = nil
            }
        }
    }
}

extension View {
    /// `neighbourOf`: the key of the side panel or list whose release this pane holds through.
    func freezesWidthWhileResizing(heavy: Bool = true, neighbourOf: String? = nil) -> some View {
        modifier(PaneHold(heavy: heavy, neighbourOf: neighbourOf))
    }

    /// A pane that follows every resize step: zero minimums, so its content's minimum never pushes the root past
    /// the window (the root's width sets the sidebar's room, and that fed back into a layout loop at 100% CPU,
    /// 2026-10-29), and clipped open at the top like `freezesWidthWhileResizing`, so a title bar row still draws.
    /// `neighbourOf` names the side panel whose release it holds through (`PaneHold`).
    func flexiblePane(neighbourOf: String? = nil) -> some View {
        modifier(PaneHold(heavy: nil, neighbourOf: neighbourOf))
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
/// While a drag runs, only this panel changes: it draws over its neighbour (on an opaque backing, with a shadow at
/// its edge) or leaves a band of the neighbour's surface, and the neighbours keep their layout. On release the layout
/// animates to the new width once. Martin, 2026-10-29: "while resizing you will just overlap some other panel so the
/// panels dont have to relayout so much and when you release it it will just animate the other panels".
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
    /// Controls drawn in the folded rail under its title, live while the panel is folded: the hub's mode
    /// switch, so a narrow window still reaches every mode in one click (H13).
    var railAccessory: AnyView?
    @ViewBuilder let content: () -> Content

    @AppStorage private var collapsed: Bool
    /// The drag's state and the panel's rest width (`rest`: saved under `panel.<key>.width`). Only `GenResizeReveal`
    /// and the leaves it hangs on read it; this body reads none of it, so a step and a release re-run no body here
    /// and never re-render `content`.
    @State private var drag: GenResizeDrag
    @State private var drawerOpen = false
    @AppStorage(HubResizeGrips.key, store: HubDefaults.store) private var grips = HubResizeGrips.auto.rawValue

    static var railWidth: CGFloat { 28 }

    init(key: String, edge: Edge, title: String = "panel", defaultWidth: CGFloat = 300, minWidth: CGFloat = 180,
         maxWidth: CGFloat = 900, autoCollapse: Bool = false, fitWidth: CGFloat? = nil,
         railAccessory: AnyView? = nil, collapsedStore: UserDefaults? = nil,
         @ViewBuilder content: @escaping () -> Content) {
        self.key = key
        self.edge = edge
        self.title = title
        self.defaultWidth = defaultWidth
        self.minWidth = minWidth
        self.maxWidth = maxWidth
        self.autoCollapse = autoCollapse
        self.fitWidth = fitWidth
        self.railAccessory = railAccessory
        self.content = content
        _drag = State(wrappedValue: GenResizeDrag(rest: Self.restingWidth(
            key: key, defaultWidth: defaultWidth, minWidth: minWidth, maxWidth: maxWidth, fitWidth: fitWidth)))
        // A review window folds its own panel (`ReviewModel.panelDefaults`); nil is the window's store.
        _collapsed = AppStorage(wrappedValue: false, "panel.\(key).collapsed", store: collapsedStore)
    }

    static func widthKey(_ key: String) -> String { "panel.\(key).width" }

    /// The fitted width until the reader drags this panel in this process, then the saved one.
    private static func restingWidth(key: String, defaultWidth: CGFloat, minWidth: CGFloat, maxWidth: CGFloat,
                                     fitWidth: CGFloat?) -> CGFloat {
        if let fitWidth, !SidePanelSizing.resized.contains(key) {
            // Capped like the shown width: the narrow-window drawer uses this one as it is.
            return min(max(minWidth, fitWidth), max(minWidth, maxWidth))
        }
        return CGFloat(HubDefaults.store.object(forKey: widthKey(key)) as? Double ?? Double(defaultWidth))
    }

    /// A dragged or adjusted width: the new rest, saved, and the fitted width no longer applies.
    private func settle(_ width: CGFloat) {
        drag.rest = width
        HubDefaults.store.set(Double(width), forKey: Self.widthKey(key))
        SidePanelSizing.resized.insert(key)
    }

    /// The room the panel may take: the parent's `maxWidth`, never under the minimum.
    private var room: CGFloat { max(minWidth, maxWidth) }

    var body: some View {
        HStack(spacing: 0) {
            if collapsed || autoCollapse {
                if edge == .trailing { railLine }
                rail
                if edge == .leading { railLine }
            } else {
                // The content reflows with the edge (`layout: { $0 }`): this is the panel the reader wants to see
                // more or less of. The slot keeps the start width, so the neighbours hold their layout until release
                // (moving them per step re-laid out the PR overview, the diff's web view and the lists beside them:
                // 30 to 45 ms a step with an accessibility client, a blank diff while it resized, 2026-10-29). The
                // handle sits on the moving edge, above the content: as a sibling drawn first, the trailing one lay
                // under the file list, which took every press on its grab area.
                GenResizeReveal(drag: drag, axis: .horizontal, fixedEdge: edge == .leading ? .leading : .trailing,
                                clamp: { [room] in min($0, room) }, layout: { $0 },
                                accessibility: accessibility) {
                    content()
                        .genResizeCollapseHint(drag, text: "Release to collapse",
                                               systemImage: edge == .leading ? "arrow.left.to.line" : "arrow.right.to.line",
                                               color: ReviewPalette.modified)
                } handle: {
                    handle
                } uncovered: {
                    // Shrinking leaves part of the held slot uncovered: paint it as the neighbour, so it
                    // reads as the neighbour already growing instead of a stray strip (screenshot 15:08).
                    Color.clear
                        .frame(maxHeight: .infinity)
                        .hubSurface(.content)
                }
            }
        }
        .overlay(alignment: edge == .leading ? .topLeading : .topTrailing) {
            if autoCollapse, !collapsed, drawerOpen { drawer }
        }
        .genResizeRaised(drag, or: drawerOpen)
        .onChange(of: autoCollapse) { _, squeezed in
            if !squeezed { drawerOpen = false }
        }
        .onChange(of: fitWidth) { _, fitted in
            // The content's fitted width arrives after the first layout (`FileListFit`); it applies until a drag.
            guard let fitted, !SidePanelSizing.resized.contains(key) else { return }
            drag.rest = min(max(minWidth, fitted), room)
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
            .frame(width: max(minWidth, drag.rest))
            .frame(maxHeight: .infinity)
            .hubSurface(.chrome)
            .hubSurface(.drawer)
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
        let resting = (HubResizeGrips(rawValue: grips) ?? .auto).showsAtRest(prominent: false)
        return GenResizeHandle(
            drag: drag, axis: .horizontal, panelSide: edge == .leading ? .before : .after,
            tint: ReviewPalette.renamed, collapseTint: ReviewPalette.modified, line: ReviewPalette.hairline,
            gripAtRest: resting, throughTitlebar: true,
            tooltip: "Drag to resize; drag past the minimum to collapse",
            onChanged: dragChanged,
            onEnded: dragEnded)
        .onReceive(NotificationCenter.default.publisher(for: HubBench.panelDrag)) { note in
            guard let drag = note.object as? HubBench.PanelDrag, drag.key == key else { return }
            switch drag.phase {
            case .change(let translation): dragChanged(translation)
            case .end: dragEnded()
            }
        }
        .accessibilityAction(named: Text("Collapse \(title)")) {
            collapsed = true
        }
    }

    /// The same resize without a drag: VoiceOver's increment/decrement, and `tools control` (a synthetic drag in a
    /// background window never reaches a SwiftUI DragGesture).
    private var accessibility: GenResizeAccessibility {
        GenResizeAccessibility(label: "Resize \(title)") { increment in
            settle(max(minWidth, min(room, drag.rest + (increment ? 20 : -20))))
        }
    }

    private func dragChanged(_ translation: CGFloat) {
        if !drag.active { drag.begin(at: min(drag.rest, room)) }
        let delta = edge == .leading ? translation : -translation
        // Past the room the parent has, the panel would clip the content next to it.
        let next = max(0, min(room, (drag.start ?? drag.rest) + delta))
        drag.move(to: next, collapsing: next < minWidth)
    }

    private func dragEnded() {
        // Both onEnded and the gesture-state reset call this; only the first one counts.
        guard let start = drag.start else { return }
        let final = drag.live ?? start
        HubPerf.log("panel.\(key) resized to \(Int(final))")
        HubMainBusy.measure("resize.panel.\(key).release")
        // One reflow, animated: the neighbour lays out once at its final width and slides while this panel's slot
        // catches up (`PaneHold`); instant under Reduce Motion.
        let reduceMotion = GenMotion.systemReduceMotion
        let duration = reduceMotion ? 0 : GenMotion.duration(expanding: final >= start)
        let settled = final < minWidth ? Self.railWidth + 1 : final
        HubLiveResize.shared.release(of: key, shift: settled - start, edge: edge == .leading ? .leading : .trailing, duration: duration)
        withAnimation(GenMotion.animation(expanding: final >= start, reduceMotion: reduceMotion)) {
            drag.end("panel.\(key)", settleAfter: duration)
            if final < minWidth {
                // Collapsed panels reopen at the width they had before this drag.
                settle(max(minWidth, start))
                collapsed = true
            } else {
                settle(final)
            }
        }
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

private struct HubGlassKey: EnvironmentKey { static let defaultValue = false }

extension EnvironmentValues {
    /// On when the hub's glass mode is (`HubGlass`): surfaces let the blurred desktop through.
    var hubGlass: Bool {
        get { self[HubGlassKey.self] }
        set { self[HubGlassKey.self] = newValue }
    }
}

enum HubSurfaceLevel {
    /// Sidebars, rails, headers: the most see-through.
    case chrome
    /// Content columns (diff, decisions): barely tinted, readability first.
    case content
    /// Sticky headers over scrolling rows: frosted, so the rows under it never show through sharp.
    case bar
    /// A group header pinned over a list's rows (`GroupHeader`): the sidebar's colour in the Hub style, glass or
    /// not, a bar in the Native style.
    case groupHeader
    /// The base under a panel opened over the panes (a side panel's drawer): opaque in the Hub style, a bar in the
    /// Native style.
    case drawer

    /// The level's fill in the Native style.
    var native: NativePaneLevel {
        switch self {
        case .chrome: return .chrome
        case .content: return .content
        case .bar, .groupHeader, .drawer: return .bar
        }
    }
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
    /// The hub's Native style (`HubStyleHost`): the settings window's look over its backdrop.
    @Environment(\.nativePanes) private var native

    func body(content: Content) -> some View {
        switch level {
        case .groupHeader, .drawer:
            // Inside a list or over the panes: never at the window's top edge.
            content.background(fill)
        default:
            // A surface that reaches the window's top edge also paints the transparent title bar above it.
            // Without this the title bar strip kept the window's own colour, a band of a third grey over the
            // sidebar (screenshot 2026-09-24 19:41). A surface lower down touches no safe area, so this
            // changes nothing for it. The strip's clicks stay with `.titlebarZone()` (WindowTitlebar.swift).
            content.titlebarBackground(fill)
        }
    }

    @ViewBuilder
    private var fill: some View {
        if native {
            NativePaneFill(level.native)
        } else {
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
            case .groupHeader:
                ReviewPalette.sidebar
            case .drawer:
                Color(nsColor: ReviewPalette.background)
            }
        }
    }
}

// MARK: - Glass mode

/// The hub's glass mode (⌘⇧G, or the drop button by the mode picker): the window lets the blurred
/// desktop through, sidebars and headers go translucent, content columns stay nearly opaque for
/// reading, and on macOS 26 the floating controls get Liquid Glass. Persisted as `hub.glass`.
enum HubGlass {
    /// The window's content: the SwiftUI root inside a behind-window blur. The hosting view states
    /// no sizes of its own (`sizingOptions = []`): deriving min, max and intrinsic size re-measured
    /// the whole tree on every layout pass, a third of the main thread while resizing (sampled
    /// 2026-09-24). `HubRootView` sets the window's minimum explicitly instead.
    static func makeContentView<Root: View>(root: Root) -> NSView {
        let hosting = GenRootHostingView(rootView: root)
        hosting.sizingOptions = []
        // The root sits in an overlay host (GenesisKit `GenOverlayContentView`): the Changes pane's file list is an
        // AppKit table laid over its slot, so scrolling it never lays out the hub's SwiftUI root. With the table inside
        // the root, a scroll step of a 1864-file list cost 15.3 ms of main thread (hub bench, 2026-10-30).
        let content = GenOverlayContentView(root: hosting)
        content.translatesAutoresizingMaskIntoConstraints = false
        let effect = NSVisualEffectView()
        effect.blendingMode = .withinWindow
        effect.material = .windowBackground
        effect.state = .inactive
        effect.addSubview(content)
        NSLayoutConstraint.activate([
            content.leadingAnchor.constraint(equalTo: effect.leadingAnchor),
            content.trailingAnchor.constraint(equalTo: effect.trailingAnchor),
            content.topAnchor.constraint(equalTo: effect.topAnchor),
            content.bottomAnchor.constraint(equalTo: effect.bottomAnchor),
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

/// The glass switch by the mode picker. The same switch as Settings → Hub → Appearance → Glass, and like it only for
/// the Hub style: in the Native style it is unavailable and says why.
struct GlassToggle: View {
    @ObservedObject private var preferences = HubDefaults.preferences

    var body: some View {
        let native = preferences.style == .native
        let glass = preferences.glass && !native
        IconButton(
            systemName: glass ? "drop.fill" : "drop",
            tooltip: native
                ? "Glass is for the Hub style. \(HubGlassSwitch.nativeNote) (Settings → General)."
                : HubKeymap.hint(glass ? "Glass is on: click for solid" : "Glass: let the desktop show through", HubKeymap.glass)
        ) {
            withAnimation(.easeInOut(duration: 0.25)) { HubGlassSwitch.toggle() }
        }
        .foregroundColor(glass ? ReviewPalette.renamed : ReviewPalette.dim)
        .opacity(native ? 0.45 : 1)
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

extension View {
    /// GenesisKit's `genHoverCursor`: set again on every move, so the text and web views underneath cannot take it
    /// over, and the arrow comes back when the pointer leaves or the view goes.
    func hoverCursor(_ cursor: NSCursor) -> some View { genHoverCursor(cursor) }
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
