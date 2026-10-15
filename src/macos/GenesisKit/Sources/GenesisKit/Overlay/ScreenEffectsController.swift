import AppKit
import SwiftUI

/// A click-through panel that never takes focus.
final class ScreenEffectPanel: ConstraintSafePanel {
    override var canBecomeKey: Bool { false }
    override var canBecomeMain: Bool { false }
}

/// The panels of one controller, kept apart from it so they can be taken down without it: by its `deinit`, by a
/// timeout that outlived it, and by `ScreenEffectsController.dismissAll()`. AppKit keeps an ordered-in panel alive and
/// on screen after its last reference goes, so dropping the references alone would leave the effect up.
@MainActor
final class ScreenEffectPanelSet {
    var screens: [String: ScreenEffectPanel] = [:]
    var bubble: ScreenEffectPanel?

    var all: [ScreenEffectPanel] { Array(screens.values) + (bubble.map { [$0] } ?? []) }

    /// Orders every panel out and lets go of it and its content.
    func closeAll() {
        for panel in all {
            panel.orderOut(nil)
            panel.contentView = nil
        }
        screens = [:]
        bubble = nil
    }
}

/// Screen effects: a click-through panel over each targeted screen (vignette, sepia, blur, dim, edge glow or no tint)
/// with an optional message pill, and an optional camera bubble in the corner of one screen.
///
/// - The panels float at status-bar level (above the Dock and the menu bar, below menus and pop-up windows) on every
///   Space and over full-screen apps, and never take a click, the keyboard or focus.
/// - Screen shares: `sharingType` `.none` (the default, and always for the bubble) only keeps the panels out of the
///   legacy `CGWindowList` captures. ScreenCaptureKit, which Zoom, Meet, Teams, QuickTime and the screenshot tools use
///   on macOS 15 and later, captures them anyway, and no public API can stop it. So while `ScreenCaptureDetector`
///   reports a capture, the controller hides what `configuration.duringScreenCapture` names: by default the camera
///   bubble. It checks when an effect shows and once a second while it is up; "unknown" counts as a capture. A
///   capture that starts between two checks can catch up to a second of what was on screen.
/// - `show()` ramps in over `rampIn` and `hide()` clears over `rampOut`, both as one window-alpha animation (at once
///   under Reduce Motion). While the effect sits still nothing redraws; the only work is the capture check above.
/// - Safety: an effect hides itself after `maximumDuration` and calls `onTimeout`; `suppress(until:)` is the kill
///   switch (hides at once, refuses every show until then), `dismissAll()` the process-wide one.
///   `preview(_:seconds:)` shows a style for a few seconds.
/// - Releasing the controller takes its panels down, even when `tearDown()` was not called.
/// - When displays change, the panels are rebuilt half a second later at the current strength, without a new ramp.
@MainActor
public final class ScreenEffectsController {
    /// What the effect draws. A change applies at once to the panels on screen.
    public var configuration: ScreenEffectConfiguration {
        didSet {
            guard configuration != oldValue, !refreshSuspended else { return }
            if configuration.duringScreenCapture != oldValue.duringScreenCapture, machine.isShown {
                isScreenCaptureDetected = detectCapture()
                scheduleCaptureCheck()
            }
            if configuration.target != oldValue.target || configuration.coversMenuBar != oldValue.coversMenuBar
                || configuration.sharingType != oldValue.sharingType
                || configuration.duringScreenCapture != oldValue.duringScreenCapture
            {
                if machine.isShown { rebuild() }
            } else {
                refreshContent()
            }
            rescheduleTimeout()
        }
    }

    /// Runs when an effect hid itself after `maximumDuration`.
    public var onTimeout: (() -> Void)?
    /// Runs with true when an effect starts to show and false when it starts to hide.
    public var onVisibilityChange: ((Bool) -> Void)?

    /// The effect is on. While `duringScreenCapture` is `.holdBack` and a capture runs, it is on but not drawn.
    public var isVisible: Bool { machine.isShown }
    public var isPreviewing: Bool { machine.isPreview }
    public var suppressedUntil: Date? { machine.suppressedUntil }
    /// A screen capture was running (or could not be ruled out) at the last check.
    public private(set) var isScreenCaptureDetected = false

