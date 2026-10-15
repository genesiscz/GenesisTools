//
//  MarkdownDocumentWindow.swift
//  GenesisKit
//
//  `genesis open <file.md> [more.md]` → one standalone window that renders the
//  files with the Obsidian-parity MarkdownWebView (tabs when several), reloads
//  when a file changes on disk, and opens relative links (`<./x.pdf>`) with the
//  default app. Pattern 7 (NSWindowController + NSHostingView), one shared
//  window: passing the same path again re-selects its tab instead of opening a
//  second window. Reached through `genesis://open?path=<encoded>&path=…&focus=0|1`.
//

import AppKit
import Combine
import SwiftUI
import UniformTypeIdentifiers

/// The one markdown window (Pattern 7). `show` adds tabs to it; it never opens a second one.
@MainActor
public final class MarkdownDocumentWindowController: NSWindowController, NSWindowDelegate {
    public static let shared = MarkdownDocumentWindowController()

    /// The reading column starts at 860 pt (draggable wider) and the outline
    /// takes 220 pt, so anything narrower scrolls sideways on a report with tables.
    static let defaultSize = CGSize(width: 1280, height: 880)

    /// The default, shrunk to whatever the screen can actually show.
    static func firstSize(in visible: CGRect) -> CGSize {
        CGSize(
            width: min(defaultSize.width, visible.width - 80),
            height: min(defaultSize.height, visible.height - 80)
        )
    }

    let model = MarkdownDocumentsModel()
    private var titleSink: AnyCancellable?
    private var floatSink: AnyCancellable?
    private var themeSink: AnyCancellable?

    private init() {
        let window = MarkdownDocumentWindow(
            contentRect: NSRect(x: 0, y: 0, width: Self.defaultSize.width, height: Self.defaultSize.height),
            styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
            backing: .buffered,
            defer: false
        )
        window.minSize = NSSize(width: 560, height: 400)
        window.title = "Markdown"
        // The breadcrumb (`MarkdownPathBar`) stands where the title text was. The title itself stays
        // set, with `representedURL`, for the Window menu, Mission Control and VoiceOver.
        window.titleVisibility = .hidden
        window.titlebarAppearsTransparent = true
        window.isMovableByWindowBackground = true
        window.backgroundColor = NSColor(MarkdownTheme.genesis.page)
        window.isReleasedWhenClosed = false
        window.setFrameAutosaveName("genesis.markdown-window.v2")
        window.contentView = NSHostingView(rootView: Self.root(model: model))
        window.documents = model
        super.init(window: window)
        window.delegate = self
        themeSink = model.$themeRaw
            .receive(on: DispatchQueue.main)
            .sink { [weak self] raw in
                let theme = MarkdownTheme(rawValue: raw) ?? .genesis
                self?.window?.backgroundColor = NSColor(theme.page)
                self?.window?.appearance = NSAppearance(named: theme.isDark ? .darkAqua : .aqua)
            }
        floatSink = model.$floating
            .receive(on: DispatchQueue.main)
            .sink { [weak self] on in
                self?.window?.level = on ? .floating : .normal
            }
        titleSink = model.$selectedId
            .receive(on: DispatchQueue.main)
            .sink { [weak self] _ in
                guard let self else { return }
                let doc = self.model.selected
                self.window?.title = doc?.title ?? "Markdown"
                self.window?.representedURL = doc?.url
            }
    }

    public required init?(coder: NSCoder) { fatalError("not supported") }

    /// The window's root. The title bar and the toolbar under it are one strip (Window/WindowTitlebar.swift):
    /// its empty part zooms (to the visible screen, see `windowWillUseStandardFrame`) on a double-click,
    /// drags the window, and opens a dropped file the way the rest of the window does. The open file's
    /// path is a row of controls in the title bar itself (`.titlebarRow()`), right of the traffic lights.
    static func root(model: MarkdownDocumentsModel) -> some View {
        VStack(spacing: 0) {
            MarkdownPathBar(model: model)
                .titlebarRow()
            MarkdownDocumentsView(model: model)
        }
        .titlebarZone(below: MarkdownDocumentToolbar.height) { urls in
            model.acceptDrop(urls)
            return true
        }
    }

