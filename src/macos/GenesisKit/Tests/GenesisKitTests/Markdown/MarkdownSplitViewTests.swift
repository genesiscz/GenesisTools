import SwiftUI
import WebKit
import XCTest
@testable import GenesisKit

/// Split view: the editor and the rendered document side by side. The divider
/// geometry, the mode toggles, and the one page behaviour split depends on —
/// a re-render must not throw the reader back to the top of the document.
@MainActor
final class MarkdownSplitViewTests: XCTestCase {
    private func model() -> MarkdownDocumentsModel {
        MarkdownDocumentsModel(defaults: UserDefaults(suiteName: "md-split-\(UUID().uuidString)")!)
    }

    func testModeTogglesAndTheirShortcutsMeanings() {
        let m = model()
        XCTAssertEqual(m.mode, .preview)

        m.toggleSource()
        XCTAssertEqual(m.mode, .source)
        m.toggleSource()
        XCTAssertEqual(m.mode, .preview)

        m.toggleSplit()
        XCTAssertEqual(m.mode, .split)
        // ⌘E out of split lands on the reading view: split already shows the source.
        m.toggleSource()
        XCTAssertEqual(m.mode, .preview)

        m.toggleSplit()
        m.toggleSplit()
        XCTAssertEqual(m.mode, .preview)
    }

    func testEditorAndPreviewAreShownPerMode() {
        XCTAssertEqual(MarkdownViewMode.preview.showsEditor, false)
        XCTAssertEqual(MarkdownViewMode.preview.showsPreview, true)
        XCTAssertEqual(MarkdownViewMode.split.showsEditor, true)
        XCTAssertEqual(MarkdownViewMode.split.showsPreview, true)
        XCTAssertEqual(MarkdownViewMode.source.showsEditor, true)
        XCTAssertEqual(MarkdownViewMode.source.showsPreview, false)

        // The find bar works in every mode: it marks matches in the page when
        // only the page is showing, and searches the source when the editor is.
        let m = model()
        // The renderer is a window-wide preference in the standard defaults,
        // so this test puts it back the way it found it.
        let renderer = m.rendererRaw
        defer { m.rendererRaw = renderer }
        m.rendererRaw = MarkdownRenderer.web.rawValue

        m.setMode(.split)
        XCTAssertTrue(m.supportsFind)
        XCTAssertTrue(m.findsInSource)
        m.setMode(.source)
        XCTAssertTrue(m.supportsFind)
        m.setMode(.preview)
        XCTAssertFalse(m.findsInSource)
        XCTAssertTrue(m.supportsFind)
        // Only the web renderer can mark matches in the rendered page.
        m.rendererRaw = MarkdownRenderer.nativeRich.rawValue
        XCTAssertFalse(m.supportsFind)
        // The editor searches itself whatever the renderer is.
        m.setMode(.source)
        XCTAssertTrue(m.supportsFind)
    }

    func testModeAndDividerSurviveAReopen() {
        let defaults = UserDefaults(suiteName: "md-split-\(UUID().uuidString)")!
        let first = MarkdownDocumentsModel(defaults: defaults)
        first.setMode(.split)
        first.splitRatio = 0.62

        let second = MarkdownDocumentsModel(defaults: defaults)
        XCTAssertEqual(second.mode, .split)
        XCTAssertEqual(second.splitRatio, 0.62, accuracy: 0.001)
    }

    func testDividerKeepsBothPanesUsable() {
        // A 1200 pt pane: the ratio decides, both sides stay above the minimum.
        XCTAssertEqual(MarkdownSplit.editorWidth(total: 1200, ratio: 0.5), 600, accuracy: 0.5)
        XCTAssertEqual(MarkdownSplit.editorWidth(total: 1200, ratio: 0.02), MarkdownSplit.minPane, accuracy: 0.5)
        XCTAssertEqual(MarkdownSplit.editorWidth(total: 1200, ratio: 0.99), 1200 - MarkdownSplit.minPane, accuracy: 0.5)
        // Dragged past either end, the divider parks instead of collapsing a pane.
        XCTAssertEqual(MarkdownSplit.ratio(x: -400, total: 1200), MarkdownSplit.minPane / 1200, accuracy: 0.001)
        XCTAssertEqual(MarkdownSplit.ratio(x: 9000, total: 1200), (1200 - MarkdownSplit.minPane) / 1200, accuracy: 0.001)
        XCTAssertEqual(MarkdownSplit.ratio(x: 300, total: 1200), 0.25, accuracy: 0.001)
        // Too narrow for two panes: an even split rather than a broken one.
        XCTAssertEqual(MarkdownSplit.editorWidth(total: 400, ratio: 0.9), 200, accuracy: 0.5)
        XCTAssertEqual(MarkdownSplit.ratio(x: 10, total: 400), MarkdownSplit.defaultRatio, accuracy: 0.001)
    }

