//
//  MarkdownHoverPreview.swift
//  GenesisKit
//
//  The floating, bordered preview of a note that opens after the pointer rests on a tab, a file
//  in the tree, or a link in the page (`GenesisKitMarkdownConfiguration.hoverPreview`).
//
//  One panel for the whole app, reused: a non-activating, borderless `NSPanel` with the note rendered
//  read-only in the window's renderer and palette. The pointer resting on an anchor for
//  `hoverPreviewDelay` opens it next to the anchor (`MarkdownHoverPlacement`); leaving the anchor hides
//  it after a short grace, unless the pointer went into the panel, where the reader can scroll. A click
//  in the panel opens the note as a tab. While a preview is up, the next anchor shows at once.
//  An image file shows its picture, an SVG with a switch to its source (`MarkdownHoverImage.swift`); a click
//  on a picture that is no text file opens it in the image viewer.
//  Idle cost: nothing. No timer runs while no pointer rests on an anchor, and a sensor view exists only
//  while one does.
//

import AppKit
import SwiftUI
import WebKit

/// The pointer resting on a link in the rendered page: what the link points at, and where it sits
/// in the web view, top-left origin, in points.
public struct MarkdownLinkHover: Equatable, Sendable {
    public var href: String
    public var rect: CGRect

    public init(href: String, rect: CGRect) {
        self.href = href
        self.rect = rect
    }
}

extension View {
    /// Opens the floating preview of `url` after the pointer rests here. nil = no preview.
    func markdownHoverPreview(_ url: URL?, model: MarkdownDocumentsModel) -> some View {
        modifier(MarkdownHoverPreviewModifier(url: url, model: model))
    }
}

// MARK: - Placement

/// Where the floating preview goes. Screen points: bottom-left origin, y grows up.
enum MarkdownHoverPlacement {
    /// Between the anchor and the preview.
    static let gap: CGFloat = 6
    /// Between the preview and the edge of the screen's visible frame.
    static let margin: CGFloat = 8
    /// Smaller than this, a preview shows too little to be worth opening.
    static let minimumSize = CGSize(width: 200, height: 120)

    /// The preview's frame for `anchor`, or nil when no side of it has room.
    ///
    /// Below and to the right of the anchor first: its top-left corner at the anchor's bottom-right. Off
    /// the right edge it flips to the anchor's left; off the bottom it flips above. Corner to corner, it
    /// covers neither the anchor nor what continues below a tab or a tree row, so the pointer can move on
    /// to the next one. When neither below nor above is tall enough (a small screen), it goes beside the
    /// anchor at full height. When nothing fits whole, it shrinks into the side with the most room. It is
    /// always inside `visible` and never overlaps the anchor.
    static func frame(size wanted: CGSize, anchor: CGRect, visible: CGRect, gap: CGFloat = gap, margin: CGFloat = margin) -> CGRect? {
        let area = visible.insetBy(dx: margin, dy: margin)
        guard area.width >= minimumSize.width, area.height >= minimumSize.height else { return nil }
        let w = min(wanted.width, area.width)
        let h = min(wanted.height, area.height)

        let rightX = anchor.maxX + gap
        let leftX = anchor.minX - gap - w
        let side: CGFloat? = rightX + w <= area.maxX ? rightX : (leftX >= area.minX ? leftX : nil)
        let belowY = anchor.minY - gap - h
        let aboveY = anchor.maxY + gap

        func clampX(_ x: CGFloat, _ width: CGFloat) -> CGFloat { min(max(x, area.minX), area.maxX - width) }
        func clampY(_ y: CGFloat, _ height: CGFloat) -> CGFloat { min(max(y, area.minY), area.maxY - height) }

        // Below, then above: across the anchor's height from it, so x only has to stay on screen. An anchor
        // outside the visible frame (under the menu bar) still gets a preview inside it, further away.
        if belowY >= area.minY {
            return CGRect(x: side ?? clampX(rightX, w), y: min(belowY, area.maxY - h), width: w, height: h)
        }
        if aboveY + h <= area.maxY {
            return CGRect(x: side ?? clampX(rightX, w), y: max(aboveY, area.minY), width: w, height: h)
        }
        // Beside: clear of the anchor's width, so y may go anywhere on screen. Top aligned with the anchor.
        if let side {
            return CGRect(x: side, y: clampY(anchor.maxY - h, h), width: w, height: h)
        }

        // Nothing fits whole: shrink into the roomiest side, keeping the larger share of the wanted area.
        let below = anchor.minY - gap - area.minY
        let above = area.maxY - aboveY
        let right = area.maxX - rightX
        let left = anchor.minX - gap - area.minX
        let tall = max(below, above)
        let wide = max(right, left)
        let frame: CGRect
        if tall * w >= wide * h {
            let y = below >= above ? anchor.minY - gap - tall : aboveY
            frame = CGRect(x: clampX(rightX, w), y: y, width: w, height: tall)
        } else {
            let x = right >= left ? rightX : anchor.minX - gap - wide
            frame = CGRect(x: x, y: clampY(anchor.maxY - h, h), width: wide, height: h)
        }
        guard frame.width >= minimumSize.width, frame.height >= minimumSize.height else { return nil }
        return frame
    }

