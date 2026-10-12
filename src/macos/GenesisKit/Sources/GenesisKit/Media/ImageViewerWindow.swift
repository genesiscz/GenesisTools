import AppKit
import Combine
import SwiftUI

/// Where a picture sits on its source surface right now, in screen coordinates: the picture itself, the area it is
/// clipped to (a web view's visible rect), and its corner radius there.
public struct ImageViewerOrigin: Equatable, Sendable {
    public var rect: CGRect
    public var clip: CGRect
    public var cornerRadius: CGFloat

    public init(rect: CGRect, clip: CGRect, cornerRadius: CGFloat = 0) {
        self.rect = rect
        self.clip = clip
        self.cornerRadius = cornerRadius
    }
}

/// Everything a host passes to open the viewer.
public struct ImageViewerRequest {
    /// One viewer per source surface: a second request from the same owner shows its picture in the open window.
    public var ownerID: ObjectIdentifier
    /// The source's pictures in document order.
    public var items: [ImageViewerItem]
    public var selectedID: String
    /// Where the double-clicked picture is now; nil opens with a fade.
    public var origin: ImageViewerOrigin?
    public var background: NSColor
    /// The window level of the source (a floating document window keeps its viewer above it too).
    public var level: NSWindow.Level
    /// The screen to open on when `origin` is nil.
    public var screen: NSScreen?
    /// Where a picture is on its source when the viewer closes, for the zoom back; nil (or no answer) fades.
    public var currentOrigin: (@MainActor (ImageViewerItem) async -> ImageViewerOrigin?)?
    /// When the user asked; the transition log measures its first frame from here.
    public var startedAt: CFTimeInterval

    /// Genesis Markdown's page colour.
    public static var defaultBackground: NSColor {
        NSColor(srgbRed: 0x0c / 255, green: 0x0e / 255, blue: 0x10 / 255, alpha: 1)
    }

    public init(ownerID: ObjectIdentifier, items: [ImageViewerItem], selectedID: String, origin: ImageViewerOrigin? = nil,
                background: NSColor = ImageViewerRequest.defaultBackground, level: NSWindow.Level = .normal,
                screen: NSScreen? = nil,
                currentOrigin: (@MainActor (ImageViewerItem) async -> ImageViewerOrigin?)? = nil,
                startedAt: CFTimeInterval = CACurrentMediaTime())
    {
        self.ownerID = ownerID
        self.items = items
        self.selectedID = selectedID
        self.origin = origin
        self.background = background
        self.level = level
        self.screen = screen
        self.currentOrigin = currentOrigin
        self.startedAt = startedAt
    }
}

/// The image viewer: zoom, pan, step through a document's pictures, and compare two with a slider or side by side.
@MainActor
public enum ImageViewer {
    static let sizeKey = "GenesisKit.imageViewer.size"
    static var controllers: [ObjectIdentifier: ImageViewerWindowController] = [:]
    /// How long the open waits for the picture before it flies a placeholder instead.
    static let decodeWait: Duration = .milliseconds(120)
    /// The viewer's own decodes, up to `MediaThumbnailCache.largestCeiling`. A full-size picture costs 40 to 180 MB,
    /// and in the shared 96 MB thumbnail cache one of them evicted every thumbnail of every page at once.
    nonisolated static let cache = MediaThumbnailCache(byteLimit: 192 << 20)

    public static func present(_ request: ImageViewerRequest) {
        guard !request.items.isEmpty else { return }
        if let open = reusableViewer(for: request.ownerID) {
            open.replace(request)
            return
        }
        let controller: ImageViewerWindowController
        if let ready = spare {
            spare = nil
            ready.adopt(request)
            controller = ready
        } else {
            controller = ImageViewerWindowController(request: request)
        }
        controllers[request.ownerID] = controller
        controller.open()
    }

    /// The owner's viewer that takes a new request: one on screen, or one still waiting for its picture (not on
    /// screen yet, so `isVisible` is false). A viewer that is closing finishes its close, and the request opens a
    /// new one; the closing one's `windowWillClose` leaves the new entry alone.
    static func reusableViewer(for owner: ObjectIdentifier) -> ImageViewerWindowController? {
        guard let open = controllers[owner], !open.isClosing else { return nil }
        return open
    }

    /// A window built and laid out ahead of time, never shown, so an open costs a frame change and a layout instead
    /// of building the window (measured ~20 ms warm, ~50 ms for the first in a process).
    static var spare: ImageViewerWindowController?
    private final class SpareOwner {}
    private static let spareOwner = SpareOwner()

