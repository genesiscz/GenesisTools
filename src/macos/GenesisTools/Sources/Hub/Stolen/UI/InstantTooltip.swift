// Copied from /Users/Martin/Tresors/Projects/GenesisPlayground.worktrees/genesis-session-redesign/Genesis/lib/GenesisAIMonitorKit/Sources/GenesisAIMonitorKit/InstantTooltip.swift at 2026-09-24T05:05:15+02:00 at commit hash 786292605d31a39fe795dafe34fb0f8d6f96d0a1
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
        guard !text.isEmpty, let window = anchorView.window else { return }
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
        let hosting = NSHostingView(rootView: TooltipBubble(text: text, style: style, wrapWidth: nil))
        hosting.layout()
        var size = hosting.fittingSize
        if size.width > Self.maxBubbleWidth {
            // Too wide: wrap inside a fixed width and let the height follow.
            hosting.rootView = TooltipBubble(text: text, style: style, wrapWidth: Self.maxBubbleWidth)
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
    let text: String
    let style: InstantTooltipStyle
    /// nil: natural width, no wrapping. Otherwise the whole bubble is this
    /// wide and the text wraps inside it.
    let wrapWidth: CGFloat?

    var body: some View {
        // Text only — the vibrancy material, border and corner radius live on
        // the NSVisualEffectView the presenter wraps this in, and the drop
        // shadow comes from the panel itself.
        if let wrapWidth {
            label
                .lineLimit(nil)
                .multilineTextAlignment(.leading)
                .fixedSize(horizontal: false, vertical: true)
                .padding(.horizontal, 10)
                .padding(.vertical, 5)
                .frame(width: wrapWidth, alignment: .leading)
        } else {
            // Natural width. Explicit "\n" breaks still start new lines (a
            // Focus timeline block puts the site on a second line).
            label
                .lineLimit(nil)
                .fixedSize()
                .padding(.horizontal, 10)
                .padding(.vertical, 5)
        }
    }

    private var label: some View {
        Text(text)
            .font(.system(size: style.fontSize, weight: .medium, design: .monospaced))
            .foregroundColor(style.textColor)
    }
}

/// A hover sensor placed over the target. Uses an NSTrackingArea so it fires in
/// ANY host (incl. the titlebar) and `hitTest → nil` so it never eats clicks.
private struct TooltipHoverSensor: NSViewRepresentable {
    let text: String
    let below: Bool

    func makeNSView(context: Context) -> SensorView {
        let v = SensorView()
        v.text = text
        v.below = below
        return v
    }

    func updateNSView(_ v: SensorView, context: Context) {
        v.text = text
        v.below = below
    }

    final class SensorView: NSView {
        /// Ownership token — a UUID, never an address, so a recycled allocation
        /// can't steal a live tooltip's hide (see the app-side history).
        let tooltipToken = UUID()
        var text = ""
        var below = true
        private var tracking: NSTrackingArea?
        private var pending: DispatchWorkItem?

        override func hitTest(_ point: NSPoint) -> NSView? { nil } // clicks pass through

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
            pending?.cancel()
            let work = DispatchWorkItem { [weak self] in self?.present() }
            pending = work
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.18, execute: work)
        }

        override func mouseExited(with event: NSEvent) {
            pending?.cancel()
            TooltipPresenter.shared.hide(owner: tooltipToken)
        }

        private func present() {
            guard window != nil, !text.isEmpty else { return }
            TooltipPresenter.shared.show(
                owner: tooltipToken,
                text: text,
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
    let text: String
    let below: Bool

    public init(text: String, below: Bool = true) {
        self.text = text
        self.below = below
    }

    public func body(content: Content) -> some View {
        content.overlay(TooltipHoverSensor(text: text, below: below))
    }
}

extension View {
    /// Instant hover label for kit surfaces (usage popup, session rows).
    func instantTooltip(_ text: String, below: Bool = true) -> some View {
        modifier(InstantTooltip(text: text, below: below))
    }
}