    func testTypingKeepsThePreviewWhereTheReaderLeftIt() async throws {
        let bridge = Loader()
        let config = WKWebViewConfiguration()
        config.setURLSchemeHandler(MarkdownWebView.AssetSchemeHandler(), forURLScheme: MarkdownWebView.assetScheme)
        let web = WKWebView(frame: NSRect(x: 0, y: 0, width: 1000, height: 700), configuration: config)
        web.navigationDelegate = bridge
        let window = NSWindow(contentRect: web.frame, styleMask: [.borderless], backing: .buffered, defer: false)
        window.contentView = web
        defer { window.contentView = nil }
        let loaded = expectation(description: "page loaded")
        bridge.loaded = loaded
        web.loadHTMLString(MarkdownWebView.template, baseURL: URL(string: "\(MarkdownWebView.assetScheme)://asset/"))
        await fulfillment(of: [loaded], timeout: 10)

        let long = (1...120).map { "Paragraph \($0) of a long note.\n" }.joined(separator: "\n")
        _ = try await web.evaluateJavaScript("window.gnRender(\(MarkdownWebView.jsString(long)))")
        _ = try await web.evaluateJavaScript("(document.scrollingElement||document.documentElement).scrollTop=1200")
        let before = try await web.evaluateJavaScript("(document.scrollingElement||document.documentElement).scrollTop") as? Double
        XCTAssertEqual(before ?? 0, 1200, accuracy: 2)

        // The next keystroke re-renders the whole document.
        _ = try await web.evaluateJavaScript("window.gnRender(\(MarkdownWebView.jsString(long + "\none more word\n")))")
        let after = try await web.evaluateJavaScript("(document.scrollingElement||document.documentElement).scrollTop") as? Double
        XCTAssertEqual(after ?? 0, 1200, accuracy: 2)
    }

    func testSplitViewHidesTheColumnGripsSoTheDividerIsTheOnlyBoundary() async throws {
        let bridge = Loader()
        let config = WKWebViewConfiguration()
        config.setURLSchemeHandler(MarkdownWebView.AssetSchemeHandler(), forURLScheme: MarkdownWebView.assetScheme)
        let web = WKWebView(frame: NSRect(x: 0, y: 0, width: 1400, height: 700), configuration: config)
        web.navigationDelegate = bridge
        let window = NSWindow(contentRect: web.frame, styleMask: [.borderless], backing: .buffered, defer: false)
        window.contentView = web
        defer { window.contentView = nil }
        let loaded = expectation(description: "page loaded")
        bridge.loaded = loaded
        web.loadHTMLString(MarkdownWebView.template, baseURL: URL(string: "\(MarkdownWebView.assetScheme)://asset/"))
        await fulfillment(of: [loaded], timeout: 10)
        _ = try await web.evaluateJavaScript("window.gnRender('# Title\\n\\nbody')")

        // Reading view: the grips are there and the column keeps its width.
        let gripsShown = try await web.evaluateJavaScript(
            "getComputedStyle(document.querySelector('.gn-grip')).display") as? String
        XCTAssertEqual(gripsShown, "block")
        let reading = try await web.evaluateJavaScript(
            "document.getElementById('gn-column').getBoundingClientRect().width") as? Double
        XCTAssertEqual(reading ?? 0, 860, accuracy: 1)

        // Split view: no grips, and the page fills the pane the divider left it.
        _ = try await web.evaluateJavaScript("window.gnGrips(false)")
        let gripsHidden = try await web.evaluateJavaScript(
            "getComputedStyle(document.querySelector('.gn-grip')).display") as? String
        XCTAssertEqual(gripsHidden, "none")
        let split = try await web.evaluateJavaScript(
            "document.getElementById('gn-column').getBoundingClientRect().width") as? Double
        XCTAssertEqual(split ?? 0, 1400 - 60, accuracy: 2)

        _ = try await web.evaluateJavaScript("window.gnGrips(true)")
        let back = try await web.evaluateJavaScript(
            "document.getElementById('gn-column').getBoundingClientRect().width") as? Double
        XCTAssertEqual(back ?? 0, 860, accuracy: 1)
    }

