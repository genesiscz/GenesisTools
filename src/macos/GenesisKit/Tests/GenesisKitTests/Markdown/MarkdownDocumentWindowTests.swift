import AppKit
import SwiftUI
import XCTest
@testable import GenesisKit

final class MarkdownDocumentWindowTests: XCTestCase {
    func testResolveRelativeLinkAgainstFolderThenVault() {
        let folder = URL(fileURLWithPath: "/docs/2026-03")
        let present: Set<String> = ["/docs/2026-03/2026-03-17_vendor.pdf", "/vault/Notes/Plan.md", "/docs/2026-03/Sibling.md"]
        let exists: (String) -> Bool = { present.contains($0) }

        XCTAssertEqual(
            MarkdownDocumentLinks.resolve("<./2026-03-17_vendor.pdf>", folder: folder, vaultRoot: "/vault", exists: exists)?.path,
            "/docs/2026-03/2026-03-17_vendor.pdf"
        )
        XCTAssertEqual(
            MarkdownDocumentLinks.resolve("./2026-03-17_vendor.pdf#page=2", folder: folder, vaultRoot: "/vault", exists: exists)?.path,
            "/docs/2026-03/2026-03-17_vendor.pdf"
        )
        XCTAssertEqual(
            MarkdownDocumentLinks.resolve("Sibling", folder: folder, vaultRoot: "/vault", exists: exists)?.path,
            "/docs/2026-03/Sibling.md"
        )
        XCTAssertEqual(
            MarkdownDocumentLinks.resolve("Notes/Plan#Heading", folder: folder, vaultRoot: "/vault", exists: exists)?.path,
            "/vault/Notes/Plan.md"
        )
        XCTAssertNil(MarkdownDocumentLinks.resolve("Missing", folder: folder, vaultRoot: "/vault", exists: exists))
        XCTAssertNil(MarkdownDocumentLinks.resolve("", folder: folder, vaultRoot: nil, exists: exists))
    }

    func testDottedNoteNamesFallBackToMarkdownAndKeepTheirHeading() throws {
        let folder = URL(fileURLWithPath: "/vault/notes")
        let files: Set<String> = ["/vault/notes/1234.analysis.md", "/vault/5678.analysis.md",
                                  "/vault/notes/report.pdf", "/vault/notes/report.pdf.md"]
        for (ref, path) in [("1234.analysis#Findings", "/vault/notes/1234.analysis.md"),
                            ("5678.analysis#Findings", "/vault/5678.analysis.md")] {
            let result = try XCTUnwrap(MarkdownDocumentLinks.locate(
                ref, folder: folder, vaultRoot: "/vault", exists: files.contains))
            XCTAssertEqual(result.url.path, path)
            XCTAssertEqual(result.fragment, "Findings")
        }
        XCTAssertEqual(MarkdownDocumentLinks.resolve("report.pdf", folder: folder, vaultRoot: nil,
            exists: files.contains)?.path, "/vault/notes/report.pdf", "an existing direct file wins")
        XCTAssertNil(MarkdownDocumentLinks.resolve("absent.analysis", folder: folder, vaultRoot: "/vault",
            exists: files.contains))
    }

    /// NSWindowController.init(window:) hands the window its own (empty) autosave name, so a name set on the window
    /// first was dropped and every launch opened at the default size.
    @MainActor
    func testTheWindowKeepsItsFrameAutosaveName() {
        let window = MarkdownDocumentWindowController.shared.window
        XCTAssertEqual(window?.frameAutosaveName, "genesis.markdown-window.v2")
    }

    /// A press held on a tab dragged the window, the window drag took the mouse-up, and every later click did
    /// nothing (2026-10-14). The title bar strip moves the window instead.
    @MainActor
    func testTheWindowDoesNotMoveFromItsBackground() {
        XCTAssertEqual(MarkdownDocumentWindowController.shared.window?.isMovableByWindowBackground, false)
    }

