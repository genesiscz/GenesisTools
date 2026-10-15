import AppKit
@testable import GenesisKit
import WebKit
import XCTest

/// The viewer's speed fixes of 2026-10-15: native path ids, the sidebar reveal's glide, and a page that
/// leaves the window kept as the next spare.
@MainActor
final class MarkdownViewerSpeedTests: XCTestCase {
    private func isNative(_ string: String) -> Bool {
        string.utf8.withContiguousStorageIfAvailable { _ in true } ?? false
    }

    /// A non-ASCII path from `URL.path` is a bridged NSString; the document keeps a native copy.
    func testADocumentKeepsItsPathAsANativeString() throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("ČEZ-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        addTeardownBlock { try? FileManager.default.removeItem(at: dir) }
        let url = dir.appendingPathComponent("Návrh.md")
        try "# Návrh".write(to: url, atomically: true, encoding: .utf8)
        let doc = MarkdownDocument(url: url)
        XCTAssertEqual(doc.id, url.path)
        XCTAssertTrue(isNative(doc.id), "the id is native UTF-8")
        XCTAssertTrue(isNative(doc.title))
        XCTAssertEqual(doc.title, "Návrh")
    }

    func testAFolderListingHandsOutNativePaths() throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("Složka-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir.appendingPathComponent("Účty"), withIntermediateDirectories: true)
        addTeardownBlock { try? FileManager.default.removeItem(at: dir) }
        try "x".write(to: dir.appendingPathComponent("Žádost.md"), atomically: true, encoding: .utf8)
        let entries = FileTreeListing.entries(of: dir.path)
        XCTAssertEqual(entries.map(\.name), ["Účty", "Žádost.md"])
        XCTAssertTrue(entries.allSatisfy { isNative($0.path) && isNative($0.name) })
    }

    func testTheGlideCentresARowByItsIndexAndStaysInsideTheDocument() {
        // 1,000 rows of 20 pt plus 4 pt padding above and below, a 600 pt sidebar.
        let height: CGFloat = 1000 * 20 + 8
        XCTAssertEqual(MarkdownTreeScroll.centeredOrigin(index: 500, count: 1000, documentHeight: height, visibleHeight: 600),
                       4 + 500.5 * 20 - 300)
        XCTAssertEqual(MarkdownTreeScroll.centeredOrigin(index: 2, count: 1000, documentHeight: height, visibleHeight: 600), 0,
                       "a row near the top cannot be centred above the document")
        XCTAssertEqual(MarkdownTreeScroll.centeredOrigin(index: 999, count: 1000, documentHeight: height, visibleHeight: 600),
                       height - 600, "nor one near the end below it")
    }

    func testAFarGlideCoversOnlyTheLastScreenAndEasesInAndOut() {
        XCTAssertEqual(MarkdownTreeScroll.glideStart(from: 0, to: 10_000, visibleHeight: 600), 9_400)
        XCTAssertEqual(MarkdownTreeScroll.glideStart(from: 10_000, to: 0, visibleHeight: 600), 600)
        XCTAssertEqual(MarkdownTreeScroll.glideStart(from: 100, to: 800, visibleHeight: 600), 100, "a near row glides all the way")
        XCTAssertEqual(MarkdownTreeScroll.eased(0), 0)
        XCTAssertEqual(MarkdownTreeScroll.eased(0.5), 0.5)
        XCTAssertEqual(MarkdownTreeScroll.eased(1), 1)
        XCTAssertLessThan(MarkdownTreeScroll.eased(0.1), 0.1, "slow at the start")
        XCTAssertGreaterThan(MarkdownTreeScroll.eased(0.9), 0.9, "slow at the end")
    }

