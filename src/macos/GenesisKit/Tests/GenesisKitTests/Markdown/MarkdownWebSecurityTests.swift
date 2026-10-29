import WebKit
import XCTest
@testable import GenesisKit

/// PR #80 review: a downloaded markdown file is untrusted, and the page that
/// renders it holds the native bridge (`openurl` opens URLs, `openrel` opens
/// local files). Raw HTML must not run script, and the bridge must only act on
/// links the reader clicks, with allowed schemes.
@MainActor
final class MarkdownWebSecurityTests: XCTestCase {
    private final class Bridge: NSObject, WKScriptMessageHandler, WKNavigationDelegate {
        var messages: [[String: Any]] = []
        var loaded: XCTestExpectation?
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

    private func render(_ markdown: String) async throws {
        _ = try await eval("window.gnRender(\(MarkdownWebView.jsString(markdown)))")
    }

    func testRawHTMLIsScrubbedAndBenignHTMLSurvives() async throws {
        let hostile = """
        # Doc

        <img id="x" src="nope.png" onerror="window.__pwned=1">

        <script>window.__pwned=2</script>

        <iframe srcdoc="<script>parent.__pwned=3</script>"></iframe>

        <a id="js" href="javascript:window.__pwned=4">js</a> <a id="js2" href="  JaVa&#x09;script:window.__pwned=5">js2</a>
        <a id="dt" href="data:text/html,<b>x</b>">dt</a>

        <svg width="10" height="10"><a id="sv" xlink:href="javascript:alert(1)"><text>x</text></a><animate attributeName="href" values="javascript:alert(1)"/></svg>

        <form action="https://example.invalid/"><input name="q"></form>

        <meta http-equiv="refresh" content="0;url=https://example.invalid/">

        <details open ontoggle="window.__pwned=6"><summary>More</summary>kept</details>

        <kbd>K</kbd> <img id="ok" src="data:image/png;base64,iVBORw0KGgo=" style="width:4px">
        """
        try await render(hostile)
        let dropped = try await eval(
            "document.querySelectorAll('#gn-article script,#gn-article iframe,#gn-article form,#gn-article meta,#gn-article animate').length"
        ) as? Int
        XCTAssertEqual(dropped, 0)
        let handlers = try await eval("""
        Array.from(document.querySelectorAll('#gn-article *')).filter(function(e){
          return Array.from(e.attributes).some(function(a){return /^on/i.test(a.name);});}).length
        """) as? Int
        XCTAssertEqual(handlers, 0)
        let hrefs = try await eval("""
        ['js','js2','dt'].map(function(id){return document.getElementById(id).hasAttribute('href');})
          .concat([document.getElementById('sv').hasAttribute('xlink:href')])
        """) as? [Bool]
        XCTAssertEqual(hrefs, [false, false, false, false])
        let kept = try await eval("""
        [!!document.querySelector('#gn-article details summary'),!!document.querySelector('#gn-article kbd'),
         document.getElementById('ok').getAttribute('src').indexOf('data:image/png')===0,
         document.getElementById('ok').style.width]
        """) as? [Any]
        XCTAssertEqual(kept?[0] as? Bool, true)
        XCTAssertEqual(kept?[1] as? Bool, true)
        XCTAssertEqual(kept?[2] as? Bool, true)
        XCTAssertEqual(kept?[3] as? String, "4px")
        // The broken image has had time to fail; nothing ran.
        try await Task.sleep(nanoseconds: 300_000_000)
        let pwned = try await eval("typeof window.__pwned") as? String
        XCTAssertEqual(pwned, "undefined")
        XCTAssertTrue(bridge.messages.allSatisfy { ($0["type"] as? String) != "openurl" && ($0["type"] as? String) != "openrel" })
    }

    /// The second wall: the CSP refuses an inline handler even if one ever got
    /// past the scrubber, while the page's own (nonce) scripts did run.
    func testTheContentSecurityPolicyRefusesInlineHandlers() async throws {
        let own = try await eval("typeof window.gnRender") as? String
        XCTAssertEqual(own, "function")
        let ran = try await eval("""
        (function(){var d=document.createElement('div');d.setAttribute('onclick','window.__csp=1');
          document.body.appendChild(d);d.click();return typeof window.__csp;})()
        """) as? String
        XCTAssertEqual(ran, "undefined")
        // Positive control: a listener the page adds itself still fires.
        let listener = try await eval("""
        (function(){var d=document.createElement('div');var hit=false;d.addEventListener('click',function(){hit=true;});
          d.click();return hit;})()
        """) as? Bool
        XCTAssertEqual(listener, true)
    }