    /// The divider is an AppKit view for two reasons that only show up live:
    /// a hairline cannot be grabbed, and a view that does not claim its
    /// mouse-down drags the whole window (the window is movable by background).
    func testTheDividerIsAGrabStripThatDoesNotDragTheWindow() throws {
        var began = 0
        var moved: [Double] = []
        let divider = MarkdownSplitDivider(
            line: .separatorColor,
            accent: .controlAccentColor,
            onBegin: { began += 1 },
            onDrag: { moved.append($0) },
            onEnd: {},
            onReset: {}
        )
        let host = NSHostingView(rootView: AnyView(divider.frame(width: MarkdownSplit.dividerWidth, height: 400)))
        host.frame = NSRect(x: 0, y: 0, width: MarkdownSplit.dividerWidth, height: 400)
        host.layoutSubtreeIfNeeded()

        func find(_ view: NSView) -> MarkdownSplitDivider.DividerView? {
            if let d = view as? MarkdownSplitDivider.DividerView { return d }
            for sub in view.subviews {
                if let d = find(sub) { return d }
            }
            return nil
        }
        let view = try XCTUnwrap(find(host))
        XCTAssertFalse(view.mouseDownCanMoveWindow)
        XCTAssertEqual(view.bounds.width, MarkdownSplit.dividerWidth, accuracy: 0.5)
        // Off-screen in a test, so ask for the tracking area the window would.
        view.updateTrackingAreas()
        let options = try XCTUnwrap(view.trackingAreas.first?.options)
        XCTAssertTrue(options.contains(.cursorUpdate))
        XCTAssertTrue(options.contains(.mouseEnteredAndExited))

        // A drag reports the distance from the mouse-down, so the pointer stays
        // on the divider however far it travels.
        let start = NSEvent.mouseEvent(
            with: .leftMouseDown, location: NSPoint(x: 100, y: 50), modifierFlags: [], timestamp: 0,
            windowNumber: 0, context: nil, eventNumber: 1, clickCount: 1, pressure: 1
        )
        let drag = NSEvent.mouseEvent(
            with: .leftMouseDragged, location: NSPoint(x: 40, y: 50), modifierFlags: [], timestamp: 0,
            windowNumber: 0, context: nil, eventNumber: 2, clickCount: 1, pressure: 1
        )
        view.mouseDown(with: try XCTUnwrap(start))
        view.mouseDragged(with: try XCTUnwrap(drag))
        XCTAssertEqual(began, 1)
        XCTAssertEqual(moved, [-60])

        // And that delta lands where the pointer is: half of a 1200 pt pane,
        // dragged 60 pt left, is 540.
        let ratio = MarkdownSplit.ratio(x: 1200 * 0.5 + moved[0], total: 1200)
        XCTAssertEqual(MarkdownSplit.editorWidth(total: 1200, ratio: ratio), 540, accuracy: 0.5)
    }

    // MARK: review findings

    /// Typing and undoing inside one debounce window used to leave the pending
    /// render running, and the preview then showed text the document no longer had.
    func testUndoInsideTheDebounceWindowCancelsThePendingRender() async throws {
        let live = MarkdownLivePreview()
        live.reset("Hello")
        live.update("Hello World")
        try await Task.sleep(for: .milliseconds(90))
        live.update("Hello")                       // back to what is on screen
        try await Task.sleep(for: .milliseconds(400))
        XCTAssertEqual(live.text, "Hello")

        // A real edit still lands, a beat later.
        live.update("Hello again")
        XCTAssertEqual(live.text, "Hello")
        try await Task.sleep(for: .milliseconds(400))
        XCTAssertEqual(live.text, "Hello again")
    }

    /// A remembered 0.9 split in a 1000 pt pane is drawn clamped at 700. A
    /// drag has to start from there, or the first 200 pt of pointer travel
    /// move nothing.
    func testADragAfterTheWindowNarrowedStartsFromTheDrawnDivider() {
        XCTAssertEqual(MarkdownSplit.editorWidth(total: 1000, ratio: 0.9), 700, accuracy: 0.5)
        let ratio = MarkdownSplit.ratio(afterMoving: -30, from: 0.9, total: 1000)
        XCTAssertEqual(MarkdownSplit.editorWidth(total: 1000, ratio: ratio), 670, accuracy: 0.5)
    }

    /// The divider is a VoiceOver splitter and moves from the keyboard.
    func testTheDividerIsAnAdjustableSplitterForTheKeyboardAndVoiceOver() throws {
        var steps: [Int] = []
        var resets = 0
        let view = MarkdownSplitDivider.DividerView()
        view.onStep = { steps.append($0) }
        view.onReset = { resets += 1 }
        view.ratio = 0.5

        XCTAssertTrue(view.isAccessibilityElement())
        XCTAssertEqual(view.accessibilityRole(), .splitter)
        XCTAssertEqual(view.accessibilityValue() as? String, "Editor 50 percent")
        XCTAssertTrue(view.accessibilityPerformIncrement())
        XCTAssertTrue(view.accessibilityPerformDecrement())
        let navigation = MarkdownSplitDivider.DividerView.keyboardNavigation
        defer { MarkdownSplitDivider.DividerView.keyboardNavigation = navigation }
        MarkdownSplitDivider.DividerView.keyboardNavigation = { true }
        XCTAssertTrue(view.acceptsFirstResponder)
        XCTAssertTrue(view.canBecomeKeyView)
        XCTAssertEqual(view.focusRingType, .none, "focus lights the line instead of ringing the strip")
        // Keyboard navigation off: the divider never takes focus, so a tab switch cannot hand it the window's focus.
        MarkdownSplitDivider.DividerView.keyboardNavigation = { false }
        XCTAssertFalse(view.acceptsFirstResponder)
        XCTAssertFalse(view.canBecomeKeyView)
        MarkdownSplitDivider.DividerView.keyboardNavigation = { true }

        func key(_ code: UInt16) throws -> NSEvent {
            try XCTUnwrap(NSEvent.keyEvent(
                with: .keyDown, location: .zero, modifierFlags: [], timestamp: 0, windowNumber: 0,
                context: nil, characters: "", charactersIgnoringModifiers: "", isARepeat: false, keyCode: code
            ))
        }
        view.keyDown(with: try key(124))
        view.keyDown(with: try key(123))
        view.keyDown(with: try key(36))
        XCTAssertEqual(steps, [1, -1, 1, -1])
        XCTAssertEqual(resets, 1)
    }