    /// A rect in `view`, top-left origin (the page reports a link's box so), in screen coordinates.
    @MainActor
    static func screenRect(ofTopLeft rect: CGRect, in view: NSView) -> CGRect? {
        guard let window = view.window else { return nil }
        let local = localRect(ofTopLeft: rect, height: view.bounds.height, flipped: view.isFlipped)
        return window.convertToScreen(view.convert(local, to: nil))
    }

    /// A top-left-origin rect in a view's own coordinates.
    static func localRect(ofTopLeft rect: CGRect, height: CGFloat, flipped: Bool) -> CGRect {
        flipped ? rect : CGRect(x: rect.minX, y: height - rect.maxY, width: rect.width, height: rect.height)
    }

    /// The visible frame of the screen the anchor is on: the one it overlaps most.
    @MainActor
    static func visibleFrame(for anchor: CGRect) -> CGRect? {
        let screen = NSScreen.screens.max { a, b in
            area(a.frame.intersection(anchor)) < area(b.frame.intersection(anchor))
        }
        let best = screen.flatMap { area($0.frame.intersection(anchor)) > 0 ? $0 : nil } ?? NSScreen.main
        return best?.visibleFrame
    }

    private static func area(_ rect: CGRect) -> CGFloat {
        rect.isNull ? 0 : rect.width * rect.height
    }
}

// MARK: - What a link previews

enum MarkdownHoverTarget {
    /// The local note or readable file a link in a note points at, resolved the way
    /// `MarkdownDocumentsModel.follow` resolves a click on it (reference definitions, `file:` paths,
    /// wikilinks against the vault, `:20` line suffixes), or the picture it points at. nil for a web address
    /// or any other scheme, a heading in the same note, a folder, a missing file, and a file the viewer
    /// cannot show that is no picture either.
    static func url(forLink href: String, folder: URL, text: String, vaultRoot: String?) -> URL? {
        var target = href.trimmingCharacters(in: .whitespacesAndNewlines)
        // A link the page resolved against its own base (`a.href`) still names a path in the vault.
        let pageBase = "\(MarkdownWebView.assetScheme)://asset/"
        if target.hasPrefix(pageBase) {
            target = String(target.dropFirst(pageBase.count)).removingPercentEncoding ?? String(target.dropFirst(pageBase.count))
        }
        guard !target.isEmpty else { return nil }
        if !MarkdownDocumentLinks.hasScheme(target), MarkdownWebView.externalURL(target) == nil,
           let definition = MarkdownSourceLinks.reference(target, in: text) {
            target = definition
        }
        if let path = MarkdownDocumentLinks.filePath(target) {
            target = path
        } else if MarkdownWebView.externalURL(target) != nil || MarkdownDocumentLinks.hasScheme(target) {
            return nil
        }
        if target.hasPrefix("#") { return nil }
        guard let (url, fragment) = MarkdownDocumentLinks.locate(target, folder: folder, vaultRoot: vaultRoot) else {
            return nil
        }
        switch MarkdownLinkRoute.decide(url, fragment: fragment) {
        case let .note(note, _, _)?: return note
        case let .viewer(file, _)?: return file
        case let .choose(file, _)?: return FileTree.isReadable(file) || MarkdownHoverImage.isImage(file) ? file : nil
        case .folder?, nil: return nil
        }
    }

