import WebKit
import XCTest
@testable import GenesisKit

/// Obsidian callouts (`> [!warning] Title`) are cut out before markdown-it
/// runs and pasted back over their placeholder paragraph. Runs the real page.
@MainActor
final class MarkdownCalloutRenderTests: XCTestCase {
    private final class Bridge: NSObject, WKScriptMessageHandler, WKNavigationDelegate {
        var loaded: XCTestExpectation?
        func userContentController(_ ucc: WKUserContentController, didReceive message: WKScriptMessage) {}
        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) { loaded?.fulfill() }
    }

    private var web: WKWebView!
    private var bridge: Bridge!
    private var window: NSWindow!

    override func setUp() async throws {
        bridge = Bridge()
        let controller = WKUserContentController()
        controller.add(bridge, name: "bridge")
        let config = WKWebViewConfiguration()
        config.userContentController = controller
        config.setURLSchemeHandler(MarkdownWebView.AssetSchemeHandler(), forURLScheme: MarkdownWebView.assetScheme)
        web = WKWebView(frame: NSRect(x: 0, y: 0, width: 1200, height: 800), configuration: config)
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
    }

    private func eval(_ js: String) async throws -> Any? {
        try await web.evaluateJavaScript(js)
    }

    /// Observed 2026-09-15 14:15: a note rendered "@@GNCALLOUT0@@" and
    /// "@@GNCALLOUT1@@" as plain text. The source-line sync had started
    /// stamping `data-line` on every paragraph, so the placeholder paragraph
    /// was `<p data-line="2">…</p>` and the literal `<p>` swap never matched.
    func testCalloutsAreRenderedAsAlertsAndTheirPlaceholdersNeverShow() async throws {
        let note = """
        # Title

        > [!warning] Verdict
        > One defect in **three** dialects.
        > Second line.

        > [!info] Ours?
        > No.

        ## After
        """
        _ = try await eval("window.gnRender(\(MarkdownWebView.jsString(note)))")
        let text = try await eval("document.getElementById('gn-article').textContent") as? String ?? ""
        XCTAssertFalse(text.contains("@@GNCALLOUT"), "placeholder leaked into the page: \(text)")
        let alerts = try await eval("document.querySelectorAll('.markdown-alert').length") as? Int
        XCTAssertEqual(alerts, 2)
        let groups = try await eval(
            "Array.from(document.querySelectorAll('.markdown-alert')).map(function(a){return a.className})"
        ) as? [String]
        XCTAssertEqual(groups, ["markdown-alert markdown-alert-warning", "markdown-alert markdown-alert-info"])
        let titles = try await eval(
            "Array.from(document.querySelectorAll('.markdown-alert-title span')).map(function(s){return s.textContent})"
        ) as? [String]
        XCTAssertEqual(titles, ["Verdict", "Ours?"])
        let body = try await eval("document.querySelector('.markdown-alert-body').innerHTML") as? String ?? ""
        XCTAssertTrue(body.contains("<strong>three</strong>"), "callout body is markdown: \(body)")
    }

    /// Cutting a four-line callout down to a one-line placeholder used to
    /// shift every later `data-line` up by three, so the source ↔ preview
    /// sync drifted after each callout.
    func testCalloutsKeepTheSourceLineNumbersOfWhatFollows() async throws {
        let note = """
        # Title

        > [!note] Three lines
        > a
        > b

        ## After
        """
        _ = try await eval("window.gnRender(\(MarkdownWebView.jsString(note)))")
        let alertLine = try await eval("document.querySelector('.markdown-alert').getAttribute('data-line')") as? String
        XCTAssertEqual(alertLine, "2", "the callout carries the line of its own header")
        let headingLine = try await eval("document.querySelector('h2').getAttribute('data-line')") as? String
        XCTAssertEqual(headingLine, "6")
    }

    /// Observed 2026-10-13: a one-line callout with a numbered list right under it (no blank line) showed
    /// "@@GNCALLOUT14@@ 4. Is there…" as one paragraph. The placeholder had no blank line after it, so the
    /// list continued its paragraph and the swap never matched.
    func testACalloutRightAboveAListEndsWhereItsQuoteLinesEnd() async throws {
        let note = """
        # Questions

        > [!info] Answered: Q1 to Q3.
        4. Is there a mobile design?
        5. Should other failures stop the spinner?

        ## After
        """
        _ = try await eval("window.gnRender(\(MarkdownWebView.jsString(note)))")
        let text = try await eval("document.getElementById('gn-article').textContent") as? String ?? ""
        XCTAssertFalse(text.contains("@@GNCALLOUT"), "placeholder leaked into the page: \(text)")
        let alerts = try await eval("document.querySelectorAll('.markdown-alert').length") as? Int
        XCTAssertEqual(alerts, 1)
        let items = try await eval("document.querySelectorAll('ol > li').length") as? Int
        XCTAssertEqual(items, 2, "the numbered lines are a list of their own")
        let start = try await eval("document.querySelector('ol').getAttribute('start')") as? String
        XCTAssertEqual(start, "4")
        let listLine = try await eval("document.querySelector('ol').getAttribute('data-line')") as? String
        XCTAssertEqual(listLine, "3", "the added blank line does not shift the source sync")
        let headingLine = try await eval("document.querySelector('h2').getAttribute('data-line')") as? String
        XCTAssertEqual(headingLine, "6")
    }
}

