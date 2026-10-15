import WebKit
import XCTest
@testable import GenesisKit

/// The find bar inside the rendered page (`gnFind` / `gnFindStep`), run on the
/// real template in a WKWebView.
@MainActor
final class MarkdownFindWebTests: XCTestCase {
    private final class Bridge: NSObject, WKScriptMessageHandler, WKNavigationDelegate {
        var finds: [(index: Int, count: Int)] = []
        var loaded: XCTestExpectation?
        func userContentController(_ ucc: WKUserContentController, didReceive message: WKScriptMessage) {
            guard let body = message.body as? [String: Any], body["type"] as? String == "find" else { return }
            finds.append((body["index"] as? Int ?? -1, body["count"] as? Int ?? -1))
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
    }

    private func eval(_ js: String) async throws -> Any? {
        try await web.evaluateJavaScript(js)
    }

    /// PR #80 review: offsets came from `toLowerCase()` of the text, and "İ"
    /// lowercases to two code units, so every match after it was cut in the
    /// wrong place and clearing left the text changed.
    func testMatchesAfterACharacterThatGrowsWhenLowercasedStayInPlace() async throws {
        _ = try await eval("window.gnRender(\(MarkdownWebView.jsString("İİ İstanbul foo and FOO end")))")
        let before = try await eval("document.getElementById('gn-article').textContent") as? String
        _ = try await eval("window.gnFind('foo')")
        let marks = try await eval(
            "Array.from(document.querySelectorAll('#gn-article mark.gn-find')).map(function(m){return m.textContent})"
        ) as? [String]
        XCTAssertEqual(marks, ["foo", "FOO"])
        let during = try await eval("document.getElementById('gn-article').textContent") as? String
        XCTAssertEqual(during, before)
        _ = try await eval("window.gnFind('')")
        let after = try await eval("document.getElementById('gn-article').textContent") as? String
        XCTAssertEqual(after, before)
        // A query with regex syntax is matched literally.
        _ = try await eval("window.gnRender('a (b) c.d')")
        _ = try await eval("window.gnFind('(b)')")
        let literal = try await eval("document.querySelectorAll('#gn-article mark.gn-find').length") as? Int
        XCTAssertEqual(literal, 1)
    }

    private func marks() async throws -> [String] {
        try await eval(
            "Array.from(document.querySelectorAll('#gn-article mark.gn-find')).map(function(m){return m.textContent})"
        ) as? [String] ?? []
    }

    private func expectMarks(_ expected: [String], file: StaticString = #filePath, line: UInt = #line) async throws {
        let got = try await marks()
        XCTAssertEqual(got, expected, file: file, line: line)
    }

    private func expectMarkCount(_ expected: Int, file: StaticString = #filePath, line: UInt = #line) async throws {
        let got = try await marks()
        XCTAssertEqual(got.count, expected, file: file, line: line)
    }

    /// `window.gnFind` with the options exactly as Swift sends them.
    private func find(_ query: String, _ options: MarkdownFindOptions = .init(), scope: Int? = nil, ticks: Bool = false) async throws {
        let command = MarkdownFindCommand(query: query, token: 0, delta: 0, options: options, scope: scope, scrollbarMarks: ticks)
        _ = try await eval("window.gnFind(\(MarkdownWebView.jsString(query)),false,\(command.jsOptions))")
    }

    /// The three toggles mean in the page what they mean in the source (`SourceFind`).
    func testMatchCaseWholeWordAndRegexInThePage() async throws {
        _ = try await eval("window.gnRender(\(MarkdownWebView.jsString("Foo foo food FOO čaj čajovna")))")
        try await find("foo")
        try await expectMarks(["Foo", "foo", "foo", "FOO"])
        try await find("foo", .init(matchCase: true))
        try await expectMarks(["foo", "foo"])
        try await find("foo", .init(wholeWord: true))
        try await expectMarks(["Foo", "foo", "FOO"])
        try await find("foo", .init(matchCase: true, wholeWord: true))
        try await expectMarks(["foo"])
        // A háček is part of the word, as in the source.
        try await find("čaj", .init(wholeWord: true))
        try await expectMarks(["čaj"])
        try await find("f\\w+d", .init(regex: true))
        try await expectMarks(["food"])
        XCTAssertEqual(bridge.finds.last?.count, 1)
    }

    func testAnInvalidRegexMarksNothingAndReportsIndexMinusOne() async throws {
        _ = try await eval("window.gnRender('alpha (beta)')")
        try await find("beta")
        try await expectMarks(["beta"])
        try await find("(beta", .init(regex: true))
        try await expectMarks([])
        XCTAssertEqual(bridge.finds.last?.index, -1)
        XCTAssertEqual(bridge.finds.last?.count, 0)
        // Not a regex: the same text is literal and found.
        try await find("(beta", .init())
        try await expectMarks(["(beta"])
    }