    /// PR #82 review: a click to drag the divider must not take first
    /// responder from the editor, or the next keystrokes land on the divider
    /// and are lost. Focus that does not come from a click (Tab) still does.
    func testAClickOnTheDividerDoesNotTakeFocus() throws {
        // AppKit's click-to-focus step asks the clicked view's
        // `acceptsFirstResponder` while the mouse-down is the current event. A
        // test process is never the active app, so a posted click never gets
        // that far; the window's current event is set by hand instead.
        final class EventWindow: NSWindow {
            var event: NSEvent?
            override var currentEvent: NSEvent? { event }
        }
        let window = EventWindow(
            contentRect: NSRect(x: 0, y: 0, width: 400, height: 200),
            styleMask: [.titled], backing: .buffered, defer: false
        )
        window.isReleasedWhenClosed = false
        defer { window.close() }
        let divider = MarkdownSplitDivider.DividerView(frame: NSRect(x: 200, y: 0, width: 8, height: 200))
        window.contentView?.addSubview(divider)
        // With keyboard navigation on (the Tab step below needs it).
        let navigation = MarkdownSplitDivider.DividerView.keyboardNavigation
        defer { MarkdownSplitDivider.DividerView.keyboardNavigation = navigation }
        MarkdownSplitDivider.DividerView.keyboardNavigation = { true }

        window.event = NSEvent.mouseEvent(
            with: .leftMouseDown, location: NSPoint(x: 204, y: 100), modifierFlags: [], timestamp: 0,
            windowNumber: window.windowNumber, context: nil, eventNumber: 1, clickCount: 1, pressure: 1
        )
        XCTAssertFalse(divider.acceptsFirstResponder, "a click to drag leaves the editor focused")

        // Tab (keyboard navigation) still reaches it.
        window.event = NSEvent.keyEvent(
            with: .keyDown, location: .zero, modifierFlags: [], timestamp: 0, windowNumber: window.windowNumber,
            context: nil, characters: "\t", charactersIgnoringModifiers: "\t", isARepeat: false, keyCode: 48
        )
        XCTAssertTrue(divider.acceptsFirstResponder)
    }

    /// A pane too narrow for two panes shows an even split, but a drag inside
    /// it must not overwrite the remembered ratio with that forced 0.5.
    func testADragInATooNarrowPaneKeepsTheRememberedRatio() {
        XCTAssertTrue(MarkdownSplit.draggable(total: 1200))
        XCTAssertFalse(MarkdownSplit.draggable(total: 2 * MarkdownSplit.minPane))
        XCTAssertFalse(MarkdownSplit.draggable(total: 540))

        let m = model()
        m.splitRatio = 0.7
        // What the divider's onDrag does, with the same guard.
        let total = 540.0
        if MarkdownSplit.draggable(total: total) {
            m.splitRatio = MarkdownSplit.ratio(x: total * 0.7 + 30, total: total)
        }
        XCTAssertEqual(m.splitRatio, 0.7, accuracy: 0.001)
    }

    /// Entering split view mid-drag used to leave the grip's window listeners
    /// running, so the mouse-up still reported a width nobody could see.
    func testEnteringSplitViewMidDragAbandonsTheColumnDrag() async throws {
        let web = try await page(width: 1400)
        defer { hosts.removeAll() }
        _ = try await web.evaluateJavaScript("window.gnRender('# Title\\n\\nbody')")

        // Grab the left grip and drag it, then switch to split view mid-drag.
        _ = try await web.evaluateJavaScript(
            "(function(){var g=document.querySelector('.gn-grip-l');"
            + "g.dispatchEvent(new MouseEvent('mousedown',{bubbles:true,button:0,clientX:200}));"
            + "window.dispatchEvent(new MouseEvent('mousemove',{bubbles:true,clientX:100}));})()"
        )
        _ = try await web.evaluateJavaScript("window.gnGrips(false)")
        _ = try await web.evaluateJavaScript("window.dispatchEvent(new MouseEvent('mouseup',{bubbles:true}))")
        try await Task.sleep(nanoseconds: 200_000_000)

        XCTAssertTrue(loader.widths.isEmpty, "an abandoned drag reported a width: \(loader.widths)")
        let stuck = try await web.evaluateJavaScript(
            "document.body.classList.contains('gn-resizing')") as? Bool
        XCTAssertEqual(stuck, false)
        let inline = try await web.evaluateJavaScript(
            "document.documentElement.style.getPropertyValue('--gn-article-width')") as? String
        XCTAssertEqual(inline, "", "the abandoned drag left its width behind")
    }