    func testANoteNameWithADotStillFindsItsMarkdownFile() {
        let folder = URL(fileURLWithPath: "/vault/Clients/Acme")
        let present: Set<String> = ["/vault/Clients/Acme/ado/1234.analysis.md", "/vault/Clients/Acme/report.v2.pdf"]
        let exists: (String) -> Bool = { present.contains($0) }

        XCTAssertEqual(
            MarkdownDocumentLinks.resolve("Clients/Acme/ado/1234.analysis", folder: folder, vaultRoot: "/vault", exists: exists)?.path,
            "/vault/Clients/Acme/ado/1234.analysis.md"
        )
        XCTAssertEqual(
            MarkdownDocumentLinks.locate("ado/1234.analysis#Scope", folder: folder, vaultRoot: "/vault", exists: exists)?.url.path,
            "/vault/Clients/Acme/ado/1234.analysis.md"
        )
        XCTAssertEqual(
            MarkdownDocumentLinks.resolve("report.v2.pdf", folder: folder, vaultRoot: "/vault", exists: exists)?.path,
            "/vault/Clients/Acme/report.v2.pdf",
            "a real file with a dotted name still wins"
        )
        XCTAssertNil(MarkdownDocumentLinks.resolve("ado/1234.md.md", folder: folder, vaultRoot: "/vault", exists: exists))
    }

    func testObsidianLinkUsesTheVaultFormInsideTheVaultAndThePathFormOutside() {
        let inside = URL(fileURLWithPath: "/vault/Notes/Plan.md")
        XCTAssertEqual(
            MarkdownDocumentActions.obsidianURL(for: inside, vaultRoot: "/vault", vaultName: "Brain")?.absoluteString,
            "obsidian://open?vault=Brain&file=Notes/Plan"
        )

        let outside = URL(fileURLWithPath: "/reports/2026-03/2026-03-invoices.md")
        XCTAssertEqual(
            MarkdownDocumentActions.obsidianURL(for: outside, vaultRoot: "/vault", vaultName: "Brain")?.absoluteString,
            "obsidian://open?path=/reports/2026-03/2026-03-invoices.md"
        )

        XCTAssertEqual(
            MarkdownDocumentActions.obsidianURL(for: inside, vaultRoot: nil, vaultName: nil)?.absoluteString,
            "obsidian://open?path=/vault/Notes/Plan.md"
        )
    }

    func testVaultRelativePathAndVaultNameFallBackToTheVaultFolder() {
        XCTAssertEqual(MarkdownDocumentActions.vaultRelativePath("/vault/a/b.md", vaultRoot: "/vault"), "a/b")
        XCTAssertEqual(MarkdownDocumentActions.vaultRelativePath("/vault/a/b.pdf", vaultRoot: "/vault/"), "a/b.pdf")
        XCTAssertNil(MarkdownDocumentActions.vaultRelativePath("/other/b.md", vaultRoot: "/vault"))
        XCTAssertNil(MarkdownDocumentActions.vaultRelativePath("/vault/b.md", vaultRoot: nil))
        // A path that only shares a prefix with the root is not inside it.
        XCTAssertNil(MarkdownDocumentActions.vaultRelativePath("/vaultarium/b.md", vaultRoot: "/vault"))

        XCTAssertEqual(MarkdownDocumentActions.vaultName(configured: "Brain", vaultRoot: "/vault"), "Brain")
        XCTAssertEqual(MarkdownDocumentActions.vaultName(configured: nil, vaultRoot: "/x/NotesVault"), "NotesVault")
        XCTAssertEqual(MarkdownDocumentActions.vaultName(configured: "", vaultRoot: "/x/NotesVault"), "NotesVault")
        XCTAssertNil(MarkdownDocumentActions.vaultName(configured: nil, vaultRoot: nil))
    }

    func testOutlineListsHeadingsAndNormalisesTheTopLevel() {
        let md = """
        ## Needs attention
        text
        ### Twisto
        more
        ## Entity genesis-tech
        ```
        ## not a heading, it is code
        ```
        """
        let items = MarkdownOutline.items(of: md)
        XCTAssertEqual(items.map(\.text), ["Needs attention", "Twisto", "Entity genesis-tech"])
        // The file starts at h2, so the outline indents from level 1.
        XCTAssertEqual(items.map(\.level), [1, 2, 1])
        XCTAssertEqual(items.map(\.slug), ["needs-attention", "twisto", "entity-genesis-tech"])
        XCTAssertTrue(MarkdownOutline.items(of: "plain text, no headings").isEmpty)
    }

    func testStatsCountWordsAndRoundReadingTimeUp() {
        let short = MarkdownStats.of("# Title\n\nThree more words here.")
        XCTAssertEqual(short.words, 6)
        XCTAssertEqual(short.readingMinutes, 1)
        XCTAssertEqual(short.summary, "6 words · 1 min read")

        let long = MarkdownStats.of(Array(repeating: "word", count: 450).joined(separator: " "))
        XCTAssertEqual(long.words, 450)
        // 450 / 200 = 2.25 → a reader needs three minutes, not two.
        XCTAssertEqual(long.readingMinutes, 3)

        let empty = MarkdownStats.of("   \n\n  ")
        XCTAssertEqual(empty.words, 0)
        XCTAssertEqual(empty.readingMinutes, 0)
        XCTAssertEqual(empty.summary, "empty")
    }

