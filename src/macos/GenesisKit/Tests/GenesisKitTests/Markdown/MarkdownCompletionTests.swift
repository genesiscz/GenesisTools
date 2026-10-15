import AppKit
import WebKit
import XCTest
@testable import GenesisKit

/// `[[` offers vault notes, `#` offers tags the vault already uses.
final class MarkdownCompletionTests: XCTestCase {
    private func request(_ text: String, caret: Int) -> MarkdownCompletion.Request? {
        MarkdownCompletion.request(in: text, caret: caret)
    }

    func testWikilinkTriggersAfterTwoBracketsAndStopsAtTheClose() {
        let text = "see [[Rep"
        let r = request(text, caret: (text as NSString).length)
        XCTAssertEqual(r?.kind, .wikilink)
        XCTAssertEqual(r?.query, "Rep")
        XCTAssertEqual(r?.range, NSRange(location: 6, length: 3))

        // Once the link is closed the caret is back in prose.
        let closed = "see [[Report]] now"
        XCTAssertNil(request(closed, caret: (closed as NSString).length))
        XCTAssertNil(request("no brackets here", caret: 5))
        // A single bracket is not a wikilink.
        XCTAssertNil(request("see [Report", caret: 11))
    }

    func testTagTriggersOnAWordBoundaryButNeverOnAHeading() {
        let text = "work on #col"
        let r = request(text, caret: (text as NSString).length)
        XCTAssertEqual(r?.kind, .tag)
        XCTAssertEqual(r?.query, "col")
        XCTAssertEqual(r?.range, NSRange(location: 9, length: 3))

        // A heading is not a tag, and neither is a `#` inside a word.
        XCTAssertNil(request("# Heading", caret: 9))
        XCTAssertNil(request("## Sub", caret: 6))
        XCTAssertNil(request("issue#12", caret: 8))
        // A tag with a slash is one tag.
        XCTAssertEqual(request("see #col/fe", caret: 11)?.query, "col/fe")
    }

    func testInsertionClosesTheBracketsOnlyOnce() {
        XCTAssertEqual(MarkdownCompletion.insertion("Note", kind: .wikilink, followedBy: ""), "Note]]")
        XCTAssertEqual(MarkdownCompletion.insertion("Note", kind: .wikilink, followedBy: "]]"), "Note")
        XCTAssertEqual(MarkdownCompletion.insertion("web-app", kind: .tag, followedBy: ""), "web-app")
    }

    /// The text view hands AppKit the typed part, so the chosen name replaces
    /// exactly that and nothing else.
    @MainActor
    func testTheTextViewCompletesOnlyTheTypedPart() {
        let view = SourceTextView(frame: NSRect(x: 0, y: 0, width: 400, height: 200))
        view.string = "see [[Rep"
        view.setSelectedRange(NSRange(location: 9, length: 0))
        XCTAssertEqual(view.rangeForUserCompletion, NSRange(location: 6, length: 3))
        view.insertCompletion("Report", forPartialWordRange: NSRange(location: 6, length: 3), movement: 0, isFinal: true)
        XCTAssertEqual(view.string, "see [[Report]]")
    }
}

/// The Properties block suggests the keys and values the vault already uses.
@MainActor
final class MarkdownPropertyVocabularyTests: XCTestCase {
    /// The page filters that vocabulary as you type, in the key field and in
    /// the value field, and never offers a key the note already carries.
    func testTheBlockOffersKeysAndValuesInThePage() async throws {
        final class Loader: NSObject, WKNavigationDelegate {
            var loaded: XCTestExpectation?
            func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) { loaded?.fulfill() }
        }
        let loader = Loader()
        let config = WKWebViewConfiguration()
        config.userContentController = WKUserContentController()
        config.userContentController.add(Sink(), name: "bridge")
        config.setURLSchemeHandler(MarkdownWebView.AssetSchemeHandler(), forURLScheme: MarkdownWebView.assetScheme)
        let web = WKWebView(frame: NSRect(x: 0, y: 0, width: 1000, height: 700), configuration: config)
        web.navigationDelegate = loader
        let window = NSWindow(contentRect: web.frame, styleMask: [.borderless], backing: .buffered, defer: false)
        window.contentView = web
        defer { window.contentView = nil }
        let loaded = expectation(description: "page loaded")
        loader.loaded = loaded
        web.loadHTMLString(MarkdownWebView.template, baseURL: URL(string: "\(MarkdownWebView.assetScheme)://asset/"))
        await fulfillment(of: [loaded], timeout: 10)

        let note = "---\nstatus: DRAFT\n---\n# Title\n"
        let (yaml, body) = MarkdownFrontmatter.split(note)
        let props = MarkdownFrontmatter.json(MarkdownFrontmatter.parse(yaml: yaml!))
        let vocabulary = #"{"status":["DRAFT","done"],"owner":["martin","alice"],"tags":["web-app"]}"#
        _ = try await web.evaluateJavaScript(
            "window.gnRender(\(MarkdownWebView.jsString(body)),\(props),true,\(vocabulary))"
        )

        // The value field offers the other values of this key.
        _ = try await web.evaluateJavaScript("""
        (function(){var i=document.querySelector('#gn-props input[type=text]');i.focus();i.value='d';
          i.dispatchEvent(new Event('input'));})()
        """)
        let values = try await web.evaluateJavaScript(
            "Array.from(document.querySelectorAll('#gn-suggest div')).map(function(e){return e.textContent})") as? [String]
        // Both start with "d", so the vocabulary's own order (most used first) holds.
        XCTAssertEqual(values, ["DRAFT", "done"])

        // A new row's key field offers the keys this note does not have yet.
        _ = try await web.evaluateJavaScript("""
        (function(){document.querySelector('.gn-props-add').click();
          var n=document.querySelectorAll('#gn-props .gn-prop-name');var last=n[n.length-1];
          last.focus();last.dispatchEvent(new Event('input'));})()
        """)
        let keys = try await web.evaluateJavaScript(
            "Array.from(document.querySelectorAll('#gn-suggest div')).map(function(e){return e.textContent})") as? [String]
        XCTAssertEqual(keys?.contains("status"), false)
        XCTAssertEqual(keys?.sorted(), ["owner", "tags"])
    }

    private final class Sink: NSObject, WKScriptMessageHandler {
        func userContentController(_ ucc: WKUserContentController, didReceive message: WKScriptMessage) {}
    }
}
