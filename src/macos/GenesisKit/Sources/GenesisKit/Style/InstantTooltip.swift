import AppKit
import SwiftUI

/// THE shared instant tooltip for every Genesis surface (main window, session
/// details, the menu-bar usage popup). One floating NSPanel, one sensor, one
/// bubble. The app forwards its public `.instantTooltip` here, so there is a
/// single implementation to fix.
///
/// Look is themable: the app injects its palette once at launch via
/// `InstantTooltipStyle.current`; the kit default is a neutral dark bubble so
/// the popup looks right even before the app configures it.
public struct InstantTooltipStyle: Sendable {
    public var fontSize: CGFloat
    public var textColor: Color
    /// No `background`: the bubble is the system `.toolTip` vibrancy material
    /// (see `TooltipPresenter.show`), so a flat colour would never be read.
    public var border: Color

    public init(
        fontSize: CGFloat = 11,
        textColor: Color = Color.white.opacity(0.92),
        border: Color = Color.white.opacity(0.14)
    ) {
        self.fontSize = fontSize
        self.textColor = textColor
        self.border = border
    }

    @MainActor public static var current = InstantTooltipStyle()
}

/// What a tooltip says: an optional bold title, then paragraphs and bullets.
///
/// A plain string reads as one: with several lines the first is the title, and a line that starts
/// with "• " is a bullet (hanging indent under its dot). A monospaced tooltip (a command, a path)
/// keeps its text as it is.
public struct TooltipContent: Equatable, Sendable {
    public enum Line: Equatable, Sendable {
        case text(String)
        case bullet(String)
    }

    public var title: String?
    public var lines: [Line]
    public var monospaced: Bool

    public init(title: String? = nil, lines: [Line] = [], monospaced: Bool = false) {
        self.title = title
        self.lines = lines
        self.monospaced = monospaced
    }

    public init(title: String?, bullets: [String], footer: [String] = []) {
        self.init(title: title, lines: bullets.map(Line.bullet) + footer.map(Line.text))
    }

    public init(_ text: String, monospaced: Bool = false) {
        guard !monospaced else {
            self.init(lines: text.isEmpty ? [] : [.text(text)], monospaced: true)
            return
        }
        var rows = text.split(separator: "\n", omittingEmptySubsequences: true).map(String.init)
        let lines = { (rows: [String]) in
            rows.map { $0.hasPrefix(Self.bulletPrefix) ? Line.bullet(String($0.dropFirst(Self.bulletPrefix.count))) : .text($0) }
        }
        guard rows.count > 1, !rows[0].hasPrefix(Self.bulletPrefix) else {
            self.init(lines: lines(rows))
            return
        }
        let title = rows.removeFirst()
        self.init(title: title, lines: lines(rows))
    }

    public static let bulletPrefix = "• "

    public var isEmpty: Bool { (title ?? "").isEmpty && lines.isEmpty }
}

/// Owns the single reusable tooltip panel, plus a watchdog that kills the
/// bubble whenever its anchor stops being hoverable. `mouseExited` alone is
/// not enough: it never fires when the anchor's window closes (menu-bar
/// popover), or when a scroll moves the row away under a stationary cursor —
/// both left the old tooltip hanging mid-screen.
@MainActor
public final class TooltipPresenter {
    public static let shared = TooltipPresenter()
    // `private(set)`, not `private`: the tests in InstantTooltipTests assert on
    // panel reuse, ownership and watchdog teardown, and only the getters are
    // module-visible — every write still happens in this file.
    private(set) var panel: NSPanel?
    private(set) var currentOwner: UUID?
    private weak var anchorView: NSView?
    private var shownAnchorRect: CGRect = .zero
    private(set) var watchdog: Timer?

    /// Widest a bubble may get before its text wraps. One line at any length
    /// made a 190-character hint about 1250pt wide, past a laptop screen.
    static let maxBubbleWidth: CGFloat = 360

    func show(owner: UUID, text: String, anchorView: NSView, below: Bool) {
        show(owner: owner, content: TooltipContent(text), anchorView: anchorView, below: below)
    }