    func testPDFDestinationSitsBesideTheNote() {
        XCTAssertEqual(
            MarkdownExport.defaultPDFURL(for: URL(fileURLWithPath: "/reports/2026-03/2026-03-invoices.md")).path,
            "/reports/2026-03/2026-03-invoices.pdf"
        )
        XCTAssertEqual(
            MarkdownExport.defaultPDFURL(for: URL(fileURLWithPath: "/reports/notes.and.more.md")).path,
            "/reports/notes.and.more.pdf"
        )
    }

    @MainActor
    func testExportWithoutAWebRendererReportsInsteadOfFailingSilently() {
        let proxy = MarkdownWebProxy()
        XCTAssertFalse(proxy.isAttached)
        let done = expectation(description: "export answered")
        var message: String?
        proxy.exportPDF(to: URL(fileURLWithPath: "/tmp/never-written.pdf")) { error in
            message = error?.localizedDescription
            done.fulfill()
        }
        wait(for: [done], timeout: 1)
        XCTAssertEqual(message, MarkdownExportError.noWebRenderer.errorDescription)
        XCTAssertFalse(FileManager.default.fileExists(atPath: "/tmp/never-written.pdf"))

        // ⌘P without a web view says why, instead of doing nothing.
        var printMessage: String?
        proxy.printDocument(title: "Note", in: nil) { printMessage = $0 }
        XCTAssertEqual(printMessage, MarkdownExportError.noWebRenderer.errorDescription)
    }

    /// Export needs the reading web view. The source editor supports find but
    /// has no page to export, so it must not look exportable.
    @MainActor
    func testExportIsAvailableOnlyWithTheWebReadingViewOnScreen() {
        let model = MarkdownDocumentsModel(defaults: UserDefaults(suiteName: "md-export-\(UUID().uuidString)")!)
        let renderer = model.rendererRaw
        defer { model.rendererRaw = renderer }
        model.rendererRaw = MarkdownRenderer.web.rawValue
        model.setMode(.source)
        XCTAssertTrue(model.supportsFind)
        XCTAssertFalse(model.canExport)
        model.setMode(.split)
        XCTAssertTrue(model.canExport)
        model.setMode(.preview)
        XCTAssertTrue(model.canExport)
        model.rendererRaw = MarkdownRenderer.nativeRich.rawValue
        XCTAssertFalse(model.canExport)
    }

    func testIconButtonsSpeakTheActionWithoutTheShortcut() {
        XCTAssertEqual(MarkdownDocumentActions.spokenLabel("Save (⌘S)"), "Save")
        XCTAssertEqual(MarkdownDocumentActions.spokenLabel("Open in Obsidian"), "Open in Obsidian")
        XCTAssertEqual(MarkdownDocumentActions.spokenLabel("Keep on top: on"), "Keep on top: on")
    }

    @MainActor
    func testFirstWindowSizeShrinksToTheScreen() {
        let big = CGRect(x: 0, y: 0, width: 2560, height: 1415)
        XCTAssertEqual(MarkdownDocumentWindowController.firstSize(in: big), CGSize(width: 1280, height: 880))
        let laptop = CGRect(x: 0, y: 0, width: 1470, height: 880)
        XCTAssertEqual(MarkdownDocumentWindowController.firstSize(in: laptop), CGSize(width: 1280, height: 800))
        let small = CGRect(x: 0, y: 0, width: 1024, height: 700)
        XCTAssertEqual(MarkdownDocumentWindowController.firstSize(in: small), CGSize(width: 944, height: 620))
    }

    func testThemeCycleVisitsEveryPaletteAndEachSetsTheVariablesTheStylesheetReads() {
        var seen: [MarkdownTheme] = []
        var theme = MarkdownTheme.genesis
        repeat {
            seen.append(theme)
            theme = theme.next
        } while theme != .genesis
        XCTAssertEqual(Set(seen), Set(MarkdownTheme.allCases))

        let required = [
            "color-scheme", "--dd-bg", "--dd-bg-panel", "--dd-bg-elevated", "--dd-border", "--dd-border-strong",
            "--dd-text", "--dd-text-dim", "--dd-text-faint", "--dd-text-strong", "--dd-accent", "--dd-link",
            "--dd-link-underline", "--dd-tag-bg", "--dd-tag-text", "--dd-code-bg", "--dd-code-text",
        ]
        for theme in MarkdownTheme.allCases {
            let missing = required.filter { theme.cssVariables[$0] == nil }
            XCTAssertTrue(missing.isEmpty, "\(theme.label) lacks \(missing)")
        }
        XCTAssertEqual(MarkdownTheme.light.cssVariables["color-scheme"], "light")
        XCTAssertFalse(MarkdownTheme.light.isDark)
    }