    static func makeSpare() {
        guard spare == nil else { return }
        let started = CACurrentMediaTime()
        let controller = ImageViewerWindowController(
            request: ImageViewerRequest(ownerID: ObjectIdentifier(spareOwner), items: [], selectedID: ""))
        controller.window?.alphaValue = 0
        controller.window?.layoutIfNeeded()
        spare = controller
        PerfLog.mark(String(format: "imageviewer.spare built in %.1fms", (CACurrentMediaTime() - started) * 1000))
    }

    /// The first click of a double-click: decodes the picture at the size the viewer will ask for, so the open
    /// that follows starts with the real picture.
    public static func prefetch(path: String, screen: NSScreen? = nil) {
        let screen = screen ?? NSScreen.main
        let frame = ImageViewerPlacement.frame(remembered: rememberedSize, visible: screen?.visibleFrame ?? CGRect(x: 0, y: 0, width: 1440, height: 900))
        let pixels = max(frame.width, frame.height) * (screen?.backingScaleFactor ?? 2)
        Task.detached(priority: .userInitiated) {
            _ = await ImageViewer.cache.thumbnail(path: path, maxPixels: pixels, kind: .image,
                                                  ceiling: MediaThumbnailCache.largestCeiling)
        }
        prepare()
    }

    /// Builds the spare window after this click's own work: the second click arrives a few hundred ms later. For a
    /// picture with no file to decode yet (an embedded one), the window alone.
    public static func prepare() {
        DispatchQueue.main.async { makeSpare() }
    }

    /// The source went away (its page closed): its viewer closes without a zoom.
    public static func close(owner: ObjectIdentifier) {
        controllers[owner]?.closeNow()
    }

    static var rememberedSize: CGSize? {
        guard let text = UserDefaults.standard.string(forKey: sizeKey) else { return nil }
        let size = NSSizeFromString(text)
        return size.width > 0 && size.height > 0 ? size : nil
    }
}

/// Esc, ⌘W, the zoom keys and the arrows reach the viewer before any control or the app's menu.
final class ImageViewerWindow: NSWindow {
    weak var model: ImageViewerModel?

    override func performKeyEquivalent(with event: NSEvent) -> Bool {
        guard event.type == .keyDown, let model else { return super.performKeyEquivalent(with: event) }
        let flags = event.modifierFlags.intersection([.command, .option, .shift, .control])
        if flags == .command, event.charactersIgnoringModifiers == "w" {
            performClose(nil)
            return true
        }
        if let action = ImageViewerKeys.action(keyCode: event.keyCode, characters: event.charactersIgnoringModifiers,
                                               modifiers: event.modifierFlags, picking: model.picking,
                                               comparing: model.compare != nil), flags.contains(.command)
        {
            model.perform(action)
            return true
        }
        return super.performKeyEquivalent(with: event)
    }

    override func sendEvent(_ event: NSEvent) {
        if event.type == .keyDown, let model, !event.modifierFlags.contains(.command),
           let action = ImageViewerKeys.action(keyCode: event.keyCode, characters: event.charactersIgnoringModifiers,
                                               modifiers: event.modifierFlags, picking: model.picking,
                                               comparing: model.compare != nil)
        {
            model.perform(action)
            return
        }
        super.sendEvent(event)
    }
}

@MainActor
public final class ImageViewerWindowController: NSWindowController, NSWindowDelegate {
    public let model: ImageViewerModel
    private var request: ImageViewerRequest
    private var flight: ImageViewerTransition?
    private var closeConfirmed = false
    private var closing = false
    /// The window is on screen: `reveal` ran.
    private var revealed = false
    /// The open's wait for the picture; a close cancels it, so a viewer closed meanwhile never shows.
    private var opening: Task<Void, Never>?
    /// The close has started (the fade or the flight back) or is done; such a viewer takes no new request.
    var isClosing: Bool { closing || closeConfirmed }
    /// False for a window that exists only to be drawn (a snapshot, a test): closing it must not become the user's size.
    var remembersSize = true
    private var titleWatch: AnyCancellable?
    private var pictureWatch: AnyCancellable?

