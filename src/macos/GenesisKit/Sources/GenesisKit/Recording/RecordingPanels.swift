import AppKit
import SwiftUI

/// A hosting view that acts on the first click: a panel that never becomes key gets every click as a first click,
/// and AppKit drops it before SwiftUI sees it unless the view accepts it.
final class FirstMouseHostingView<Content: View>: NSHostingView<Content> {
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
}

/// The recording controls' window: floats over every app and Space, never takes the keyboard or activates the app.
final class RecordingControlsWindow: NSPanel {
    override var canBecomeKey: Bool { false }
    override var canBecomeMain: Bool { false }
}

/// The target picker's window: takes the keyboard (arrows, Return, Esc, the filter) without activating the app, so
/// the app the person was in stays active and gets the keyboard back when the picker closes.
final class RecordingPickerWindow: NSPanel {
    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { false }
}

/// Where the controls go, in Cocoa screen coordinates. Pure, so the placement rules are tested without a screen.
enum RecordingPanelLayout {
    struct Screen {
        let frame: CGRect
        let visible: CGRect
    }

    static let margin: CGFloat = 16
    static let gap: CGFloat = 12

    /// `targetCG` is what is recorded in CoreGraphics points (top-left origin of the primary display), nil for a
    /// display; `displayIndex` names the recorded display in `screens` order (NSScreen order).
    static func frame(size: CGSize, placement: RecordingPanelPlacement, targetCG: CGRect?, displayIndex: Int?,
                      screens: [Screen]) -> CGRect {
        guard let primary = screens.first else { return CGRect(origin: .zero, size: size) }
        let target = targetCG.map { cocoa($0, primaryHeight: primary.frame.height) }
        let screen = displayIndex.flatMap { screens.indices.contains($0) ? screens[$0] : nil }
            ?? target.flatMap { rect in screens.first { $0.frame.contains(CGPoint(x: rect.midX, y: rect.midY)) } }
            ?? primary
        let visible = screen.visible
        var origin: CGPoint
        switch placement {
        case .topLeft:
            origin = CGPoint(x: visible.minX + margin, y: visible.maxY - margin - size.height)
        case .topRight:
            origin = CGPoint(x: visible.maxX - margin - size.width, y: visible.maxY - margin - size.height)
        case .bottomLeft:
            origin = CGPoint(x: visible.minX + margin, y: visible.minY + margin)
        case .bottomRight:
            origin = CGPoint(x: visible.maxX - margin - size.width, y: visible.minY + margin)
        case .nearTarget:
            if let target, displayIndex == nil {
                let below = target.minY - gap - size.height
                // Under the window when the screen has room, else inside its bottom edge.
                let y = below >= visible.minY + margin ? below : target.minY + gap
                origin = CGPoint(x: target.midX - size.width / 2, y: y)
            } else {
                origin = CGPoint(x: visible.midX - size.width / 2, y: visible.minY + margin * 2)
            }
        }
        origin.x = min(max(origin.x, visible.minX + margin), visible.maxX - margin - size.width)
        origin.y = min(max(origin.y, visible.minY + margin), visible.maxY - margin - size.height)
        return CGRect(origin: origin, size: size).integral
    }

    static func cocoa(_ rect: CGRect, primaryHeight: CGFloat) -> CGRect {
        CGRect(x: rect.minX, y: primaryHeight - rect.maxY, width: rect.width, height: rect.height)
    }

    static var liveScreens: [Screen] {
        NSScreen.screens.map { Screen(frame: $0.frame, visible: $0.visibleFrame) }
    }
}

/// A drag area that moves its window. It tracks the drag itself from each event's location: `performDrag(with:)`
/// moved a non-activating panel only on the first drag of a show (ux ledger, 2026-10-14).
struct RecordingWindowDragArea: NSViewRepresentable {
    var dragged: () -> Void

    func makeNSView(context: Context) -> RecordingWindowDragView {
        let view = RecordingWindowDragView()
        view.dragged = dragged
        return view
    }

