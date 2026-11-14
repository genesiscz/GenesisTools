import AppKit
import SwiftUI

/// Where an `AutocompleteField` shows its list.
public enum AutocompletePresentation: Sendable, Equatable {
    /// Over the page, in a small child window under the field: nothing in the page moves while the list is open, and
    /// no card or scroll view cuts it. The default.
    case floating
    /// In the page, under the field: the content below moves down while the list is open.
    case inPage
}

/// Where the floating list goes, in screen coordinates (origin at the bottom left): under the field with the left edges
/// equal, as wide as the field but never narrower than `minimumWidth`, and above the field when the room below it on
/// the screen's visible frame is too small for the list.
public enum AutocompletePlacement {
    public static let minimumWidth: CGFloat = 220
    /// The room between the field and the list.
    public static let gap: CGFloat = 4

    /// The list's width for a field: the field's, at least `minimumWidth`, at most the visible frame's.
    public static func width(field: CGRect, visible: CGRect) -> CGFloat {
        min(max(field.width, minimumWidth), visible.width)
    }

    /// The panel's frame for a list of `size` under (or above) `field`. When neither side has room for the whole
    /// list, it opens on the side with more room and is as tall as that room: the list scrolls inside it, and no row
    /// sits past the screen's edge out of the pointer's reach.
    public static func frame(field: CGRect, visible: CGRect, size: CGSize) -> CGRect {
        let width = width(field: field, visible: visible)
        let below = field.minY - gap - visible.minY
        let above = visible.maxY - field.maxY - gap
        let opensAbove = size.height > below && (size.height <= above || above > below)
        let height = max(0, min(size.height, opensAbove ? above : below))
        let y = opensAbove ? field.maxY + gap : field.minY - gap - height
        let x = min(max(field.minX, visible.minX), visible.maxX - width)
        return CGRect(x: x, y: y, width: width, height: height)
    }

    /// Whether the field shows in full inside every clip view around it (all in window coordinates). A field scrolled
    /// even partly out of its scroll view closes its list, so the list never floats over a toolbar or another pane.
    public static func isVisible(_ field: CGRect, in clips: [CGRect]) -> Bool {
        clips.allSatisfy { $0.insetBy(dx: -0.5, dy: -0.5).contains(field) }
    }
}

/// Opens one named field's list when the field first appears, through its model: no key event, no first responder,
/// no window to the front. For a picture of the open list (a settings snapshot's `--autocomplete-open <identifier>`).
@MainActor
public enum AutocompleteLaunch {
    private static var identifier: String?
    private static var requested: String?
    private static var opened = false

    /// The field whose accessibility identifier is `identifier` opens its list once it appears.
    public static func open(_ identifier: String) {
        self.identifier = identifier
        requested = identifier
        opened = false
    }

    /// The field has opened its list through its model (`whenInSight` ran).
    static func markOpened() {
        opened = true
    }

    /// Waits until the field named in `open(_:)` has opened its list, then a moment for its floating panel to appear
    /// as a child window. True at once when no field was requested; false when the field did not open within
    /// `timeout` seconds (it never came into sight), so a caller can report that instead of capturing a closed list.
    public static func waitUntilOpened(timeout: TimeInterval = 20) async -> Bool {
        guard requested != nil else { return true }
        let deadline = ContinuousClock.now + .seconds(timeout)
        while !opened, ContinuousClock.now < deadline {
            try? await Task.sleep(for: .milliseconds(50))
        }

        guard opened else { return false }
        try? await Task.sleep(for: .milliseconds(300))
        return true
    }

    /// True once, for the named field.
    static func take(_ identifier: String) -> Bool {
        guard self.identifier == identifier else { return false }
        self.identifier = nil
        return true
    }