    /// Two reveals in one glide: the first timer must stop, or it keeps pulling the list toward the old row.
    func testASecondGlideCancelsTheOneStillRunning() {
        let scroll = NSScrollView(frame: NSRect(x: 0, y: 0, width: 200, height: 400))
        let document = NSView(frame: NSRect(x: 0, y: 0, width: 200, height: 4_000))
        scroll.documentView = document
        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 200, height: 400),
            styleMask: [.borderless],
            backing: .buffered,
            defer: false
        )
        window.isReleasedWhenClosed = false
        window.contentView = scroll
        let box = MarkdownTreeScrollBox()
        defer {
            box.cancelGlide()
            window.close()
        }
        MarkdownTreeScroll.glide(toRow: 80, of: 100, in: scroll, box: box)
        let first = box.glide
        MarkdownTreeScroll.glide(toRow: 1, of: 100, in: scroll, box: box)
        XCTAssertEqual(first?.cancelled, true, "the glide already running stops")
        let second = box.glide
        XCTAssertFalse(second === first)
        XCTAssertEqual(second?.cancelled, false)
        RunLoop.main.run(until: Date().addingTimeInterval(0.12))
        XCTAssertEqual(first?.frames, 0, "the cancelled timer writes no further origin")
        XCTAssertGreaterThan(second?.frames ?? 0, 0)
        let frames = second?.frames ?? 0
        box.cancelGlide()
        RunLoop.main.run(until: Date().addingTimeInterval(0.12))
        XCTAssertEqual(second?.frames, frames, "cancel stops the timer, as a re-root or the tree leaving the window does")
        XCTAssertNil(box.glide)
    }

    func testTheOutlineParsesANoteOnlyWhenItsTextChanged() {
        let cache = MarkdownOutlineCache()
        let text = "# One\n\ntext\n\n## Two\n"
        XCTAssertEqual(cache.items(for: text).map(\.text), ["One", "Two"])
        _ = cache.items(for: text)
        _ = cache.items(for: String(text))
        XCTAssertEqual(cache.parses, 1, "the same text is not parsed again")
        XCTAssertEqual(cache.items(for: text + "## Three\n").map(\.text), ["One", "Two", "Three"])
        XCTAssertEqual(cache.parses, 2)
    }

    /// The page a pane gives back is the next spare: the next take gets it at once, already loaded.
    func testAPageThatLeavesTheWindowIsTheNextSpare() throws {
        let spare = MarkdownWebSpare()
        let page = MarkdownDropWebView(frame: .zero, configuration: WKWebViewConfiguration())
        let host = NSView(frame: .zero)
        host.addSubview(page)
        spare.recycle(page, media: MarkdownMediaRegistry())
        XCTAssertNil(page.superview, "it leaves its old pane")
        XCTAssertEqual(spare.recycled, 1)
        let view = MarkdownWebView(
            markdown: "# Doc\n", scrollTarget: nil, highlightQuery: nil, highlightToken: 0,
            onWikilink: { _ in }, onActiveSection: { _ in }
        )
        let taken = try XCTUnwrap(spare.take(for: MarkdownWebView.Coordinator(view)))
        XCTAssertTrue(taken.web === page)
        XCTAssertTrue(taken.ready, "a recycled page needs no load")
        // A second page while the slot is full is let go, not kept.
        spare.recycle(MarkdownDropWebView(frame: .zero, configuration: WKWebViewConfiguration()), media: MarkdownMediaRegistry())
        spare.recycle(MarkdownDropWebView(frame: .zero, configuration: WKWebViewConfiguration()), media: MarkdownMediaRegistry())
        XCTAssertEqual(spare.recycled, 2)
    }

    /// A page recycled from a themed pane must not keep that pane's inline theme. A host with no theme of its own
    /// never calls `gnTheme`, so the stylesheet's own palette only shows once those properties are gone.
    func testARecycledPageDropsThePreviousTheme() async throws {
        let spare = MarkdownWebSpare()
        let page = MarkdownDropWebView(frame: .zero, configuration: WKWebViewConfiguration())
        _ = try await page.evaluateJavaScript("""
        window.gnTheme=function(vars){var s=document.documentElement.style;for(var k in vars){s.setProperty(k,vars[k]);}};
        window.gnDiff=function(){};window.gnGitMarks=function(){};window.gnHighlightLines=function(){};
        window.gnWidth=function(){};
        window.gnTheme({'--dd-bg':'#ffffff','color-scheme':'light'});
        """)
        spare.recycle(page, media: MarkdownMediaRegistry())
        let deadline = Date().addingTimeInterval(2)
        var background = "#ffffff"
        while Date() < deadline {
            background = (try? await page.evaluateJavaScript(
                "document.documentElement.style.getPropertyValue('--dd-bg')"
            )) as? String ?? ""
            if background.isEmpty { break }
            try? await Task.sleep(for: .milliseconds(20))
        }
        XCTAssertEqual(background, "", "the previous pane's theme does not stay on the spare")
    }
}
