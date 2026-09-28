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
//   its clicks and its drags. `below:` adds a custom toolbar drawn right under the title bar.
// - `.titlebarBackground(fill)` for any fill that also paints the strip. A plain `.background` that
//   ignores the top safe area takes the strip's clicks before the zone sees them.
// - `.titlebarRow()` on a row of controls placed in the strip: the strip's height, and clear of the
//   traffic lights and the window title. `.titlebarLabel()` on plain title text in that row, so a
//   double-click on it zooms too.
// - `WindowTitlebar.audit(window, expectsRow:)` for a `--snapshot` check: where a click on the strip
//   lands, and whether an empty band sits under the strip.

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

    /// Zoom, minimize or nothing. `.drag` needs the mouse-down event: only the zone does that.
    @MainActor
    static func perform(_ action: Action, on window: NSWindow) {
        switch action {
        case .zoom: window.zoom(nil)
        case .minimize: window.miniaturize(nil)
        case .drag, .none: break
        }
    }

    /// A double-click on chrome the zone does not cover, as System Settings says: a tab bar under a
    /// custom toolbar (Genesis's markdown viewer).
    @MainActor
    static func performDoubleClick(on window: NSWindow) {
        perform(action(clickCount: 2, preference: preference), on: window)
    }

    /// The file URLs a drag carries, or none.
    static func fileURLs(on pasteboard: NSPasteboard) -> [URL] {
        let objects = pasteboard.readObjects(forClasses: [NSURL.self], options: [.urlReadingFileURLsOnly: true])
        return (objects ?? []).compactMap { $0 as? URL }
    }

    /// The strip's height: 32 pt on macOS 26 without a toolbar, 28 pt before, 0 in full screen
    /// (the title bar then slides in over the content and handles its own clicks).
    @MainActor
    static func stripHeight(of window: NSWindow) -> CGFloat {
        max(0, window.frame.height - window.contentLayoutRect.maxY)
    }

    /// True for a point in window coordinates inside the strip: the window's own title bar and the
    /// `below` points of chrome right under it.
    @MainActor
    static func contains(_ point: CGPoint, window: NSWindow, below: CGFloat = 0) -> Bool {
        let strip = stripHeight(of: window) + below
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
        var width: CGFloat = 0
        /// The widest flat stretch right under the strip (`Band.widest`), nil when there is none.
        var band: Band?

        /// Rows under the strip where nothing is drawn across a whole column of the window: a header that
        /// pads its first row down (every hub mode used 34 pt) leaves one from the column's left edge.
        /// A row with text on its left and nothing on its right is not a band.
        struct Band: Equatable {
            var minX: CGFloat
            var maxX: CGFloat
            var height: CGFloat

            /// One `columnWidth` slice of the window under the strip.
            struct Column: Equatable {
                /// How far down from the strip the slice stays one colour.
                var height: CGFloat
                /// Its colour right under the strip, packed RGBA.
                var color: UInt32
                /// A vertical line or an edge crosses the slice right under the strip (its samples differ).
                var edge = false
            }

            /// A band counts from this height and this share of the window's width. The sidebar's own
            /// gaps between its buttons stay under the share.
            static let minHeight: CGFloat = 12
            static let minShare: CGFloat = 0.4

            /// The longest run of columns flat for at least `minHeight`, at the run's lowest height,
            /// among the runs that start a region: at the window's left edge, after a divider, or where
            /// the colour under the strip changes (the sidebar ends). A run that starts beside drawn text
            /// is the empty end of a row, not a band.
            static func widest(columns: [Column], columnWidth: CGFloat) -> Band? {
                var best: Band?
                var start: Int?
                for index in 0...columns.count {
                    if index < columns.count, columns[index].height >= minHeight {
                        start = start ?? index
                        continue
                    }

                    if let first = start, startsRegion(columns, at: first) {
                        let run = Band(minX: CGFloat(first) * columnWidth, maxX: CGFloat(index) * columnWidth,
                                       height: columns[first..<index].map(\.height).min() ?? 0)
                        if run.maxX - run.minX > (best.map { $0.maxX - $0.minX } ?? 0) {
                            best = run
                        }
                    }
                    start = nil
                }
                return best
            }

            private static func startsRegion(_ columns: [Column], at index: Int) -> Bool {
                guard index > 0 else { return true }

                let left = columns[index - 1]
                return left.edge || left.color != columns[index].color
            }
        }

        /// A band across much of the window under a header meant for the title bar.
        var emptyBand: Band? {
            guard expectsRow, let band, width > 0, band.maxX - band.minX >= width * Band.minShare else { return nil }
            return band
        }

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

            if let band = emptyBand {
                found.append("an empty band \(Int(band.height)) pt tall under the title bar at x \(Int(band.minX))-\(Int(band.maxX)): put the header's first row in the title bar (TitlebarHeader)")
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
            if let band {
                parts.append("flat under the strip \(Int(band.height)) pt at \(Int(band.minX))-\(Int(band.maxX))")
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
        let width = window.frame.width
        guard strip > 0, let frameView = window.contentView?.superview else {
            return Audit(stripHeight: strip, leadingReserve: reserve, runs: [], expectsRow: expectsRow, width: width)
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
        let columnWidth: CGFloat = 8
        return Audit(
            stripHeight: strip, leadingReserve: reserve, runs: Audit.runs(samples, step: step), expectsRow: expectsRow,
            width: width, band: Audit.Band.widest(columns: flatColumns(under: window, columnWidth: columnWidth), columnWidth: columnWidth)
        )
    }

    /// For each `columnWidth` column of the window, how far down from the strip's bottom edge it stays
    /// one colour (three samples across it, up to `depth` points), and that colour. Draws the content
    /// view once.
    @MainActor
    static func flatColumns(under window: NSWindow, columnWidth: CGFloat, depth: CGFloat = 120) -> [Audit.Band.Column] {
        guard let view = window.contentView, view.bounds.height > 0,
              let rep = view.bitmapImageRepForCachingDisplay(in: view.bounds) else { return [] }
        view.cacheDisplay(in: view.bounds, to: rep)
        let scale = CGFloat(rep.pixelsHigh) / view.bounds.height
        let top = Int((stripHeight(of: window) * scale).rounded())
        let bottom = min(rep.pixelsHigh, top + Int(depth * scale))
        let columnPixels = max(3, Int(columnWidth * scale))
        guard top < bottom else { return [] }

        var reference = [Int](repeating: 0, count: max(4, rep.samplesPerPixel))
        var sample = reference
        var columns: [Audit.Band.Column] = []
        for left in stride(from: 0, through: rep.pixelsWide - columnPixels, by: columnPixels) {
            let xs = [left, left + columnPixels / 2, left + columnPixels - 1]
            rep.getPixel(&reference, atX: xs[1], y: top)
            var rows = 0
            scan: for y in top..<bottom {
                for x in xs {
                    rep.getPixel(&sample, atX: x, y: y)
                    // A few levels of slack: antialiasing and dithering, not a drawn line.
                    if zip(sample, reference).prefix(rep.samplesPerPixel).contains(where: { abs($0 - $1) > 3 }) {
                        break scan
                    }
                }
                rows += 1
            }
            let color = reference.prefix(4).reduce(UInt32(0)) { ($0 << 8) | UInt32(clamping: $1) }
            // Flat for not even one row: its own samples differ, so a line or an edge crosses it.
            columns.append(Audit.Band.Column(height: CGFloat(rows) / scale, color: color, edge: rows == 0))
        }
        return columns
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
    /// Chrome right under the title bar that belongs to the strip too (a custom toolbar).
    var below: CGFloat = 0
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
        return WindowTitlebar.contains(superview.convert(point, to: nil), window: window, below: below) ? self : nil
    }

    override func mouseDown(with event: NSEvent) {
        guard let window else { return }
        let action = WindowTitlebar.action(clickCount: event.clickCount, preference: WindowTitlebar.preference)
        if action == .drag {
            window.performDrag(with: event)
        } else {
            WindowTitlebar.perform(action, on: window)
        }
    }

    /// Files dropped on the empty strip. The strip's fills take no hits, so without this a drop there
    /// reached no drop target (Genesis's markdown viewer lost its toolbar drop). AppKit picks a drag's
    /// destination by frame, not by `hitTest`: the deepest view registered for the dragged type whose
    /// frame holds the pointer (`-[NSView _hitTest:dragTypes:]`, probed 2026-09-28). That is why the
    /// zone's frame is the strip and no more (`TitlebarZoneHost`): as large as the window, it took
    /// every file drop meant for the content.
    var onDropFiles: (([URL]) -> Bool)? {
        didSet {
            guard (oldValue == nil) != (onDropFiles == nil) else { return }
            if onDropFiles == nil {
                unregisterDraggedTypes()
            } else {
                registerForDraggedTypes([.fileURL])
            }
        }
    }

    override func draggingEntered(_ sender: NSDraggingInfo) -> NSDragOperation {
        dropOperation(sender)
    }

    override func draggingUpdated(_ sender: NSDraggingInfo) -> NSDragOperation {
        dropOperation(sender)
    }

    override func performDragOperation(_ sender: NSDraggingInfo) -> Bool {
        let urls = WindowTitlebar.fileURLs(on: sender.draggingPasteboard)
        guard let onDropFiles, !urls.isEmpty else { return false }
        return onDropFiles(urls)
    }

    private func dropOperation(_ sender: NSDraggingInfo) -> NSDragOperation {
        onDropFiles != nil && !WindowTitlebar.fileURLs(on: sender.draggingPasteboard).isEmpty ? .copy : []
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
            height: WindowTitlebar.stripHeight(of: window),
            leadingReserve: WindowTitlebar.leadingReserve(of: window)
        )
        guard metrics != reported else { return }
        reported = metrics
        // Called during layout: the state change waits for the next turn of the run loop.
        DispatchQueue.main.async { onMetrics(metrics) }
    }
}

/// What SwiftUI sizes to the window's root: it only holds the zone at its top edge, as tall as the
/// strip, and hands every hit to the zone. It takes no clicks and no drags of its own.
final class TitlebarZoneHost: NSView {
    let zone = TitlebarZoneView()

    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        addSubview(zone)
    }

    required init?(coder: NSCoder) { fatalError("not supported") }

    override var isFlipped: Bool { true }

    override func hitTest(_ point: NSPoint) -> NSView? {
        zone.hitTest(convert(point, from: superview))
    }

    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        placeZone()
    }

    override func setFrameSize(_ newSize: NSSize) {
        super.setFrameSize(newSize)
        placeZone()
    }

    /// The window's title bar and the `below` points under it; in full screen only `below`.
    func placeZone() {
        let strip = window.map { WindowTitlebar.stripHeight(of: $0) } ?? 0
        let frame = NSRect(x: 0, y: 0, width: bounds.width, height: min(bounds.height, strip + zone.below))
        if zone.frame != frame {
            zone.frame = frame
        }
    }
}