    private var machine = ScreenEffectMachine()
    private let panelSet = ScreenEffectPanelSet()
    private var bubbleView: NSView?
    private var previewRestore: ScreenEffectConfiguration?
    private var timeout: DispatchWorkItem?
    private var previewEnd: DispatchWorkItem?
    private var screenRebuild: DispatchWorkItem?
    private var captureCheck: DispatchWorkItem?
    // Written once in init and read once in deinit.
    nonisolated(unsafe) private var screenObserver: NSObjectProtocol?
    private let screens: @MainActor () -> [ScreenEffectScreen]
    private let cursor: @MainActor () -> CGPoint
    private let now: () -> Date
    private let reduceMotion: @MainActor () -> Bool
    private let reduceTransparency: @MainActor () -> Bool
    private let screenCapture: @MainActor () -> Bool?

    /// Every live controller, for `dismissAll()`.
    private static let live = NSHashTable<ScreenEffectsController>.weakObjects()
    /// Seconds between two capture checks while an effect is up.
    static let captureCheckInterval: TimeInterval = 1

    /// - Parameters:
    ///   - screens: the displays, main first (default `NSScreen.screens`). Tests pass made-up screens.
    ///   - cursor: the pointer in global coordinates (default `NSEvent.mouseLocation`).
    ///   - reduceMotion, reduceTransparency: default to the system settings, read at each show.
    ///   - screenCapture: whether the screen is captured now, nil when unknown (default `ScreenCaptureDetector`).
    public init(
        configuration: ScreenEffectConfiguration = ScreenEffectConfiguration(),
        screens: @escaping @MainActor () -> [ScreenEffectScreen] = { NSScreen.screens.map(ScreenEffectScreen.init) },
        cursor: @escaping @MainActor () -> CGPoint = { NSEvent.mouseLocation },
        now: @escaping () -> Date = Date.init,
        reduceMotion: @escaping @MainActor () -> Bool = { NSWorkspace.shared.accessibilityDisplayShouldReduceMotion },
        reduceTransparency: @escaping @MainActor () -> Bool = {
            NSWorkspace.shared.accessibilityDisplayShouldReduceTransparency
        },
        screenCapture: @escaping @MainActor () -> Bool? = { ScreenCaptureDetector.current() }
    ) {
        self.configuration = configuration
        self.screens = screens
        self.cursor = cursor
        self.now = now
        self.reduceMotion = reduceMotion
        self.reduceTransparency = reduceTransparency
        self.screenCapture = screenCapture
        screenObserver = NotificationCenter.default.addObserver(
            forName: NSApplication.didChangeScreenParametersNotification, object: nil, queue: .main
        ) { [weak self] _ in
            MainActor.assumeIsolated { self?.scheduleRebuild() }
        }
        Self.live.add(self)
    }

    deinit {
        if let screenObserver { NotificationCenter.default.removeObserver(screenObserver) }
        // A controller dropped while its effect is up must not leave the panels on screen.
        let panels = panelSet
        if Thread.isMainThread {
            MainActor.assumeIsolated { panels.closeAll() }
        } else {
            DispatchQueue.main.async { MainActor.assumeIsolated { panels.closeAll() } }
        }
    }

    /// Takes every screen effect of this process down at once: each live controller hides without a ramp (and
    /// refuses shows until `date`, when given), and any panel left on screen by a controller that is gone is ordered
    /// out. For a global "hide effects" command that must work whoever owns the controllers.
    public static func dismissAll(suppressingUntil date: Date? = nil) {
        for controller in live.allObjects {
            if let date { controller.suppress(until: date) }
            controller.hide(animated: false)
        }
        for window in NSApplication.shared.windows {
            guard let panel = window as? ScreenEffectPanel, panel.isVisible else { continue }
            panel.orderOut(nil)
        }
    }

    // MARK: Showing and hiding

    /// Shows the effect, ramping in. Returns false while suppressed. A show during a preview makes it a real one.
    @discardableResult
    public func show() -> Bool {
        if machine.isPreview {
            previewEnd?.cancel()
            previewEnd = nil
            if let restore = previewRestore {
                previewRestore = nil
                configuration = restore
            }
        }
        return present(preview: false)
    }

    /// Hides the effect, clearing over `rampOut` (at once when `animated` is false or under Reduce Motion).
    public func hide(animated: Bool = true) {
        endPreview(restoring: true)
        guard machine.hide() else { return }
        timeout?.cancel()
        timeout = nil
        stopCaptureChecks()
        onVisibilityChange?(false)
        fadeOut(duration: animated && !reduceMotion() ? configuration.rampOut : 0)
    }

    /// The kill switch: hides at once and refuses every show, previews included, until `date`.
    public func suppress(until date: Date) {
        endPreview(restoring: true)
        let wasShown = machine.suppress(until: date)
        timeout?.cancel()
        timeout = nil
        stopCaptureChecks()
        if wasShown {
            onVisibilityChange?(false)
            fadeOut(duration: reduceMotion() ? 0 : min(0.15, configuration.rampOut))
        }
    }

