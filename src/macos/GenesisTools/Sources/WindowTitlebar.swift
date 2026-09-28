import AppKit
import SwiftUI

// The title bar of a window whose content runs under it (`.fullSizeContentView` with a transparent
// title bar: the hub, the review window). The SwiftUI hosting view covers that strip, so every click
// there except on the traffic lights lands in SwiftUI (hit test, 2026-09-28: `NSHostingView`, never
// `NSTitlebarView`). AppKit's title bar never saw a double-click, and the window did not zoom. The
// window server still dragged it from anywhere in the strip, a control placed there included,
// because the hosting view says `mouseDownCanMoveWindow`.
//
// This file gives the strip back to the window. It has no app types, so Genesis can take it as is.
//
// - `.titlebarZone()` on the window's root view: the empty strip zooms (or minimizes, or nothing,
//   as System Settings says) on a double-click and drags the window. A control in the strip keeps
//   its clicks and its drags.
// - `.titlebarBackground(fill)` for any fill that also paints the strip. A plain `.background` that
//   ignores the top safe area takes the strip's clicks before the zone sees them.
// - `.titlebarRow()` on a row of controls placed in the strip: the strip's height, and clear of the
//   traffic lights and the window title.

enum WindowTitlebar {
    enum Action: Equatable {
        case drag
        case zoom
        case minimize
        case none
    }

    /// System Settings → Desktop & Dock → "Double-click a window's title bar to".
    static let preferenceKey = "AppleActionOnDoubleClick"

    static var preference: String? { UserDefaults.standard.string(forKey: preferenceKey) }

    /// What a click on the empty strip does. "Fill" (macOS 15+) is a zoom here: none of these windows
    /// names a standard frame, so AppKit zooms them to the screen's visible frame. A missing value
    /// means Zoom, the system default.
    static func action(clickCount: Int, preference: String?) -> Action {
        switch clickCount {
        case 1:
            return .drag
        case 2:
            switch preference {
            case "Minimize", "Miniaturize": return .minimize
            case "None": return .none
            default: return .zoom
            }
        default:
            return .none
        }
    }

    /// The strip's height: 32 pt on macOS 26 without a toolbar, 28 pt before, 0 in full screen
    /// (the title bar then slides in over the content and handles its own clicks).
    @MainActor
    static func stripHeight(of window: NSWindow) -> CGFloat {
        max(0, window.frame.height - window.contentLayoutRect.maxY)
    }

    /// True for a point in window coordinates inside the strip: the top `height` points, or the
    /// window's own title bar when `height` is nil.
    @MainActor
    static func contains(_ point: CGPoint, window: NSWindow, height: CGFloat? = nil) -> Bool {
        let strip = height ?? stripHeight(of: window)
        return strip > 0 && point.y >= window.frame.height - strip && point.y <= window.frame.height
    }

    static let reserveGap: CGFloat = 12

    /// Window x where the traffic lights and the window title end, plus a gap: a row placed in the
    /// strip starts there at the earliest. The title is left of the controls on macOS 26 and centred
    /// before, so it is measured, not assumed.
    @MainActor
    static func leadingReserve(of window: NSWindow) -> CGFloat {
        var edge: CGFloat = 0
        for kind: NSWindow.ButtonType in [.closeButton, .miniaturizeButton, .zoomButton] {
            guard let button = window.standardWindowButton(kind), button.window === window, !button.isHidden else { continue }
            edge = max(edge, button.convert(button.bounds, to: nil).maxX)
        }
        if window.titleVisibility == .visible, !window.title.isEmpty,
           let bar = window.standardWindowButton(.closeButton)?.superview,
           let field = titleField(in: bar, title: window.title), field.window === window {
            edge = max(edge, textMaxX(of: field))
        }
        return edge > 0 ? edge + reserveGap : 0
    }

    @MainActor
    private static func titleField(in view: NSView, title: String) -> NSTextField? {
        if let field = view as? NSTextField, !field.isHidden, field.stringValue == title {
            return field
        }

        for subview in view.subviews {
            if let field = titleField(in: subview, title: title) {
                return field
            }
        }
        return nil
    }

    @MainActor
    private static func textMaxX(of field: NSTextField) -> CGFloat {
        let frame = field.convert(field.bounds, to: nil)
        let width = min(frame.width, field.attributedStringValue.size().width)
        switch field.alignment {
        case .center: return frame.midX + width / 2
        case .right: return frame.maxX
        default: return frame.minX + width
        }
    }

    // MARK: Audit

    /// What the strip's centre line hits, left to right: the window's own buttons, the empty
    /// strip (the zone), or content (a control, or a view that took the strip's clicks).
    struct Audit: Equatable {
        enum Kind: String {
            case window
            case zone
            case content
        }