    /// Whether `url` has anything to preview: a note, a file the viewer reads, or a picture.
    static func isPreviewable(_ url: URL) -> Bool {
        !MarkdownLinkRoute.isFolder(url) && (FileTree.isReadable(url) || MarkdownHoverImage.isImage(url))
    }
}

// MARK: - The controller

/// Owns the one preview panel. Anchors report the pointer arriving (`enter`) and leaving (`exit`);
/// the panel reports the pointer inside it and a click.
@MainActor
final class MarkdownHoverPreviewController {
    static let shared = MarkdownHoverPreviewController()

    /// After the pointer leaves the anchor or the panel: time to reach the panel before it hides.
    static let grace: TimeInterval = 0.3
    /// While a preview is up, the next anchor's delay: a beat, so sweeping across tabs does not
    /// render every one of them on the way.
    static let warmDelay: TimeInterval = 0.08
    /// The most of a file a preview reads: a preview is the top of the note.
    static let readLimit = 256 * 1024
    /// How long the panel waits for a picture before it opens without one: most decode well within it, so
    /// the panel opens on the picture; a slower one shows that it loads and arrives in place.
    static let pictureWait: Duration = .milliseconds(350)

    struct Request {
        let owner: UUID
        let url: URL
        weak var model: MarkdownDocumentsModel?
        /// The view the anchor is drawn in (the sensor, or the page for a link): its window, and the
        /// tooltip guard's click and menu checks.
        weak var view: NSView?
        /// The anchor's frame on screen now; nil once it is gone.
        let anchor: () -> CGRect?
    }

    /// The anchor the pointer is on: pending, or the one shown.
    private(set) var request: Request?
    /// What the panel shows, while it is on screen.
    private(set) var shown: Request?
    private(set) var pointerInPanel = false
    private var pending: DispatchWorkItem?
    private var hideWork: DispatchWorkItem?
    /// Bumped whenever `request` changes or the panel hides: a load or a render that finishes after
    /// the pointer moved on is dropped.
    private var token = 0
    private var panel: MarkdownHoverPanel?
    private var hosting: NSHostingView<MarkdownHoverCard>?
    /// The shown preview's own state (an image's picture, the switch to its source) and what it shows.
    private var state: MarkdownHoverCardState?
    private var shownContent: MarkdownHoverContent?
    /// The card's own web view: export and print stay on the window's.
    private let proxy = MarkdownWebProxy()
    private var resignObserver: NSObjectProtocol?
    /// While the panel is up: a click anywhere else in the app takes it down at once.
    private var clickMonitor: Any?
    /// While the panel is up: Esc takes it down (it appears by itself, so it must close without acting).
    private var keyMonitor: Any?

    var isShowing: Bool { panel?.isVisible == true && shown != nil }

    /// The pointer rests on an anchor for `url`, drawn in `view`.
    func enter(owner: UUID, url: URL, model: MarkdownDocumentsModel, view: NSView?, anchor: @escaping () -> CGRect?) {
        guard model.configuration.hoverPreview, MarkdownHoverTarget.isPreviewable(url) else {
            exit(owner: owner)
            return
        }
        let url = url.standardizedFileURL
        if let current = request, current.owner == owner, current.url == url { return }
        // The tooltip's guard: a click on the anchor, or an open menu, keeps the preview away too.
        if let view { TooltipGuard.entered(owner, view: view) }
        request = Request(owner: owner, url: url, model: model, view: view, anchor: anchor)
        token += 1
        hideWork?.cancel()
        hideWork = nil
        pending?.cancel()
        let delay = isShowing ? Self.warmDelay : max(0, model.configuration.hoverPreviewDelay)
        let work = DispatchWorkItem { [weak self] in self?.present() }
        pending = work
        DispatchQueue.main.asyncAfter(deadline: .now() + delay, execute: work)
    }

    /// The pointer left the anchor `owner` (or it went away).
    func exit(owner: UUID) {
        TooltipGuard.exited(owner)
        if request?.owner == owner {
            request = nil
            token += 1
            pending?.cancel()
            pending = nil
        }
        if shown?.owner == owner { scheduleHide() }
    }