    init(request: ImageViewerRequest, frame: CGRect? = nil) {
        self.request = request
        model = ImageViewerModel(items: request.items, selectedID: request.selectedID, cache: ImageViewer.cache)
        model.background = Color(nsColor: request.background)
        let placed = frame ?? Self.placement(for: request)
        let window = ImageViewerWindow(
            contentRect: placed, styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
            backing: .buffered, defer: false)
        window.model = model
        window.titlebarAppearsTransparent = true
        // The title row draws the name (`ImageViewerToolbar`); the title stays set for the Window menu and Mission Control.
        window.titleVisibility = .hidden
        window.isMovableByWindowBackground = false
        window.appearance = NSAppearance(named: .darkAqua)
        window.backgroundColor = request.background
        window.minSize = ImageViewerPlacement.minSize
        window.isReleasedWhenClosed = false
        window.level = request.level
        window.collectionBehavior.insert(.fullScreenAuxiliary)
        window.animationBehavior = .none
        window.tabbingMode = .disallowed
        window.title = model.title
        window.contentView = NSHostingView(rootView: ImageViewerView(model: model))
        window.setFrame(placed, display: false)
        super.init(window: window)
        window.delegate = self
        model.onDismiss = { [weak self] in self?.window?.performClose(nil) }
        titleWatch = model.objectWillChange.sink { [weak self] in
            DispatchQueue.main.async {
                guard let self, let window = self.window else { return }
                let title = self.model.title
                if window.title != title { window.title = title }
            }
        }
        // A picture that lands while the placeholder flies replaces it in flight.
        pictureWatch = model.$stateA.sink { [weak self] state in
            guard state.isReady else { return }
            DispatchQueue.main.async {
                guard let self, let flight = self.flight, flight.isRunning else { return }
                flight.setImage(self.model.canvas.pictureA?.image)
            }
        }
    }

    required init?(coder: NSCoder) { fatalError("not supported") }

    /// The remembered size, centred on the screen the picture is on (or the source's screen).
    static func placement(for request: ImageViewerRequest) -> CGRect {
        let screen = request.origin.flatMap { origin in
            NSScreen.screens.first { $0.frame.contains(CGPoint(x: origin.rect.midX, y: origin.rect.midY)) }
        } ?? request.screen ?? NSScreen.main
        let visible = screen?.visibleFrame ?? CGRect(x: 0, y: 0, width: 1440, height: 900)
        return ImageViewerPlacement.frame(remembered: ImageViewer.rememberedSize, visible: visible)
    }

    /// A spare window (built during the first click of a double-click) takes over this request.
    func adopt(_ next: ImageViewerRequest) {
        request = next
        model.background = Color(nsColor: next.background)
        model.reset(items: next.items, selectedID: next.selectedID)
        guard let window else { return }
        window.backgroundColor = next.background
        window.level = next.level
        window.setFrame(Self.placement(for: next), display: false)
    }

    private var reduceMotion: Bool { NSWorkspace.shared.accessibilityDisplayShouldReduceMotion }

    // MARK: - Open

    /// Builds and lays the window out at alpha 0, waits briefly for the picture, then flies it from the page.
    func open() {
        guard let window else { return }
        let built = CACurrentMediaTime()
        window.alphaValue = 0
        window.layoutIfNeeded()
        window.contentView?.layoutSubtreeIfNeeded()
        model.start()
        let buildMs = (CACurrentMediaTime() - built) * 1000
        opening = Task { [weak self] in
            guard let self else { return }
            let waited = CACurrentMediaTime()
            await self.model.waitUntilLoaded(timeout: ImageViewer.decodeWait)
            guard !Task.isCancelled else { return }
            PerfLog.mark(String(format: "imageviewer.open build=%.1fms decode-wait=%.1fms ready=%@", buildMs,
                                (CACurrentMediaTime() - waited) * 1000, self.model.stateA.isReady ? "yes" : "no"))
            self.reveal()
        }
    }

    private func reveal() {
        guard let window, !isClosing else { return }
        revealed = true
        window.makeKeyAndOrderFront(nil)
        window.makeFirstResponder(model.canvas)
        guard !reduceMotion, let origin = request.origin, let target = canvasFrame(fitted: true) else {
            fade(window, to: 1, duration: reduceMotion ? 0.16 : 0.2)
            return
        }
        model.canvas.picturesHidden = true
        let flight = ImageViewerTransition(level: window.level, covering: [Self.frame(origin), target], label: "open",
                                           startedAt: request.startedAt)
        self.flight = flight
        flight.run(image: model.canvas.pictureA?.image, placeholder: NSColor(white: 1, alpha: 0.06),
                   from: Self.frame(origin), to: target, duration: 0.3,
                   curve: CAMediaTimingFunction(controlPoints: 0.2, 0.85, 0.25, 1)) { [weak self, weak flight] in
            guard let self else { return }
            self.model.canvas.picturesHidden = false
            flight?.close()
            if self.flight === flight { self.flight = nil }
        }
        NSAnimationContext.runAnimationGroup { context in
            context.duration = 0.22
            context.timingFunction = CAMediaTimingFunction(name: .easeOut)
            window.animator().alphaValue = 1
        }
    }