    // MARK: page helper

    private let loader = Loader()
    private var hosts: [NSWindow] = []

    /// A loaded page in a real window, with the bridge wired for width posts.
    private func page(width: CGFloat) async throws -> WKWebView {
        let controller = WKUserContentController()
        controller.add(loader, name: "bridge")
        let config = WKWebViewConfiguration()
        config.userContentController = controller
        config.setURLSchemeHandler(MarkdownWebView.AssetSchemeHandler(), forURLScheme: MarkdownWebView.assetScheme)
        let web = WKWebView(frame: NSRect(x: 0, y: 0, width: width, height: 700), configuration: config)
        web.navigationDelegate = loader
        let window = NSWindow(contentRect: web.frame, styleMask: [.borderless], backing: .buffered, defer: false)
        window.contentView = web
        hosts.append(window)
        let loaded = expectation(description: "page loaded")
        loader.loaded = loaded
        web.loadHTMLString(MarkdownWebView.template, baseURL: URL(string: "\(MarkdownWebView.assetScheme)://asset/"))
        await fulfillment(of: [loaded], timeout: 10)
        return web
    }

    /// Scroll sync: the page stamps every block with the source line it came
    /// from, and `gnSyncLine` puts the block that owns a line at the top.
    func testTheEditorLineScrollsThePreviewToTheSameBlock() async throws {
        let bridge = Loader()
        let config = WKWebViewConfiguration()
        config.setURLSchemeHandler(MarkdownWebView.AssetSchemeHandler(), forURLScheme: MarkdownWebView.assetScheme)
        let web = WKWebView(frame: NSRect(x: 0, y: 0, width: 900, height: 600), configuration: config)
        web.navigationDelegate = bridge
        let window = NSWindow(contentRect: web.frame, styleMask: [.borderless], backing: .buffered, defer: false)
        window.contentView = web
        defer { window.contentView = nil }
        let loaded = expectation(description: "page loaded")
        bridge.loaded = loaded
        web.loadHTMLString(MarkdownWebView.template, baseURL: URL(string: "\(MarkdownWebView.assetScheme)://asset/"))
        await fulfillment(of: [loaded], timeout: 10)

        // 60 paragraphs, so paragraph N starts on body line 2N.
        let body = (0..<60).map { "Paragraph \($0)." }.joined(separator: "\n\n")
        _ = try await web.evaluateJavaScript("window.gnRender(\(MarkdownWebView.jsString(body)))")

        let lines = try await web.evaluateJavaScript(
            "Array.from(document.querySelectorAll('#gn-article p')).slice(0,3).map(function(e){return e.getAttribute('data-line')})"
        ) as? [String]
        XCTAssertEqual(lines, ["0", "2", "4"])

        _ = try await web.evaluateJavaScript("window.gnSyncLine(80)")
        let top = try await web.evaluateJavaScript(
            "document.querySelector('[data-line=\"80\"]').getBoundingClientRect().top") as? Double
        // The block that owns the line sits at the top of the page, give or
        // take the 12 px of breathing room the sync leaves.
        XCTAssertEqual(top ?? -999, 12, accuracy: 3)

        // Back to the start of the document.
        _ = try await web.evaluateJavaScript("window.gnSyncLine(0)")
        let scroll = try await web.evaluateJavaScript(
            "(document.scrollingElement||document.documentElement).scrollTop") as? Double
        XCTAssertEqual(scroll ?? -1, 0, accuracy: 1)
    }