    /// Hides the preview now, whatever the pointer is on.
    func hide() {
        pending?.cancel()
        pending = nil
        hideWork?.cancel()
        hideWork = nil
        token += 1
        request = nil
        shown = nil
        state = nil
        shownContent = nil
        pointerInPanel = false
        panel?.orderOut(nil)
        if let resignObserver {
            NotificationCenter.default.removeObserver(resignObserver)
            self.resignObserver = nil
        }
        if let clickMonitor {
            NSEvent.removeMonitor(clickMonitor)
            self.clickMonitor = nil
        }
        if let keyMonitor {
            NSEvent.removeMonitor(keyMonitor)
            self.keyMonitor = nil
        }
    }

    /// Whether the preview may open for `request` now: not over an open menu, not for an anchor just
    /// clicked, not for an anchor another window covers.
    private func allowed(_ request: Request) -> Bool {
        guard let window = request.view?.window else { return request.view == nil }
        return TooltipGuard.allows(request.owner, in: window)
    }

    private func scheduleHide() {
        guard !pointerInPanel else { return }
        hideWork?.cancel()
        let work = DispatchWorkItem { [weak self] in
            guard let self, !self.pointerInPanel, self.request == nil else { return }
            self.hide()
        }
        hideWork = work
        DispatchQueue.main.asyncAfter(deadline: .now() + Self.grace, execute: work)
    }

    /// Out of the panel and onto an anchor (its own or another), that anchor's `enter` keeps the panel;
    /// anywhere else it goes after the grace.
    private func pointer(inPanel inside: Bool) {
        pointerInPanel = inside
        if inside {
            hideWork?.cancel()
            hideWork = nil
        } else if request == nil {
            scheduleHide()
        }
    }

    private func openShown() {
        guard let shown, let model = shown.model else {
            hide()
            return
        }
        let url = shown.url
        // A picture that is no text file has no tab: the image viewer opens it, grown from the preview.
        if MarkdownHoverImage.isImage(url), !FileTree.isReadable(url) {
            let origin = panel.flatMap { pictureOrigin(in: $0) }
            let request = ImageViewerRequest(
                ownerID: ObjectIdentifier(self), items: [ImageViewerItem(id: url.path, path: url.path)],
                selectedID: url.path, origin: origin, background: Self.viewerBackground(model.theme),
                level: shown.view?.window?.level ?? .normal, screen: panel?.screen)
            hide()
            ImageViewer.present(request)
            return
        }
        hide()
        model.open([url])
    }

    /// Where the picture is on screen, for the image viewer to grow from; nil while none is drawn.
    private func pictureOrigin(in panel: MarkdownHoverPanel) -> ImageViewerOrigin? {
        guard let rect = MarkdownHoverMarker.rects(.picture, in: panel.container).last, !rect.isEmpty else { return nil }
        return ImageViewerOrigin(rect: panel.convertToScreen(rect), clip: panel.frame)
    }

    /// The page's colour behind the viewer when it is dark; the viewer stays dark under the light theme.
    private static func viewerBackground(_ theme: MarkdownTheme) -> NSColor {
        guard theme.isDark else { return ImageViewerRequest.defaultBackground }
        let hex = theme.pageHex
        return NSColor(srgbRed: CGFloat((hex >> 16) & 0xff) / 255, green: CGFloat((hex >> 8) & 0xff) / 255,
                       blue: CGFloat(hex & 0xff) / 255, alpha: 1)
    }

    // MARK: Showing

    private func present() {
        pending = nil
        guard let request, let model = request.model, allowed(request) else { return }
        let token = token
        let url = request.url
        if MarkdownHoverImage.isImage(url) {
            // The same picture again while it is up (the pointer went into the panel and back): it stays as it
            // is, the reader's switch to the source included.
            if isShowing, let state, state.picture != nil, let content = shownContent, content.url == url {
                show(request, content: content, state: state, token: token)
                return
            }
            let doc = model.docs.first(where: { $0.url == url })
            presentImage(request, model: model, draft: doc?.displayText, dirty: doc?.isDirty == true, token: token)
            return
        }
        if let doc = model.docs.first(where: { $0.url == url }) {
            // An open tab: its draft, as the tab shows it, and nothing read from disk.
            show(request, content: Self.content(url: url, text: doc.displayText), token: token)
            return
        }
        let limit = Self.readLimit
        Task { @MainActor [weak self] in
            let content = await Task.detached(priority: .userInitiated) {
                Self.readText(url, limit: limit).map { Self.content(url: url, text: $0) }
            }.value
            guard let self, self.token == token, let content else { return }
            self.show(request, content: content, token: token)
        }
    }