    func updateNSView(_ view: RecordingWindowDragView, context: Context) { view.dragged = dragged }
}

final class RecordingWindowDragView: NSView {
    var dragged: (() -> Void)?
    private var last: CGPoint?

    override init(frame: NSRect) {
        super.init(frame: frame)
        setAccessibilityElement(true)
        setAccessibilityRole(.handle)
        setAccessibilityIdentifier("recording.drag")
        setAccessibilityLabel("Move the recording controls")
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }
    override var mouseDownCanMoveWindow: Bool { false }
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
    override func resetCursorRects() { addCursorRect(bounds, cursor: last == nil ? .openHand : .closedHand) }

    /// Global CoreGraphics points (y down), from the event itself, so a drag delivered in the background moves it too.
    private func location(_ event: NSEvent) -> CGPoint {
        event.cgEvent?.location ?? CGPoint(x: NSEvent.mouseLocation.x, y: -NSEvent.mouseLocation.y)
    }

    override func mouseDown(with event: NSEvent) {
        last = location(event)
        window?.invalidateCursorRects(for: self)
    }

    override func mouseDragged(with event: NSEvent) {
        guard let window, let last else { return }
        let point = location(event)
        window.setFrameOrigin(CGPoint(x: window.frame.minX + point.x - last.x, y: window.frame.minY - (point.y - last.y)))
        self.last = point
        dragged?()
    }

    override func mouseUp(with event: NSEvent) {
        last = nil
        window?.invalidateCursorRects(for: self)
    }
}

/// The floating window that holds the recording controls. Out of every movie by window id (the session passes it to
/// the recorder); `sharingType = .none` also keeps it out of legacy window captures.
@MainActor
final class RecordingControlsPanel {
    let window: RecordingControlsWindow
    private let hosting: FirstMouseHostingView<AnyView>
    /// True once the person dragged the controls: a target switch then leaves them where they are.
    private(set) var moved = false

    init() {
        window = RecordingControlsWindow(contentRect: CGRect(x: 0, y: 0, width: 520, height: 52),
                                         styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
        window.title = "Recording controls"
        window.identifier = NSUserInterfaceItemIdentifier("recording.controls")
        RecordingPanelChrome.apply(to: window)
        hosting = FirstMouseHostingView(rootView: AnyView(EmptyView()))
        // The panel sizes itself from its content's measured size (below); a hosting view that also reports an
        // intrinsic size makes AppKit lay the whole tree out on every update.
        hosting.sizingOptions = []
        window.contentView = hosting
    }

    /// The CG window id the recorder leaves out.
    var windowID: Int { window.windowNumber }

    /// `view` is drawn at its ideal size; the window follows that size, keeping its centre and bottom edge.
    func setContent(_ view: some View) {
        hosting.rootView = AnyView(view.fixedSize().onGeometryChange(for: CGSize.self, of: { $0.size }) { [weak self] size in
            // Never resize the window inside the layout pass that measured it.
            DispatchQueue.main.async { self?.resize(to: size) }
        })
    }

    func noteMoved() { moved = true }

    private func resize(to size: CGSize) {
        let size = CGSize(width: size.width.rounded(.up), height: size.height.rounded(.up))
        guard size.width > 0, size.height > 0, size != window.frame.size else { return }
        let frame = window.frame
        window.setFrame(CGRect(x: (frame.midX - size.width / 2).rounded(), y: frame.minY, width: size.width,
                               height: size.height), display: true)
    }

    func place(_ placement: RecordingPanelPlacement, targetCG: CGRect?, displayIndex: Int?) {
        guard !moved else { return }
        hosting.layoutSubtreeIfNeeded()
        let size = hosting.fittingSize
        window.setFrame(RecordingPanelLayout.frame(size: size, placement: placement, targetCG: targetCG,
                                                   displayIndex: displayIndex, screens: RecordingPanelLayout.liveScreens),
                        display: true)
    }

    func show() { window.orderFrontRegardless() }

    func close() {
        window.orderOut(nil)
        window.close()
    }
}

/// What both recording windows share: floating over every app, Space and full-screen app, above the widget's panels,
/// clear behind their own rounded content, out of legacy window captures.
@MainActor
enum RecordingPanelChrome {
    static func apply(to window: NSPanel) {
        window.isFloatingPanel = true
        // After isFloatingPanel, whose setter resets the level: above the widget's edge panels.
        window.level = NSWindow.Level(rawValue: NSWindow.Level.statusBar.rawValue + 1)
        window.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .ignoresCycle]
        window.hidesOnDeactivate = false
        window.isReleasedWhenClosed = false
        window.backgroundColor = .clear
        window.isOpaque = false
        window.hasShadow = true
        window.sharingType = .none
    }
}