    func testZoomWalksTheLadderAndClampsAtBothEnds() {
        XCTAssertEqual(MarkdownZoom.step(from: 1.0, direction: 1), 1.15)
        XCTAssertEqual(MarkdownZoom.step(from: 1.0, direction: -1), 0.9)
        XCTAssertEqual(MarkdownZoom.step(from: 2.0, direction: 1), 2.0)
        XCTAssertEqual(MarkdownZoom.step(from: 0.7, direction: -1), 0.7)
        // An off-ladder value snaps to the nearest rung, then steps.
        XCTAssertEqual(MarkdownZoom.step(from: 1.12, direction: 1), 1.3)
        XCTAssertEqual(MarkdownZoom.percent(1.15), "115%")
        XCTAssertEqual(MarkdownZoom.percent(1.0), "100%")
    }

    @MainActor
    func testClosingTheSelectedTabSelectsTheOneThatTakesItsPlace() {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("md-close-\(UUID().uuidString)")
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let urls = ["a", "b", "c", "d"].map { dir.appendingPathComponent("\($0).md") }
        for url in urls { try? "# x".write(to: url, atomically: true, encoding: .utf8) }

        let model = MarkdownDocumentsModel(defaults: UserDefaults(suiteName: "md-test-\(UUID().uuidString)")!)
        model.open(urls)
        let title = { model.docs.first { $0.id == model.selectedId }?.title }

        // The first tab: the new first, not the last (Martin, 2026-10-01).
        model.select(model.docs[0].id)
        model.close(model.docs[0])
        XCTAssertEqual(title(), "b")
        // A middle tab: the one to its right.
        model.select(model.docs[1].id)
        model.close(model.docs[1])
        XCTAssertEqual(title(), "d")
        // The last tab: the one before it.
        model.close(model.docs[1])
        XCTAssertEqual(title(), "b")
    }

    @MainActor
    func testReopenWalksBackThroughClosedTabsAndSkipsOnesAlreadyOpen() {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("md-reopen-\(UUID().uuidString)")
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let a = dir.appendingPathComponent("a.md")
        let b = dir.appendingPathComponent("b.md")
        try? "# A".write(to: a, atomically: true, encoding: .utf8)
        try? "# B".write(to: b, atomically: true, encoding: .utf8)

        let model = MarkdownDocumentsModel(defaults: UserDefaults(suiteName: "md-test-\(UUID().uuidString)")!)
        model.open([a, b])
        model.close(model.docs[1])
        model.close(model.docs[0])
        XCTAssertTrue(model.docs.isEmpty)
        XCTAssertEqual(model.recentlyClosed.map(\.lastPathComponent), ["b.md", "a.md"])

        // ⌘W on the empty window closes it; with a tab left it closes the tab (the last tab leaves the window open).
        if case .window = MarkdownDocumentWindowController.closeTarget(selected: model.selected) {} else {
            XCTFail("no tab left: ⌘W closes the window")
        }

        model.reopenLastClosed()
        XCTAssertEqual(model.docs.map(\.title), ["a"])
        if case let .tab(doc) = MarkdownDocumentWindowController.closeTarget(selected: model.selected) {
            XCTAssertEqual(doc.title, "a", "the last tab is closed, not the window")
        } else {
            XCTFail("one tab left: ⌘W closes the tab")
        }

        // b is next on the stack; a is open again, so it is not offered twice.
        model.open([a])
        model.reopenLastClosed()
        XCTAssertEqual(model.docs.map(\.title), ["a", "b"])

        model.reopenLastClosed()
        XCTAssertEqual(model.docs.count, 2)
    }