    /// Lifts a suppression early.
    public func clearSuppression() { machine.clearSuppression() }

    /// Shows `override` (or the current configuration) for `seconds`, then hides it and puts the configuration back.
    /// A preview never replaces a real effect that is already up; then it only updates nothing and returns false.
    @discardableResult
    public func preview(_ override: ScreenEffectConfiguration? = nil, seconds: TimeInterval = 5) -> Bool {
        if machine.isShown, !machine.isPreview { return false }
        if machine.isSuppressed(at: now()) { return false }
        if let override {
            if previewRestore == nil { previewRestore = configuration }
            configuration = override
        }
        let presented = machine.isShown || present(preview: true)
        guard presented else { return false }
        previewEnd?.cancel()
        let end = DispatchWorkItem { [weak self] in
            MainActor.assumeIsolated {
                guard let self, self.machine.isPreview else { return }
                self.hide()
            }
        }
        previewEnd = end
        DispatchQueue.main.asyncAfter(deadline: .now() + seconds, execute: end)
        return true
    }

    /// Puts `view` in a round bubble at the corner of the target screen (the camera preview), or removes it. The
    /// bubble shows only while the effect does, and hides while the screen is captured unless `duringScreenCapture`
    /// is `.showEverything`.
    ///
    /// The bubble shows whatever `view` draws. A camera that stops between interval checks (Battery saver) leaves a
    /// black or frozen picture, so keep the camera running while the bubble shows, or pass nil until it runs.
    public func setCameraBubble(_ view: NSView?) {
        bubbleView?.removeFromSuperview()
        bubbleView = view
        if view == nil {
            panelSet.bubble?.orderOut(nil)
            panelSet.bubble?.contentView = nil
            panelSet.bubble = nil
        } else if machine.isShown {
            placeBubble(alpha: currentStrength)
        }
    }

    /// Takes every panel down at once (on quit, or when the feature turns off). Releasing the controller does the same.
    public func tearDown() {
        endPreview(restoring: true)
        let wasShown = machine.hide()
        timeout?.cancel()
        timeout = nil
        screenRebuild?.cancel()
        stopCaptureChecks()
        panelSet.closeAll()
        if wasShown { onVisibilityChange?(false) }
    }

    // MARK: Internals

    private func present(preview: Bool) -> Bool {
        switch machine.show(at: now(), preview: preview) {
        case .suppressed:
            return false
        case .alreadyShown, .promoted:
            rescheduleTimeout()
            return true
        case .presented:
            isScreenCaptureDetected = detectCapture()
            rebuild(alpha: 0)
            onVisibilityChange?(true)
            fadeIn(duration: reduceMotion() ? 0 : configuration.rampIn)
            rescheduleTimeout()
            scheduleCaptureCheck()
            return true
        }
    }

    private func endPreview(restoring: Bool) {
        previewEnd?.cancel()
        previewEnd = nil
        if restoring, let restore = previewRestore {
            previewRestore = nil
            // Restoring while the preview fades would swap its look mid-fade; the panels keep the preview's content
            // until they are rebuilt for the next show.
            withoutRefresh { configuration = restore }
        }
    }

    private var refreshSuspended = false

    private func withoutRefresh(_ change: () -> Void) {
        refreshSuspended = true
        change()
        refreshSuspended = false
    }

    private func rescheduleTimeout() {
        timeout?.cancel()
        timeout = nil
        guard let deadline = machine.deadline(maximumDuration: configuration.maximumDuration) else { return }
        // Holds the panels itself: the timeout takes them down even when the controller is already gone.
        let item = DispatchWorkItem { [weak self, panelSet] in
            MainActor.assumeIsolated {
                guard let self else {
                    panelSet.closeAll()
                    return
                }
                guard self.machine.isShown else { return }
                self.hide()
                self.onTimeout?()
            }
        }
        timeout = item
        DispatchQueue.main.asyncAfter(deadline: .now() + max(0, deadline.timeIntervalSince(now())), execute: item)
    }