        struct Run: Equatable {
            var kind: Kind
            var minX: CGFloat
            var maxX: CGFloat
        }

        var stripHeight: CGFloat
        var leadingReserve: CGFloat
        var runs: [Run]
        /// The window puts a row of controls in the strip (`.titlebarRow()`), so the strip must hold some.
        var expectsRow = false

        /// Content over the strip with no zone left, content under the traffic lights or the title, or
        /// an expected row that is not in the strip. A strip that is all window is AppKit's own title bar.
        var problems: [String] {
            var found: [String] = []
            let content = runs.contains { $0.kind == .content }
            if content, !runs.contains(where: { $0.kind == .zone }) {
                found.append("no empty strip reaches the zone: a view over the title bar takes its clicks")
            }

            if expectsRow, !content {
                found.append("nothing in the strip: the row meant for the title bar is not there")
            }

            for run in runs where run.kind == .content && run.minX < leadingReserve - Self.reserveSlack {
                found.append("content at x \(Int(run.minX))-\(Int(run.maxX)) under the traffic lights or the title (they end at \(Int(leadingReserve)))")
            }
            return found
        }

        /// Half the gap: a control may sit a little closer to the title than the reserve asks.
        static let reserveSlack = WindowTitlebar.reserveGap / 2

        func width(of kind: Kind) -> CGFloat {
            runs.filter { $0.kind == kind }.reduce(0) { $0 + $1.maxX - $1.minX }
        }

        var line: String {
            let content = runs.filter { $0.kind == .content }
            var parts = ["strip \(Int(stripHeight)) pt", "reserve \(Int(leadingReserve))",
                         "zone \(Int(width(of: .zone))) pt", "window buttons \(Int(width(of: .window))) pt"]
            if let first = content.first, let last = content.last {
                parts.append("content \(Int(width(of: .content))) pt in \(content.count) runs at \(Int(first.minX))-\(Int(last.maxX))")
            } else {
                parts.append("no content")
            }
            let found = problems
            return parts.joined(separator: ", ") + (found.isEmpty ? "; ok" : "; " + found.joined(separator: "; "))
        }

        /// Samples classified left to right, merged into runs.
        static func runs(_ samples: [(x: CGFloat, kind: Kind)], step: CGFloat) -> [Run] {
            var runs: [Run] = []
            for sample in samples {
                if var last = runs.last, last.kind == sample.kind {
                    last.maxX = sample.x + step
                    runs[runs.count - 1] = last
                } else {
                    runs.append(Run(kind: sample.kind, minX: sample.x, maxX: sample.x + step))
                }
            }
            return runs
        }
    }

    /// Hit-tests the strip's centre line every `step` points, the way a click would land. `expectsRow`:
    /// the window has a `.titlebarRow()` on screen now.
    @MainActor
    static func audit(_ window: NSWindow, expectsRow: Bool = false, step: CGFloat = 2) -> Audit {
        let strip = stripHeight(of: window)
        let reserve = leadingReserve(of: window)
        guard strip > 0, let frameView = window.contentView?.superview else {
            return Audit(stripHeight: strip, leadingReserve: reserve, runs: [], expectsRow: expectsRow)
        }

        let bar = window.standardWindowButton(.closeButton)?.superview?.superview
        let y = window.frame.height - strip / 2
        var samples: [(x: CGFloat, kind: Audit.Kind)] = []
        var x: CGFloat = 0
        while x < window.frame.width {
            let hit = frameView.hitTest(frameView.convert(NSPoint(x: x, y: y), from: nil))
            let kind: Audit.Kind
            if hit is TitlebarZoneView {
                kind = .zone
            } else if hit === frameView {
                // The frame's own resize border at the window's edge.
                kind = .window
            } else if let bar, let hit, hit.isDescendant(of: bar) {
                kind = .window
            } else {
                kind = .content
            }
            samples.append((x, kind))
            x += step
        }
        return Audit(stripHeight: strip, leadingReserve: reserve, runs: Audit.runs(samples, step: step), expectsRow: expectsRow)
    }
}

/// The strip's size as the zone last measured it; descendants of `.titlebarZone()` read it.
struct TitlebarMetrics: Equatable {
    var height: CGFloat = 0
    var leadingReserve: CGFloat = 0
}

extension EnvironmentValues {
    @Entry var titlebarMetrics = TitlebarMetrics()
}

/// The empty part of the strip. It lies behind the window's SwiftUI content, so a control in the
/// strip is hit first, and it claims only points inside the strip.
final class TitlebarZoneView: NSView {
    /// The strip's height; nil: the window's own title bar.
    var height: CGFloat? {
        didSet { report() }
    }
    var onMetrics: ((TitlebarMetrics) -> Void)? {
        didSet { report() }
    }
    private var reported: TitlebarMetrics?