    @MainActor
    func testFindCommandCarriesTheQueryOnlyWhileTheBarIsOpen() {
        let model = MarkdownDocumentsModel(defaults: UserDefaults(suiteName: "md-test-\(UUID().uuidString)")!)
        XCTAssertEqual(model.findCommand.query, "")

        model.openFind()
        model.findQuery = "invoice"
        model.search()
        XCTAssertTrue(model.findOpen)
        XCTAssertEqual(model.findCommand.query, "invoice")
        XCTAssertEqual(model.findCommand.delta, 0)

        // Nothing marked yet: a step re-searches instead of walking nothing.
        model.stepFind(1)
        XCTAssertEqual(model.findCommand.delta, 0)

        model.findCount = 3
        model.findIndex = 1
        let before = model.findCommand.token
        model.stepFind(1)
        XCTAssertEqual(model.findCommand.delta, 1)
        XCTAssertNotEqual(model.findCommand.token, before)

        // Closing clears the query, which is what wipes the marks.
        model.closeFind()
        XCTAssertFalse(model.findOpen)
        XCTAssertEqual(model.findCommand.query, "")
        XCTAssertEqual(model.findCount, 0)
    }

    @MainActor
    func testModelReusesAnOpenDocumentAndSelectsTheLastPath() {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("md-window-\(UUID().uuidString)")
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let a = dir.appendingPathComponent("a.md")
        let b = dir.appendingPathComponent("b.md")
        try? "# A".write(to: a, atomically: true, encoding: .utf8)
        try? "# B".write(to: b, atomically: true, encoding: .utf8)

        let model = MarkdownDocumentsModel(defaults: UserDefaults(suiteName: "md-test-\(UUID().uuidString)")!)
        model.open([a, b])
        XCTAssertEqual(model.docs.map(\.title), ["a", "b"])
        XCTAssertEqual(model.selected?.title, "b")

        model.open([a])
        XCTAssertEqual(model.docs.count, 2)
        XCTAssertEqual(model.selected?.title, "a")
        XCTAssertEqual(model.selected?.text, "# A")

        model.close(model.docs[0])
        XCTAssertEqual(model.selected?.title, "b")

        model.scrollTarget = "Some heading"
        model.close(model.docs[0])
        XCTAssertNil(model.selected)
        XCTAssertNil(model.scrollTarget)
    }
}

@MainActor
final class MarkdownDocumentTabsRestoreTests: XCTestCase {
    func testTabsAndSelectionComeBackAfterARelaunchAndMissingFilesAreDropped() throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("md-tabs-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let a = dir.appendingPathComponent("A.md"), b = dir.appendingPathComponent("B.md")
        try "# A".write(to: a, atomically: true, encoding: .utf8)
        try "# B".write(to: b, atomically: true, encoding: .utf8)
        let defaults = UserDefaults(suiteName: "md-tabs-\(UUID().uuidString)")!

        let first = MarkdownDocumentsModel(defaults: defaults)
        XCTAssertTrue(first.docs.isEmpty)
        first.open([a, b])
        first.select(a.path)

        let second = MarkdownDocumentsModel(defaults: defaults)
        XCTAssertEqual(second.docs.map(\.id), [a.path, b.path])
        XCTAssertEqual(second.selectedId, a.path)

        // Closing persists too, and a file deleted while the app was down is not restored.
        second.close(second.docs[0])
        try FileManager.default.removeItem(at: b)
        let third = MarkdownDocumentsModel(defaults: defaults)
        XCTAssertTrue(third.docs.isEmpty)
        XCTAssertNil(third.selectedId)
    }
}

@MainActor
final class MarkdownHeadingLinkFollowTests: XCTestCase {
    func testFragmentOfALink() {
        XCTAssertEqual(MarkdownDocumentLinks.fragment(of: "Note#Part two"), "Part two")
        XCTAssertEqual(MarkdownDocumentLinks.fragment(of: "#Part"), "Part")
        XCTAssertNil(MarkdownDocumentLinks.fragment(of: "Note"))
        XCTAssertNil(MarkdownDocumentLinks.fragment(of: "Note#"))
    }

    /// `x.ts#L147` and `#L147-L190` open the editor at line 147; a heading fragment has no line.
    func testLineNumberOfAGitHubStyleFragment() {
        XCTAssertEqual(MarkdownDocumentLinks.lineNumber("L147"), 147)
        XCTAssertEqual(MarkdownDocumentLinks.lineNumber("L147-L190"), 147)
        XCTAssertNil(MarkdownDocumentLinks.lineNumber("Lines"))
        XCTAssertNil(MarkdownDocumentLinks.lineNumber("Part two"))
        XCTAssertNil(MarkdownDocumentLinks.lineNumber("L0"))
        XCTAssertNil(MarkdownDocumentLinks.lineNumber(nil))
    }

