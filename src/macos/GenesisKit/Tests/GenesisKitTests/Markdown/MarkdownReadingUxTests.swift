import SwiftUI
import WebKit
import XCTest
@testable import GenesisKit

/// The reading pane's answers from the UX audit of 2026-10-25 (P1 to P21): a dead link or anchor says so, a page
/// that fails to draw offers Retry, headings with the same title stay apart, a removed property can be undone, and
/// pictures say what they are. Pages run in hidden, never-ordered-front windows.
@MainActor
final class MarkdownReadingUxTests: XCTestCase {
    private var window: NSWindow?
    private var coordinator: MarkdownWebView.Coordinator?
    private var messages: [[String: Any]] = []

    override func tearDown() {
        coordinator?.hideNotice()
        window?.contentView = nil
        window = nil
        coordinator = nil
        messages = []
    }

    private func view(_ markdown: String = "", onRelativeLink: ((String) -> Void)? = nil,
                      onProperties: (([MarkdownProperty]) -> Void)? = nil) -> MarkdownWebView {
        MarkdownWebView(markdown: markdown, scrollTarget: nil, highlightQuery: nil, highlightToken: 0,
                        onWikilink: { _ in }, onActiveSection: { _ in }, onRelativeLink: onRelativeLink,
                        onProperties: onProperties)
    }

    /// A page driven by the app's own coordinator, in a hidden window.
    private func page(_ view: MarkdownWebView) async throws -> (WKWebView, MarkdownWebView.Coordinator) {
        let coordinator = MarkdownWebView.Coordinator(view)
        let config = MarkdownWebView.configuration(for: coordinator)
        let web = WKWebView(frame: NSRect(x: 0, y: 0, width: 800, height: 600), configuration: config)
        web.navigationDelegate = coordinator
        coordinator.web = web
        let window = NSWindow(contentRect: web.frame, styleMask: [.borderless], backing: .buffered, defer: false)
        window.contentView = web
        web.loadHTMLString(MarkdownWebView.template, baseURL: URL(string: "\(MarkdownWebView.assetScheme)://asset/"))
        for _ in 0..<100 where !coordinator.ready {
            try await Task.sleep(nanoseconds: 50_000_000)
        }
        XCTAssertTrue(coordinator.ready)
        self.window = window
        self.coordinator = coordinator
        return (web, coordinator)
    }

    private func render(_ web: WKWebView, _ markdown: String, props: String = "[]", editable: Bool = false,
                        media: String = "{}") async throws -> String? {
        try await web.evaluateJavaScript(
            "window.gnRender(\(MarkdownWebView.jsString(markdown)),\(props),\(editable),null,\(media),false,1)") as? String
    }

    /// Lets the page's script messages reach the coordinator.
    private func settle() async throws {
        try await Task.sleep(nanoseconds: 150_000_000)
    }

    // MARK: P3, P4: headings with the same title, a second click

    func testHeadingsWithTheSameTitleGetTheIdsTheOutlineNames() async throws {
        let markdown = "# Notes\n\n## Examples\n\nOne.\n\n## Examples\n\nTwo.\n\n## Examples 1\n\nThree."
        let (web, _) = try await page(view())
        _ = try await render(web, markdown)
        let ids = try await web.evaluateJavaScript(
            "Array.from(document.querySelectorAll('#gn-article h1,#gn-article h2')).map(function(h){return h.id})") as? [String]
        XCTAssertEqual(ids, ["notes", "examples", "examples-1", "examples-1-1"])
        XCTAssertEqual(MarkdownOutline.items(of: markdown).map(\.slug), ids, "one numbering on both sides")
        XCTAssertEqual(MarkdownBlocks.uniqueSlugs(["a", "a", "a-1", "a"]), ["a", "a-1", "a-1-1", "a-2"])
    }

    func testASecondClickOnTheSameRowIsANewTargetForTheSameHeading() {
        let item = MarkdownOutline.Item(level: 2, text: "Examples", slug: "examples-1", index: 3)
        let first = MarkdownOutline.target(for: item, current: nil)
        XCTAssertEqual(first, "examples-1")
        let second = MarkdownOutline.target(for: item, current: first)
        XCTAssertNotEqual(second, first, "a new value, so both renderers see a change")
        XCTAssertEqual(MarkdownOutline.target(for: item, current: second), first, "and back again on a third click")
        XCTAssertEqual(MarkdownBlocks.slugify(second), "examples-1", "it still names the same heading")
    }

