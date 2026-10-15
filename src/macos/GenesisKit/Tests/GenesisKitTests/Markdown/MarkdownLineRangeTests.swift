import AppKit
import WebKit
import XCTest
@testable import GenesisKit

/// Lines in the viewer: `range=` on an open URL, `#L10-L20` on a link inside a
/// note, line numbers beside a file shown as code, and the marks on the page.
@MainActor
final class MarkdownLineRangeTests: XCTestCase {
    func testEveryFragmentFormIsALineOrARange() {
        XCTAssertEqual(MarkdownLineRange.parse("30"), MarkdownLineRange(first: 30, last: 30))
        XCTAssertEqual(MarkdownLineRange.parse("30-50"), MarkdownLineRange(first: 30, last: 50))
        XCTAssertEqual(MarkdownLineRange.parse("L30"), MarkdownLineRange(first: 30, last: 30))
        XCTAssertEqual(MarkdownLineRange.parse("L30-50"), MarkdownLineRange(first: 30, last: 50))
        XCTAssertEqual(MarkdownLineRange.parse("L30-L50"), MarkdownLineRange(first: 30, last: 50))
        XCTAssertEqual(MarkdownLineRange.parse("l7"), MarkdownLineRange(first: 7, last: 7))
        // Written backwards still means the same lines.
        XCTAssertEqual(MarkdownLineRange.parse("50-30"), MarkdownLineRange(first: 30, last: 50))
    }

    func testAHeadingOrAnotherFragmentIsNotALine() {
        for text in ["Heading", "page=2", "L", "0", "L0-L3", "30-", "-30", "30-50-70", "L30x", "", nil] {
            XCTAssertNil(MarkdownLineRange.parse(text), "\(text ?? "nil") is not a line")
        }
        // The old single-line helper keeps answering with the first line.
        XCTAssertEqual(MarkdownDocumentLinks.lineNumber("L147-L190"), 147)
        XCTAssertEqual(MarkdownDocumentLinks.lineNumber("147"), 147)
        XCTAssertNil(MarkdownDocumentLinks.lineNumber("Setup"))
    }

    func testANoteAndADataFileOpenInTheViewerAndCodeOffersTheMenu() {
        let file: (URL) -> Bool = { _ in true }
        let ts = URL(fileURLWithPath: "/src/file.ts")
        let go = URL(fileURLWithPath: "/src/fleet/registry.go")
        let json = URL(fileURLWithPath: "/data/x.json")
        let log = URL(fileURLWithPath: "/data/run.log")
        let note = URL(fileURLWithPath: "/notes/Plan.md")
        let pdf = URL(fileURLWithPath: "/docs/manual.pdf")
        let range = MarkdownLineRange(first: 5, last: 8)!

        XCTAssertEqual(MarkdownLinkRoute.decide(json, fragment: "5-8", isFile: file), .viewer(json, lines: range))
        XCTAssertEqual(MarkdownLinkRoute.decide(json, fragment: nil, isFile: file), .viewer(json, lines: nil))
        XCTAssertEqual(MarkdownLinkRoute.decide(log, fragment: "L5-L8", isFile: file), .viewer(log, lines: range))
        XCTAssertEqual(
            MarkdownLinkRoute.decide(note, fragment: "L5-8", isFile: file),
            .note(note, heading: nil, lines: range)
        )
        XCTAssertEqual(
            MarkdownLinkRoute.decide(note, fragment: "Setup", isFile: file),
            .note(note, heading: "Setup", lines: nil)
        )
        // Code, and any other file, gets the menu, with or without lines.
        XCTAssertEqual(MarkdownLinkRoute.decide(ts, fragment: "L5-L8", isFile: file), .choose(ts, lines: range))
        XCTAssertEqual(MarkdownLinkRoute.decide(ts, fragment: nil, isFile: file), .choose(ts, lines: nil))
        XCTAssertEqual(
            MarkdownLinkRoute.decide(go, fragment: "L20-L37", isFile: file),
            .choose(go, lines: MarkdownLineRange(first: 20, last: 37))
        )
        XCTAssertEqual(MarkdownLinkRoute.decide(pdf, fragment: nil, isFile: file), .choose(pdf, lines: nil))
        // An app or another bundle is neither a file nor a folder: refused.
        XCTAssertNil(MarkdownLinkRoute.decide(ts, fragment: "L5", isFile: { _ in false }, isFolder: { _ in false }))
    }