    func show(owner: UUID, content: TooltipContent, anchorView: NSView, below: Bool) {
        guard !content.isEmpty, let window = anchorView.window else { return }
        guard TooltipGuard.allows(owner, in: window) else { return } // never over an open menu or popover (TooltipGuard.swift).
        let anchorScreenRect = window.convertToScreen(anchorView.convert(anchorView.bounds, to: nil))
        // An enclosing control (a whole row) must not replace the tooltip of
        // a control inside it. Both sensors get `mouseEntered` together when
        // the pointer lands on the inner control, and whichever timer fired
        // last used to win, so a row's "Click to expand." hid the badge's own
        // text half of the time.
        if currentOwner != nil, currentOwner != owner, let shown = self.anchorView, shown.window === window,
           anchorScreenRect.contains(shownAnchorRect), anchorScreenRect != shownAnchorRect {
            return
        }
        let style = InstantTooltipStyle.current
        let hosting = NSHostingView(rootView: TooltipBubble(content: content, style: style, wrapWidth: nil))
        hosting.layout()
        var size = hosting.fittingSize
        if size.width > Self.maxBubbleWidth {
            // Too wide: wrap inside a fixed width and let the height follow.
            hosting.rootView = TooltipBubble(content: content, style: style, wrapWidth: Self.maxBubbleWidth)
            hosting.layout()
            size = hosting.fittingSize
        }
        let panel = panel ?? makePanel()
        // Native vibrancy bubble: the flat SwiftUI rectangle looked cheap on
        // 1x displays. NSVisualEffectView with the system .toolTip material
        // (forced dark) blurs whatever sits behind the panel, exactly like
        // AppKit's own tooltips, with a hairline border on the layer.
        let effect = NSVisualEffectView(frame: CGRect(origin: .zero, size: size))
        effect.material = .toolTip
        effect.state = .active
        effect.blendingMode = .behindWindow
        effect.wantsLayer = true
        effect.layer?.cornerRadius = 7
        effect.layer?.cornerCurve = .continuous
        effect.layer?.masksToBounds = true
        effect.layer?.borderWidth = 1
        effect.layer?.borderColor = NSColor(style.border).cgColor
        hosting.frame = effect.bounds
        hosting.autoresizingMask = [.width, .height]
        effect.addSubview(hosting)
        panel.contentView = effect
        // Screen coords are bottom-left origin (y grows up). "below" the button
        // visually = lower on screen = smaller y.
        var x = anchorScreenRect.midX - size.width / 2
        var y = below ? anchorScreenRect.minY - size.height - 6
                      : anchorScreenRect.maxY + 6
        let screen = NSScreen.screens.first { $0.frame.intersects(anchorScreenRect) } ?? NSScreen.main
        if let visible = screen?.visibleFrame {
            x = min(max(x, visible.minX + 4), visible.maxX - size.width - 4)
            y = min(max(y, visible.minY + 4), visible.maxY - size.height - 4)
        }
        panel.setFrame(CGRect(x: x, y: y, width: size.width, height: size.height), display: true)
        panel.orderFront(nil)
        self.panel = panel
        currentOwner = owner
        self.anchorView = anchorView
        shownAnchorRect = anchorScreenRect
        startWatchdog()
    }

    func hide(owner: UUID) {
        guard currentOwner == owner else { return }
        hideNow()
    }

    private func hideNow() {
        panel?.orderOut(nil)
        currentOwner = nil
        anchorView = nil
        watchdog?.invalidate()
        watchdog = nil
    }

    /// While the bubble is up, re-check ~7×/s that the anchor is still a live,
    /// visible view in a visible window, still at the position we anchored to,
    /// and still under the pointer. Any miss dismisses the tooltip.
    private func startWatchdog() {
        watchdog?.invalidate()
        let timer = Timer(timeInterval: 0.15, repeats: true) { _ in
            Task { @MainActor in TooltipPresenter.shared.watchdogTick() }
        }
        RunLoop.main.add(timer, forMode: .common)
        watchdog = timer
    }

    /// Internal rather than private so tests can drive a tick directly instead
    /// of waiting on the 0.15s timer.
    func watchdogTick() {
        guard currentOwner != nil else {
            watchdog?.invalidate()
            watchdog = nil
            return
        }
        guard let view = anchorView,
              let window = view.window,
              window.isVisible,
              view.superview != nil,
              !view.visibleRect.isEmpty
        else {
            hideNow()
            return
        }
        let rect = window.convertToScreen(view.convert(view.bounds, to: nil))
        // Content scrolled: the row moved out from under the bubble.
        if abs(rect.midX - shownAnchorRect.midX) > 1 || abs(rect.midY - shownAnchorRect.midY) > 1 {
            hideNow()
            return
        }
        // Pointer left without a mouseExited (e.g. window switch, warp).
        if !rect.insetBy(dx: -3, dy: -3).contains(NSEvent.mouseLocation) {
            hideNow()
        }
    }

