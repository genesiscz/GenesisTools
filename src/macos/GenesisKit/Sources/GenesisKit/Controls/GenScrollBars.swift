import AppKit
import SwiftUI

/// Which scroll bars the hub's scroll views draw. GenesisKit's is a thin overlay knob that never takes layout width: a
/// visible system scroll bar ("Always" in System Settings, or a mouse attached) narrowed every list and covered the
/// diff's last column (Martin, 2026-11-10, annotations 2391 and 2393). Both faces read `key` through `@AppStorage`.
public enum GenScrollBarStyle: String, CaseIterable, Identifiable, Sendable {
    case genesis, system
    public static let key = "hub.scrollBars"
    public var id: String { rawValue }
    public var title: String {
        switch self {
        case .genesis: return "GenesisKit"
        case .system: return "System"
        }
    }

    public var detail: String {
        switch self {
        case .genesis: return "A thin bar over the content's edge, shown while you scroll or point at it. It never narrows a list."
        case .system: return "The macOS scroll bars, as System Settings → Appearance sets them. A visible one takes room from the content."
        }
    }

    /// Unset or unknown reads as GenesisKit.
    public init(stored: String?) {
        self = GenScrollBarStyle(rawValue: stored ?? "") ?? .genesis
    }
}

/// The GenesisKit scroller: no track, a rounded knob 5 pt wide (7 pt under the pointer) inset from the edge, in the
/// label colour at low alpha so it reads on the hub's dark panes and in a light theme. Compatible with overlay
/// scrollers, so the scroll view fades it in on scroll and out at rest and never gives it layout width.
public final class GenScroller: NSScroller {
    override public class var isCompatibleWithOverlayScrollers: Bool { true }

    override public class func scrollerWidth(for controlSize: NSControl.ControlSize, scrollerStyle: NSScroller.Style) -> CGFloat {
        11
    }

    private var hovering = false {
        didSet { if hovering != oldValue { needsDisplay = true } }
    }

    private var vertical: Bool { bounds.height >= bounds.width }

    override public func drawKnobSlot(in slotRect: NSRect, highlight flag: Bool) {}

    override public func drawKnob() {
        let knob = rect(for: .knob)
        guard knob.width > 0, knob.height > 0 else { return }
        let thickness: CGFloat = hovering ? 7 : 5
        let inset: CGFloat = 2
        let shape = vertical
            ? NSRect(x: bounds.maxX - thickness - inset, y: knob.minY + inset, width: thickness, height: max(0, knob.height - 2 * inset))
            : NSRect(x: knob.minX + inset, y: bounds.maxY - thickness - inset, width: max(0, knob.width - 2 * inset), height: thickness)
        NSColor.labelColor.withAlphaComponent(hovering ? 0.5 : 0.32).setFill()
        NSBezierPath(roundedRect: shape, xRadius: thickness / 2, yRadius: thickness / 2).fill()
    }

    override public func updateTrackingAreas() {
        super.updateTrackingAreas()
        trackingAreas.filter { $0.owner === self }.forEach(removeTrackingArea)
        addTrackingArea(NSTrackingArea(rect: bounds, options: [.mouseEnteredAndExited, .activeAlways, .inVisibleRect],
                                       owner: self, userInfo: nil))
    }

    override public func mouseEntered(with event: NSEvent) {
        super.mouseEntered(with: event)
        hovering = true
    }

    override public func mouseExited(with event: NSEvent) {
        super.mouseExited(with: event)
        hovering = false
    }
}

/// Puts GenesisKit's scroll bars on an `NSScrollView`, or gives it back the system's. A scroll view resets its style
/// when the system's preferred style changes (a mouse is attached), so every adopted view is kept in a weak table and
/// set again after that notification.
@MainActor
public enum GenScrollBars {
    private static let adopted = NSHashTable<NSScrollView>.weakObjects()
    private static var observer: NSObjectProtocol?

    public static func apply(_ style: GenScrollBarStyle, to scrollView: NSScrollView) {
        switch style {
        case .genesis:
            adopted.add(scrollView)
            observePreferredStyle()
            if scrollView.hasVerticalScroller, !(scrollView.verticalScroller is GenScroller) {
                scrollView.verticalScroller = GenScroller()
            }
            if scrollView.hasHorizontalScroller, !(scrollView.horizontalScroller is GenScroller) {
                scrollView.horizontalScroller = GenScroller()
            }
            if scrollView.scrollerStyle != .overlay { scrollView.scrollerStyle = .overlay }
        case .system:
            guard adopted.contains(scrollView) else { return }
            adopted.remove(scrollView)
            if scrollView.verticalScroller is GenScroller { scrollView.verticalScroller = NSScroller() }
            if scrollView.horizontalScroller is GenScroller { scrollView.horizontalScroller = NSScroller() }
            scrollView.scrollerStyle = NSScroller.preferredScrollerStyle
        }
    }

    private static func observePreferredStyle() {
        guard observer == nil else { return }
        observer = NotificationCenter.default.addObserver(forName: NSScroller.preferredScrollerStyleDidChangeNotification,
                                                          object: nil, queue: .main) { _ in
            // The scroll views take the new system style in their own observer; set ours after them.
            DispatchQueue.main.async {
                MainActor.assumeIsolated {
                    for view in adopted.allObjects where view.scrollerStyle != .overlay {
                        view.scrollerStyle = .overlay
                    }
                }
            }
        }
    }
}

public extension View {
    /// Draws the enclosing SwiftUI `ScrollView` with the scroll bars Settings → Hub → Appearance picks (GenesisKit's by
    /// default). Put it on the scroll view's content: it finds the `NSScrollView` around it.
    func genScrollBars() -> some View {
        background(GenScrollBarsProbe())
    }
}

/// An empty view inside the scroll view's document; it reaches its `enclosingScrollView` once it is in a window.
private struct GenScrollBarsProbe: NSViewRepresentable {
    @AppStorage(GenScrollBarStyle.key) private var stored = GenScrollBarStyle.genesis.rawValue

    func makeNSView(context: Context) -> ProbeView {
        let view = ProbeView()
        view.style = GenScrollBarStyle(stored: stored)
        return view
    }

    func updateNSView(_ view: ProbeView, context: Context) {
        view.style = GenScrollBarStyle(stored: stored)
    }

    final class ProbeView: NSView {
        var style: GenScrollBarStyle = .genesis {
            didSet { if style != oldValue { applyStyle() } }
        }

        override func hitTest(_ point: NSPoint) -> NSView? { nil }

        override func viewDidMoveToWindow() {
            super.viewDidMoveToWindow()
            applyStyle()
        }

        private func applyStyle() {
            guard window != nil, let scrollView = enclosingScrollView else { return }
            MainActor.assumeIsolated { GenScrollBars.apply(style, to: scrollView) }
        }
    }
}
