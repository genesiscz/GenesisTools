import WebKit
import XCTest
@testable import GenesisKit

/// The page renders the frontmatter rows as a properties block above the
/// article, and edits in it come back through the bridge as the full row list.
@MainActor
final class MarkdownPropertiesWebTests: XCTestCase {
    private final class Bridge: NSObject, WKScriptMessageHandler, WKNavigationDelegate {
        var posted: [[MarkdownProperty]] = []
        var loaded: XCTestExpectation?
        func userContentController(_ ucc: WKUserContentController, didReceive message: WKScriptMessage) {
            guard let body = message.body as? [String: Any], body["type"] as? String == "properties",
                  let rows = MarkdownFrontmatter.properties(fromBridge: body["items"]) else { return }
            posted.append(rows)
        }
        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) { loaded?.fulfill() }
    }

    private var web: WKWebView!
    private var bridge: Bridge!
    private var window: NSWindow!

    private let note = "---\ntitle: Hello\ntags: [a, b]\ndone: false\nn: 3\n---\n# Heading\n\nbody\n"

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

    private func render(editable: Bool, note: String? = nil) async throws {
        let (yaml, body) = MarkdownFrontmatter.split(note ?? self.note)
        let props = MarkdownFrontmatter.json(MarkdownFrontmatter.parse(yaml: yaml!))
        _ = try await eval("window.gnRender(\(MarkdownWebView.jsString(body)),\(props),\(editable))")
    }

    private func posted() async -> [MarkdownProperty]? {
        for _ in 0..<40 where bridge.posted.isEmpty {
            try? await Task.sleep(nanoseconds: 50_000_000)
        }
        return bridge.posted.last
    }

    func testTheBlockRendersEveryRowAsObsidianDoesAndTheBodyHasNoStrayHeading() async throws {
        try await render(editable: true)
        let keys = try await eval("Array.from(document.querySelectorAll('#gn-props .gn-prop-name')).map(function(e){return e.textContent})") as? [String]
        XCTAssertEqual(keys, ["title", "tags", "done", "n"])
        let chips = try await eval("Array.from(document.querySelectorAll('#gn-props .gn-prop-tags .gn-chip')).map(function(e){return e.firstChild.textContent})") as? [String]
        XCTAssertEqual(chips, ["#a", "#b"])
        let checked = try await eval("document.querySelector('#gn-props input[type=checkbox]').checked") as? Bool
        XCTAssertEqual(checked, false)
        let numberType = try await eval("document.querySelectorAll('#gn-props input')[document.querySelectorAll('#gn-props input').length-1].type") as? String
        XCTAssertEqual(numberType, "number")
        // The block sits above the article's first heading, and the frontmatter
        // never reached markdown-it (it used to become a setext heading).
        let firstTag = try await eval("document.getElementById('gn-article').firstElementChild.id") as? String
        XCTAssertEqual(firstTag, "gn-props")
        let h2 = try await eval("document.querySelectorAll('#gn-article h2').length") as? Int
        XCTAssertEqual(h2, 0)
        let addButtons = try await eval("document.querySelectorAll('#gn-props .gn-props-add').length") as? Int
        XCTAssertEqual(addButtons, 1)
    }

    func testEditingTheTextValuePostsTheWholeRowListOnBlur() async throws {
        try await render(editable: true)
        _ = try await eval("""
        (function(){var i=document.querySelector('#gn-props input[type=text]');i.focus();i.value='Changed';i.blur();})()
        """)
        let rows = await posted()
        XCTAssertEqual(rows?.map(\.key), ["title", "tags", "done", "n"])
        XCTAssertEqual(rows?[0].value, "Changed")
        XCTAssertEqual(rows?[1].items, ["a", "b"])
        XCTAssertEqual(rows?[1].inline, true)
        // And applied to the note it is a one-line change.
        let out = MarkdownFrontmatter.replacing(properties: rows!, in: note)
        XCTAssertEqual(out, note.replacingOccurrences(of: "title: Hello", with: "title: Changed"))
    }

    func testEnterInTheTagInputAddsATagAndCheckboxTogglePosts() async throws {
        try await render(editable: true)
        _ = try await eval("""
        (function(){var i=document.querySelector('#gn-props .gn-chip-in');i.value='#c';
          i.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));})()
        """)
        var rows = await posted()
        XCTAssertEqual(rows?[1].items, ["a", "b", "c"])
        bridge.posted = []
        _ = try await eval("(function(){var c=document.querySelector('#gn-props input[type=checkbox]');c.click();})()")
        rows = await posted()
        XCTAssertEqual(rows?[2].value, "true")
    }

    func testRemoveAndTypeChange() async throws {
        try await render(editable: true)
        _ = try await eval("document.querySelectorAll('#gn-props .gn-prop-remove')[3].click()")
        var rows = await posted()
        XCTAssertEqual(rows?.map(\.key), ["title", "tags", "done"])
        bridge.posted = []
        // Open the type menu on `title` and pick List.
        _ = try await eval("""
        (function(){document.querySelector('#gn-props .gn-prop-icon').dispatchEvent(new MouseEvent('click',{bubbles:true}));
          var items=document.querySelectorAll('.gn-prop-menu div');items[5].click();})()
        """)
        rows = await posted()
        XCTAssertEqual(rows?[0].kind, .list)
        XCTAssertEqual(rows?[0].items, ["Hello"])
    }

    // MARK: PR #80 review

    /// Enter then a blur (Tab away before the 220 ms split-view render) used to
    /// add the item twice, and a list item lost its leading '#'.
    func testEnterThenBlurAddsAListItemOnceAndKeepsItsHash() async throws {
        try await render(editable: true, note: "---\nrefs: [x]\n---\nbody\n")
        _ = try await eval("""
        (function(){var i=document.querySelector('#gn-props .gn-chip-in');i.focus();i.value='#123';
          i.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));i.blur();})()
        """)
        let rows = await posted()
        XCTAssertEqual(rows?[0].kind, .list)
        XCTAssertEqual(rows?[0].items, ["x", "#123"])
        try await Task.sleep(nanoseconds: 200_000_000)
        XCTAssertEqual(bridge.posted.count, 1)
    }

    /// Every field carries its property's name, and the type menu opens from a
    /// real button and is driven by the arrows and Enter.
    func testFieldsAreLabelledAndTheTypeMenuWorksFromTheKeyboard() async throws {
        try await render(editable: true)
        let labels = try await eval(
            "Array.from(document.querySelectorAll('#gn-props .gn-prop-value input')).map(function(e){return e.getAttribute('aria-label')})"
        ) as? [String]
        XCTAssertEqual(labels, ["title", "Add tag to tags", "done", "n"])
        let trigger = try await eval(
            "(function(){var b=document.querySelector('#gn-props .gn-prop-type');return b.tagName+'|'+b.getAttribute('aria-label');})()"
        ) as? String
        XCTAssertEqual(trigger, "BUTTON|Property type: Text")
        let focused = try await eval("""
        (function(){document.querySelector('#gn-props .gn-prop-type').click();
          return document.activeElement.textContent;})()
        """) as? String
        XCTAssertEqual(focused, "Text")
        _ = try await eval("""
        (function(){var m=document.querySelector('.gn-prop-menu');
          m.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowDown',bubbles:true}));
          m.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));})()
        """)
        let rows = await posted()
        XCTAssertEqual(rows?[0].kind, .number)
        // Escape closes the menu and gives focus back to the button.
        let back = try await eval("""
        (function(){var b=document.querySelectorAll('#gn-props .gn-prop-type')[1];b.click();
          document.querySelector('.gn-prop-menu').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));
          return !document.querySelector('.gn-prop-menu')&&document.activeElement===b;})()
        """) as? Bool
        XCTAssertEqual(back, true)
    }

    func testReadOnlyRendersRowsWithoutEditingControls() async throws {
        try await render(editable: false)
        let ro = try await eval("document.getElementById('gn-props').classList.contains('gn-ro')") as? Bool
        XCTAssertEqual(ro, true)
        let editable = try await eval("document.querySelectorAll('#gn-props [contenteditable]').length") as? Int
        XCTAssertEqual(editable, 0)
        let text = try await eval("document.querySelector('#gn-props .gn-prop-value').textContent") as? String
        XCTAssertEqual(text, "Hello")
    }
}