    /// Martin, 2026-10-08: `[x](/abs/registry.go#L20-L37)` did nothing. Every fragment form
    /// finds the file and its lines.
    func testEveryLinkFormLocatesTheFileAndItsLines() {
        let folder = URL(fileURLWithPath: "/notes")
        let exists: (String) -> Bool = { ["/repo/registry.go", "/notes/rel.ts", "/repo/odd:20"].contains($0) }
        func locate(_ ref: String) -> String? {
            guard let found = MarkdownDocumentLinks.locate(ref, folder: folder, vaultRoot: nil, exists: exists) else {
                return nil
            }
            let lines = MarkdownLineRange.parse(found.fragment).map { "\($0.first)-\($0.last)" } ?? found.fragment ?? "-"
            return "\(found.url.path) \(lines)"
        }
        XCTAssertEqual(locate("/repo/registry.go"), "/repo/registry.go -")
        XCTAssertEqual(locate("/repo/registry.go#L20"), "/repo/registry.go 20-20")
        XCTAssertEqual(locate("/repo/registry.go#L20-L37"), "/repo/registry.go 20-37")
        XCTAssertEqual(locate("/repo/registry.go#L20-37"), "/repo/registry.go 20-37")
        XCTAssertEqual(locate("/repo/registry.go#20-37"), "/repo/registry.go 20-37")
        XCTAssertEqual(locate("/repo/registry.go:20"), "/repo/registry.go 20-20")
        XCTAssertEqual(locate("/repo/registry.go:20-37"), "/repo/registry.go 20-37")
        XCTAssertEqual(locate("/repo/registry.go:L20-L37"), "/repo/registry.go 20-37")
        XCTAssertEqual(locate("/repo/registry.go:20:5"), "/repo/registry.go 20-20", "the column is dropped")
        XCTAssertEqual(locate("./rel.ts:7"), "/notes/rel.ts 7-7", "a relative link takes the suffix too")
        XCTAssertEqual(locate("/repo/registry.go#Setup"), "/repo/registry.go Setup")
        // A file really named `odd:20` is that file, not line 20 of `odd`.
        XCTAssertEqual(locate("/repo/odd:20"), "/repo/odd:20 -")
        XCTAssertNil(locate("/repo/missing.go:20"))
        XCTAssertNil(locate("/repo/registry.go:x"))
    }

    func testOnlyAnEditorStyleSuffixIsALineSuffix() {
        XCTAssertEqual(MarkdownDocumentLinks.lineSuffix("a.ts:20")?.path, "a.ts")
        XCTAssertEqual(MarkdownDocumentLinks.lineSuffix("a.ts:20-37")?.fragment, "20-37")
        for text in ["a.ts", "a.ts:", "a.ts:0", "a.ts:20-", "Note: thoughts", ":20", "a.ts:20-37-40"] {
            XCTAssertNil(MarkdownDocumentLinks.lineSuffix(text), "\(text) has no line suffix")
        }
    }

