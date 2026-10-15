import WebKit
import XCTest
@testable import GenesisKit

/// The reading column used to be a fixed 860 px, so a wide window just grew
/// its margins. Now the grips beside the page drag it wider and the width is
/// remembered per window model. Runs the real page in a WKWebView.
@MainActor
final class MarkdownColumnWidthTests: XCTestCase {
    private final class Bridge: NSObject, WKScriptMessageHandler, WKNavigationDelegate {
        var widths: [Double] = []
        var loaded: XCTestExpectation?
        func userContentController(_ ucc: WKUserContentController, didReceive message: WKScriptMessage) {
            guard let body = message.body as? [String: Any], body["type"] as? String == "width",
                  let value = body["value"] as? Double else { return }
            widths.append(value)
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
        web = WKWebView(frame: NSRect(x: 0, y: 0, width: 1600, height: 900), configuration: config)
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

    private func columnWidth() async throws -> Double {
        try await eval("document.getElementById('gn-column').getBoundingClientRect().width") as? Double ?? -1
    }

    func testDefaultColumnIsTheStylesheetWidthAndGnWidthStretchesIt() async throws {
        _ = try await eval("window.gnRender('# Title\\n\\nbody')")
        var width = try await columnWidth()
        XCTAssertEqual(width, 860, accuracy: 1)

        _ = try await eval("window.gnWidth(1300)")
        width = try await columnWidth()
        XCTAssertEqual(width, 1300, accuracy: 1)

        // Wider than the pane: the column stops at the pane's inner width.
        _ = try await eval("window.gnWidth(5000)")
        width = try await columnWidth()
        XCTAssertEqual(width, 1600 - 60, accuracy: 1)

        _ = try await eval("window.gnWidth(null)")
        width = try await columnWidth()
        XCTAssertEqual(width, 860, accuracy: 1)
    }

    func testDraggingTheRightGripWidensTheColumnAndReportsTheWidthOnMouseUp() async throws {
        _ = try await eval("window.gnRender('# Title\\n\\nbody')")
        // The column is centred, so moving one edge by 100 px widens it by 200.
        let drag = """
        (function(){
          var g=document.querySelector('.gn-grip-r');
          function ev(t,x,target){var e=new MouseEvent(t,{bubbles:true,cancelable:true,button:0,clientX:x,clientY:100});(target||window).dispatchEvent(e);}
          ev('mousedown',1230,g);ev('mousemove',1280);ev('mousemove',1330);ev('mouseup',1330);
          return document.getElementById('gn-column').getBoundingClientRect().width;
        })()
        """
        let live = try await eval(drag) as? Double ?? -1
        XCTAssertEqual(live, 1060, accuracy: 1)
        XCTAssertEqual(bridge.widths, [1060])

        // The left grip works mirrored: dragging it left widens too.
        let dragLeft = """
        (function(){
          var g=document.querySelector('.gn-grip-l');
          function ev(t,x,target){var e=new MouseEvent(t,{bubbles:true,cancelable:true,button:0,clientX:x,clientY:100});(target||window).dispatchEvent(e);}
          ev('mousedown',260,g);ev('mousemove',210);ev('mouseup',210);
          return document.getElementById('gn-column').getBoundingClientRect().width;
        })()
        """
        let wider = try await eval(dragLeft) as? Double ?? -1
        XCTAssertEqual(wider, 1160, accuracy: 1)
        XCTAssertEqual(bridge.widths, [1060, 1160])
    }

    /// PR #80 review: the grips were mouse-only. They are focusable separators
    /// now; the arrows move that edge like a drag and Enter resets.
    func testTheGripsWorkFromTheKeyboard() async throws {
        _ = try await eval("window.gnRender('# Title\\n\\nbody')")
        let tab = try await eval("document.querySelector('.gn-grip-r').tabIndex") as? Int
        XCTAssertEqual(tab, 0)
        let role = try await eval("document.querySelector('.gn-grip-l').getAttribute('role')") as? String
        XCTAssertEqual(role, "separator")
        func key(_ grip: String, _ name: String) -> String {
            "document.querySelector('.\(grip)').dispatchEvent(new KeyboardEvent('keydown',{key:'\(name)',bubbles:true,cancelable:true}))"
        }
        // Right edge moves right by 20: the centred column grows by 40.
        _ = try await eval(key("gn-grip-r", "ArrowRight"))
        var width = try await columnWidth()
        XCTAssertEqual(width, 900, accuracy: 1)
        // The left edge moving left widens too.
        _ = try await eval(key("gn-grip-l", "ArrowLeft"))
        width = try await columnWidth()
        XCTAssertEqual(width, 940, accuracy: 1)
        _ = try await eval(key("gn-grip-l", "Enter"))
        width = try await columnWidth()
        XCTAssertEqual(width, 860, accuracy: 1)
        XCTAssertEqual(bridge.widths, [900, 940, 0])
    }

    func testDoubleClickOnAGripResetsToTheDefaultAndReportsZero() async throws {
        _ = try await eval("window.gnWidth(1300)")
        _ = try await eval("document.querySelector('.gn-grip-l').dispatchEvent(new MouseEvent('dblclick',{bubbles:true,cancelable:true}))")
        let width = try await columnWidth()
        XCTAssertEqual(width, 860, accuracy: 1)
        XCTAssertEqual(bridge.widths, [0])
    }

    func testModelRemembersTheWidthAndTreatsZeroAsTheDefault() {
        let key = "markdownWindow.articleWidth"
        let previous = UserDefaults.standard.object(forKey: key)
        defer {
            if let previous { UserDefaults.standard.set(previous, forKey: key) }
            else { UserDefaults.standard.removeObject(forKey: key) }
        }
        UserDefaults.standard.removeObject(forKey: key)
        let model = MarkdownDocumentsModel()
        XCTAssertEqual(model.articleWidth, 0)
        model.articleWidth = 1240
        XCTAssertEqual(UserDefaults.standard.double(forKey: key), 1240)
        XCTAssertEqual(MarkdownDocumentsModel().articleWidth, 1240)
        model.articleWidth = 0
        XCTAssertEqual(MarkdownDocumentsModel().articleWidth, 0)
    }
}