/// The floating window that holds the target picker. It closes, as a cancel, when it loses the keyboard (a click in
/// another app or window).
@MainActor
final class RecordingPickerPanel: NSObject, NSWindowDelegate {
    let window: RecordingPickerWindow
    private var onDismiss: (() -> Void)?

    override init() {
        window = RecordingPickerWindow(contentRect: CGRect(x: 0, y: 0, width: 400, height: 420),
                                       styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
        super.init()
        window.title = "Choose what to record"
        window.identifier = NSUserInterfaceItemIdentifier("recording.picker")
        RecordingPanelChrome.apply(to: window)
        window.delegate = self
    }

    var isVisible: Bool { window.isVisible }

    /// Shows the picker with its top centred under `anchor` (Cocoa screen point), inside that screen, and gives it
    /// the keyboard without activating the app.
    func present(_ view: some View, near anchor: CGPoint, onDismiss: @escaping () -> Void) {
        self.onDismiss = onDismiss
        // A fresh hosting view each time: a reused one that had been on screen measured 0x0 after a new root view, so
        // the second picker of a session opened invisible and the recorder waited for a choice nobody could see.
        let hosting = FirstMouseHostingView(rootView: AnyView(view.fixedSize().onGeometryChange(for: CGSize.self, of: { $0.size }) { [weak self] size in
            DispatchQueue.main.async { self?.resize(to: size) }
        }))
        hosting.sizingOptions = []
        window.contentView = hosting
        hosting.layoutSubtreeIfNeeded()
        let size = hosting.fittingSize
        let screen = NSScreen.screens.first { $0.frame.contains(anchor) } ?? NSScreen.screens.first
        let visible = screen?.visibleFrame ?? CGRect(origin: .zero, size: size)
        var origin = CGPoint(x: anchor.x - size.width / 2, y: anchor.y - 8 - size.height)
        if origin.y < visible.minY + 8 { origin.y = anchor.y + 8 }
        origin.x = min(max(origin.x, visible.minX + 8), visible.maxX - 8 - size.width)
        origin.y = min(max(origin.y, visible.minY + 8), visible.maxY - 8 - size.height)
        window.setFrame(CGRect(origin: origin, size: size).integral, display: true)
        window.makeKeyAndOrderFront(nil)
    }

    /// Follows the content (a tab that lists more or fewer rows), keeping the top edge.
    private func resize(to size: CGSize) {
        let size = CGSize(width: size.width.rounded(.up), height: size.height.rounded(.up))
        guard window.isVisible, size.width > 0, size.height > 0, size != window.frame.size else { return }
        let frame = window.frame
        window.setFrame(CGRect(x: frame.minX, y: frame.maxY - size.height, width: size.width, height: size.height),
                        display: true)
    }

    func dismiss() {
        onDismiss = nil
        window.orderOut(nil)
    }

    func windowDidResignKey(_ notification: Notification) {
        guard window.isVisible, let onDismiss else { return }
        self.onDismiss = nil
        window.orderOut(nil)
        onDismiss()
    }
}