    private func makePanel() -> NSPanel {
        let p = NSPanel(
            contentRect: .zero,
            styleMask: [.borderless, .nonactivatingPanel],
            backing: .buffered,
            defer: true
        )
        p.isFloatingPanel = true
        p.level = .popUpMenu          // above all app windows
        // Genesis is always-dark; pin the material so a light system theme
        // never produces a white bubble over the dark UI.
        p.appearance = NSAppearance(named: .darkAqua)
        p.backgroundColor = .clear
        p.isOpaque = false
        p.hasShadow = true
        p.ignoresMouseEvents = true   // never blocks clicks / hover
        p.hidesOnDeactivate = false
        p.collectionBehavior = [.transient, .ignoresCycle, .fullScreenAuxiliary]
        return p
    }
}

private struct TooltipBubble: View {
    let content: TooltipContent
    let style: InstantTooltipStyle
    /// nil: natural width, no wrapping. Otherwise the whole bubble is this
    /// wide and the text wraps inside it.
    let wrapWidth: CGFloat?

    var body: some View {
        // Text only — the vibrancy material, border and corner radius live on
        // the NSVisualEffectView the presenter wraps this in, and the drop
        // shadow comes from the panel itself.
        let stack = VStack(alignment: .leading, spacing: 3) {
            if let title = content.title, !title.isEmpty {
                wrapping(Text(verbatim: title).font(.system(size: style.fontSize, weight: .semibold)))
                    .foregroundColor(style.textColor)
                    .padding(.bottom, content.lines.isEmpty ? 0 : 1)
            }
            ForEach(Array(content.lines.enumerated()), id: \.offset) { _, line in
                switch line {
                case .text(let text):
                    wrapping(Text(verbatim: text).font(bodyFont))
                case .bullet(let text):
                    // Hanging indent: a wrapped bullet continues under its text, not under the dot.
                    HStack(alignment: .firstTextBaseline, spacing: 5) {
                        Text(verbatim: "•").font(bodyFont.weight(.bold))
                        wrapping(Text(verbatim: text).font(bodyFont))
                    }
                }
            }
            .foregroundColor(content.title == nil ? style.textColor : style.textColor.opacity(0.82))
        }
        .padding(.horizontal, 10)
        .padding(.vertical, content.title == nil && content.lines.count < 2 ? 5 : 7)
        if let wrapWidth {
            stack.frame(width: wrapWidth, alignment: .leading)
        } else {
            stack.fixedSize()
        }
    }

    private var bodyFont: Font {
        content.monospaced
            ? .system(size: style.fontSize, weight: .medium, design: .monospaced)
            : .system(size: style.fontSize)
    }

    /// Natural width: explicit lines stay one line each. Wrapped: the text breaks inside the width.
    private func wrapping(_ text: Text) -> some View {
        text
            .lineLimit(nil)
            .multilineTextAlignment(.leading)
            .fixedSize(horizontal: wrapWidth == nil, vertical: true)
    }
}

/// A hover sensor placed over the target. Uses an NSTrackingArea so it fires in
/// ANY host (incl. the titlebar) and `hitTest → nil` so it never eats clicks.
private struct TooltipHoverSensor: NSViewRepresentable {
    let content: TooltipContent
    let below: Bool

    func makeNSView(context: Context) -> SensorView {
        let v = SensorView()
        v.content = content
        v.below = below
        return v
    }

    func updateNSView(_ v: SensorView, context: Context) {
        v.content = content
        v.below = below
    }

    final class SensorView: NSView {
        /// Ownership token — a UUID, never an address, so a recycled allocation
        /// can't steal a live tooltip's hide (see the app-side history).
        let tooltipToken = UUID()
        var content = TooltipContent()
        var below = true
        private var tracking: NSTrackingArea?
        private var pending: DispatchWorkItem?