    /// An image file: the picture, decoded off the main thread, and an SVG's source under it (an open tab's
    /// draft, as the tab shows it). The panel waits `pictureWait` for the picture, then opens without it and
    /// takes it in place when it comes.
    private func presentImage(_ request: Request, model: MarkdownDocumentsModel, draft: String?, dirty: Bool, token: Int) {
        let url = request.url
        let hasSource = MarkdownHoverImage.hasSource(url)
        let scale = request.view?.window?.backingScaleFactor ?? NSScreen.main?.backingScaleFactor ?? 2
        let pixels = MarkdownHoverImage.pixels(for: model.configuration.hoverPreviewSize, scale: scale)
        let pictureDraft = dirty && hasSource ? draft : nil
        let limit = Self.readLimit
        Task { @MainActor [weak self] in
            let decode = Task { await MarkdownHoverImage.picture(url: url, pixels: pixels, draft: pictureDraft) }
            let (content, bytes) = await Task.detached(priority: .userInitiated) { () -> (MarkdownHoverContent, Int64?) in
                let source = hasSource ? (draft ?? Self.readText(url, limit: limit)) : nil
                return (Self.content(url: url, text: source ?? ""), MediaFileIdentity.current(url.path)?.size)
            }.value
            let early = await MediaThumbnailCache.firstResult(of: decode, within: Self.pictureWait)
            guard let self, self.token == token else { return }
            let state = MarkdownHoverCardState(picture: early ?? .loading, bytes: bytes, hasSource: hasSource) {
                await MarkdownHoverImage.picture(url: url, pixels: pixels, draft: pictureDraft, reload: true)
            }
            self.show(request, content: content, state: state, token: token)
            guard early == nil else { return }
            // The wait gave up on the first ask; this one joins its decode, or finds the picture cached.
            let late = await MarkdownHoverImage.picture(url: url, pixels: pixels, draft: pictureDraft)
            guard self.state === state, case .loading? = state.picture else { return }
            state.picture = late
        }
    }

    /// What the card renders: a note as it is, any other readable file as the viewer shows it.
    nonisolated static func content(url: URL, text: String) -> MarkdownHoverContent {
        let presentation = DocumentPreview.presentation(for: url)
        let native = presentation == .markdown
        return MarkdownHoverContent(
            url: url,
            markdown: native ? text : DocumentPreview.markdown(for: url, text: text),
            lineNumbers: !native && presentation != .table
        )
    }

    /// The first `limit` bytes of `url` as text; nil when it cannot be read.
    nonisolated static func readText(_ url: URL, limit: Int) -> String? {
        guard let handle = try? FileHandle(forReadingFrom: url) else { return nil }
        defer { try? handle.close() }
        guard let data = try? handle.read(upToCount: limit) else { return nil }
        return String(decoding: data, as: UTF8.self)
    }

    private func show(_ request: Request, content: MarkdownHoverContent, state: MarkdownHoverCardState? = nil, token: Int) {
        guard allowed(request), let model = request.model, let anchor = request.anchor(),
              let visible = MarkdownHoverPlacement.visibleFrame(for: anchor),
              let frame = MarkdownHoverPlacement.frame(size: model.configuration.hoverPreviewSize, anchor: anchor, visible: visible)
        else { return }
        let theme = model.theme
        let state = state ?? MarkdownHoverCardState()
        let card = MarkdownHoverCard(
            content: content,
            theme: theme,
            renderer: model.renderer,
            zoom: model.zoom,
            vaultRoot: GenesisKit.host?.markdownVaultRoot,
            proxy: proxy,
            state: state
        )
        let panel = panel ?? makePanel()
        panel.appearance = NSAppearance(named: theme.isDark ? .darkAqua : .aqua)
        let changed = !panel.isVisible || shown?.url != content.url
        self.state = state
        shownContent = content
        if let hosting {
            hosting.rootView = card
        } else {
            let hosting = NSHostingView(rootView: card)
            hosting.frame = panel.container.bounds
            hosting.autoresizingMask = [.width, .height]
            panel.container.addSubview(hosting)
            self.hosting = hosting
        }
        // A hidden panel takes its size now, so the page lays out at the width it will show at. A visible
        // one keeps its frame until the new note is in, then moves once.
        if !panel.isVisible { panel.setContentSize(frame.size) }
        // Runs the card's update now: the web view queues the new note's render script here.
        hosting?.layoutSubtreeIfNeeded()
        let finish = { [weak self] in
            guard let self, self.token == token else { return }
            self.reveal(panel, at: frame, request: request)
        }
        guard model.renderer == .web, changed, let web = proxy.web else {
            finish()
            return
        }
        // Scripts run in order, so this one completes after the render: the panel appears (or moves) on
        // the new note, at its top, and never shows the previous note there for a frame.
        web.evaluateJavaScript("window.gnScrollTo&&window.gnScrollTo(0)") { _, _ in finish() }
    }