    /// Mermaid still renders under the CSP (it must not need inline script).
    func testMermaidStillRendersUnderThePolicy() async throws {
        try await render("```mermaid\ngraph TD\n  A-->B\n```\n")
        var svg = false
        for _ in 0..<60 where !svg {
            svg = try await eval("!!document.querySelector('#gn-article .mermaid svg')") as? Bool ?? false
            if !svg { try await Task.sleep(nanoseconds: 100_000_000) }
        }
        XCTAssertTrue(svg)
    }

    /// t38: a link with a scheme is an external URL (Swift allow-lists it);
    /// a path or a `file:` URL is a local file.
    func testLinksAreRoutedByScheme() async throws {
        try await render(
            // A `file:` markdown link renders as a link (the /explain form); `javascript:` stays text.
            "[m](mailto:a@b.c) [o](obsidian://open?vault=V) [r](./x.pdf) [f](file:///tmp/x.ts#L3) [w](https://example.com/) [h](#doc) [j](javascript:alert(1))\n"
        )
        let clicked = try await eval("""
        (function(){var as=document.querySelectorAll('#gn-article a');
          for(var i=0;i<as.length;i++)as[i].dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true}));
          return as.length;})()
        """) as? Int
        XCTAssertEqual(clicked, 6)
        let routed = bridge.messages.compactMap { m -> String? in
            guard let type = m["type"] as? String else { return nil }
            if type == "openurl" { return "url:\(m["url"] as? String ?? "")" }
            if type == "openrel" { return "rel:\(m["href"] as? String ?? "")" }
            return nil
        }
        XCTAssertEqual(routed, [
            "url:mailto:a@b.c",
            "url:obsidian://open?vault=V",
            "rel:./x.pdf",
            "rel:file:///tmp/x.ts#L3",
            "url:https://example.com/",
        ])
    }

    func testOnlyAllowedSchemesLeaveThePage() {
        XCTAssertNotNil(MarkdownWebView.externalURL("https://example.com/a"))
        XCTAssertNotNil(MarkdownWebView.externalURL("HTTP://example.com/"))
        XCTAssertNotNil(MarkdownWebView.externalURL("mailto:a@b.c"))
        XCTAssertNotNil(MarkdownWebView.externalURL("obsidian://open?vault=V"))
        XCTAssertNil(MarkdownWebView.externalURL("javascript:alert(1)"))
        XCTAssertNil(MarkdownWebView.externalURL("file:///System/Applications/Calculator.app"))
        XCTAssertNil(MarkdownWebView.externalURL("x-apple.systempreferences:com.apple.preference.security"))
        XCTAssertNil(MarkdownWebView.externalURL("data:text/html,x"))

        XCTAssertTrue(MarkdownWebView.isLocalHref("./a.pdf"))
        XCTAssertTrue(MarkdownWebView.isLocalHref("../Notes/A%20B.md"))
        XCTAssertTrue(MarkdownWebView.isLocalHref("/tmp/x.pdf"))
        XCTAssertTrue(MarkdownWebView.isLocalHref("file:///tmp/x.pdf"))
        XCTAssertFalse(MarkdownWebView.isLocalHref("mailto:a@b.c"))
        XCTAssertFalse(MarkdownWebView.isLocalHref("javascript:alert(1)"))
        XCTAssertFalse(MarkdownWebView.isLocalHref("ssh://host"))
    }