    /// The whole chain in the real window: the editor scrolls, the pane turns its top line into a sync line, and the
    /// page puts that block at its top (Martin, 2026-10-26: "the scrolling no longer scrolls both").
    func testScrollingTheEditorInSplitViewScrollsThePreview() async throws {
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent("md-split-sync-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        let note = folder.appendingPathComponent("long.md")
        let body = (0 ..< 200).map { "Paragraph \($0) of a long note." }.joined(separator: "\n\n")
        try "---\ntitle: Long\n---\n\n# Long\n\n\(body)\n".write(to: note, atomically: true, encoding: .utf8)
        let model = model()
        model.configuration = GenesisKitMarkdownConfiguration(
            defaults: UserDefaults(suiteName: "md-split-sync-config-\(UUID().uuidString)")!)
        model.modeRaw = MarkdownViewMode.split.rawValue
        model.open([note])
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1400, height: 800),
                              styleMask: [.titled, .resizable, .fullSizeContentView], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.contentView = MarkdownDocumentWindowController.contentView(model: model)
        window.alphaValue = 0
        window.level = .init(rawValue: Int(CGWindowLevelForKey(.desktopWindow)) - 1)
        window.order(.below, relativeTo: 0)
        defer {
            window.orderOut(nil)
            window.close()
        }
        func first<T: NSView>(_ type: T.Type, in view: NSView) -> T? {
            if let hit = view as? T { return hit }
            for child in view.subviews { if let hit = first(type, in: child) { return hit } }
            return nil
        }
        var web: WKWebView?
        var editor: NSTextView?
        for _ in 0 ..< 60 where web == nil || editor == nil {
            try await Task.sleep(nanoseconds: 100_000_000)
            web = first(WKWebView.self, in: try XCTUnwrap(window.contentView))
            editor = first(NSTextView.self, in: try XCTUnwrap(window.contentView))
        }
        let page = try XCTUnwrap(web, "no page in split view")
        let text = try XCTUnwrap(editor?.enclosingScrollView, "no editor in split view")
        var blocks = 0
        for _ in 0 ..< 60 where blocks < 100 {
            try await Task.sleep(nanoseconds: 100_000_000)
            blocks = try await page.evaluateJavaScript("document.querySelectorAll('#gn-article p').length") as? Int ?? 0
        }
        XCTAssertGreaterThanOrEqual(blocks, 100, "the page never rendered the note")

        text.contentView.scroll(to: NSPoint(x: 0, y: 3000))
        text.reflectScrolledClipView(text.contentView)
        try await Task.sleep(nanoseconds: 500_000_000)
        let scrolled = try await page.evaluateJavaScript("(document.scrollingElement||document.documentElement).scrollTop")
            as? Double ?? 0
        XCTAssertGreaterThan(scrolled, 500, "the preview stayed at the top while the editor scrolled 3000 pt")

        // The paragraph at the top of each pane is the same one.
        let editorText = try XCTUnwrap(editor)
        var probe = text.contentView.bounds
        probe.origin.y = max(0, probe.origin.y - editorText.textContainerInset.height)
        probe.size.height = 1
        let layout = try XCTUnwrap(editorText.layoutManager), container = try XCTUnwrap(editorText.textContainer)
        let offset = layout.characterIndexForGlyph(at: layout.glyphRange(forBoundingRect: probe, in: container).location)
        let source = editorText.string as NSString
        let editorTop = source.substring(with: source.lineRange(for: NSRange(location: offset, length: 0)))
        let pageTop = try await page.evaluateJavaScript(
            "(function(){var ps=document.querySelectorAll('#gn-article p');for(var i=0;i<ps.length;i++){"
            + "if(ps[i].getBoundingClientRect().bottom>40)return ps[i].textContent;}return ''})()"
        ) as? String ?? ""
        let number: (String) -> Int? = { Int($0.split(separator: " ").dropFirst().first ?? "") }
        print("split sync: editor top \(editorTop.debugDescription), page top \(pageTop.debugDescription)")
        let gap = abs((number(editorTop) ?? -100) - (number(pageTop) ?? 100))
        XCTAssertLessThanOrEqual(gap, 1, "editor shows \(editorTop), page shows \(pageTop)")

        // The other way: the reader scrolls the page (a wheel event first, as a trackpad gives), the editor follows.
        func editorTopNumber() -> Int? {
            var probe = text.contentView.bounds
            // One point in: the line put exactly at the top starts where the line above it ends.
            probe.origin.y = max(0, probe.origin.y - editorText.textContainerInset.height + 1)
            probe.size.height = 1
            let at = layout.characterIndexForGlyph(at: layout.glyphRange(forBoundingRect: probe, in: container).location)
            return source.substring(to: at).components(separatedBy: "\n").count - 1
        }
        let target = source.substring(to: source.range(of: "Paragraph 150 of").location).components(separatedBy: "\n").count - 1
        _ = try await page.evaluateJavaScript(
            "(function(){var p=document.querySelectorAll('#gn-article p')[150];"
            + "var sc=document.scrollingElement||document.documentElement;"
            + "sc.scrollTop=sc.scrollTop+p.getBoundingClientRect().top-12;})();"
            + "window.dispatchEvent(new WheelEvent('wheel',{deltaY:400}));"
            // A page in a window that is not on screen fires no scroll events by itself.
            + "window.dispatchEvent(new Event('scroll'));true")
        try await Task.sleep(nanoseconds: 600_000_000)
        XCTAssertEqual(Double(editorTopNumber() ?? -100), Double(target), accuracy: 2, "the editor did not follow the page")

        // Count the actual top-line queries in the article, with an active-scroll positive control.
        _ = try await page.evaluateJavaScript(
            "(function(){var art=document.getElementById('gn-article'), query=art.querySelectorAll;"
            + "window.__syncMeasurements=0;art.querySelectorAll=function(selector){"
            + "if(selector==='[data-line]')window.__syncMeasurements++;return query.call(this,selector);};return true;})()")

        // A scrollbar gesture can last longer than the input timeout.
        _ = try await page.evaluateJavaScript("window.dispatchEvent(new MouseEvent('mousedown',{buttons:1}));true")
        try await Task.sleep(nanoseconds: 800_000_000)
        let dragTarget = source.substring(to: source.range(of: "Paragraph 100 of").location).components(separatedBy: "\n").count - 1
        _ = try await page.evaluateJavaScript(
            "(function(){var p=document.querySelectorAll('#gn-article p')[100];"
            + "var sc=document.scrollingElement||document.documentElement;"
            + "sc.scrollTop=sc.scrollTop+p.getBoundingClientRect().top-12;})();"
            + "window.dispatchEvent(new Event('scroll'));true")
        try await Task.sleep(nanoseconds: 600_000_000)
        XCTAssertEqual(Double(editorTopNumber() ?? -100), Double(dragTarget), accuracy: 2, "a sustained drag stopped syncing")
        let activeMeasurements = try await page.evaluateJavaScript("window.__syncMeasurements") as? Int ?? 0
        XCTAssertGreaterThan(activeMeasurements, 0, "the active scroll must measure top lines")
        _ = try await page.evaluateJavaScript("window.dispatchEvent(new MouseEvent('mouseup'));true")

        // Paused: the page scrolls alone, and the editor stays.
        model.splitScrollSync = false
        try await Task.sleep(nanoseconds: 300_000_000)
        _ = try await page.evaluateJavaScript("window.__syncMeasurements=0;true")
        _ = try await page.evaluateJavaScript(
            "window.dispatchEvent(new WheelEvent('wheel',{deltaY:400}));"
            + "(document.scrollingElement||document.documentElement).scrollTop=0;"
            + "window.dispatchEvent(new Event('scroll'));true")
        try await Task.sleep(nanoseconds: 600_000_000)
        XCTAssertEqual(Double(editorTopNumber() ?? -100), Double(dragTarget), accuracy: 2, "a paused sync still moved the editor")
        let pausedMeasurements = try await page.evaluateJavaScript("window.__syncMeasurements") as? Int ?? -1
        XCTAssertEqual(pausedMeasurements, 0, "paused mode must not measure top lines")
    }