    // MARK: P1: a link that goes nowhere answers

    func testAHeadingThatIsNotThereIsAnsweredOnThePage() async throws {
        let (web, coordinator) = try await page(view())
        _ = try await render(web, "# Setup\n\n[gone](#renamed-heading) and [[#Missing part]]")
        let found = try await web.evaluateJavaScript("window.gnScrollToSlug('setup','Setup')") as? Bool
        XCTAssertEqual(found, true)
        try await settle()
        XCTAssertNil(coordinator.currentNotice, "a heading that is there gets no notice")

        _ = try await web.evaluateJavaScript("document.querySelector('a.dd-wikilink').click();true")
        try await settle()
        XCTAssertEqual(coordinator.currentNotice?.text, "No heading “Missing part” in this note.")
        XCTAssertTrue(coordinator.noticeHost?.superview === web, "shown over the page")

        _ = try await web.evaluateJavaScript("document.querySelector('a[href^=\"#\"]:not(.dd-wikilink)').click();true")
        try await settle()
        XCTAssertEqual(coordinator.currentNotice?.text, "No heading “renamed-heading” in this note.")
    }

    func testABlockedSchemeAndAPaneWithNoFileLinksSaySo() async throws {
        let (web, coordinator) = try await page(view())
        _ = try await render(web, "[server](ssh://example.org) and [file](./x.pdf)")
        _ = try await web.evaluateJavaScript("document.querySelector('a[href^=\"ssh\"]').click();true")
        try await settle()
        XCTAssertEqual(coordinator.currentNotice?.text, "The viewer does not open ssh: links.")
        XCTAssertEqual(coordinator.currentNotice?.kind, .link)
        XCTAssertEqual(coordinator.currentNotice?.lasts, 6, "a link notice goes by itself")

        _ = try await web.evaluateJavaScript("document.querySelector('a[href^=\"./\"]').click();true")
        try await settle()
        XCTAssertEqual(coordinator.currentNotice, .noFileLinks)
    }

    // MARK: P2: a page that fails to draw

    func testAFailedRenderKeepsTheLastTextAndOffersRetryWithTheRawErrorBehindDetails() async throws {
        let (web, coordinator) = try await page(view())
        let ok = try await render(web, "# Kept\n\nThe last good text.")
        XCTAssertEqual(ok, "ok")
        // A number has no `split`: the render throws before it touches the article.
        let failed = try await web.evaluateJavaScript("window.gnRender(42,[],false,null,{},false,2)") as? String
        XCTAssertEqual(failed, "failed")
        try await settle()
        let text = try await web.evaluateJavaScript("document.getElementById('gn-article').textContent") as? String ?? ""
        XCTAssertTrue(text.contains("The last good text."), "the last good text stays: \(text)")
        XCTAssertFalse(text.contains("split"), "no raw error on the page")
        let notice = try XCTUnwrap(coordinator.currentNotice)
        XCTAssertEqual(notice.text, "This page could not be drawn.")
        XCTAssertEqual(notice.action, .retry)
        XCTAssertNil(notice.lasts, "a failure stays until Retry works or the reader closes it")
        XCTAssertTrue(notice.more?.contains("split") == true, "the raw message is behind Details: \(notice.more ?? "nil")")

        // Retry loads the page again; the next render that draws takes the notice away.
        coordinator.lastMarkdown = "# Back"
        coordinator.retryPage()
        XCTAssertNil(coordinator.noticeHost, "Retry closes the notice first")
        for _ in 0..<100 where !coordinator.ready {
            try await Task.sleep(nanoseconds: 50_000_000)
        }
        try await settle()
        let back = try await web.evaluateJavaScript("document.querySelector('#gn-article h1').textContent") as? String
        XCTAssertEqual(back, "Back")
    }