    /// The app's own coordinator: the page loads, `openrel` refuses a
    /// scheme URL, and the page cannot be navigated away from.
    func testTheCoordinatorLoadsThePageAndRefusesEverythingElse() async throws {
        var followed: [String] = []
        let view = MarkdownWebView(
            markdown: "# Doc\n", scrollTarget: nil, highlightQuery: nil, highlightToken: 0,
            onWikilink: { _ in }, onActiveSection: { _ in },
            onRelativeLink: { followed.append($0) }
        )
        let page = try await coordinatorPage(view)

        _ = try await page.evaluateJavaScript("""
        window.webkit.messageHandlers.bridge.postMessage({type:'openrel',href:'ssh://host'});
        window.webkit.messageHandlers.bridge.postMessage({type:'openrel',href:'./x.pdf'});true
        """)
        try await Task.sleep(nanoseconds: 100_000_000)
        XCTAssertEqual(followed, ["./x.pdf"])

        _ = try await page.evaluateJavaScript("location.href='file:///tmp/';true")
        try await Task.sleep(nanoseconds: 300_000_000)
        // A bundled asset is not a page either.
        _ = try await page.evaluateJavaScript("location.href='genres://asset/markdown-it.min.js';true")
        try await Task.sleep(nanoseconds: 300_000_000)
        let still = try await page.evaluateJavaScript("location.protocol+'|'+!!document.getElementById('gn-article')") as? String
        XCTAssertEqual(still, "genres:|true")
    }

    /// PR #82 review: every link door (`openrel`, `wikilink`, a reference
    /// definition) ends in the window's real `follow`, and the note is
    /// untrusted. Driven from the page through the coordinator into the real
    /// model: a document and an allowed scheme reach the system; an app, a
    /// folder, a script, an executable or another scheme never does.
    func testTheRealFollowPathOpensDocumentsAndNeverLaunchesAnApp() async throws {
        let fm = FileManager.default
        let dir = fm.temporaryDirectory.appendingPathComponent("md-follow-\(UUID().uuidString)")
        try fm.createDirectory(at: dir.appendingPathComponent("Fake.app/Contents"), withIntermediateDirectories: true)
        try fm.createDirectory(at: dir.appendingPathComponent("folder"), withIntermediateDirectories: true)
        let note = dir.appendingPathComponent("note.md")
        try """
        # Note

        [calc]: file:///System/Applications/Calculator.app
        [shell]: ssh://host
        [pdf]: ./x.pdf
        """.write(to: note, atomically: true, encoding: .utf8)
        try "# Other".write(to: dir.appendingPathComponent("other.md"), atomically: true, encoding: .utf8)
        try "%PDF-1.4".write(to: dir.appendingPathComponent("x.pdf"), atomically: true, encoding: .utf8)
        try "echo pwned".write(to: dir.appendingPathComponent("run.command"), atomically: true, encoding: .utf8)
        let tool = dir.appendingPathComponent("tool")
        try "#!/bin/sh\necho pwned".write(to: tool, atomically: true, encoding: .utf8)
        try fm.setAttributes([.posixPermissions: 0o755], ofItemAtPath: tool.path)

        let model = MarkdownDocumentsModel(defaults: UserDefaults(suiteName: "md-follow-\(UUID().uuidString)")!)
        var opened: [String] = []
        model.openExternally = { opened.append($0.isFileURL ? $0.lastPathComponent : $0.absoluteString) }
        // A file that is not a note shows a menu; the test picks its "Open in <default app>" item,
        // so every file a pick could launch reaches `opened`. The stub app is no code editor, so
        // only the file's own type decides.
        var menus: [MarkdownFileLinkMenu] = []
        model.presentFileMenu = { menus.append($0) }
        var folderMenus: [URL] = []
        model.presentFolderMenu = { folder, _ in
            folderMenus.append(folder)
            return false
        }
        model.defaultApp = { _ in
            DefaultApp(url: URL(fileURLWithPath: "/Applications/Viewer.app"), name: "Viewer", bundleIdentifier: "com.example.viewer", schemes: [])
        }
        model.openWithApp = { _, file, _ in opened.append(file.lastPathComponent) }
        model.open([note])
        let doc = try XCTUnwrap(model.selected)
        let view = MarkdownWebView(
            markdown: "# Doc\n", scrollTarget: nil, highlightQuery: nil, highlightToken: 0,
            onWikilink: { model.follow($0, from: doc) }, onActiveSection: { _ in },
            onRelativeLink: { model.follow($0, from: doc) }
        )
        let page = try await coordinatorPage(view)

        func rel(_ href: String) -> String {
            "window.webkit.messageHandlers.bridge.postMessage({type:'openrel',href:'\(href)'});"
        }
        func wiki(_ target: String) -> String {
            "window.webkit.messageHandlers.bridge.postMessage({type:'wikilink',target:'\(target)'});"
        }
        let refused = [
            rel("file:///System/Applications/Calculator.app"),
            rel("FILE:///System/Applications/Calculator.app/"),
            rel("/System/Applications/Calculator.app"),
            rel("./Fake.app"),
            rel("./folder"),
            rel("./run.command"),
            rel("./tool"),
            rel("file://\(tool.path)"),
            wiki("file:///System/Applications/Calculator.app"),
            wiki("ssh://host"),
            wiki("vnc://host"),
            wiki("x-apple.systempreferences://com.apple.preference.security"),
            wiki("calc"),
            wiki("shell"),
        ]
        let allowed = [
            rel("./x.pdf"),
            rel("file://\(dir.appendingPathComponent("x.pdf").path)"),
            wiki("pdf"),
            wiki("https://example.com/"),
            wiki("other"),
        ]
        _ = try await page.evaluateJavaScript((refused + allowed).joined() + "true")
        try await Task.sleep(nanoseconds: 300_000_000)
        for menu in menus {
            menu.items.first { $0.title == "Open in Viewer" }?.run()
        }

        XCTAssertEqual(
            menus.map { $0.file.lastPathComponent },
            ["run.command", "tool", "tool", "x.pdf", "x.pdf", "x.pdf"],
            "a script or an executable gets the menu, never an app pick"
        )
        XCTAssertEqual(opened, ["https://example.com/", "x.pdf", "x.pdf", "x.pdf"])
        XCTAssertEqual(model.docs.map(\.title), ["note", "other"], "a markdown link opens a tab, not an app")
    }