    /// The menu a code link shows, built on real files so the type checks are the real ones.
    func testTheCodeLinkMenuOffersTheDefaultAppTheViewerAndTheSidebar() throws {
        let fm = FileManager.default
        let dir = fm.temporaryDirectory.appendingPathComponent("md-codemenu-\(UUID().uuidString)")
        try fm.createDirectory(at: dir, withIntermediateDirectories: true)
        defer { try? fm.removeItem(at: dir) }
        let go = dir.appendingPathComponent("registry.go")
        try (1...40).map { "line \($0)" }.joined(separator: "\n").write(to: go, atomically: true, encoding: .utf8)
        let script = dir.appendingPathComponent("run.command")
        try "echo pwned".write(to: script, atomically: true, encoding: .utf8)
        let note = dir.appendingPathComponent("note.md")
        try "# Note".write(to: note, atomically: true, encoding: .utf8)

        let cursor = DefaultApp(url: URL(fileURLWithPath: "/Applications/Cursor.app"), name: "Cursor",
                                bundleIdentifier: "com.example.cursor", schemes: ["cursor"])
        let terminal = DefaultApp(url: URL(fileURLWithPath: "/System/Applications/Utilities/Terminal.app"), name: "Terminal",
                                  bundleIdentifier: "com.example.terminal", schemes: [])
        let model = MarkdownDocumentsModel(defaults: UserDefaults(suiteName: "md-codemenu-\(UUID().uuidString)")!)
        var app: DefaultApp? = cursor
        var launched: [String] = []
        model.defaultApp = { _ in app }
        model.openWithApp = { app, file, line in launched.append("\(app.name) \(file.lastPathComponent) \(line.map(String.init) ?? "-")") }
        model.open([note])
        let lines = MarkdownLineRange(first: 20, last: 37)

        let menu = model.fileLinkMenu(go, lines: lines)
        XCTAssertEqual(menu.titles, ["Open in Cursor", "Open in Genesis Markdown", "Reveal in sidebar"])
        menu.items[0].run()
        XCTAssertEqual(launched, ["Cursor registry.go 20"])
        XCTAssertEqual(model.docs.count, 1, "the default app is not the viewer")

        menu.items[2].run()
        XCTAssertTrue(model.showFiles)
        XCTAssertEqual(model.revealTarget, go.standardizedFileURL)

        menu.items[1].run()
        XCTAssertEqual(model.selected?.url, go.standardizedFileURL)
        XCTAssertEqual(model.lineHighlight?.range, lines)

        // A script whose default app runs it is never offered to that app; an editor may show it.
        app = terminal
        XCTAssertEqual(model.fileLinkMenu(script, lines: nil).titles, ["Reveal in sidebar"])
        app = cursor
        XCTAssertEqual(model.fileLinkMenu(script, lines: nil).titles, ["Open in Cursor", "Reveal in sidebar"])
        // A type no app declares (`.go` without Go tooling) may go to whatever app claims it.
        let atom = DefaultApp(url: URL(fileURLWithPath: "/Applications/Atom.app"), name: "Atom",
                              bundleIdentifier: "com.example.atom", schemes: [])
        app = atom
        XCTAssertEqual(model.fileLinkMenu(go, lines: nil).titles.first, "Open in Atom")
        app = nil
        XCTAssertEqual(model.fileLinkMenu(go, lines: nil).titles, ["Open in Genesis Markdown", "Reveal in sidebar"])
    }

    /// The whole click path: a link in a note, every fragment form, ends in the menu for code and
    /// in a tab for a data file.
    func testFollowingACodeLinkShowsTheMenuWithItsLines() throws {
        let fm = FileManager.default
        let dir = fm.temporaryDirectory.appendingPathComponent("md-codefollow-\(UUID().uuidString)")
        try fm.createDirectory(at: dir, withIntermediateDirectories: true)
        defer { try? fm.removeItem(at: dir) }
        let go = dir.appendingPathComponent("registry.go")
        try "package fleet\n".write(to: go, atomically: true, encoding: .utf8)
        let json = dir.appendingPathComponent("data.json")
        try "{\n  \"a\": 1\n}\n".write(to: json, atomically: true, encoding: .utf8)
        let note = dir.appendingPathComponent("note.md")
        try "# Note".write(to: note, atomically: true, encoding: .utf8)

        let model = MarkdownDocumentsModel(defaults: UserDefaults(suiteName: "md-codefollow-\(UUID().uuidString)")!)
        var menus: [MarkdownFileLinkMenu] = []
        var external: [URL] = []
        model.presentFileMenu = { menus.append($0) }
        model.openExternally = { external.append($0) }
        model.defaultApp = { _ in nil }
        model.open([note])
        let doc = try XCTUnwrap(model.selected)

        for ref in ["\(go.path)#L20-L37", "\(go.path)#L20-37", "\(go.path):20-37", "file://\(go.path)#L20-L37", "./registry.go#L20"] {
            model.follow(ref, from: doc)
        }
        model.follow(go.path, from: doc)
        XCTAssertEqual(menus.count, 6)
        XCTAssertEqual(Set(menus.map(\.file.standardizedFileURL)), [go.standardizedFileURL])
        XCTAssertEqual(menus.first?.titles, ["Open in Genesis Markdown", "Reveal in sidebar"])
        XCTAssertEqual(model.docs.count, 1, "a code link opens no tab until a pick")
        XCTAssertTrue(external.isEmpty)

        model.follow("\(json.path)#L2", from: doc)
        XCTAssertEqual(model.selected?.url, json.standardizedFileURL, "a data file opens in the viewer")
        XCTAssertEqual(model.lineHighlight?.range, MarkdownLineRange(first: 2, last: 2))
        XCTAssertEqual(menus.count, 6)
    }