    /// A second double-click on the same page: that picture, in this window, no flight.
    func replace(_ next: ImageViewerRequest) {
        request = next
        model.replace(items: next.items, selectedID: next.selectedID)
        // Before `reveal` the window waits at alpha 0 for its picture; the reveal shows it, flying from this click.
        if revealed {
            window?.makeKeyAndOrderFront(nil)
        }
    }

    // MARK: - Close

    public func windowShouldClose(_ sender: NSWindow) -> Bool {
        if closeConfirmed { return true }
        guard !closing else { return false }
        closing = true
        opening?.cancel()
        opening = nil
        flight?.cancel()
        flight = nil
        Task { [weak self] in await self?.animateClose() }
        return false
    }

    private func animateClose() async {
        guard let window else { return }
        var target: ImageViewerOrigin?
        if !reduceMotion, let item = model.current, let ask = request.currentOrigin {
            let answer = Task { @MainActor in await ask(item) }
            target = await MediaThumbnailCache.firstResult(of: answer, within: .milliseconds(150)) ?? nil
        }
        // A `closeNow` (the source went away) may have closed the viewer while the origin was asked for.
        guard !closeConfirmed else { return }
        guard let target, let from = canvasFrame(fitted: false), let image = model.canvas.pictureA?.image else {
            fade(window, to: 0, duration: reduceMotion ? 0.16 : 0.18) { [weak self] in self?.finishClose() }
            return
        }
        let to = Self.frame(target)
        let flight = ImageViewerTransition(level: window.level, covering: [from, to], label: "close",
                                           startedAt: CACurrentMediaTime())
        self.flight = flight
        model.canvas.picturesHidden = true
        flight.run(image: image, placeholder: .clear, from: from, to: to, duration: 0.26,
                   curve: CAMediaTimingFunction(controlPoints: 0.4, 0, 0.2, 1)) { [weak flight] in
            flight?.fadeOut(duration: 0.08)
        }
        fade(window, to: 0, duration: 0.14) { [weak self] in self?.finishClose() }
    }

    private func finishClose() {
        opening?.cancel()
        opening = nil
        closeConfirmed = true
        window?.close()
    }

    /// Closes at once, without a flight (the source went away).
    func closeNow() {
        flight?.cancel()
        flight = nil
        finishClose()
    }

    public func windowWillClose(_ notification: Notification) {
        rememberSize()
        if ImageViewer.controllers[request.ownerID] === self {
            ImageViewer.controllers[request.ownerID] = nil
        }
    }

    public func windowDidEndLiveResize(_ notification: Notification) {
        rememberSize()
    }

    private func rememberSize() {
        guard remembersSize, let size = window?.frame.size,
              size.width >= ImageViewerPlacement.minSize.width else { return }
        UserDefaults.standard.set(NSStringFromSize(size), forKey: ImageViewer.sizeKey)
    }

    // MARK: - Geometry

    /// Picture A's frame on screen (fitted, or as shown now) and the canvas it is clipped to.
    private func canvasFrame(fitted: Bool) -> ImageViewerTransition.Frame? {
        let canvas = model.canvas
        guard let window, canvas.window === window,
              let rect = fitted ? canvas.fittedRectA : canvas.displayedRectA else { return nil }
        func screen(_ local: CGRect) -> CGRect { window.convertToScreen(canvas.convert(local, to: nil)) }
        return ImageViewerTransition.Frame(clip: screen(canvas.clipRectA), image: screen(rect), cornerRadius: 0)
    }

    private static func frame(_ origin: ImageViewerOrigin) -> ImageViewerTransition.Frame {
        ImageViewerTransition.Frame(clip: origin.clip, image: origin.rect, cornerRadius: origin.cornerRadius)
    }

    private func fade(_ window: NSWindow, to alpha: CGFloat, duration: CFTimeInterval, then: (() -> Void)? = nil) {
        NSAnimationContext.runAnimationGroup({ context in
            context.duration = duration
            window.animator().alphaValue = alpha
        }, completionHandler: {
            MainActor.assumeIsolated { then?() }
        })
    }
}