    /// A vault with a note in `Notes/`, pictures in three Obsidian layouts, a
    /// JSON file, and a folder outside the vault holding a secret picture.
    private struct MediaVault {
        let base: URL
        let vault: URL
        let note: URL
        let outside: URL
    }

    private func makeMediaVault() throws -> MediaVault {
        let fm = FileManager.default
        let base = fm.temporaryDirectory.appendingPathComponent("md-media-\(UUID().uuidString)")
        let vault = base.appendingPathComponent("vault")
        let outside = base.appendingPathComponent("outside")
        for dir in ["Notes/near", "assets", ".obsidian"] {
            try fm.createDirectory(at: vault.appendingPathComponent(dir), withIntermediateDirectories: true)
        }
        try fm.createDirectory(at: outside, withIntermediateDirectories: true)
        let png = try Self.png(width: 30, height: 20)
        try png.write(to: vault.appendingPathComponent("assets/by-name.png"))
        try png.write(to: vault.appendingPathComponent("Notes/near/rel pic.png"))
        try png.write(to: vault.appendingPathComponent("Notes/abs.png"))
        try png.write(to: outside.appendingPathComponent("secret.png"))
        try fm.createSymbolicLink(at: vault.appendingPathComponent("Notes/link.png"),
                                  withDestinationURL: outside.appendingPathComponent("secret.png"))
        try #"{"b":1,"a":[1,2]}"#.write(to: vault.appendingPathComponent("Notes/data.json"), atomically: true, encoding: .utf8)
        let note = vault.appendingPathComponent("Notes/note.md")
        try "# Note".write(to: note, atomically: true, encoding: .utf8)
        return MediaVault(base: base, vault: vault, note: note, outside: outside)
    }

    private static func png(width: Int, height: Int) throws -> Data {
        let rep = try XCTUnwrap(NSBitmapImageRep(
            bitmapDataPlanes: nil, pixelsWide: width, pixelsHigh: height, bitsPerSample: 8, samplesPerPixel: 4,
            hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0))
        return try XCTUnwrap(rep.representation(using: .png, properties: [:]))
    }

    private func mediaPage(_ v: MediaVault, _ markdown: String) async throws -> (WKWebView, MarkdownWebView.Coordinator) {
        let view = MarkdownWebView(
            markdown: markdown, scrollTarget: nil, highlightQuery: nil, highlightToken: 0,
            onWikilink: { _ in }, onActiveSection: { _ in },
            documentURL: v.note, vaultRoot: v.vault.path
        )
        let page = try await coordinatorPage(view)
        let coordinator = try XCTUnwrap(liveCoordinator)
        coordinator.web = page
        coordinator.render(markdown)
        try await Task.sleep(nanoseconds: 100_000_000)
        return (page, coordinator)
    }