    private func reveal(_ panel: MarkdownHoverPanel, at frame: CGRect, request: Request) {
        let appearing = !panel.isVisible
        panel.setFrame(frame, display: true)
        shown = request
        if appearing {
            let still = NSWorkspace.shared.accessibilityDisplayShouldReduceMotion
            panel.alphaValue = still ? 1 : 0
            panel.orderFront(nil)
            if !still {
                NSAnimationContext.runAnimationGroup { context in
                    context.duration = 0.12
                    panel.animator().alphaValue = 1
                }
            }
        }
        panel.invalidateShadow()
        // Leaving the anchor bumps the token, so a load that finished after the pointer left never got
        // here: whatever is shown here has its anchor under the pointer.
        if resignObserver == nil {
            resignObserver = NotificationCenter.default.addObserver(
                forName: NSApplication.didResignActiveNotification, object: nil, queue: .main
            ) { _ in
                MainActor.assumeIsolated { MarkdownHoverPreviewController.shared.hide() }
            }
        }
        if clickMonitor == nil {
            clickMonitor = NSEvent.addLocalMonitorForEvents(matching: [.leftMouseDown, .rightMouseDown, .otherMouseDown]) { event in
                MainActor.assumeIsolated {
                    let controller = MarkdownHoverPreviewController.shared
                    if event.window !== controller.panel { controller.hide() }
                }
                return event
            }
        }
        if keyMonitor == nil {
            keyMonitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { event in
                // Esc (53) with no modifier: the preview goes and the key is used up; anything else passes.
                guard event.keyCode == 53,
                      event.modifierFlags.intersection(.deviceIndependentFlagsMask).subtracting(.capsLock).isEmpty else {
                    return event
                }
                let closed = MainActor.assumeIsolated {
                    let controller = MarkdownHoverPreviewController.shared
                    guard controller.isShowing else { return false }
                    controller.hide()
                    return true
                }
                return closed ? nil : event
            }
        }
    }

    private func makePanel() -> MarkdownHoverPanel {
        let panel = MarkdownHoverPanel(
            contentRect: CGRect(origin: .zero, size: CGSize(width: 560, height: 440)),
            styleMask: [.borderless, .nonactivatingPanel],
            backing: .buffered,
            defer: true
        )
        panel.isFloatingPanel = true
        panel.level = .floating
        panel.backgroundColor = .clear
        panel.isOpaque = false
        panel.hasShadow = true
        panel.hidesOnDeactivate = false
        panel.isReleasedWhenClosed = false
        panel.collectionBehavior = [.transient, .ignoresCycle, .fullScreenAuxiliary]
        panel.onClick = { [weak self] in self?.openShown() }
        panel.container.onPointer = { [weak self] inside in self?.pointer(inPanel: inside) }
        self.panel = panel
        return panel
    }
}

/// What a preview card renders.
struct MarkdownHoverContent: Equatable, Sendable {
    var url: URL
    var markdown: String
    /// A code, json or text file is one numbered block, as in its tab.
    var lineNumbers: Bool
}

/// The floating panel. It never becomes key, so the window keeps the keyboard. A click anywhere in it
/// opens the note, except on a control the card marks (the source switch, Retry), which gets the click;
/// the scroll wheel reaches the page, so the reader can scroll the preview.
final class MarkdownHoverPanel: NSPanel {
    var onClick: (() -> Void)?
    let container = MarkdownHoverContainer()
    /// A press that began on a control: its drag and release go to the control too.
    private var pressingControl = false