    /// `[[Other#Part two]]` opens the other note AND lands on the heading;
    /// before, the heading was dropped with the rest after the `#`.
    func testFollowingANoteHeadingLinkOpensTheNoteAndTargetsTheHeading() {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("md-follow-\(UUID().uuidString)")
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let a = dir.appendingPathComponent("a.md")
        let other = dir.appendingPathComponent("Other.md")
        try? "# A\n\nSee [[Other#Part two]] and [[#Local]].\n\n## Local".write(to: a, atomically: true, encoding: .utf8)
        try? "# Other\n\n## Part two".write(to: other, atomically: true, encoding: .utf8)

        let model = MarkdownDocumentsModel(defaults: UserDefaults(suiteName: "md-test-\(UUID().uuidString)")!)
        model.open([a])
        let doc = model.selected!
        model.follow("Other#Part two", from: doc)
        XCTAssertEqual(model.selected?.url.lastPathComponent, "Other.md")
        XCTAssertEqual(model.scrollTarget, "Part two")

        model.select(doc.id)
        XCTAssertNil(model.scrollTarget, "selecting a tab clears the jump")
        model.follow("#Local", from: doc)
        XCTAssertEqual(model.selected?.id, doc.id, "a bare heading link stays in the note")
        XCTAssertEqual(model.scrollTarget, "Local")
    }

    /// PR #82 review: `mailto:` has no `//`, so it used to be resolved as a relative path and
    /// dropped. The source editor's ⌘-click and the wikilinks reach `follow` with it.
    func testFollowingAMailtoLinkOpensItAndOtherBareSchemesStayDropped() {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("md-mailto-\(UUID().uuidString)")
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let a = dir.appendingPathComponent("a.md")
        try? "# A\n\n[ask]: mailto:team@example.com\n".write(to: a, atomically: true, encoding: .utf8)

        let model = MarkdownDocumentsModel(defaults: UserDefaults(suiteName: "md-test-\(UUID().uuidString)")!)
        var opened: [String] = []
        model.openExternally = { opened.append($0.absoluteString) }
        model.open([a])
        let doc = model.selected!
        model.follow("mailto:a@b.c", from: doc)
        model.follow("ask", from: doc)
        model.follow("tel:123", from: doc)
        XCTAssertEqual(opened, ["mailto:a@b.c", "mailto:team@example.com"], "tel: is not on the allowlist")
        XCTAssertEqual(model.docs.count, 1, "no link opened a tab")
    }

    /// PR #82 review: Knowledge's native preview sent `file:` links to the note-title resolver,
    /// so a PDF (or even a `file:` link to a note) did nothing.
    func testAFileLinkInAVaultNoteOpensTheNoteOrTheDocumentAndNeverAnApp() throws {
        let fm = FileManager.default
        let vault = fm.temporaryDirectory.appendingPathComponent("md-vault-\(UUID().uuidString)")
        try fm.createDirectory(at: vault.appendingPathComponent("sub"), withIntermediateDirectories: true)
        let note = vault.appendingPathComponent("sub/Note.md")
        let pdf = vault.appendingPathComponent("sub/scan.pdf")
        let script = vault.appendingPathComponent("run.command")
        try "# Note".write(to: note, atomically: true, encoding: .utf8)
        try "%PDF-1.4".write(to: pdf, atomically: true, encoding: .utf8)
        try "echo pwned".write(to: script, atomically: true, encoding: .utf8)

        XCTAssertEqual(MarkdownDocumentLinks.fileLinkTarget("file://\(note.path)#Part", vaultRoot: vault.path),
                       .note(path: "sub/Note.md", fragment: "Part"))
        XCTAssertEqual(MarkdownDocumentLinks.fileLinkTarget("file://\(pdf.path)", vaultRoot: vault.path),
                       .document(pdf.standardizedFileURL))
        XCTAssertNil(MarkdownDocumentLinks.fileLinkTarget("file://\(script.path)", vaultRoot: vault.path))
        XCTAssertNil(MarkdownDocumentLinks.fileLinkTarget("file:///System/Applications/Calculator.app", vaultRoot: vault.path))
        XCTAssertNil(MarkdownDocumentLinks.fileLinkTarget("Note", vaultRoot: vault.path), "not a file: link")

        // A `#` in a file name arrives as `%23`; it belongs to the path, not the fragment.
        let hashed = vault.appendingPathComponent("sub/My#Note.md")
        try "# Hashed".write(to: hashed, atomically: true, encoding: .utf8)
        XCTAssertEqual(MarkdownDocumentLinks.fileLinkTarget("file://\(vault.path)/sub/My%23Note.md#Part%20two",
                                                            vaultRoot: vault.path),
                       .note(path: "sub/My#Note.md", fragment: "Part two"))
    }