    /// Every Obsidian form resolves to a file that loads through gnmedia:
    /// a name-only `![[x|30]]`, a relative `![](near/rel%20pic.png)`, and a
    /// `file://` URL inside the vault.
    /// A pinch magnifies the page (WebKit magnification), past the column width; the text zoom stays `pageZoom`.
    func testPinchZoomIsEnabled() {
        let page = WKWebView(frame: NSRect(x: 0, y: 0, width: 400, height: 300))
        XCTAssertFalse(page.allowsMagnification)
        MarkdownWebView.prepare(page)
        XCTAssertTrue(page.allowsMagnification)
        page.magnification = 2.5
        XCTAssertEqual(page.magnification, 2.5, accuracy: 0.01)
        XCTAssertEqual(page.pageZoom, 1, accuracy: 0.001)
    }

    func testLocalImagesRenderWithANaturalSize() async throws {
        let v = try makeMediaVault()
        let markdown = """
        ![[by-name.png|30]]

        ![caption|25](near/rel%20pic.png)

        ![](file://\(v.vault.appendingPathComponent("Notes/abs.png").path))
        """
        let (page, _) = try await mediaPage(v, markdown)
        var sizes: [String] = []
        for _ in 0..<60 {
            sizes = try await page.evaluateJavaScript("""
            Array.from(document.querySelectorAll('#gn-article img')).map(function(i){
              return i.getAttribute('src').split('/')[2]+':'+(i.complete?i.naturalWidth+'x'+i.naturalHeight:'loading');})
            """) as? [String] ?? []
            if sizes.count == 3, sizes.allSatisfy({ $0.hasSuffix("30x20") }) { break }
            try await Task.sleep(nanoseconds: 100_000_000)
        }
        XCTAssertEqual(sizes, ["m:30x20", "m:30x20", "m:30x20"])
        let widths = try await page.evaluateJavaScript("""
        Array.from(document.querySelectorAll('#gn-article img')).map(function(i){return i.getAttribute('width')+'|'+i.getAttribute('alt');})
        """) as? [String]
        XCTAssertEqual(widths?.prefix(2), ["30|by-name.png", "25|caption"])
    }

    /// `..` out of the vault, a symlink that points outside it, an absolute
    /// `file://` path outside it, and a token the page made up all fail.
    func testTraversalAndSymlinkEscapesAreRefused() async throws {
        let v = try makeMediaVault()
        let context = MarkdownMedia.Context(folder: v.note.deletingLastPathComponent(), vaultRoot: v.vault)
        let escapes = [
            "../../outside/secret.png",
            "link.png",
            "file://\(v.outside.appendingPathComponent("secret.png").path)",
            "/\(v.outside.appendingPathComponent("secret.png").path)",
            "\(v.outside.path)/../outside/secret.png",
        ]
        let index = VaultFileIndex(root: v.vault)
        let indexed = expectation(description: "vault indexed")
        index.refreshIfNeeded { indexed.fulfill() }
        await fulfillment(of: [indexed], timeout: 5)
        for ref in escapes {
            XCTAssertNil(MarkdownMedia.resolve(MarkdownMedia.key(ref), in: context, index: index), ref)
        }
        // Positive control: the same resolver admits a file inside the vault.
        XCTAssertNotNil(MarkdownMedia.resolve("by-name.png", in: context, index: index))

        let markdown = escapes.map { "![x](\($0))" }.joined(separator: "\n\n") + "\n\n![[link.png]]\n\n![[by-name.png]]\n"
        let (page, coordinator) = try await mediaPage(v, markdown)
        let shown = try await page.evaluateJavaScript("""
        [document.querySelectorAll('#gn-article img').length,document.querySelectorAll('#gn-article .gn-img-missing').length]
        """) as? [Int]
        XCTAssertEqual(shown, [1, escapes.count + 1])
        XCTAssertEqual(coordinator.media.entries.count, 1, "only the file inside the vault is registered")

        // A URL the page builds itself is refused by the scheme handler.
        let made = try await page.callAsyncJavaScript("""
        return await new Promise(function(done){var i=new Image();
          i.onload=function(){done('loaded');};i.onerror=function(){done('refused');};
          i.src='gnmedia://m/00000000-0000-0000-0000-000000000000';});
        """, contentWorld: .page) as? String
        XCTAssertEqual(made, "refused")
    }

