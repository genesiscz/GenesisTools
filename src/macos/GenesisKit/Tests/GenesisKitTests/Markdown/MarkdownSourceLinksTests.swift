import WebKit
import XCTest
@testable import GenesisKit

/// ⌘-click in the source follows the same links the reading view does, and a
/// reference-style link resolves through its definition line.
final class MarkdownSourceLinksTests: XCTestCase {
    private let note = """
    ---
    tags: [a]
    ---
    # Plan

    See [[Other Note|the other one]] and [the report](./2026-09-01_report.pdf).
    Reference style: [the spec][spec] and a bare https://gitlab.dev/x/y link.

    [spec]: ./Spec.md
    """

    private func offset(of needle: String) -> Int {
        (note as NSString).range(of: needle).location
    }

    func testEveryLinkFormOnTheLineIsFollowed() {
        XCTAssertEqual(MarkdownSourceLinks.target(in: note, at: offset(of: "Other Note") + 2), "Other Note")
        // The alias half of a wikilink points at the same note.
        XCTAssertEqual(MarkdownSourceLinks.target(in: note, at: offset(of: "the other one")), "Other Note")
        XCTAssertEqual(
            MarkdownSourceLinks.target(in: note, at: offset(of: "the report") + 3),
            "./2026-09-01_report.pdf"
        )
        XCTAssertEqual(MarkdownSourceLinks.target(in: note, at: offset(of: "the spec") + 2), "spec")
        XCTAssertEqual(
            MarkdownSourceLinks.target(in: note, at: offset(of: "gitlab.dev")),
            "https://gitlab.dev/x/y"
        )
        // Plain prose is not a link.
        XCTAssertNil(MarkdownSourceLinks.target(in: note, at: offset(of: "# Plan") + 3))
        XCTAssertNil(MarkdownSourceLinks.target(in: note, at: 0))
    }

    func testWikilinkHeadingsSurviveClicksOnTargetsAndAliases() {
        for (link, target) in [
            ("[[Other Note#Part two|alias]]", "Other Note#Part two"),
            ("![[Other Note#Part two]]", "Other Note#Part two"),
            ("[[#Local heading|here]]", "#Local heading"),
        ] {
            let text = "See \(link) now"
            for offset in 4..<(4 + (link as NSString).length) {
                XCTAssertEqual(MarkdownSourceLinks.target(in: text, at: offset), target)
            }
        }
    }

    func testAReferenceLabelResolvesThroughItsDefinition() {
        XCTAssertEqual(MarkdownSourceLinks.reference("spec", in: note), "./Spec.md")
        XCTAssertNil(MarkdownSourceLinks.reference("missing", in: note))
        // A definition with a title keeps only the destination.
        XCTAssertEqual(
            MarkdownSourceLinks.reference("x", in: "[x]: ./A.md \"A title\"\n"),
            "./A.md"
        )
    }

    func testAngleBracketsAndTitlesAreStripped() {
        let line = "see [it](<./a file.md> \"Title\")"
        XCTAssertEqual(MarkdownSourceLinks.target(in: line, at: 6), "./a file.md")
    }

    /// The reading view side: a reference-style link renders as a plain
    /// relative link, so it goes through the same bridge message as any other.
    @MainActor
    func testReferenceLinksReachTheBridgeFromTheRenderedPage() async throws {
        final class Bridge: NSObject, WKScriptMessageHandler, WKNavigationDelegate {
            var hrefs: [String] = []
            var loaded: XCTestExpectation?
            func userContentController(_ ucc: WKUserContentController, didReceive message: WKScriptMessage) {
                guard let body = message.body as? [String: Any], body["type"] as? String == "openrel",
                      let href = body["href"] as? String else { return }
                hrefs.append(href)
            }
            func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) { loaded?.fulfill() }
        }
        let bridge = Bridge()
        let controller = WKUserContentController()
        controller.add(bridge, name: "bridge")
        let config = WKWebViewConfiguration()
        config.userContentController = controller
        config.setURLSchemeHandler(MarkdownWebView.AssetSchemeHandler(), forURLScheme: MarkdownWebView.assetScheme)
        let web = WKWebView(frame: NSRect(x: 0, y: 0, width: 800, height: 600), configuration: config)
        web.navigationDelegate = bridge
        let window = NSWindow(contentRect: web.frame, styleMask: [.borderless], backing: .buffered, defer: false)
        window.contentView = web
        defer { window.contentView = nil }
        let loaded = expectation(description: "page loaded")
        bridge.loaded = loaded
        web.loadHTMLString(MarkdownWebView.template, baseURL: URL(string: "\(MarkdownWebView.assetScheme)://asset/"))
        await fulfillment(of: [loaded], timeout: 10)

        let body = "See [the spec][spec].\n\n[spec]: ./Spec.md\n"
        _ = try await web.evaluateJavaScript("window.gnRender(\(MarkdownWebView.jsString(body)))")
        _ = try await web.evaluateJavaScript(
            "document.querySelector('#gn-article a').dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true}))"
        )
        for _ in 0..<40 where bridge.hrefs.isEmpty {
            try? await Task.sleep(nanoseconds: 50_000_000)
        }
        XCTAssertEqual(bridge.hrefs, ["./Spec.md"])
    }
}
