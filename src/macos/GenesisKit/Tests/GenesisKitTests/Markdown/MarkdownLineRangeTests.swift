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

    /// A polished meeting keeps its transcript inside `<details>`, so a link to a transcript line names a block the page
    /// does not draw. The page scrolled to where that hidden block would sit (empty space near the end) and drew an empty
    /// band there. A range, a find match and a heading jump now open that fold and every fold around it, and a fold the
    /// reader closes again stays closed. `MARKDOWN_DETAILS_SHOTS=<folder>` keeps the page after the range as
    /// `details-range.png`.
    func testARangeAFindMatchAndAHeadingInsideAClosedFoldOpenItAndEveryFoldAroundIt() async throws {
        let web = try await page()
        let note = Self.foldedNote
        let lines = note.components(separatedBy: "\n")
        let target = try XCTUnwrap(lines.firstIndex(of: "Turn 150 asks about the ticket."))
        let inner = try XCTUnwrap(lines.firstIndex(of: "Change 12 renames the field."))
        let folds = "Array.from(document.querySelectorAll('#gn-article details')).map(d=>d.open?'open':'closed').join(',')"
        let closeAll = "document.querySelectorAll('#gn-article details').forEach(d=>{d.open=false});true"
        func run(_ js: String) async throws -> Any? { try await web.evaluateJavaScript(js) }
        func shown(_ element: String) async throws -> Bool {
            // On screen and drawn there: a block in a closed fold still has a box, where it would sit, but no pixels.
            let js = "(function(){var e=\(element);if(!e)return false;var r=e.getBoundingClientRect();"
                + "if(!(r.height>0&&r.top>=0&&r.bottom<=innerHeight))return false;"
                + "var c=document.elementFromPoint(r.left+Math.min(8,r.width/2),r.top+r.height/2);return !!c&&e.contains(c);})()"
            // A jump may scroll smoothly: give it the time a person would see it take.
            for _ in 0..<40 {
                if try await run(js) as? Bool == true { return true }
                try await Task.sleep(nanoseconds: 50_000_000)
            }
            return false
        }

        _ = try await run("window.gnRender(\(MarkdownWebView.jsString(note)),[],false,null,{},false);true")
        let start = try await run(folds) as? String
        XCTAssertEqual(start, "closed,closed", "a fold starts closed, as the note wrote it")

        // The link's range: the transcript fold opens, the lines are on screen and the band covers them.
        _ = try await run("window.gnHighlightLines(\(target),\(target + 2),'blocks',true);true")
        let range = try await run("""
            (function(){var h=document.querySelectorAll('#gn-article .gn-hl'),b=document.getElementById('gn-hl-band');
            if(!h.length||!b)return 'nothing marked';var f=h[0].getBoundingClientRect(),l=h[h.length-1].getBoundingClientRect(),
            r=b.getBoundingClientRect(),c=document.elementFromPoint(f.left+8,f.top+f.height/2);
            return [h[0].textContent.trim(),h.length,f.height>0&&f.top>=0&&l.bottom<=innerHeight&&!!c&&h[0].contains(c),
            r.height>0&&r.top<=f.top&&r.bottom>=l.bottom].join('|');})()
            """) as? String
        let opened = try await run(folds) as? String
        if let out = ProcessInfo.processInfo.environment["MARKDOWN_DETAILS_SHOTS"] {
            let image = try await web.takeSnapshot(configuration: nil)
            let rep = try XCTUnwrap(image.cgImage(forProposedRect: nil, context: nil, hints: nil).map(NSBitmapImageRep.init(cgImage:)))
            try XCTUnwrap(rep.representation(using: .png, properties: [:]))
                .write(to: URL(fileURLWithPath: out).appendingPathComponent("details-range.png"))
        }
        XCTAssertEqual(range, "Turn 150 asks about the ticket.|2|true|true", "the marked lines and the band are on screen")
        XCTAssertEqual(opened, "open,closed", "only the fold that holds the range opens")

        // A re-render, as an agent's write to the open note causes, keeps the fold open and the band on the lines.
        _ = try await run("window.gnRender(\(MarkdownWebView.jsString(note + "\nmore\n")),[],false,null,{},false);true")
        let kept = try await run(folds) as? String
        XCTAssertEqual(kept, "open,closed")
        let band = try await run("""
            (function(){var h=document.querySelector('#gn-article .gn-hl').getBoundingClientRect(),
            r=document.getElementById('gn-hl-band').getBoundingClientRect();return h.height>0&&r.top<=h.top&&r.bottom>=h.bottom;})()
            """) as? Bool
        XCTAssertEqual(band, true, "the band still covers the marked line after the re-render")

        // A range in a fold inside a fold opens both.
        _ = try await run(closeAll)
        _ = try await run("window.gnHighlightLines(\(inner),\(inner),'blocks',true);true")
        let both = try await run(folds) as? String
        XCTAssertEqual(both, "open,open")
        let innerShown = try await shown("document.querySelector('#gn-article .gn-hl')")
        XCTAssertTrue(innerShown, "the line in the inner fold is on screen")

        // Closed again by hand: a click ends the range, and neither a resize nor a re-render opens the fold again.
        _ = try await run("document.body.dispatchEvent(new MouseEvent('mousedown',{bubbles:true}));"
            + "document.querySelector('#gn-article details > summary').click();true")
        _ = try await run("window.dispatchEvent(new Event('resize'));true")
        _ = try await run("window.gnRender(\(MarkdownWebView.jsString(note)),[],false,null,{},false);true")
        let handClosed = try await run(folds) as? String
        XCTAssertEqual(handClosed, "closed,open", "the outer fold stays closed; the inner one keeps its own state")

        // A find match in the inner fold opens it and the fold around it.
        _ = try await run(closeAll)
        _ = try await run("window.gnFind('needle',false,{});true")
        let found = try await run(folds) as? String
        XCTAssertEqual(found, "open,open")
        let matchShown = try await shown("document.querySelector('#gn-article mark.gn-find-current')")
        XCTAssertTrue(matchShown, "the current match is on screen")
        _ = try await run("window.gnFind('',false,{});true")

        // A heading jump (a #heading link, the outline) opens the fold that holds the heading, and no other.
        _ = try await run(closeAll)
        let jumped = try await run("window.gnScrollToSlug('inner-heading','Inner heading')") as? Bool
        XCTAssertEqual(jumped, true)
        let headingFolds = try await run(folds) as? String
        XCTAssertEqual(headingFolds, "open,closed")
        let headingShown = try await shown("document.getElementById('inner-heading')")
        XCTAssertTrue(headingShown, "the heading is on screen")

        // Split view's sync to a line in a closed fold shows the fold, not the place where its hidden line would sit.
        _ = try await run(closeAll)
        _ = try await run("window.gnSyncLine(\(target));true")
        let synced = try await shown("document.querySelector('#gn-article details > summary')")
        XCTAssertTrue(synced, "the fold's summary is on screen")

        // A git bar for a changed line in a closed fold sits beside the fold.
        _ = try await run("window.gnGitMarks([{k:'added',a:\(target),b:\(target),i:0}]);true")
        let bar = try await run("""
            (function(){var b=document.querySelector('.gn-git-bar'),d=document.querySelector('#gn-article details');
            if(!b)return 'no bar';var r=b.getBoundingClientRect(),f=d.getBoundingClientRect();
            return r.top>=f.top-4&&r.bottom<=f.bottom+4?'beside the fold':'at '+Math.round(r.top-f.top)+' px from the fold';})()
            """) as? String
        XCTAssertEqual(bar, "beside the fold")
    }

    /// The shape of a polished meeting (`tools meetings polish build`): turns inside a fold, a fold inside it.
    private static let foldedNote: String = {
        let turns = (1...300).map { "Turn \($0) asks about the ticket." }.joined(separator: "\n\n")
        let changes = (1...40).map { $0 == 33 ? "Change 33 moves the needle." : "Change \($0) renames the field." }
            .joined(separator: "\n\n")
        let points = (1...30).map { "Point \($0) of the summary." }.joined(separator: "\n\n")
        let notes = (1...30).map { "Note \($0) after the transcript." }.joined(separator: "\n\n")
        return "# Workshop\n\n\(points)\n\n<details>\n<summary>The polished turns</summary>\n\n\(turns)\n\n"
            + "### Inner heading\n\n<details>\n<summary>Diffs</summary>\n\n\(changes)\n\n</details>\n\n</details>\n\n"
            + "## After\n\n\(notes)\n"
    }()

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