private struct TitlebarZone: NSViewRepresentable {
    var below: CGFloat
    var onDropFiles: (([URL]) -> Bool)?
    var onMetrics: (TitlebarMetrics) -> Void

    func makeNSView(context: Context) -> TitlebarZoneHost { TitlebarZoneHost() }

    func updateNSView(_ host: TitlebarZoneHost, context: Context) {
        if host.zone.below != below {
            host.zone.below = below
            host.placeZone()
        }

        host.zone.onDropFiles = onDropFiles
        host.zone.onMetrics = onMetrics
    }
}

private struct TitlebarZoneModifier: ViewModifier {
    let below: CGFloat
    let onDropFiles: (([URL]) -> Bool)?
    @State private var metrics = TitlebarMetrics()

    func body(content: Content) -> some View {
        content
            .environment(\.titlebarMetrics, metrics)
            .background {
                TitlebarZone(below: below, onDropFiles: onDropFiles) { metrics = $0 }
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
    /// Settings) and drags the window; controls in the strip keep their clicks. `below`: points of
    /// chrome drawn right under the title bar that belong to the strip too (a custom toolbar row,
    /// Genesis's markdown viewer); its fill must take no clicks. `onDropFiles`: a window that opens
    /// dropped files passes its open path, so a file dropped on the empty strip still opens: the
    /// strip's fills take no hits, and a drop there otherwise reaches no drop target.
    func titlebarZone(below: CGFloat = 0, onDropFiles: (([URL]) -> Bool)? = nil) -> some View {
        modifier(TitlebarZoneModifier(below: below, onDropFiles: onDropFiles))
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

    /// Plain text and icons in a title bar row: a double-click on them zooms and a drag moves the
    /// window, as on the window's own title. SwiftUI hit-tests text, so without this it took the click.
    /// Not for text with a tooltip, a link or selection: those need the pointer.
    func titlebarLabel() -> some View {
        allowsHitTesting(false)
    }
}