    /// A probe over a real note (`MARKDOWN_SYNC_NOTE=<path>`): prints the editor's and the page's top line at
    /// several scroll offsets. Read-only; skipped without the variable.
    func testSyncProbeOnARealNote() async throws {
        guard let path = ProcessInfo.processInfo.environment["MARKDOWN_SYNC_NOTE"] else { throw XCTSkip("no note") }
        let model = model()
        model.configuration = GenesisKitMarkdownConfiguration(
            defaults: UserDefaults(suiteName: "md-split-probe-config-\(UUID().uuidString)")!)
        model.modeRaw = MarkdownViewMode.split.rawValue
        model.open([URL(fileURLWithPath: path)])
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1400, height: 800),
                              styleMask: [.titled, .resizable, .fullSizeContentView], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.contentView = MarkdownDocumentWindowController.contentView(model: model)
        window.alphaValue = 0
        window.level = .init(rawValue: Int(CGWindowLevelForKey(.desktopWindow)) - 1)
        window.order(.below, relativeTo: 0)
        defer { window.orderOut(nil); window.close() }
        func first<T: NSView>(_ type: T.Type, in view: NSView) -> T? {
            if let hit = view as? T { return hit }
            for child in view.subviews { if let hit = first(type, in: child) { return hit } }
            return nil
        }
        try await Task.sleep(nanoseconds: 3_000_000_000)
        let page = try XCTUnwrap(first(WKWebView.self, in: try XCTUnwrap(window.contentView)))
        let editor = try XCTUnwrap(first(NSTextView.self, in: try XCTUnwrap(window.contentView)))
        let text = try XCTUnwrap(editor.enclosingScrollView)
        for y in stride(from: 0.0, through: 6000.0, by: 750.0) {
            text.contentView.scroll(to: NSPoint(x: 0, y: y))
            text.reflectScrolledClipView(text.contentView)
            try await Task.sleep(nanoseconds: 400_000_000)
            var probe = text.contentView.bounds
            probe.origin.y = max(0, probe.origin.y - editor.textContainerInset.height)
            probe.size.height = 1
            let layout = try XCTUnwrap(editor.layoutManager)
            let offset = layout.characterIndexForGlyph(at: layout.glyphRange(forBoundingRect: probe, in: try XCTUnwrap(editor.textContainer)).location)
            let source = editor.string as NSString
            let top = source.substring(with: source.lineRange(for: NSRange(location: offset, length: 0)))
            let page = try await page.evaluateJavaScript(
                "(function(){var sc=document.scrollingElement;var ns=document.querySelectorAll('#gn-article [data-line]');"
                + "for(var i=ns.length-1;i>=0;i--){if(ns[i].getBoundingClientRect().top<=60)return sc.scrollTop+' line '+ns[i].getAttribute('data-line')+': '+ns[i].textContent.slice(0,60);}return sc.scrollTop+' none'})()"
            ) as? String ?? "?"
            print("sync probe y=\(Int(y)) editor: \(top.prefix(60).debugDescription) | page: \(page.debugDescription)")
        }
    }

    /// Editor lines count the frontmatter, page lines do not.
    func testLineMathBehindTheSync() {
        let note = "---\ntitle: x\ntags: [a]\n---\n# Heading\n\nbody\n"
        XCTAssertEqual(MarkdownFrontmatter.bodyLineOffset(in: note), 4)
        XCTAssertEqual(MarkdownFrontmatter.bodyLineOffset(in: "# No block\n"), 0)

        let starts = SourceEditing.lineStarts(note)
        XCTAssertEqual(starts.count, note.components(separatedBy: "\n").count)
        XCTAssertEqual(SourceEditing.line(at: 0, starts: starts), 0)
        // The offset of "# Heading" is line 4, which is body line 0.
        let heading = (note as NSString).range(of: "# Heading").location
        XCTAssertEqual(SourceEditing.line(at: heading, starts: starts), 4)
        XCTAssertEqual(SourceEditing.line(at: (note as NSString).length, starts: starts), starts.count - 1)
    }

    private final class Loader: NSObject, WKNavigationDelegate, WKScriptMessageHandler {
        var loaded: XCTestExpectation?
        var widths: [Double] = []
        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) { loaded?.fulfill() }
        func userContentController(_ ucc: WKUserContentController, didReceive message: WKScriptMessage) {
            guard let body = message.body as? [String: Any], body["type"] as? String == "width",
                  let value = body["value"] as? Double else { return }
            widths.append(value)
        }
    }
}