    /// Runs `open` once the field has stayed in sight at one place for a second: a page that loads its data and
    /// scrolls to an anchor moves the field meanwhile, and a field out of sight closes its list at once. Gives up
    /// after 15 s.
    static func whenInSight(_ field: NSView, _ open: @escaping @MainActor () -> Void) {
        Task { @MainActor [weak field] in
            let deadline = ContinuousClock.now + .seconds(15)
            var last: CGRect?
            var steady = 0
            while ContinuousClock.now < deadline {
                guard let field else { return }
                let rect = field.convert(field.bounds, to: nil)
                let inSight = field.window != nil
                    && AutocompletePlacement.isVisible(rect, in: AutocompleteFloatingList.clips(around: field))
                steady = inSight && rect == last ? steady + 1 : 0
                last = rect
                if steady >= 10 {
                    open()
                    return
                }

                try? await Task.sleep(for: .milliseconds(100))
            }
        }
    }
}

/// The floating list's window: borderless, never key and never main, so the field keeps its editing and its caret,
/// and a click in the list does not activate the app or end the field's editing.
final class AutocompleteListPanel: NSPanel {
    init() {
        super.init(contentRect: .zero, styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: true)
        isOpaque = false
        backgroundColor = .clear
        // The window server draws outside the interactive frame. A padded clear panel swallowed clicks on the page.
        hasShadow = true
        hidesOnDeactivate = false
        isReleasedWhenClosed = false
        worksWhenModal = true
        animationBehavior = .none
        isExcludedFromWindowsMenu = true
        collectionBehavior = [.transient, .ignoresCycle, .fullScreenAuxiliary]
        // A clear window hands its transparent pixels to the window below; the list keeps the pointer.
        ignoresMouseEvents = false
    }

    override var canBecomeKey: Bool { false }
    override var canBecomeMain: Bool { false }
}

/// The list's hosting view: a click acts at once, also as the first click into the panel.
final class AutocompleteListHost: NSHostingView<AnyView> {
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
}

/// One field's floating list: a child window of the field's own window, made on the first open and removed with the
/// field. It follows the field (the window moves or resizes, a scroll view scrolls, the page's layout changes) and
/// closes when the window stops being key, the app goes to the background, or the field scrolls out of sight.
@MainActor
final class AutocompleteFloatingList {
    private(set) var panel: AutocompleteListPanel?
    private var host: AutocompleteListHost?
    private weak var field: NSView?
    private var observers: [NSObjectProtocol] = []
    private var content: AnyView?
    private(set) var isShown = false
    /// The field's model closes the list: the window lost the keyboard, the app went to the background, or the field
    /// scrolled out of sight. Typing or Down opens it again.
    var onClose: () -> Void = {}
    /// The fade that shows the panel; at once under Reduce Motion.
    static let fadeDuration: Double = 0.12

    nonisolated init() {}

    func attach(_ field: NSView) {
        self.field = field
    }

    /// Shows `content` (the list, with the field's environment applied), or hides the panel for nil.
    func update(_ content: AnyView?, reduceMotion: Bool) {
        self.content = content
        guard content != nil, let field, let parent = field.window else {
            hide()
            return
        }

        let opening = !isShown
        guard place(field: field, parent: parent, opening: opening) else { return }
        if opening { open(in: parent, reduceMotion: reduceMotion) }
    }

    /// Moves the panel to the field again, after the field moved on screen.
    func follow() {
        guard isShown, let field, let parent = field.window else { return }
        _ = place(field: field, parent: parent, opening: false)
    }

    func hide() {
        guard isShown else { return }
        isShown = false
        for observer in observers { NotificationCenter.default.removeObserver(observer) }
        observers = []
        (field as? NSTextField)?.setAccessibilityLinkedUIElements(nil)
        if let panel {
            panel.parent?.removeChildWindow(panel)
            panel.orderOut(nil)
        }
    }

    /// The field went away: the panel goes with it.
    func tearDown() {
        hide()
        panel?.close()
        panel = nil
        host = nil
        content = nil
    }

    private func close() {
        hide()
        onClose()
    }