    /// The markdown window's `follow` takes the same `file:` links through `filePath` and
    /// `resolve`, which cuts at the first `#`.
    func testFollowingAFileLinkKeepsAHashInTheFileName() throws {
        let fm = FileManager.default
        let dir = fm.temporaryDirectory.appendingPathComponent("md-hash-\(UUID().uuidString)")
        try fm.createDirectory(at: dir, withIntermediateDirectories: true)
        let a = dir.appendingPathComponent("a.md")
        let hashed = dir.appendingPathComponent("My#Note 100%.md")
        try "# A".write(to: a, atomically: true, encoding: .utf8)
        try "# Hashed\n\n## Part two".write(to: hashed, atomically: true, encoding: .utf8)

        let model = MarkdownDocumentsModel(defaults: UserDefaults(suiteName: "md-test-\(UUID().uuidString)")!)
        model.open([a])
        let doc = model.selected!
        model.follow("file://\(dir.path)/My%23Note%20100%25.md#Part%20two", from: doc)
        XCTAssertEqual(model.selected?.url.lastPathComponent, "My#Note 100%.md")
        XCTAssertEqual(model.scrollTarget, "Part two")
    }
}

/// Genesis Markdown has a transparent title bar with its toolbar right under it, so AppKit never saw
/// a double-click there. The window's `.titlebarZone(below:)` answers it now (UI/WindowTitlebar.swift):
/// the empty title bar and toolbar zoom and drag, a toolbar button keeps its clicks.
final class MarkdownWindowChromeTests: XCTestCase {
    /// The real toolbar with a document open, in a window shaped like the viewer's.
    @MainActor
    func testTheEmptyToolbarReachesTheZoneAndItsButtonsKeepTheirClicks() throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("md-chrome-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let note = dir.appendingPathComponent("note.md")
        try "# Note\n\nBody.".write(to: note, atomically: true, encoding: .utf8)
        let model = MarkdownDocumentsModel(defaults: UserDefaults(suiteName: "md-chrome-\(UUID().uuidString)")!)
        model.open([note])

        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 1100, height: 600),
            styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
            backing: .buffered,
            defer: false
        )
        window.title = "Markdown"
        window.titlebarAppearsTransparent = true
        window.isMovableByWindowBackground = true
        window.isReleasedWhenClosed = false
        window.contentView = MarkdownDocumentWindowController.contentView(model: model)
        window.alphaValue = 0
        window.level = .init(rawValue: Int(CGWindowLevelForKey(.desktopWindow)) - 1)
        window.orderFrontRegardless()
        defer {
            window.orderOut(nil)
            window.close()
        }
        RunLoop.main.run(until: Date().addingTimeInterval(1.0))

        // The title bar itself: the zone past the traffic lights and the title.
        let audit = WindowTitlebar.audit(window)
        XCTAssertEqual(audit.problems, [], audit.line)
        XCTAssertTrue(audit.runs.contains { $0.kind == .zone }, audit.line)
        // The toolbar's middle line, right under it: its spacer is the zone, its buttons are not.
        let frameView = try XCTUnwrap(window.contentView?.superview)
        let y = window.frame.height - WindowTitlebar.stripHeight(of: window) - MarkdownDocumentToolbar.height / 2
        var samples: [(x: CGFloat, kind: WindowTitlebar.Audit.Kind)] = []
        for x in stride(from: CGFloat(0), to: window.frame.width, by: 2) {
            let hit = frameView.hitTest(frameView.convert(NSPoint(x: x, y: y), from: nil))
            samples.append((x, hit is TitlebarZoneView ? .zone : .content))
        }
        let runs = WindowTitlebar.Audit.runs(samples, step: 2)
        let line = runs.map { "\($0.kind.rawValue) \(Int($0.minX))-\(Int($0.maxX))" }.joined(separator: ", ")
        // The row's leading inset, then a gap between every two buttons. The row sits under the title bar, so the
        // traffic lights need no room in it (the 68 pt spacer went in the 2026-10-13 UX round).
        let lead = try XCTUnwrap(runs.first { $0.kind == .zone }, line)
        XCTAssertLessThan(lead.minX, 10, "the toolbar's leading room: \(line)")
        XCTAssertGreaterThanOrEqual(lead.maxX - lead.minX, 6, "the toolbar's leading room: \(line)")
        XCTAssertLessThan(lead.maxX, 30, "the first button starts near the window's edge: \(line)")
        XCTAssertGreaterThanOrEqual(runs.filter { $0.kind == .zone }.count, 5, "gaps between the buttons: \(line)")
        XCTAssertGreaterThanOrEqual(runs.filter { $0.kind == .content }.count, 5, "the toolbar's buttons: \(line)")
        // The toolbar's trailing end is empty: the strip stays the zone up to the right edge. (The folder
        // path that sat there moved into the title bar as `MarkdownPathBar`; as a label with a tooltip it
        // had taken the pointer along most of the row, 2026-10-01, .claude/docs/swift-headers.md.)
        // The last 2 points are the window's edge, so the check reads the run just inside it.
        let edge = window.frame.width - 20
        let trailing = try XCTUnwrap(runs.first { $0.minX <= edge && edge < $0.maxX }, line)
        XCTAssertEqual(trailing.kind, .zone, "the toolbar's trailing path: \(line)")
        XCTAssertGreaterThan(trailing.maxX - trailing.minX, 200, "the toolbar's trailing path: \(line)")
        // Under the toolbar the page keeps its clicks.
        let page = NSPoint(x: (lead.minX + lead.maxX) / 2, y: y - MarkdownDocumentToolbar.height)
        XCTAssertFalse(frameView.hitTest(frameView.convert(page, from: nil)) is TitlebarZoneView)

        // A file dropped on the toolbar's empty part opens as a tab, as a drop on the rest of the window
        // does. AppKit picks a drag's destination by frame, so a drag over the page is not the zone's.
        let x = (lead.minX + lead.maxX) / 2
        let toolbarLine = window.frame.height - y
        let zone = try XCTUnwrap(frameView.hitTest(frameView.convert(NSPoint(x: x, y: y), from: nil)) as? TitlebarZoneView)
        XCTAssertTrue(try titlebarDragDestination(window, x: x, yFromTop: toolbarLine) === zone)
        XCTAssertFalse(try titlebarDragDestination(window, x: x, yFromTop: toolbarLine + MarkdownDocumentToolbar.height + 60) === zone)
        let other = dir.appendingPathComponent("other.md")
        try "# Other".write(to: other, atomically: true, encoding: .utf8)
        XCTAssertTrue(zone.performDragOperation(TitlebarFakeDrag(files: [other])))
        XCTAssertEqual(model.selected?.url.standardizedFileURL, other.standardizedFileURL, "the dropped file is the open tab")
    }

    /// The viewer's own window class zooms to the whole visible screen, the way a double-click on its
    /// title bar asks (Martin, 2026-10-02: "genesis markdown header doesnt resize it to full size").
    /// `ConstraintSafeWindow` dropped every `setFrame` made inside another one, and an animated zoom
    /// sets the frame step by step from inside its own `setFrame(_:display:animate:)`.
    @MainActor
    func testTheViewersWindowZoomsToTheVisibleScreen() throws {
        let window = MarkdownDocumentWindow(
            contentRect: NSRect(x: 0, y: 0, width: 700, height: 500),
            styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
            backing: .buffered,
            defer: false
        )
        window.isReleasedWhenClosed = false
        window.alphaValue = 0
        window.level = .init(rawValue: Int(CGWindowLevelForKey(.desktopWindow)) - 1)
        window.orderFrontRegardless()
        defer {
            window.orderOut(nil)
            window.close()
        }
        guard let visible = window.screen?.visibleFrame else {
            throw XCTSkip("no screen: a headless session cannot zoom a window")
        }
        window.setFrame(NSRect(x: visible.minX + 40, y: visible.minY + 40, width: 700, height: 500), display: true)
        let start = window.frame
        // The zoom animates: wait for the frame to arrive, up to 5 s, rather than a fixed half second.
        func settle(until done: () -> Bool) {
            let deadline = Date().addingTimeInterval(5)
            while !done(), Date() < deadline {
                RunLoop.main.run(until: Date().addingTimeInterval(0.05))
            }
        }
        window.zoom(nil)
        settle { window.frame.width > start.width + 100 && window.frame.height > start.height + 100 }
        XCTAssertGreaterThan(window.frame.width, start.width + 100, "zoom: \(start) -> \(window.frame), screen \(visible)")
        XCTAssertGreaterThan(window.frame.height, start.height + 100, "zoom: \(start) -> \(window.frame), screen \(visible)")
        window.zoom(nil)
        settle { window.frame.size == start.size }
        XCTAssertEqual(window.frame.size, start.size, "a second zoom puts it back")
    }
}