    override init(contentRect: NSRect, styleMask style: NSWindow.StyleMask, backing backingStoreType: NSWindow.BackingStoreType, defer flag: Bool) {
        super.init(contentRect: contentRect, styleMask: style, backing: backingStoreType, defer: flag)
        container.frame = CGRect(origin: .zero, size: contentRect.size)
        container.autoresizingMask = [.width, .height]
        contentView = container
    }

    override var canBecomeKey: Bool { false }
    override var canBecomeMain: Bool { false }

    override func sendEvent(_ event: NSEvent) {
        switch event.type {
        case .leftMouseDown:
            if container.control(at: event.locationInWindow) {
                pressingControl = true
                super.sendEvent(event)
            } else {
                pressingControl = false
                onClick?()
            }
        case .leftMouseUp, .leftMouseDragged:
            guard pressingControl else { break }
            if event.type == .leftMouseUp { pressingControl = false }
            super.sendEvent(event)
        case .rightMouseDown, .rightMouseUp, .otherMouseDown, .otherMouseUp:
            // Read-only: no selection, no link, no context menu inside the preview.
            break
        default:
            super.sendEvent(event)
        }
    }
}

/// The panel's content view: reports the pointer entering and leaving the whole panel.
final class MarkdownHoverContainer: NSView {
    var onPointer: ((Bool) -> Void)?
    private var tracking: NSTrackingArea?

    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        if let tracking { removeTrackingArea(tracking) }
        let area = NSTrackingArea(rect: bounds, options: [.mouseEnteredAndExited, .activeAlways, .inVisibleRect], owner: self, userInfo: nil)
        addTrackingArea(area)
        tracking = area
    }

    override func mouseEntered(with event: NSEvent) { onPointer?(true) }
    override func mouseExited(with event: NSEvent) { onPointer?(false) }

    /// Whether a control the card marks (`MarkdownHoverMarker`) is under `point`, in window coordinates.
    func control(at point: NSPoint) -> Bool {
        MarkdownHoverMarker.rects(.control, in: self).contains { $0.contains(point) }
    }
}

/// The preview itself: which file, then the note, read-only, in the window's renderer and palette; an
/// image file's picture over it.
struct MarkdownHoverCard: View {
    let content: MarkdownHoverContent
    let theme: MarkdownTheme
    let renderer: MarkdownRenderer
    let zoom: Double
    let vaultRoot: String?
    let proxy: MarkdownWebProxy
    /// An image file's picture and the switch to its source; a note's state holds neither.
    @ObservedObject var state: MarkdownHoverCardState

    static let cornerRadius: CGFloat = 10