    /// A token serves only while its document references it, a JSON file over the limit is never
    /// read, a file swapped for a symlink after the render stops serving, and a destination may
    /// hold balanced parentheses.
    func testMediaIndexLoadsOffMainAndOnlyNotifiesTheLatestDocument() async throws {
        let v = try makeMediaVault()
        let started = expectation(description: "scan started")
        let release = DispatchSemaphore(value: 0)
        let index = VaultFileIndex(root: v.vault) { _ in
            XCTAssertFalse(Thread.isMainThread, "the filesystem walk must not block a render")
            started.fulfill()
            _ = release.wait(timeout: .now() + 5)
            return .init(paths: ["attachments/by-name.png"], attachmentFolder: "attachments")
        }
        let registry = MarkdownMediaRegistry(indexForVault: { _ in index })
        let context = MarkdownMedia.Context(folder: v.note.deletingLastPathComponent(), vaultRoot: v.vault)
        var staleCalls = 0
        let first = registry.update(markdown: "![[by-name.png]]", context: context) { staleCalls += 1 }
        XCTAssertEqual(first["by-name.png"]?["kind"], "pending",
                       "the first render returns while the walk is blocked, with no negative answer yet")
        await fulfillment(of: [started], timeout: 3)
        XCTAssertTrue(index.lookup("by-name.png").isEmpty, "lookup reads only the available cache")
        let ready = expectation(description: "latest document notified")
        _ = registry.update(markdown: "![[missing.png]]", context: context) { ready.fulfill() }
        release.signal()
        await fulfillment(of: [ready], timeout: 3)
        XCTAssertEqual(staleCalls, 0)
        XCTAssertEqual(index.lookup("by-name.png"), ["attachments/by-name.png"])
        XCTAssertEqual(index.attachmentFolder, "attachments")
        var refreshedAgain = false
        index.refreshIfNeeded { refreshedAgain = true }
        XCTAssertFalse(refreshedAgain, "a fresh cache does not schedule another render")
    }

    func testMediaIndexRefreshPublishesNewFilesAndRevokedContextStaysRevoked() async throws {
        let v = try makeMediaVault()
        let index = VaultFileIndex(root: v.vault)
        let oldTime = Date().addingTimeInterval(-31)
        let first = expectation(description: "initial scan")
        index.refreshIfNeeded(now: oldTime) { first.fulfill() }
        await fulfillment(of: [first], timeout: 5)
        XCTAssertTrue(index.lookup("new.png").isEmpty)
        let file = v.vault.appendingPathComponent("Notes/new.png")
        try Data().write(to: file)
        let registry = MarkdownMediaRegistry(indexForVault: { _ in index })
        let context = MarkdownMedia.Context(folder: v.note.deletingLastPathComponent(), vaultRoot: v.vault)
        var staleCalls = 0
        _ = registry.update(markdown: "![[new.png]]", context: context) { staleCalls += 1 }
        _ = registry.update(markdown: "", context: nil)
        let refreshed = expectation(description: "refresh finished")
        index.refreshIfNeeded { refreshed.fulfill() }
        await fulfillment(of: [refreshed], timeout: 5)
        XCTAssertEqual(index.lookup("new.png"), ["Notes/new.png"])
        XCTAssertEqual(staleCalls, 0)
        XCTAssertTrue(registry.entries.isEmpty)
    }