    /// False, so the window server leaves the strip to the app (its drag region is the title bar minus
    /// every view that says false here). The zone drags the empty strip itself, and a SwiftUI control
    /// in the strip gets its own drags. With `isMovableByWindowBackground`, true here also let AppKit
    /// track the first click as a window drag, and the double-click never arrived (Genesis markdown window).
    override var mouseDownCanMoveWindow: Bool { false }

    /// The first click on an inactive window's strip already drags it, as on a real title bar.
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }

    override func hitTest(_ point: NSPoint) -> NSView? {
        guard let window, let superview, frame.contains(point) else { return nil }
        return WindowTitlebar.contains(superview.convert(point, to: nil), window: window, height: height) ? self : nil
    }

    override func mouseDown(with event: NSEvent) {
        guard let window else { return }
        switch WindowTitlebar.action(clickCount: event.clickCount, preference: WindowTitlebar.preference) {
        case .drag: window.performDrag(with: event)
        case .zoom: window.zoom(nil)
        case .minimize: window.miniaturize(nil)
        case .none: break
        }
    }

    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        report()
    }

    override func setFrameSize(_ newSize: NSSize) {
        super.setFrameSize(newSize)
        report()
    }

    /// The strip's height changes in and out of full screen; a centred title moves with the width.
    private func report() {
        guard let window, let onMetrics else { return }
        let metrics = TitlebarMetrics(
            height: height ?? WindowTitlebar.stripHeight(of: window),
            leadingReserve: WindowTitlebar.leadingReserve(of: window)
        )
        guard metrics != reported else { return }
        reported = metrics
        // Called during layout: the state change waits for the next turn of the run loop.
        DispatchQueue.main.async { onMetrics(metrics) }
    }
}

private struct TitlebarZone: NSViewRepresentable {
    var height: CGFloat?
    var onMetrics: (TitlebarMetrics) -> Void

    func makeNSView(context: Context) -> TitlebarZoneView { TitlebarZoneView() }

    func updateNSView(_ view: TitlebarZoneView, context: Context) {
        if view.height != height {
            view.height = height
        }

        view.onMetrics = onMetrics
    }
}

private struct TitlebarZoneModifier: ViewModifier {
    let height: CGFloat?
    @State private var metrics = TitlebarMetrics()

    func body(content: Content) -> some View {
        content
            .environment(\.titlebarMetrics, metrics)
            .background {
                TitlebarZone(height: height) { metrics = $0 }
                    .ignoresSafeArea(.container, edges: .top)
            }
    }
}

private struct TitlebarRowModifier: ViewModifier {
    let minHeight: CGFloat
    @Environment(\.titlebarMetrics) private var metrics
    @State private var minX: CGFloat = .infinity

    func body(content: Content) -> some View {
        content
            .padding(.leading, max(0, metrics.leadingReserve - minX))
            .frame(height: max(metrics.height, minHeight))
            // Up into the strip, taking no height below it. Not `.ignoresSafeArea` on the parent: SwiftUI
            // then hands the strip's inset to every view under the row too, and a pane that ignores the
            // safe area itself (the stolen session screen) slid up under the row.
            .padding(.top, -metrics.height)
            // Whole points: the row re-renders only when the sidebar beside it really moves.
            .onGeometryChange(for: CGFloat.self, of: { $0.frame(in: .global).minX.rounded() }) { minX = $0 }
    }
}

extension View {
    /// Put on a window's root view. The empty title bar strip zooms on a double-click (per System
    /// Settings) and drags the window; controls in the strip keep their clicks. `height` makes the
    /// top `height` points the strip instead of the window's own title bar (a taller custom toolbar).
    func titlebarZone(height: CGFloat? = nil) -> some View {
        modifier(TitlebarZoneModifier(height: height))
    }

    /// A background that also paints the title bar strip above the view, and leaves the strip's
    /// clicks to `.titlebarZone()`. In the view's own frame it still takes clicks, as `.background(fill)` did.
    func titlebarBackground<Fill: View>(_ fill: Fill) -> some View {
        background(Color.clear.contentShape(Rectangle()))
            .background {
                fill
                    .ignoresSafeArea(.container, edges: .top)
                    .allowsHitTesting(false)
            }
    }

    /// A row of controls for the title bar strip. Put it first in a view that starts right under the
    /// title bar: the row moves up into the strip, as tall as the strip, and takes no height below it.
    /// It is pushed right when it would start under the traffic lights or the title. In full screen
    /// (no strip) it stays in place, `minHeight` tall.
    func titlebarRow(minHeight: CGFloat = 28) -> some View {
        modifier(TitlebarRowModifier(minHeight: minHeight))
    }
}