    var body: some View {
        VStack(spacing: 0) {
            header
            Rectangle().fill(theme.border).frame(height: 1)
            ZStack {
                // The page stays in place under a picture: the card's one web view is never torn down (making
                // another costs 140 ms to 1.2 s on the main thread), and an SVG's source is rendered there already.
                page
                    .opacity(state.showsPage ? 1 : 0)
                    .allowsHitTesting(state.showsPage)
                    .accessibilityHidden(!state.showsPage)
                if let picture = state.picture, !state.showsSource {
                    MarkdownHoverPicturePane(url: content.url, picture: picture, bytes: state.bytes, theme: theme) {
                        state.retry()
                    }
                }
            }
        }
        .background(theme.page)
        .clipShape(RoundedRectangle(cornerRadius: Self.cornerRadius, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: Self.cornerRadius, style: .continuous)
                .strokeBorder(theme.borderStrong, lineWidth: 1)
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Preview of \(MarkdownDocument.title(for: content.url))")
        .accessibilityIdentifier("markdown-hover-preview")
    }

    private var header: some View {
        HStack(spacing: 6) {
            Image(systemName: icon)
                .font(.system(size: 10, weight: .semibold))
                .foregroundStyle(theme.textSecondary)
            Text(MarkdownDocument.title(for: content.url))
                .font(.system(size: 12, weight: .semibold))
                .foregroundStyle(theme.text)
                .lineLimit(1)
            Text((content.url.deletingLastPathComponent().path as NSString).abbreviatingWithTildeInPath)
                .font(GenTypography.mono(11))
                .foregroundStyle(theme.textMuted)
                .lineLimit(1)
                .truncationMode(.head)
            Spacer(minLength: 8)
            if state.hasSource, state.picture != nil {
                MarkdownHoverSourceToggle(showsSource: state.showsSource, theme: theme) { state.toggleSource() }
            }
            // A text file opens as a tab; a picture that is no text file opens in the image viewer.
            Text(FileTree.isReadable(content.url) ? "Click to open" : "Click to view")
                .font(.system(size: 11))
                .foregroundStyle(theme.textMuted)
                .fixedSize()
        }
        .padding(.horizontal, 12)
        .frame(height: 30)
        .background(theme.chrome)
    }

    private var icon: String {
        if state.picture != nil { return "photo" }
        return DocumentPreview.presentation(for: content.url) == .markdown ? "doc.text" : "doc.plaintext"
    }

    @ViewBuilder
    private var page: some View {
        if renderer == .web {
            MarkdownWebView(
                markdown: content.markdown,
                highlightToken: 0,
                onWikilink: { _ in },
                onActiveSection: { _ in },
                zoom: zoom,
                proxy: proxy,
                cssVariables: theme.cssVariables,
                columnResizable: false,
                lineNumbers: content.lineNumbers,
                documentURL: content.url,
                vaultRoot: vaultRoot
            )
        } else {
            MarkdownPreviewView(
                markdown: content.markdown,
                scrollTarget: nil,
                onWikilink: { _ in },
                highlightQuery: nil,
                highlightToken: 0,
                rich: renderer == .nativeRich,
                zoom: zoom,
                theme: theme
            )
            .id(content.url)
        }
    }
}

// MARK: - The anchor side

private struct MarkdownHoverPreviewModifier: ViewModifier {
    let url: URL?
    let model: MarkdownDocumentsModel
    /// The sensor (an NSView) exists only while the pointer is over the anchor: every platform view is
    /// a responder SwiftUI walks on an accessibility update, and a tree has hundreds of rows.
    @State private var hovering = false

    func body(content: Content) -> some View {
        content
            .onHover { inside in
                if hovering != inside { hovering = inside }
            }
            .overlay {
                if hovering, let url, model.configuration.hoverPreview {
                    MarkdownHoverSensor(url: url, model: model)
                }
            }
    }
}

/// Over the anchor while the pointer is on it. Arriving is entering, leaving is exiting; it takes no
/// clicks. It also tells the controller where the anchor is on screen when the preview opens.
private struct MarkdownHoverSensor: NSViewRepresentable {
    let url: URL
    let model: MarkdownDocumentsModel

    func makeNSView(context: Context) -> SensorView {
        let view = SensorView()
        view.url = url
        view.model = model
        return view
    }

    func updateNSView(_ view: SensorView, context: Context) {
        view.update(url: url, model: model)
    }

    final class SensorView: NSView {
        let owner = UUID()
        var url: URL?
        weak var model: MarkdownDocumentsModel?

        override func hitTest(_ point: NSPoint) -> NSView? { nil }

        override func viewDidMoveToWindow() {
            super.viewDidMoveToWindow()
            if window != nil { entered() }
        }

        override func viewWillMove(toWindow newWindow: NSWindow?) {
            super.viewWillMove(toWindow: newWindow)
            if newWindow == nil, window != nil {
                MarkdownHoverPreviewController.shared.exit(owner: owner)
            }
        }

        func update(url: URL, model: MarkdownDocumentsModel) {
            self.model = model
            guard url != self.url else { return }
            self.url = url
            if window != nil { entered() }
        }

        private func entered() {
            guard let url, let model else { return }
            MarkdownHoverPreviewController.shared.enter(owner: owner, url: url, model: model, view: self) { [weak self] in
                self?.screenRect
            }
        }

        private var screenRect: CGRect? {
            guard let window, superview != nil, !visibleRect.isEmpty else { return nil }
            return window.convertToScreen(convert(bounds, to: nil))
        }

        deinit {
            let owner = owner
            if Thread.isMainThread {
                MainActor.assumeIsolated { MarkdownHoverPreviewController.shared.exit(owner: owner) }
            } else {
                Task { @MainActor in MarkdownHoverPreviewController.shared.exit(owner: owner) }
            }
        }
    }
}