    func testANoticeSitsAtTheBottomAndLetsClicksBesideItReachThePage() async throws {
        let (web, coordinator) = try await page(view())
        coordinator.show(.failure("raw"))
        try await settle()
        let host = try XCTUnwrap(coordinator.noticeHost)
        XCTAssertGreaterThan(host.frame.height, 20)
        XCTAssertLessThanOrEqual(host.frame.width, 520)
        let bottomGap = web.isFlipped ? web.bounds.height - host.frame.maxY : host.frame.minY
        XCTAssertEqual(bottomGap, 16, accuracy: 1)
        // Far left of the host, outside the centred pill: the page gets the click.
        let beside = host.convert(NSPoint(x: 1, y: host.bounds.midY), to: web)
        XCTAssertNil(host.hitTest(beside), "a click beside the pill reaches the page")
        coordinator.hideNotice()
        XCTAssertNil(host.superview)
    }

    // MARK: P5: removing a property

    func testRemovingAPropertyIsLabelledReachableAndCanBeUndone() async throws {
        var posted: [[MarkdownProperty]] = []
        let (web, coordinator) = try await page(view(onProperties: { posted.append($0) }))
        let props = #"[{"key":"status","kind":"text","value":"draft","items":[],"inline":false},{"key":"tags","kind":"tags","value":"","items":["a","b"],"inline":true}]"#
        _ = try await render(web, "Body", props: props, editable: true)
        let labels = try await web.evaluateJavaScript("""
        [document.querySelector('.gn-prop-remove').getAttribute('aria-label'),
         document.querySelector('.gn-chip-x').tagName,document.querySelector('.gn-chip-x').getAttribute('aria-label')].join('|')
        """) as? String
        XCTAssertEqual(labels, "Remove property status|BUTTON|Remove tag a")
        let focusRule = try await web.evaluateJavaScript("""
        Array.from(document.styleSheets).some(function(s){try{return Array.from(s.cssRules).some(function(r){
          return (r.selectorText||'').indexOf('.gn-prop:focus-within .gn-prop-remove')>=0;});}catch(e){return false;}})
        """) as? Bool
        XCTAssertEqual(focusRule, true, "the button shows when the keyboard reaches its row")

        _ = try await web.evaluateJavaScript("document.querySelector('.gn-prop-remove').click();true")
        try await settle()
        XCTAssertEqual(posted.last?.map(\.key), ["tags"])
        XCTAssertEqual(coordinator.currentNotice?.text, "Property “status” removed.")
        XCTAssertEqual(coordinator.currentNotice?.action, .undoProperties)

        _ = try await web.evaluateJavaScript("window.gnPropsUndo();true")
        try await settle()
        XCTAssertEqual(posted.last?.map(\.key), ["status", "tags"], "Undo posts the rows from before the removal")
    }

    func testPropertyUndoSurvivesARenderButDoesNotDiscardLaterEdits() async throws {
        var posted: [[MarkdownProperty]] = []
        let (web, _) = try await page(view(onProperties: { posted.append($0) }))
        let props = #"[{"key":"status","kind":"text","value":"draft","items":[],"inline":false},{"key":"tags","kind":"tags","value":"","items":["a","b"],"inline":true}]"#
        _ = try await render(web, "Body", props: props, editable: true)
        _ = try await web.evaluateJavaScript("document.querySelector('.gn-prop-remove').click();true")
        try await settle()
        let remaining = MarkdownFrontmatter.json(try XCTUnwrap(posted.last))
        _ = try await render(web, "Body", props: remaining, editable: true)
        _ = try await web.evaluateJavaScript("window.gnPropsUndo();true")
        try await settle()
        XCTAssertEqual(posted.last?.map(\.key), ["status", "tags"], "the host's render keeps Undo valid")

        // Each edit changes the state after a removal, including edits from a host render.
        for edit in ["var i=document.querySelector('.gn-chip-in');i.value='later';i.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter'}))",
                     "var n=document.querySelector('.gn-prop-name');n.textContent='renamed';n.dispatchEvent(new Event('blur'))",
                     "document.querySelector('.gn-props-add').click();var ns=document.querySelectorAll('.gn-prop-name');var n=ns[ns.length-1];n.textContent='new';n.blur()",
                     "window.gnRender('Body',[{key:'external',kind:'text',value:'kept'}],true,null,{},false,1)"] {
            _ = try await render(web, "Body", props: props, editable: true)
            _ = try await web.evaluateJavaScript("document.querySelector('.gn-prop-remove').click();true")
            try await settle()
            _ = try await render(web, "Body", props: remaining, editable: true)
            _ = try await web.evaluateJavaScript("\(edit);true")
            try await settle()
            let before = try await web.evaluateJavaScript("document.getElementById('gn-props').textContent") as? String
            let count = posted.count
            _ = try await web.evaluateJavaScript("window.gnPropsUndo();true")
            try await settle()
            let after = try await web.evaluateJavaScript("document.getElementById('gn-props').textContent") as? String
            XCTAssertEqual(after, before, edit)
            XCTAssertEqual(posted.count, count, "a stale Undo never overwrites the host's properties")
        }
    }