    private func scheduleRebuild() {
        screenRebuild?.cancel()
        let item = DispatchWorkItem { [weak self] in
            MainActor.assumeIsolated {
                guard let self, self.machine.isShown else { return }
                self.rebuild()
            }
        }
        screenRebuild = item
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.5, execute: item)
    }

    // MARK: Screen capture

    private func detectCapture() -> Bool {
        configuration.duringScreenCapture == .showEverything ? false : (screenCapture() ?? true)
    }

    /// The bubble hides during a capture unless everything may show.
    private var hidesBubble: Bool { isScreenCaptureDetected && configuration.duringScreenCapture != .showEverything }
    private var hidesMessage: Bool {
        isScreenCaptureDetected
            && (configuration.duringScreenCapture == .hideCameraBubbleAndMessage
                || configuration.duringScreenCapture == .holdBack)
    }
    private var holdsBack: Bool { isScreenCaptureDetected && configuration.duringScreenCapture == .holdBack }

    /// One capture check now; while the effect is up and something may need to hide, another follows a second later.
    /// Each check is a fresh work item that holds the controller weakly, so the chain ends with the controller.
    private func scheduleCaptureCheck() {
        captureCheck?.cancel()
        captureCheck = nil
        guard machine.isShown, configuration.duringScreenCapture != .showEverything else { return }
        let item = DispatchWorkItem { [weak self] in
            MainActor.assumeIsolated {
                guard let self else { return }
                self.checkScreenCapture()
                self.scheduleCaptureCheck()
            }
        }
        captureCheck = item
        DispatchQueue.main.asyncAfter(deadline: .now() + Self.captureCheckInterval, execute: item)
    }

    private func stopCaptureChecks() {
        captureCheck?.cancel()
        captureCheck = nil
    }

    /// Reads the capture state and, when it changed while the effect is up, hides or brings back what it gates.
    func checkScreenCapture() {
        let detected = detectCapture()
        guard detected != isScreenCaptureDetected else { return }
        isScreenCaptureDetected = detected
        guard machine.isShown else { return }
        rebuild()
    }

    // MARK: Panels

    private var currentStrength: CGFloat { panelSet.screens.values.first?.alphaValue ?? 1 }

    /// One panel per targeted screen at `alpha` (the current strength when nil), old panels on other screens closed.
    func rebuild(alpha: CGFloat? = nil) {
        let strength = alpha ?? currentStrength
        let all = screens()
        let targets = ScreenEffectGeometry.screens(for: configuration.target, among: all, cursor: cursor())
        let wanted = Set(targets.map(\.id))
        for (id, panel) in panelSet.screens where !wanted.contains(id) {
            panel.orderOut(nil)
            panel.contentView = nil
            panelSet.screens[id] = nil
        }
        for screen in targets {
            let frame = ScreenEffectGeometry.panelFrame(on: screen, coversMenuBar: configuration.coversMenuBar)
            let panel = panelSet.screens[screen.id] ?? makePanel(identifier: "screen-effect-\(screen.id)")
            panelSet.screens[screen.id] = panel
            panel.sharingType = configuration.sharingType
            panel.setFrame(frame, display: false)
            updateContent(of: panel, screen: screen, frame: frame)
            panel.alphaValue = strength
            if holdsBack { panel.orderOut(nil) } else { panel.orderFrontRegardless() }
        }
        placeBubble(alpha: strength)
    }

    private func refreshContent() {
        guard !refreshSuspended, machine.isShown else { return }
        for screen in screens() {
            guard let panel = panelSet.screens[screen.id] else { continue }
            let frame = ScreenEffectGeometry.panelFrame(on: screen, coversMenuBar: configuration.coversMenuBar)
            updateContent(of: panel, screen: screen, frame: frame)
        }
    }

    /// Gives the panel's hosting view the current look; the hosting view is made once per panel and then reused, so
    /// a host that steps `intensity` does not rebuild a full-screen view per step.
    private func updateContent(of panel: ScreenEffectPanel, screen: ScreenEffectScreen, frame: CGRect) {
        let content = ScreenEffectView(
            style: configuration.style, intensity: configuration.clampedIntensity, glow: configuration.glow,
            message: hidesMessage ? nil : configuration.message,
            pillCenter: ScreenEffectGeometry.pillCenter(panel: frame, visible: screen.visibleFrame),
            reduceTransparency: reduceTransparency())
        if let host = panel.contentView as? NSHostingView<ScreenEffectView> {
            host.rootView = content
            return
        }
        let host = NSHostingView(rootView: content)
        host.sizingOptions = []
        host.frame = CGRect(origin: .zero, size: frame.size)
        host.autoresizingMask = [.width, .height]
        panel.contentView = host
    }

    private func makePanel(identifier: String) -> ScreenEffectPanel {
        let panel = ScreenEffectPanel(
            contentRect: .zero, styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
        panel.isFloatingPanel = true
        panel.becomesKeyOnlyIfNeeded = true
        // NSPanel hides on deactivation by default; the effect floats over every app.
        panel.hidesOnDeactivate = false
        // After `isFloatingPanel`, whose setter resets the level. Status-bar level covers the Dock and the menu bar
        // but stays below menus and pop-up windows; the screen-saver level sat above nearly all system UI.
        panel.level = .statusBar
        panel.backgroundColor = .clear
        panel.isOpaque = false
        panel.hasShadow = false
        // A full-screen panel that took clicks would freeze the desktop.
        panel.ignoresMouseEvents = true
        panel.collectionBehavior = [.canJoinAllSpaces, .stationary, .fullScreenAuxiliary, .ignoresCycle]
        panel.isMovableByWindowBackground = false
        panel.isReleasedWhenClosed = false
        panel.animationBehavior = .none
        panel.setAccessibilityIdentifier(identifier)
        return panel
    }

    private func placeBubble(alpha: CGFloat) {
        guard let bubbleView, !hidesBubble,
              let screen = ScreenEffectGeometry.bubbleScreen(for: configuration.target, among: screens(), cursor: cursor())
        else {
            panelSet.bubble?.orderOut(nil)
            return
        }
        let panel = panelSet.bubble ?? makePanel(identifier: "screen-effect-bubble")
        panelSet.bubble = panel
        // Keeps the camera out of the legacy captures; ScreenCaptureKit ignores it, hence `hidesBubble`.
        panel.sharingType = .none
        let frame = ScreenEffectGeometry.bubbleFrame(on: screen)
        panel.setFrame(frame, display: false)
        if let container = panel.contentView as? ScreenEffectBubbleView, bubbleView.superview === container {
            container.frame = CGRect(origin: .zero, size: frame.size)
        } else {
            let container = ScreenEffectBubbleView(frame: CGRect(origin: .zero, size: frame.size))
            container.embed(bubbleView)
            panel.contentView = container
        }
        panel.alphaValue = alpha
        panel.orderFrontRegardless()
    }

    private func fadeIn(duration: TimeInterval) {
        let targets = panelSet.all
        guard duration > 0 else {
            for panel in targets { panel.alphaValue = 1 }
            return
        }
        NSAnimationContext.runAnimationGroup { context in
            context.duration = duration
            context.timingFunction = CAMediaTimingFunction(name: .easeOut)
            for panel in targets { panel.animator().alphaValue = 1 }
        }
    }

    private func fadeOut(duration: TimeInterval) {
        let targets = panelSet.all
        guard duration > 0 else {
            for panel in targets { panel.alphaValue = 0 }
            finishFadeOut(panelSet)
            return
        }
        // The completion holds the panel set, not the controller: a controller released mid-fade has already closed
        // the set in its deinit, and ordering out closed panels is harmless.
        let panels = panelSet
        NSAnimationContext.runAnimationGroup({ context in
            context.duration = duration
            context.timingFunction = CAMediaTimingFunction(name: .easeIn)
            for panel in targets { panel.animator().alphaValue = 0 }
        }, completionHandler: { [weak self] in
            MainActor.assumeIsolated {
                if let self { self.finishFadeOut(panels) } else { panels.closeAll() }
            }
        })
    }

    private func finishFadeOut(_ panels: ScreenEffectPanelSet) {
        // A show that came in during the fade owns the panels now.
        guard !machine.isShown else { return }
        for panel in panels.all { panel.orderOut(nil) }
    }

    // MARK: Test access

    var panelFrames: [String: CGRect] { panelSet.screens.mapValues(\.frame) }
    var panelList: [NSPanel] { Array(panelSet.screens.values) }
    var bubble: NSPanel? { panelSet.bubble }
    /// The message the first panel draws.
    var drawnMessage: ScreenEffectMessage? {
        (panelSet.screens.values.first?.contentView as? NSHostingView<ScreenEffectView>)?.rootView.message
    }
}

/// The round frame of the camera bubble: the host's view clipped to a circle, a hairline ring around it.
final class ScreenEffectBubbleView: NSView {
    override init(frame: NSRect) {
        super.init(frame: frame)
        wantsLayer = true
        layer?.cornerRadius = frame.width / 2
        layer?.masksToBounds = true
        layer?.borderWidth = 1.5
        layer?.borderColor = NSColor.white.withAlphaComponent(0.28).cgColor
        layer?.backgroundColor = NSColor(white: 0.08, alpha: 1).cgColor
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

    func embed(_ view: NSView) {
        view.removeFromSuperview()
        view.frame = bounds
        view.autoresizingMask = [.width, .height]
        addSubview(view, positioned: .below, relativeTo: nil)
    }
}
