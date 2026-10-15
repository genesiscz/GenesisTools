import WebKit
import XCTest
@testable import GenesisKit

/// Each tab keeps its own reading position, and the window remembers them
/// between launches.
@MainActor
final class MarkdownScrollMemoryTests: XCTestCase {
    private var dir: URL!

    override func setUp() async throws {
        dir = FileManager.default.temporaryDirectory.appendingPathComponent("md-scroll-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    }

    private func note(_ name: String) throws -> URL {
        let url = dir.appendingPathComponent(name)
        try "# \(name)\n\nbody\n".write(to: url, atomically: true, encoding: .utf8)
        return url
    }

    func testEachTabAndPaneKeepsItsOwnPositionAcrossAReopen() throws {
        let defaults = UserDefaults(suiteName: "md-scroll-\(UUID().uuidString)")!
        let a = try note("A.md")
        let b = try note("B.md")

        let first = MarkdownDocumentsModel(defaults: defaults)
        first.open([a, b])
        first.rememberScroll(1200, for: a.path, pane: .preview)
        first.rememberScroll(340, for: a.path, pane: .source)
        first.rememberScroll(80, for: b.path, pane: .preview)

        XCTAssertEqual(first.scrollOffset(for: a.path, pane: .preview), 1200)
        XCTAssertEqual(first.scrollOffset(for: a.path, pane: .source), 340)
        XCTAssertEqual(first.scrollOffset(for: b.path, pane: .preview), 80)
        XCTAssertNil(first.scrollOffset(for: b.path, pane: .source))

        // Writes are coalesced, so the positions reach the disk when the
        // window closes — which is what `windowShouldClose` does before a
        // relaunch, and what this stands in for.
        first.flushScroll()

        // A new window, the same defaults: the tabs come back where they were.
        let second = MarkdownDocumentsModel(defaults: defaults)
        XCTAssertEqual(second.docs.map(\.id).sorted(), [a.path, b.path].sorted())
        XCTAssertEqual(second.scrollOffset(for: a.path, pane: .preview), 1200)
        XCTAssertEqual(second.scrollOffset(for: b.path, pane: .preview), 80)
    }

    func testClosingATabForgetsItsPosition() throws {
        let defaults = UserDefaults(suiteName: "md-scroll-\(UUID().uuidString)")!
        let a = try note("A.md")
        let b = try note("B.md")
        let model = MarkdownDocumentsModel(defaults: defaults)
        model.open([a, b])
        model.rememberScroll(500, for: a.path, pane: .preview)
        model.rememberScroll(500, for: b.path, pane: .preview)

        let doc = try XCTUnwrap(model.docs.first { $0.id == a.path })
        model.close(doc) { _ in .discard }
        // Still remembered until the next write, then dropped with the tab.
        model.rememberScroll(600, for: b.path, pane: .preview)
        XCTAssertNil(model.scrollOffset(for: a.path, pane: .preview))
        XCTAssertEqual(model.scrollOffset(for: b.path, pane: .preview), 600)
    }

    /// The page reports its position and takes one back.
    func testThePageReportsAndRestoresItsScroll() async throws {
        final class Bridge: NSObject, WKScriptMessageHandler, WKNavigationDelegate {
            var tops: [Double] = []
            var loaded: XCTestExpectation?
            func userContentController(_ ucc: WKUserContentController, didReceive message: WKScriptMessage) {
                guard let body = message.body as? [String: Any], body["type"] as? String == "scroll",
                      let top = body["top"] as? Double else { return }
                tops.append(top)
            }
            func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) { loaded?.fulfill() }
        }
        let bridge = Bridge()
        let controller = WKUserContentController()
        controller.add(bridge, name: "bridge")
        let config = WKWebViewConfiguration()
        config.userContentController = controller
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

        let long = (1...100).map { "Paragraph \($0)." }.joined(separator: "\n\n")
        _ = try await web.evaluateJavaScript("window.gnRender(\(MarkdownWebView.jsString(long)))")
        _ = try await web.evaluateJavaScript("window.gnScrollTo(900)")
        let top = try await web.evaluateJavaScript("window.gnScrollTop()") as? Double
        XCTAssertEqual(top ?? 0, 900, accuracy: 2)

        // Scrolling reports the new position through the bridge.
        _ = try await web.evaluateJavaScript(
            "(document.scrollingElement||document.documentElement).scrollTop=300;window.dispatchEvent(new Event('scroll'))"
        )
        for _ in 0..<40 where bridge.tops.isEmpty {
            try? await Task.sleep(nanoseconds: 50_000_000)
        }
        XCTAssertEqual(bridge.tops.last ?? -1, 300, accuracy: 2)
    }
}