/// The layout defects behind the 2026-09-10 wedge: the split panes must be
/// sized by the geometry alone, and the reader's position must not reach the
/// disk on every scroll tick.
@MainActor
final class MarkdownSplitLayoutCostTests: XCTestCase {
    private func model() -> MarkdownDocumentsModel {
        MarkdownDocumentsModel(defaults: UserDefaults(suiteName: "md-cost-\(UUID().uuidString)")!)
    }

    func testThePanesAndDividerExactlyFillTheRow() {
        // No pane may be left to size itself from its AppKit content: an
        // NSTextView and a WKWebView answer sizeThatFits from what they hold,
        // and a free dimension lets the stack re-propose forever.
        for total in [900.0, 1280.0, 1600.0, 2400.0] {
            for ratio in [0.2, 0.35, 0.5, 0.8] {
                let editor = MarkdownSplit.editorWidth(total: total, ratio: ratio)
                let preview = MarkdownSplit.previewWidth(total: total, ratio: ratio)
                XCTAssertEqual(
                    editor + MarkdownSplit.dividerWidth + preview, total, accuracy: 0.5,
                    "panes must tile the row exactly at total=\(total) ratio=\(ratio)"
                )
                XCTAssertGreaterThan(preview, 0)
            }
        }
    }

    func testAPaneTooNarrowToSplitStillLeavesThePreviewANonNegativeWidth() {
        // Below the two-pane minimum the editor takes half, and the preview
        // must never be asked for a negative width.
        let total = 200.0
        XCTAssertGreaterThanOrEqual(MarkdownSplit.previewWidth(total: total, ratio: 0.9), 0)
    }

    func testScrollPositionsAreKeptInMemoryAndOnlyWrittenWhenTheReaderStops() {
        let defaults = UserDefaults(suiteName: "md-scroll-\(UUID().uuidString)")!
        let m = MarkdownDocumentsModel(defaults: defaults)
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("md-scroll-\(UUID().uuidString).md")
        try? "# a\n\nbody\n".write(to: url, atomically: true, encoding: .utf8)
        defer { try? FileManager.default.removeItem(at: url) }
        m.open([url])
        let id = m.docs[0].id

        // A gesture is dozens of these. The first reaches the disk at once so
        // a kill cannot lose it; the rest coalesce instead of serializing the
        // whole dictionary per tick, which is what they used to do.
        for y in stride(from: 0.0, to: 600.0, by: 12.0) {
            m.rememberScroll(y, for: id, pane: .source)
        }
        XCTAssertEqual(m.scrollOffset(for: id, pane: .source), 588)
        XCTAssertEqual(m.scrollWrites, 1, "50 positions, one write")

        let stored = defaults.dictionary(forKey: "markdownWindow.scroll") as? [String: [String: Double]]
        XCTAssertEqual(stored?[id]?[MarkdownPane.source.rawValue], 0, "the leading write is on disk")

        m.flushScroll()
        XCTAssertEqual(m.scrollWrites, 2)
        let after = defaults.dictionary(forKey: "markdownWindow.scroll") as? [String: [String: Double]]
        XCTAssertEqual(after?[id]?[MarkdownPane.source.rawValue], 588, "the last position lands on the flush")
    }

    func testTheSamePositionTwiceDoesNotRescheduleAnything() {
        let m = model()
        m.rememberScroll(42, for: "x", pane: .preview)
        m.rememberScroll(42, for: "x", pane: .preview)
        XCTAssertEqual(m.scrollOffset(for: "x", pane: .preview), 42)
    }
}