    func testARegistryTokenIsRevokedAndBounded() throws {
        let v = try makeMediaVault()
        let context = MarkdownMedia.Context(folder: v.note.deletingLastPathComponent(), vaultRoot: v.vault)
        let registry = MarkdownMediaRegistry()

        let map = registry.update(markdown: "[data](data.json)", context: context)
        let token = try XCTUnwrap(map["data.json"]?["token"])
        XCTAssertNotNil(registry.jsonText(token))
        _ = registry.update(markdown: "no media here", context: context)
        XCTAssertNil(registry.entry(token), "a reference removed from the document revokes its token")
        XCTAssertNil(registry.jsonText(token))

        let big = v.vault.appendingPathComponent("Notes/big.json")
        try Data(repeating: 0x20, count: MarkdownMedia.maxJSONBytes + 1).write(to: big)
        let bigToken = try XCTUnwrap(registry.update(markdown: "[big](big.json)", context: context)["big.json"]?["token"])
        XCTAssertNil(registry.jsonText(bigToken), "a JSON file over the limit is never read")

        let swapped = registry.update(markdown: "[data](data.json)", context: context)
        let swappedToken = try XCTUnwrap(swapped["data.json"]?["token"])
        let data = v.vault.appendingPathComponent("Notes/data.json")
        try FileManager.default.removeItem(at: data)
        try FileManager.default.createSymbolicLink(at: data, withDestinationURL: v.outside.appendingPathComponent("secret.png"))
        XCTAssertNil(registry.jsonText(swappedToken), "a file swapped for an outside symlink after the render is refused")

        XCTAssertEqual(MarkdownMedia.references(in: "![](photo(1).png)").map(\.key), ["photo(1).png"])
    }

    /// `[![alt|480](small.webp)](full.webp)`: the image inside a link is an embed. The outer link used to swallow
    /// it, so the picture showed as missing.
    func testAnImageInsideALinkIsRegistered() {
        let refs = MarkdownMedia.references(in: "[![Prices|480](proposal/images/01.webp)](proposal/images/full/01.webp)")
        XCTAssertEqual(refs, [MarkdownMedia.Reference(key: "proposal/images/01.webp", embed: true)])
        XCTAssertEqual(
            MarkdownMedia.references(in: "[see ![x](a.png) and](b.json)").map(\.key).sorted(), ["a.png", "b.json"])
    }

    /// A `.json` link or embed is a chip; a click opens the file pretty-printed
    /// as a json block, and a token the document did not reference opens nothing.
    func testAJSONChipOpensAPrettyPrintedPanel() async throws {
        let v = try makeMediaVault()
        let (page, _) = try await mediaPage(v, "See [the data](data.json) and ![[data.json]].\n")
        let chips = try await page.evaluateJavaScript("document.querySelectorAll('#gn-article .gn-json-chip').length") as? Int
        XCTAssertEqual(chips, 2)
        _ = try await page.evaluateJavaScript("document.querySelector('#gn-article .gn-json-chip').click();true")
        var text = ""
        for _ in 0..<40 where text.isEmpty {
            text = try await page.evaluateJavaScript(
                "(document.querySelector('#gn-article .gn-json-panel code.language-json')||{}).textContent||''"
            ) as? String ?? ""
            if text.isEmpty { try await Task.sleep(nanoseconds: 50_000_000) }
        }
        XCTAssertEqual(text, "{\n  \"b\": 1,\n  \"a\": [\n    1,\n    2\n  ]\n}")

        _ = try await page.evaluateJavaScript("""
        window.webkit.messageHandlers.bridge.postMessage({type:'json',token:'not-registered'});true
        """)
        try await Task.sleep(nanoseconds: 200_000_000)
        let panels = try await page.evaluateJavaScript("document.querySelectorAll('#gn-article .gn-json-panel').length") as? Int
        XCTAssertEqual(panels, 1)
    }

    /// The page under the app's own coordinator, loaded and ready.
    private func coordinatorPage(_ view: MarkdownWebView) async throws -> WKWebView {
        let coordinator = MarkdownWebView.Coordinator(view)
        let config = MarkdownWebView.configuration(for: coordinator)
        let page = WKWebView(frame: NSRect(x: 0, y: 0, width: 800, height: 600), configuration: config)
        page.navigationDelegate = coordinator
        window.contentView = page
        page.loadHTMLString(MarkdownWebView.template, baseURL: URL(string: "\(MarkdownWebView.assetScheme)://asset/"))
        for _ in 0..<100 where !coordinator.ready {
            try await Task.sleep(nanoseconds: 50_000_000)
        }
        XCTAssertTrue(coordinator.ready)
        // `navigationDelegate` is weak; the test keeps the coordinator alive.
        liveCoordinator = coordinator
        return page
    }
}