    /// Find in selection marks only inside the DOM selection taken when the
    /// toggle turned on, and rebuilding the marks leaves that selection alone.
    func testFindInSelectionStaysInsideTheSelectionOfThatMoment() async throws {
        _ = try await eval("window.gnRender(\(MarkdownWebView.jsString("foo one\n\nfoo two\n\nfoo three\n")))")
        let select = """
        (function(){var p=document.querySelectorAll('#gn-article p')[1];var r=document.createRange();
          r.selectNodeContents(p);var s=window.getSelection();s.removeAllRanges();s.addRange(r);})()
        """
        _ = try await eval(select)
        let selected = try await eval("window.getSelection().toString()") as? String
        XCTAssertEqual(selected, "foo two")
        try await find("foo")
        try await expectMarkCount(3)
        // The marks were rebuilt under the selection; it still covers the same text.
        let kept = try await eval("window.getSelection().toString()") as? String
        XCTAssertEqual(kept, selected)

        try await find("foo", scope: 1)
        try await expectMarkCount(1)
        let marked = try await eval("document.querySelector('#gn-article mark.gn-find').parentNode.textContent") as? String
        XCTAssertEqual(marked, "foo two")
        // A new query keeps the scope of the same token, even with the selection gone.
        _ = try await eval("window.getSelection().removeAllRanges()")
        try await find("o", scope: 1)
        try await expectMarks(["o", "o", "o"])
        // Off: the whole page.
        try await find("foo")
        try await expectMarkCount(3)
        // On again with nothing selected: the whole page too.
        try await find("foo", scope: 2)
        try await expectMarkCount(3)
    }

    func testMatchTicksSitOnTheEdgeAndAClickGoesToThatMatch() async throws {
        let doc = (1...6).map { "foo \($0)\n\n" + String(repeating: "filler line\n\n", count: 20) }.joined()
        _ = try await eval("window.gnRender(\(MarkdownWebView.jsString(doc)))")
        try await find("foo", ticks: true)
        let ticks = try await eval("document.querySelectorAll('#gn-find-ticks .gn-find-tick').length") as? Int
        XCTAssertEqual(ticks, 6)
        let current = try await eval("document.querySelectorAll('#gn-find-ticks .gn-find-tick-current').length") as? Int
        XCTAssertEqual(current, 1)
        // Top to bottom, in document order.
        let tops = try await eval("""
        Array.from(document.querySelectorAll('#gn-find-ticks .gn-find-tick')).sort(function(a,b){return a.getAttribute('data-i')-b.getAttribute('data-i')}).map(function(t){return parseFloat(t.style.top)})
        """) as? [Double] ?? []
        XCTAssertEqual(tops, tops.sorted())
        XCTAssertEqual(Set(tops).count, 6)

        _ = try await eval("document.querySelector('#gn-find-ticks .gn-find-tick[data-i=\"4\"]').click()")
        XCTAssertEqual(bridge.finds.last?.index, 5)
        let moved = try await eval("document.querySelector('#gn-find-ticks .gn-find-tick-current').getAttribute('data-i')") as? String
        XCTAssertEqual(moved, "4")

        // Off in the configuration: no lane at all.
        try await find("foo", ticks: false)
        let gone = try await eval("document.getElementById('gn-find-ticks')===null") as? Bool
        XCTAssertEqual(gone, true)
    }

    /// PR #80 review: a live-preview render re-ran the search from scratch and
    /// jumped back to the first match. A refresh keeps the selected match.
    func testARenderDuringASearchKeepsTheSelectedMatch() async throws {
        let doc = "foo one\n\nfoo two\n\nfoo three\n"
        _ = try await eval("window.gnRender(\(MarkdownWebView.jsString(doc)))")
        _ = try await eval("window.gnFind('foo')")
        _ = try await eval("window.gnFindStep(1)")
        XCTAssertEqual(bridge.finds.last?.index, 2)

        // The editor changed the text: Swift renders and refreshes the search.
        _ = try await eval("window.gnRender(\(MarkdownWebView.jsString(doc + "\nmore\n")))")
        _ = try await eval("window.gnFind('foo',true)")
        let current = try await eval("""
        (function(){var ms=Array.from(document.querySelectorAll('#gn-article mark.gn-find'));
          return ms.indexOf(document.querySelector('#gn-article mark.gn-find-current'));})()
        """) as? Int
        XCTAssertEqual(current, 1)
        XCTAssertEqual(bridge.finds.last?.index, 2)
        XCTAssertEqual(bridge.finds.last?.count, 3)

        // A new search still starts at the first match.
        _ = try await eval("window.gnFind('foo')")
        XCTAssertEqual(bridge.finds.last?.index, 1)
    }
}