    /// ⌘W: the selected tab goes, not the window. A dirty tab asks first
    /// (save / don't save / cancel); when the last tab closes the window
    /// follows, the way a browser's does.
    @objc public func closeSelectedTab(_ sender: Any?) {
        closeSelectedTabOrWindow()
    }

    /// Returns false when the reader cancelled the unsaved-changes prompt.
    @discardableResult
    func closeSelectedTabOrWindow() -> Bool {
        guard let doc = model.selected else {
            window?.performClose(nil)
            return true
        }
        guard model.close(doc) else { return false }
        if model.docs.isEmpty {
            window?.performClose(nil)
        }
        return true
    }

    @objc public func saveSelected(_ sender: Any?) {
        model.saveSelected()
    }

    /// File → Go to Location… (⇧⌘G).
    @objc public func goToLocation(_ sender: Any?) {
        show(paths: [], focus: true)
        model.goToOpen = true
    }

    /// Green-button zoom / title-bar double-click fill the visible screen,
    /// then restore. Without this, AppKit fits the WKWebView and the window
    /// barely moves.
    public func windowWillUseStandardFrame(_ window: NSWindow, defaultFrame newFrame: NSRect) -> NSRect {
        guard let visible = window.screen?.visibleFrame else {
            return newFrame
        }

        return visible
    }

    /// Closing the window with unsaved tabs asks per tab, like closing them,
    /// but keeps the tabs: the window reopens the way it was closed.
    public func windowShouldClose(_ sender: NSWindow) -> Bool {
        model.flushScroll()
        return model.resolveUnsavedForClose()
    }

    /// Opens (or re-selects) the given files. `focus` brings the app and window forward.
    /// No paths = show the viewer as it was last closed (tabs are remembered).
    /// `range` belongs to the last path, the tab that ends up selected.
    public func show(paths: [String], focus: Bool, range: MarkdownLineRange? = nil, diff: MarkdownDiffRequest? = nil) {
        let urls = paths.map { URL(fileURLWithPath: ($0 as NSString).expandingTildeInPath) }
        model.open(urls)
        if let range, !urls.isEmpty { model.reveal(range) }
        if let diff, !urls.isEmpty { model.showChanges(diff) }
        guard let window else { return }
        if !window.isVisible, window.frameAutosaveName.isEmpty || !window.setFrameUsingName(window.frameAutosaveName) {
            let mouse = NSEvent.mouseLocation
            let screen = NSScreen.screens.first { NSMouseInRect(mouse, $0.frame, false) } ?? NSScreen.main
            if let visible = screen?.visibleFrame {
                var frame = window.frame
                frame.size = Self.firstSize(in: visible)
                frame.origin.x = visible.midX - frame.width / 2
                frame.origin.y = visible.midY - frame.height / 2
                window.setFrame(frame, display: false)
            } else {
                window.center()
            }
        }
        if focus {
            WindowRaise.raise(window)
        } else {
            window.orderFront(nil)
        }
    }
}

/// What a link to a code file (or any file that is not a note) offers, built by
/// `MarkdownDocumentsModel.fileLinkMenu`. A plain value, so a test reads the titles and runs a pick.
struct MarkdownFileLinkMenu {
    struct Item {
        let title: String
        let run: () -> Void
    }

    let file: URL
    let items: [Item]

    var titles: [String] { items.map(\.title) }

    /// The menu at the pointer, as the folder link's menu does.
    func popUp() {
        let menu = NSMenu()
        menu.autoenablesItems = false
        for item in items {
            menu.addItem(ClosureMenuItem(item.title, item.run))
        }
        let picked = menu.popUp(positioning: nil, at: NSEvent.mouseLocation, in: nil)
        GenesisKit.log("markdown: file link \(file.path), menu \(titles), picked=\(picked)")
    }
}