    // MARK: P6, P7, P17, P20: pictures and embeds

    func testViewablePicturesTakeTheKeyboardAndMissingOnesSayWhy() async throws {
        let (web, _) = try await page(view())
        let media = #"{"pending.png":{"kind":"pending","name":"pending.png"}}"#
        let png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="
        _ = try await render(web, "![dot](\(png))\n\n![[gone.png]]\n\n![[pending.png]]\n\n![[Other note]]", media: media)
        let image = try await web.evaluateJavaScript("""
        var i=document.querySelector('#gn-article img[data-gn-img]');
        [i.getAttribute('tabindex'),i.getAttribute('role'),i.getAttribute('aria-label'),getComputedStyle(i).cursor].join('|')
        """) as? String
        XCTAssertEqual(image, "0|button|Open picture dot|zoom-in")
        let missing = try await web.evaluateJavaScript(
            "var m=document.querySelector('.gn-img-missing');m.textContent.trim()+'|'+m.getAttribute('role')") as? String
        XCTAssertEqual(missing, "⧉ Picture not found: gone.png|img", "the words are on the pill, not only in a tooltip")
        let pending = try await web.evaluateJavaScript(
            "var p=document.querySelector('.gn-img-pending');p?p.getAttribute('aria-label'):'none'") as? String
        XCTAssertEqual(pending, "Loading picture pending.png", "a lookup still running shows no negative answer")
        let embed = try await web.evaluateJavaScript(
            "var e=document.querySelector('a.dd-md-embed-stub');e?e.getAttribute('data-wikilink'):'none'") as? String
        XCTAssertEqual(embed, "Other note", "an embedded note is a link to it")
    }

    func testANameOnlyPictureIsPendingUntilTheVaultScanAnswers() async throws {
        let vault = FileManager.default.temporaryDirectory.appendingPathComponent("reading-ux-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: vault, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: vault) }
        let index = VaultFileIndex(root: vault) { _ in VaultFileIndex.Snapshot(paths: [], attachmentFolder: nil) }
        let registry = MarkdownMediaRegistry(indexForVault: { _ in index })
        let context = MarkdownMedia.Context(folder: vault, vaultRoot: vault)
        let ready = expectation(description: "scan answered")
        let before = registry.update(markdown: "![[photo.png]]", context: context) { ready.fulfill() }
        XCTAssertEqual(before["photo.png"]?["kind"], "pending")
        await fulfillment(of: [ready], timeout: 5)
        let after = registry.update(markdown: "![[photo.png]]", context: context) {}
        XCTAssertNil(after["photo.png"], "after the scan a miss is a miss, and the page says not found")
    }

    func testAnEmptyNoteSaysSo() async throws {
        let (web, _) = try await page(view())
        _ = try await render(web, "  \n")
        let empty = try await web.evaluateJavaScript("""
        var a=document.getElementById('gn-article');a.classList.contains('gn-is-empty')+'|'+getComputedStyle(a,'::after').content
        """) as? String
        XCTAssertEqual(empty, "true|\"This note is empty.\"")
        _ = try await render(web, "Text")
        let full = try await web.evaluateJavaScript("document.getElementById('gn-article').classList.contains('gn-is-empty')") as? Bool
        XCTAssertEqual(full, false)
    }

    // MARK: P8, P9: the native panes

    func testTheNativePaneFollowsThePaletteAndSelectsText() {
        let light = MarkdownTheme.light.native(.vault)
        XCTAssertEqual(light.textColor, MarkdownTheme.light.text)
        XCTAssertEqual(light.accentColor, MarkdownTheme.light.accent)
        XCTAssertEqual(MarkdownTheme.genesis.native(.vault), .vault, "the default palette keeps the vault look")
        XCTAssertEqual(MarkdownTheme.light.nativePage, MarkdownTheme.light.page)
    }
}