/// `[[#Heading]]` (this note) and `[[Note#Heading]]` are links, not text.
@MainActor
final class MarkdownHeadingWikilinkRenderTests: XCTestCase {
    private final class Bridge: NSObject, WKScriptMessageHandler, WKNavigationDelegate {
        var loaded: XCTestExpectation?
        var posted: [[String: Any]] = []
        func userContentController(_ ucc: WKUserContentController, didReceive message: WKScriptMessage) {
            if let body = message.body as? [String: Any] { posted.append(body) }
        }
        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) { loaded?.fulfill() }
    }

    private var web: WKWebView!
    private var bridge: Bridge!
    private var window: NSWindow!

    override func setUp() async throws {
        bridge = Bridge()
        let controller = WKUserContentController()
        controller.add(bridge, name: "bridge")
        let config = WKWebViewConfiguration()
        config.userContentController = controller
        config.setURLSchemeHandler(MarkdownWebView.AssetSchemeHandler(), forURLScheme: MarkdownWebView.assetScheme)
        web = WKWebView(frame: NSRect(x: 0, y: 0, width: 1200, height: 300), configuration: config)
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
    }

    private func eval(_ js: String) async throws -> Any? {
        try await web.evaluateJavaScript(js)
    }

    /// Observed 2026-09-15 14:21: "See [[#Not the auth cluster]]" rendered as
    /// the literal brackets, in a callout and in plain text alike, because
    /// the wikilink rule required a note name before the `#`.
    func testHeadingOnlyWikilinkIsALinkLabelledWithTheHeading() async throws {
        let note = "See [[#Not the auth cluster]] and [[Other#Part two|two]] and [[Plain]].\n\n> [!info] Q\n> Also [[#Not the auth cluster]].\n\n## Not the auth cluster\n\nbody"
        _ = try await eval("window.gnRender(\(MarkdownWebView.jsString(note)))")
        let text = try await eval("document.getElementById('gn-article').textContent") as? String ?? ""
        XCTAssertFalse(text.contains("[["), "brackets leaked: \(text)")
        let links = try await eval(
            "Array.from(document.querySelectorAll('a.dd-wikilink')).map(function(a){return a.getAttribute('data-wikilink')+'|'+a.textContent})"
        ) as? [String]
        XCTAssertEqual(links, [
            "#Not the auth cluster|Not the auth cluster",
            "Other#Part two|two",
            "Plain|Plain",
            "#Not the auth cluster|Not the auth cluster",
        ])
        // The heading it points at exists under the slug the click will use.
        let target = try await eval("document.getElementById('not-the-auth-cluster') !== null") as? Bool
        XCTAssertEqual(target, true)
    }

    func testHeadingOnlyClickScrollsThePageInsteadOfAskingSwift() async throws {
        let filler = String(repeating: "line\n\n", count: 80)
        let note = "[[#Deep]]\n\n\(filler)## Deep\n\nend"
        _ = try await eval("window.gnRender(\(MarkdownWebView.jsString(note)))")
        // Smooth scrolling never settles in an off-screen view, so spy on the
        // jump the click must route to instead of measuring the offset.
        _ = try await eval("window.__jumped=null; window.gnScrollToSlug=function(s){window.__jumped=s}; true")
        _ = try await eval("document.querySelector('a.dd-wikilink').click(); true")
        let jumped = try await eval("window.__jumped") as? String
        XCTAssertEqual(jumped, "deep", "the click scrolls to the heading slug in-page")
        // Script messages arrive on a later main-queue turn; give them the
        // same window the positive case below needs.
        try await Task.sleep(for: .milliseconds(300))
        XCTAssertTrue(bridge.posted.filter { $0["type"] as? String == "wikilink" }.isEmpty, "no wikilink message reached Swift")
        // A cross-note click still goes to Swift.
        _ = try await eval("window.gnRender(\(MarkdownWebView.jsString("[[Other#Part]]")))")
        _ = try await eval("document.querySelector('a.dd-wikilink').click(); true")
        for _ in 0..<20 where bridge.posted.last?["target"] as? String != "Other#Part" {
            try await Task.sleep(for: .milliseconds(50))
        }
        XCTAssertEqual(bridge.posted.last?["target"] as? String, "Other#Part")
    }
}