    /// Lays the list out at the panel's width and moves the panel under the field. False when the field is out of
    /// sight, which closes the list.
    private func place(field: NSView, parent: NSWindow, opening: Bool) -> Bool {
        let inWindow = field.convert(field.bounds, to: nil)
        guard AutocompletePlacement.isVisible(inWindow, in: Self.clips(around: field)) else {
            if isShown || opening { close() }
            return false
        }

        let onScreen = parent.convertToScreen(inWindow)
        let visible = (parent.screen ?? NSScreen.main)?.visibleFrame ?? onScreen.insetBy(dx: -2000, dy: -2000)
        let width = AutocompletePlacement.width(field: onScreen, visible: visible)
        let host = host ?? makePanel()
        host.rootView = framed(width: width)
        host.layoutSubtreeIfNeeded()
        let size = CGSize(width: width, height: ceil(host.fittingSize.height))
        let frame = AutocompletePlacement.frame(field: onScreen, visible: visible, size: size)
        listFrame = frame
        if let panel, panel.frame != frame {
            panel.setFrame(frame, display: true)
        }
        return true
    }

    /// The visible list and its interactive panel share one frame; `.zero` before the first open.
    private(set) var listFrame: CGRect = .zero

    private func framed(width: CGFloat) -> AnyView {
        AnyView((content ?? AnyView(EmptyView())).frame(width: width))
    }

    private func makePanel() -> AutocompleteListHost {
        let panel = AutocompleteListPanel()
        let host = AutocompleteListHost(rootView: AnyView(EmptyView()))
        // The panel sizes itself; the hosting view never sets the window's minimum or maximum size.
        host.sizingOptions = [.intrinsicContentSize]
        host.autoresizingMask = [.width, .height]
        panel.contentView = host
        self.panel = panel
        self.host = host
        return host
    }

    private func open(in parent: NSWindow, reduceMotion: Bool) {
        guard let panel, let host else { return }
        isShown = true
        panel.appearance = parent.effectiveAppearance
        panel.level = parent.level
        // A child shares its parent's alpha: an off-screen snapshot window (alpha 0) never shows its list on screen.
        let alpha = parent.alphaValue
        panel.alphaValue = reduceMotion || alpha == 0 ? alpha : 0
        parent.addChildWindow(panel, ordered: .above)
        if panel.alphaValue != alpha {
            NSAnimationContext.runAnimationGroup { context in
                context.duration = Self.fadeDuration
                context.timingFunction = CAMediaTimingFunction(name: .easeOut)
                panel.animator().alphaValue = alpha
            }
        }
        // VoiceOver reaches the rows from the field through its linked element (VO-Command-J).
        (field as? NSTextField)?.setAccessibilityLinkedUIElements([host])
        observe(parent)
    }

    private func observe(_ parent: NSWindow) {
        let center = NotificationCenter.default
        func on(_ name: Notification.Name, _ object: AnyObject?, _ action: @escaping @MainActor (AutocompleteFloatingList) -> Void) {
            observers.append(center.addObserver(forName: name, object: object, queue: .main) { [weak self] _ in
                MainActor.assumeIsolated {
                    guard let self else { return }
                    action(self)
                }
            })
        }

        on(NSWindow.didResignKeyNotification, parent) { $0.close() }
        on(NSApplication.didResignActiveNotification, nil) { $0.close() }
        on(NSWindow.willCloseNotification, parent) { $0.close() }
        on(NSWindow.didMoveNotification, parent) { $0.follow() }
        on(NSWindow.didResizeNotification, parent) { $0.follow() }
        if let field {
            for clip in Self.clipViews(around: field) {
                clip.postsBoundsChangedNotifications = true
                on(NSView.boundsDidChangeNotification, clip) { $0.follow() }
            }
        }
    }

    private static func clipViews(around view: NSView) -> [NSClipView] {
        var clips: [NSClipView] = []
        var ancestor = view.superview
        while let current = ancestor {
            if let clip = current as? NSClipView { clips.append(clip) }
            ancestor = current.superview
        }
        return clips
    }

    static func clips(around view: NSView) -> [CGRect] {
        clipViews(around: view).map { $0.convert($0.bounds, to: nil) }
    }
}