    func testALinkToAFolderOffersTheFolderMenuWhateverItsFragment() {
        let folder = URL(fileURLWithPath: "/notes/Screenshots")
        let file = URL(fileURLWithPath: "/notes/Plan.md")
        let isFolder: (URL) -> Bool = { $0 == folder }
        XCTAssertEqual(MarkdownLinkRoute.decide(folder, fragment: nil, isFile: { _ in false }, isFolder: isFolder), .folder(folder))
        XCTAssertEqual(MarkdownLinkRoute.decide(folder, fragment: "L3", isFile: { _ in true }, isFolder: isFolder), .folder(folder))
        XCTAssertEqual(
            MarkdownLinkRoute.decide(file, fragment: nil, isFile: { _ in true }, isFolder: isFolder),
            .note(file, heading: nil, lines: nil)
        )
        // On disk: a real folder is one, a bundle and a file are not.
        let tmp = FileManager.default.temporaryDirectory.appendingPathComponent("gn-folder-\(UUID().uuidString)")
        let bundle = tmp.appendingPathComponent("Thing.app")
        try? FileManager.default.createDirectory(at: bundle, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: tmp) }
        XCTAssertTrue(MarkdownLinkRoute.isFolder(tmp))
        XCTAssertFalse(MarkdownLinkRoute.isFolder(bundle))
        XCTAssertFalse(MarkdownLinkRoute.isFolder(tmp.appendingPathComponent("missing.md")))
        // A relative folder link resolves like a file link, against the note's folder.
        let resolved = MarkdownDocumentLinks.resolve(
            "Screenshots/", folder: URL(fileURLWithPath: "/notes"), vaultRoot: nil,
            exists: { $0 == "/notes/Screenshots" || $0 == "/notes/Screenshots/" }
        )
        XCTAssertEqual(resolved?.standardizedFileURL.path, "/notes/Screenshots")
    }

    func testATabShowsTheExtensionOfEveryFileButANote() {
        XCTAssertEqual(MarkdownDocument.title(for: URL(fileURLWithPath: "/n/Plan.md")), "Plan")
        XCTAssertEqual(MarkdownDocument.title(for: URL(fileURLWithPath: "/n/CLAUDE.md")), "CLAUDE")
        XCTAssertEqual(MarkdownDocument.title(for: URL(fileURLWithPath: "/p/package.json")), "package.json")
        XCTAssertEqual(MarkdownDocument.title(for: URL(fileURLWithPath: "/p/file.ts")), "file.ts")
        XCTAssertEqual(MarkdownDocument.title(for: URL(fileURLWithPath: "/p/notes.txt")), "notes.txt")
        XCTAssertEqual(MarkdownDocument.title(for: URL(fileURLWithPath: "/p/Makefile")), "Makefile")
    }

    func testTheRangeSelectsTheLinesInTheSource() {
        let text = "one\ntwo\nthree\nfour\n"
        let range = MarkdownLineRange(first: 2, last: 3)!.characterRange(in: text)
        XCTAssertEqual((text as NSString).substring(with: range), "two\nthree")
        // Past the end: the last line, not a crash.
        let past = MarkdownLineRange(first: 40, last: 90)!.characterRange(in: "a\nb")
        XCTAssertEqual(("a\nb" as NSString).substring(with: past), "b")
    }

    func testLaidOutJSONIsShownAsWrittenSoItsLineNumbersAreTheFileLines() {
        let text = "{\n  \"a\": [1, 2],\n  \"b\": true\n}\n"
        let out = DocumentPreview.markdown(for: URL(fileURLWithPath: "/tmp/x.json"), text: text)
        XCTAssertEqual(out, "```json\n\(text.dropLast())\n```\n")
    }

    // MARK: the page

    func testARangeMarksTheNumberedLinesOfAFileAndTheOverlappingBlocksOfANote() async throws {
        let web = try await page()
        let json = DocumentPreview.markdown(
            for: URL(fileURLWithPath: "/tmp/x.json"),
            text: (1...40).map { "  \"k\($0)\": \($0)," }.joined(separator: "\n")
        )
        _ = try await web.evaluateJavaScript("window.gnRender(\(MarkdownWebView.jsString(json)),[],false,null,{},true)")
        let numbered = try await web.evaluateJavaScript("document.querySelectorAll('.gn-ln').length") as? Int
        XCTAssertEqual(numbered, 40, "every line of the file has a number")
        _ = try await web.evaluateJavaScript("window.gnHighlightLines(30,33,'lines',true)")
        let marked = try await web.evaluateJavaScript(
            "Array.from(document.querySelectorAll('.gn-ln.gn-hl')).map(e=>e.getAttribute('data-ln')).join(',')"
        ) as? String
        XCTAssertEqual(marked, "30,31,32,33")
        let top = try await web.evaluateJavaScript("(document.scrollingElement||document.documentElement).scrollTop") as? Double
        XCTAssertGreaterThan(top ?? 0, 0, "the first marked line was scrolled to")

        // A note: body lines 2-4 are the second paragraph and the list item.
        let note = "First paragraph.\n\nSecond paragraph.\n\n- item one\n- item two\n\nLast.\n"
        _ = try await web.evaluateJavaScript("window.gnRender(\(MarkdownWebView.jsString(note)),[],false,null,{},false)")
        let none = try await web.evaluateJavaScript("document.querySelectorAll('.gn-ln').length") as? Int
        XCTAssertEqual(none, 0, "the code inside a note is not numbered")
        _ = try await web.evaluateJavaScript("window.gnHighlightLines(2,4,'blocks',true)")
        let blocks = try await web.evaluateJavaScript(
            "Array.from(document.querySelectorAll('.gn-hl')).map(e=>e.localName+':'+e.textContent.trim()).join('|')"
        ) as? String
        XCTAssertEqual(blocks, "p:Second paragraph.|li:item one")
        // The marks survive the re-render a keystroke causes.
        _ = try await web.evaluateJavaScript("window.gnRender(\(MarkdownWebView.jsString(note + "\nmore\n")),[],false,null,{},false)")
        let kept = try await web.evaluateJavaScript("document.querySelectorAll('.gn-hl').length") as? Int
        XCTAssertEqual(kept, 2)
        _ = try await web.evaluateJavaScript("window.gnHighlightLines(null)")
        let cleared = try await web.evaluateJavaScript("document.querySelectorAll('.gn-hl').length") as? Int
        XCTAssertEqual(cleared, 0)

        // One band over the whole range, not a bar per paragraph; a click fades it for good.
        _ = try await web.evaluateJavaScript("window.gnHighlightLines(2,4,'blocks',false)")
        let bands = try await web.evaluateJavaScript("document.querySelectorAll('#gn-hl-band').length") as? Int
        XCTAssertEqual(bands, 1)
        let covers = try await web.evaluateJavaScript("""
            (function(){var b=document.getElementById('gn-hl-band').getBoundingClientRect();
            var h=document.querySelectorAll('.gn-hl');var f=h[0].getBoundingClientRect(),l=h[h.length-1].getBoundingClientRect();
            return b.top<=f.top&&b.bottom>=l.bottom;})()
            """) as? Bool
        XCTAssertEqual(covers, true, "the band spans the first to the last marked block")
        _ = try await web.evaluateJavaScript("document.body.dispatchEvent(new MouseEvent('mousedown',{bubbles:true}))")
        let fading = try await web.evaluateJavaScript("document.getElementById('gn-hl-band').classList.contains('gn-fading')") as? Bool
        XCTAssertEqual(fading, true)
        // A re-render after the click does not bring it back.
        _ = try await web.evaluateJavaScript("window.gnRender(\(MarkdownWebView.jsString(note)),[],false,null,{},false)")
        let after = try await web.evaluateJavaScript("document.querySelectorAll('.gn-hl').length") as? Int
        XCTAssertEqual(after, 0)
    }

    private final class Loader: NSObject, WKNavigationDelegate {
        var loaded: XCTestExpectation?
        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) { loaded?.fulfill() }
    }

    private let loader = Loader()
    private var hosts: [NSWindow] = []

    override func tearDown() {
        hosts.forEach { $0.contentView = nil }
        hosts = []
        super.tearDown()
    }

    private func page() async throws -> WKWebView {
        let config = WKWebViewConfiguration()
        config.setURLSchemeHandler(MarkdownWebView.AssetSchemeHandler(), forURLScheme: MarkdownWebView.assetScheme)
        let web = WKWebView(frame: NSRect(x: 0, y: 0, width: 900, height: 400), configuration: config)
        web.navigationDelegate = loader
        let window = NSWindow(contentRect: web.frame, styleMask: [.borderless], backing: .buffered, defer: false)
        window.contentView = web
        hosts.append(window)
        let loaded = expectation(description: "page loaded")
        loader.loaded = loaded
        web.loadHTMLString(MarkdownWebView.template, baseURL: URL(string: "\(MarkdownWebView.assetScheme)://asset/"))
        await fulfillment(of: [loaded], timeout: 10)
        return web
    }
}