        override func hitTest(_ point: NSPoint) -> NSView? { nil } // clicks pass through

        // the sensor is created under the pointer (see `InstantTooltip`), and a
        // tracking area added there never reports the entry. Arriving counts as entering, leaving as exiting.
        override func viewDidMoveToWindow() {
            super.viewDidMoveToWindow()
            if window != nil {
                entered()
            }
        }

        override func viewWillMove(toWindow newWindow: NSWindow?) {
            super.viewWillMove(toWindow: newWindow)
            if newWindow == nil, window != nil {
                exited()
            }
        }

        override func updateTrackingAreas() {
            super.updateTrackingAreas()
            if let t = tracking { removeTrackingArea(t) }
            let t = NSTrackingArea(
                rect: bounds,
                options: [.mouseEnteredAndExited, .activeAlways, .inVisibleRect],
                owner: self,
                userInfo: nil
            )
            addTrackingArea(t)
            tracking = t
        }

        override func mouseEntered(with event: NSEvent) {
            entered()
        }

        override func mouseExited(with event: NSEvent) {
            exited()
        }

        private func entered() {
            TooltipGuard.entered(tooltipToken, view: self) // a click on this control mutes its bubble (TooltipGuard.swift).
            pending?.cancel()
            let work = DispatchWorkItem { [weak self] in self?.present() }
            pending = work
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.18, execute: work)
        }

        private func exited() {
            TooltipGuard.exited(tooltipToken) // leaving the control unmutes it (TooltipGuard.swift).
            pending?.cancel()
            TooltipPresenter.shared.hide(owner: tooltipToken)
        }

        private func present() {
            guard window != nil, !content.isEmpty else { return }
            TooltipPresenter.shared.show(
                owner: tooltipToken,
                content: content,
                anchorView: self,
                below: below
            )
        }

        deinit {
            let id = tooltipToken
            // Rows come and go with every lazy-stack pass, and a Task per
            // deinit was 67 ms of one popup open (2026-09-02 `sample`). NSView
            // deinit runs on the main thread, so hide inline there.
            if Thread.isMainThread {
                MainActor.assumeIsolated { TooltipPresenter.shared.hide(owner: id) }
            } else {
                Task { @MainActor in TooltipPresenter.shared.hide(owner: id) }
            }
        }
    }
}

/// Public modifier so the app target can forward its own `.instantTooltip`
/// extension here without creating an ambiguous duplicate extension.
public struct InstantTooltip: ViewModifier {
    let tooltip: TooltipContent
    let below: Bool

    public init(text: String, monospaced: Bool = false, below: Bool = true) {
        self.init(content: TooltipContent(text, monospaced: monospaced), below: below)
    }

    public init(content: TooltipContent, below: Bool = true) {
        self.tooltip = content
        self.below = below
    }

    // the sensor (an NSView) exists only while the pointer is over the view.
    // Every NSViewRepresentable is a platform responder, and SwiftUI walks all of them whenever the
    // accessibility focus updates: folding a PR group with #424 open cost 900 ms of main thread, 440 ms
    // without the sensors (2026-09-24, `HubMainBusy` "groups.prs.repos.toggle").
    @State private var hovering = false

    public func body(content: Content) -> some View {
        content
            .onHover { inside in
                if hovering != inside { hovering = inside }
            }
            .overlay {
                if hovering {
                    TooltipHoverSensor(content: tooltip, below: below)
                }
            }
    }
}

public extension View {
    /// The instant hover label every control in both apps uses (a floating panel, no delay). Several
    /// lines: the first is a bold title and "• " lines are bullets (`TooltipContent`). `monospaced` for
    /// a command or a path, shown as it is.
    func instantTooltip(_ text: String, monospaced: Bool = false, below: Bool = true) -> some View {
        modifier(InstantTooltip(text: text, monospaced: monospaced, below: below))
    }

    /// A title over a bulleted list: `.instantTooltip(title: "Blocked", bullets: ["It is a draft", …])`.
    func instantTooltip(title: String?, bullets: [String], below: Bool = true) -> some View {
        modifier(InstantTooltip(content: TooltipContent(title: title, bullets: bullets), below: below))
    }

    func instantTooltip(_ content: TooltipContent, below: Bool = true) -> some View {
        modifier(InstantTooltip(content: content, below: below))
    }
}
