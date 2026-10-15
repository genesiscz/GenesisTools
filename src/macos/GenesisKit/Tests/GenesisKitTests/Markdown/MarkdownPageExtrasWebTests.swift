import PDFKit
import WebKit
import XCTest
@testable import GenesisKit

/// The page extras on the real page: heading anchors, the code block bar, the sticky section line
/// and the link hover reports, plus the Swift side that copies, builds the link and parses a hover.
@MainActor
final class MarkdownPageExtrasWebTests: XCTestCase {
    private final class Bridge: NSObject, WKScriptMessageHandler, WKNavigationDelegate {
        var loaded: XCTestExpectation?
        var messages: [[String: Any]] = []
        func userContentController(_ ucc: WKUserContentController, didReceive message: WKScriptMessage) {
            if let body = message.body as? [String: Any] { messages.append(body) }
        }
        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) { loaded?.fulfill() }
    }

    private var web: WKWebView!
    private var bridge: Bridge!
    private var window: NSWindow!
    private var liveCoordinator: MarkdownWebView.Coordinator?

    override func setUp() async throws {
        bridge = Bridge()
        let controller = WKUserContentController()
        controller.add(bridge, name: "bridge")
        let config = WKWebViewConfiguration()
        config.userContentController = controller
        config.setURLSchemeHandler(MarkdownWebView.AssetSchemeHandler(), forURLScheme: MarkdownWebView.assetScheme)
        web = WKWebView(frame: NSRect(x: 0, y: 0, width: 1000, height: 700), configuration: config)
        web.navigationDelegate = bridge
        window = NSWindow(contentRect: web.frame, styleMask: [.borderless], backing: .buffered, defer: false)
        window.contentView = web
        let loaded = expectation(description: "page loaded")
        bridge.loaded = loaded
        web.loadHTMLString(MarkdownWebView.template, baseURL: URL(string: "\(MarkdownWebView.assetScheme)://asset/"))
        await fulfillment(of: [loaded], timeout: 10)
    }

    override func tearDown() {
        window.contentView = nil
        window = nil
        web = nil
        liveCoordinator = nil
    }

    private func eval(_ js: String) async throws -> Any? {
        try await web.evaluateJavaScript(js)
    }

    private func render(_ markdown: String, anchors: Bool = false, codeBar: Bool = false, sticky: Bool = false, lines: Bool = false) async throws {
        _ = try await eval("window.gnPage({anchors:\(anchors),codeBar:\(codeBar),sticky:\(sticky)});true")
        _ = try await eval("window.gnRender(\(MarkdownWebView.jsString(markdown)),[],false,null,{},\(lines));true")
    }

    /// The bridge's messages of one type. Script messages land on the main thread a moment later.
    private func posted(_ type: String) async throws -> [[String: Any]] {
        try await Task.sleep(nanoseconds: 60_000_000)
        return bridge.messages.filter { $0["type"] as? String == type }
    }

    // MARK: Heading anchors

    func testEveryHeadingGetsAnAnchorThatPostsItsHeadingAndSaysCopied() async throws {
        try await render("# Plan\n\nIntro.\n\n## Setup **now**\n\nText.", anchors: true)
        let count = try await eval("document.querySelectorAll('#gn-article .gn-anchor').length") as? Int
        XCTAssertEqual(count, 2)
        let display = try await eval("getComputedStyle(document.querySelector('h2 .gn-anchor')).display") as? String
        XCTAssertEqual(display, "flex")
        let text = try await eval("document.getElementById('gn-article').textContent") as? String ?? ""
        XCTAssertFalse(text.contains("#"), "the # is drawn by CSS, so the find and a copy never see it: \(text)")

        _ = try await eval("document.querySelector('h2 .gn-anchor').click();true")
        let anchors = try await posted("anchor")
        XCTAssertEqual(anchors.map { $0["heading"] as? String }, ["Setup now"])
        let toast = try await eval(
            "var t=document.getElementById('gn-toast');t.textContent+'|'+t.classList.contains('gn-on')+'|'+!!t.closest('#gn-article')"
        ) as? String
        XCTAssertEqual(toast, "Copied|true|false", "the confirmation shows, outside the article the find walks")

        // The link the anchor copies leads back to this heading: the viewer slugs the fragment.
        let id = try await eval("document.querySelector('h2').id") as? String
        XCTAssertEqual(id, MarkdownBlocks.slugify("Setup now"))

        _ = try await eval("window.gnPage({anchors:false});true")
        let off = try await eval("getComputedStyle(document.querySelector('h2 .gn-anchor')).display") as? String
        XCTAssertEqual(off, "none", "off: out of sight and out of the keyboard's way")
    }

    func testTheCopiedLinkIsTheWikilinkTheViewerFollows() {
        let plan = URL(fileURLWithPath: "/tmp/notes/plan.md")
        XCTAssertEqual(MarkdownWebView.headingLink("Setup now", documentURL: plan), "[[plan#Setup now]]")
        XCTAssertEqual(MarkdownWebView.headingLink("A [b] | c #d ^e", documentURL: plan), "[[plan#A b c d e]]",
                       "what would end the wikilink or start a block reference becomes a space")
        XCTAssertEqual(MarkdownWebView.headingLink("Setup", documentURL: nil), "[[#Setup]]", "no file: a link into this note")
        XCTAssertEqual(MarkdownWebView.headingLink("Setup", documentURL: URL(fileURLWithPath: "/tmp/notes/log.txt")), "[[log.txt#Setup]]")
    }

    // MARK: Code block bar

    func testTheCodeBarIsOnFencedBlocksOnlyAndCopiesTheBlocksSource() async throws {
        let markdown = "```ts\nlet a = 1\n```\n\n```mermaid\ngraph TD; A-->B\n```\n\n```\nplain\n```"
        try await render(markdown, codeBar: true)
        let langs = try await eval(
            "Array.from(document.querySelectorAll('#gn-article .gn-code .gn-code-lang')).map(function(s){return s.getAttribute('data-lang')})"
        ) as? [String]
        XCTAssertEqual(langs, ["ts", ""], "the ts block and the plain one; a diagram has no bar")
        let mermaidBar = try await eval("!!document.querySelector('#gn-article .mermaid').closest('.gn-code')") as? Bool
        XCTAssertEqual(mermaidBar, false)
        let text = try await eval("document.getElementById('gn-article').textContent") as? String ?? ""
        XCTAssertFalse(text.contains("Copy"), "the label is CSS, not text the find would match: \(text)")

        _ = try await eval("document.querySelector('.gn-code-copy').click();true")
        let copies = try await posted("copy")
        XCTAssertEqual(copies.map { $0["text"] as? String }, ["let a = 1"], "the block's own source, without the fence's last newline")
        let label = try await eval("document.querySelector('.gn-code-copy').getAttribute('data-label')") as? String
        XCTAssertEqual(label, "Copied")

        try await render(markdown, codeBar: false)
        let offBars = try await eval("document.querySelectorAll('#gn-article .gn-code').length") as? Int
        XCTAssertEqual(offBars, 0)
        let lined = try await eval("document.querySelectorAll('#gn-article pre[data-line]').length") as? Int
        XCTAssertEqual(lined, 2, "without the bar the blocks are marked on the pre, as before")

        // A code or json file shown as one numbered block (`lineNumbers`) keeps its plain frame.
        try await render("```json\n{\"a\":1}\n```", codeBar: true, lines: true)
        let numbered = try await eval(
            "document.querySelectorAll('#gn-article .gn-code').length+'|'+document.querySelectorAll('#gn-article .gn-ln').length"
        ) as? String
        XCTAssertEqual(numbered, "0|1")
    }

    func testALineRangeStillMarksTheCodeBlockUnderItsBar() async throws {
        // Body lines: 0 the first paragraph, 2…5 the fence, 7 the last paragraph.
        try await render("First paragraph.\n\n```ts\nlet a = 1\nlet b = 2\n```\n\nLast paragraph.", codeBar: true)
        let wrapper = try await eval(
            "var w=document.querySelector('.gn-code');w.getAttribute('data-line')+'-'+w.getAttribute('data-line-end')+'|'+document.querySelectorAll('pre[data-line]').length"
        ) as? String
        XCTAssertEqual(wrapper, "2-6|0", "the wrapper carries the fence's lines, the pre no longer does")

        _ = try await eval("window.gnHighlightLines(3,3,'blocks',false);true")
        let marked = try await eval(
            "Array.from(document.querySelectorAll('#gn-article .gn-hl')).map(function(e){return e.localName+'.'+e.classList[0]+'|'+e.getAttribute('data-line')})"
        ) as? [String]
        XCTAssertEqual(marked, ["div.gn-code|2"])
        let covered = try await eval("""
        (function(){var b=document.getElementById('gn-hl-band').getBoundingClientRect(),w=document.querySelector('.gn-code').getBoundingClientRect();
          return b.top<=w.top&&b.bottom>=w.bottom;})()
        """) as? Bool
        XCTAssertEqual(covered, true, "the band covers the bar and the code")

        _ = try await eval("window.gnHighlightLines(7,7,'blocks',false);true")
        let after = try await eval(
            "Array.from(document.querySelectorAll('#gn-article .gn-hl')).map(function(e){return e.localName+'|'+e.getAttribute('data-line')})"
        ) as? [String]
        XCTAssertEqual(after, ["p|7"], "the paragraph after the block keeps its own line")
    }

    // MARK: Sticky section

    private let filler = (1...30).map { "Line \($0) of the filler text." }.joined(separator: "\n\n")
    private var outline: String {
        "# Guide\n\n\(filler)\n\n## Install\n\n\(filler)\n\n### macOS\n\n\(filler)\n\n## Usage\n\n\(filler)"
    }

    private func sticky() async throws -> String? {
        try await eval("""
        window.gnStickyRefresh();var b=document.getElementById('gn-sticky');
        (b.classList.contains('gn-on')?'on':'off')+'|'+Array.from(b.querySelectorAll('.gn-sticky-part')).map(function(p){return p.textContent}).join(' › ')
        """) as? String
    }

    private func scrollPast(_ id: String, by extra: Int = 300) async throws {
        _ = try await eval(
            "var s=document.scrollingElement;s.scrollTop=document.getElementById('\(id)').getBoundingClientRect().top+s.scrollTop+\(extra);true"
        )
    }

    func testTheStickyLineShowsThePathOfTheSectionOnScreen() async throws {
        try await render(outline, sticky: true)
        let top = try await sticky()
        XCTAssertEqual(top, "off|", "at the top no heading has scrolled off")

        try await scrollPast("macos")
        let nested = try await sticky()
        XCTAssertEqual(nested, "on|Guide › Install › macOS")

        try await scrollPast("usage")
        let sibling = try await sticky()
        XCTAssertEqual(sibling, "on|Guide › Usage", "a new H2 ends the H3's section")

        let text = try await eval("document.getElementById('gn-article').textContent") as? String ?? ""
        XCTAssertFalse(text.contains("Guide › Usage"), "the bar is outside the article the find walks")

        _ = try await eval("window.__into=null;Element.prototype.scrollIntoView=function(){window.__into=this.id};true")
        _ = try await eval("document.querySelector('#gn-sticky .gn-sticky-part').click();true")
        let into = try await eval("window.__into") as? String
        XCTAssertEqual(into, "guide", "a click on a part goes to its heading")

        _ = try await eval("window.gnPage({sticky:false});true")
        let off = try await sticky()
        XCTAssertEqual(off, "off|")
    }

    func testTheStickyLineNeverCoversWhereAJumpLands() async throws {
        try await render(outline, sticky: true)
        let margin = try await eval("getComputedStyle(document.getElementById('install')).scrollMarginTop") as? String
        XCTAssertEqual(margin, "42px", "a heading jump leaves the bar's 30 px free, plus the usual 12")

        // Split view sync puts the block at the top, below the bar.
        let line = try XCTUnwrap(outline.components(separatedBy: "\n").firstIndex(of: "## Install"))
        _ = try await eval("window.gnSyncLine(\(line));true")
        let landed = try await eval("document.getElementById('install').getBoundingClientRect().top") as? Double ?? -1
        XCTAssertEqual(landed, 42, accuracy: 1)

        _ = try await render(outline, sticky: false)
        _ = try await eval("window.gnSyncLine(\(line));true")
        let plain = try await eval("document.getElementById('install').getBoundingClientRect().top") as? Double ?? -1
        XCTAssertEqual(plain, 12, accuracy: 1, "off: the sync is where it always was")
    }

    func testPrintAndPDFLeaveTheStickyLineOut() async throws {
        try await render(outline, anchors: true, codeBar: true, sticky: true)
        try await scrollPast("macos")
        let shown = try await sticky()
        XCTAssertEqual(shown, "on|Guide › Install › macOS")

        web.mediaType = "print"
        let printed = try await eval(
            "[getComputedStyle(document.getElementById('gn-sticky')).display,getComputedStyle(document.querySelector('.gn-anchor')).display].join('|')"
        ) as? String
        XCTAssertEqual(printed, "none|none")
        web.mediaType = nil

        let proxy = MarkdownWebProxy()
        proxy.web = web
        let file = FileManager.default.temporaryDirectory.appendingPathComponent("md-extras-\(UUID().uuidString).pdf")
        defer { try? FileManager.default.removeItem(at: file) }
        let exported = expectation(description: "exported")
        var failure: Error?
        proxy.exportPDF(to: file) { failure = $0; exported.fulfill() }
        await fulfillment(of: [exported], timeout: 10)
        XCTAssertNil(failure)
        let pdfText = PDFDocument(url: file)?.string ?? ""
        XCTAssertTrue(pdfText.contains("Line 1 of the filler text."), "the export holds the note")
        XCTAssertFalse(pdfText.contains("Guide › Install"), "the sticky line is not part of the export")
        let back = try await eval("getComputedStyle(document.getElementById('gn-sticky')).display") as? String
        XCTAssertEqual(back, "block", "and it is back on screen afterwards")
    }

    // MARK: Link hover

    func testLinkHoverReportsTheLinkUnderThePointerAndNothingWhileAButtonIsDown() async throws {
        try await render("See [[Plan#Setup|the plan]], [the PDF](./x.pdf) and [docs](https://example.com/docs).")
        func hover(_ selector: String, buttons: Int = 0) async throws {
            _ = try await eval(
                "document.querySelector('\(selector)').dispatchEvent(new MouseEvent('mouseover',{bubbles:true,buttons:\(buttons)}));true"
            )
        }
        func leave(_ selector: String) async throws {
            _ = try await eval(
                "document.querySelector('\(selector)').dispatchEvent(new MouseEvent('mouseout',{bubbles:true,relatedTarget:document.body}));true"
            )
        }
        try await hover(".dd-wikilink")
        try await leave(".dd-wikilink")
        try await hover("a[href=\\\"./x.pdf\\\"]")
        try await leave("a[href=\\\"./x.pdf\\\"]")
        try await hover("a[href^=\\\"https\\\"]")
        let reports = try await posted("linkHover")
        XCTAssertEqual(reports.map { $0["href"] as? String }, ["Plan#Setup", nil, "./x.pdf", nil, "https://example.com/docs"],
                       "a wikilink's target, a local link as written, an external link's URL; nil when it left")
        let box = reports.first?["rect"] as? [String: Any]
        XCTAssertGreaterThan((box?["w"] as? NSNumber)?.doubleValue ?? 0, 0)

        try await leave("a[href^=\\\"https\\\"]")
        bridge.messages = []
        try await hover(".dd-wikilink", buttons: 1)
        _ = try await eval("window.dispatchEvent(new Event('scroll'));true")
        try await hover("a[href=\\\"./x.pdf\\\"]")
        let quiet = try await posted("linkHover")
        XCTAssertTrue(quiet.isEmpty, "a drag or a scroll reports nothing: \(quiet)")
    }

    func testAHoverMessageBecomesTheLinkAndItsBoxInPoints() {
        let hover = MarkdownWebView.linkHover(from: ["type": "linkHover", "href": "./x.pdf", "rect": ["x": 10, "y": 20, "w": 30, "h": 12]], zoom: 1.5)
        XCTAssertEqual(hover, MarkdownLinkHover(href: "./x.pdf", rect: CGRect(x: 15, y: 30, width: 45, height: 18)))
        XCTAssertNil(MarkdownWebView.linkHover(from: ["type": "linkHover", "href": NSNull()], zoom: 1))
    }

    // MARK: Through the app's coordinator

    private func coordinatorPage(_ view: MarkdownWebView, markdown: String? = nil) async throws -> (WKWebView, MarkdownWebView.Coordinator) {
        let coordinator = MarkdownWebView.Coordinator(view)
        coordinator.lastMarkdown = markdown
        _ = coordinator.syncPageExtras()
        let config = MarkdownWebView.configuration(for: coordinator)
        let page = WKWebView(frame: NSRect(x: 0, y: 0, width: 800, height: 600), configuration: config)
        page.navigationDelegate = coordinator
        coordinator.web = page
        window.contentView = page
        page.loadHTMLString(MarkdownWebView.template, baseURL: URL(string: "\(MarkdownWebView.assetScheme)://asset/"))
        for _ in 0..<100 where !coordinator.ready {
            try await Task.sleep(nanoseconds: 50_000_000)
        }
        XCTAssertTrue(coordinator.ready)
        liveCoordinator = coordinator
        return (page, coordinator)
    }

    private func view(extras: MarkdownWebView.PageExtras, zoom: Double = 1, onLinkHover: ((MarkdownLinkHover?) -> Void)? = nil) -> MarkdownWebView {
        MarkdownWebView(
            markdown: "", scrollTarget: nil, highlightQuery: nil, highlightToken: 0,
            onWikilink: { _ in }, onActiveSection: { _ in }, onLinkHover: onLinkHover, zoom: zoom,
            pageExtras: extras
        )
    }

    func testTheCoordinatorSendsTheExtrasBeforeTheFirstRenderAndAskForARenderWhenTheBarFlips() async throws {
        let on = MarkdownWebView.PageExtras(headingAnchors: true, codeBlockBar: true, stickySection: false)
        let (page, coordinator) = try await coordinatorPage(view(extras: on), markdown: "# A\n\n```ts\nlet a = 1\n```")
        try await Task.sleep(nanoseconds: 100_000_000)
        let drawn = try await page.evaluateJavaScript(
            "document.querySelectorAll('#gn-article .gn-code').length+'|'+document.body.classList.contains('gn-anchors')"
        ) as? String
        XCTAssertEqual(drawn, "1|true", "the first render already has the bar")

        coordinator.parent = view(extras: MarkdownWebView.PageExtras(headingAnchors: true, codeBlockBar: true, stickySection: true))
        XCTAssertFalse(coordinator.syncPageExtras(), "the sticky line needs no render")
        coordinator.parent = view(extras: MarkdownWebView.PageExtras(headingAnchors: true, codeBlockBar: false, stickySection: true))
        XCTAssertTrue(coordinator.syncPageExtras(), "the bar is drawn by the renderer")
    }

    func testTheCoordinatorHandsAHoverToTheHostInPoints() async throws {
        var hovers: [MarkdownLinkHover?] = []
        let extras = MarkdownWebView.PageExtras(headingAnchors: false, codeBlockBar: false, stickySection: false)
        let (page, _) = try await coordinatorPage(view(extras: extras, zoom: 2, onLinkHover: { hovers.append($0) }))
        _ = try await page.evaluateJavaScript("""
        window.webkit.messageHandlers.bridge.postMessage({type:'linkHover',href:'./x.pdf',rect:{x:1,y:2,w:3,h:4}});
        window.webkit.messageHandlers.bridge.postMessage({type:'linkHover',href:null});true
        """)
        try await Task.sleep(nanoseconds: 100_000_000)
        XCTAssertEqual(hovers, [MarkdownLinkHover(href: "./x.pdf", rect: CGRect(x: 2, y: 4, width: 6, height: 8)), nil])
    }
}
