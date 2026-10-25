import AppKit
@testable import GenesisKit
import SwiftUI
import XCTest

/// The window and tab bar fixes of the UX audit of 2026-10-25 (W1 to W26, E2, D1): the message slot, saves that fail
/// inside the unsaved-changes prompt, batch closes with one Undo, tab keys and moves, dead links, dropped programs,
/// the menu bar and the tab-drag check. Model-level and menu-level only: no window is shown.
@MainActor
final class MarkdownWindowUxTests: XCTestCase {
    private var root: URL!
    private var model: MarkdownDocumentsModel!

    override func setUpWithError() throws {
        root = FileManager.default.temporaryDirectory
            .appendingPathComponent("md-window-ux-\(UUID().uuidString)")
            .standardizedFileURL
        try FileManager.default.createDirectory(at: root.appendingPathComponent("locked"), withIntermediateDirectories: true)
        for path in ["a.md", "b.md", "c.md", "d.md", "locked/note.md"] {
            try "# \(path)".write(to: root.appendingPathComponent(path), atomically: true, encoding: .utf8)
        }
        let suite = "md-window-ux-\(UUID().uuidString)"
        model = MarkdownDocumentsModel(defaults: UserDefaults(suiteName: suite)!)
        addTeardownBlock { UserDefaults.standard.removePersistentDomain(forName: suite) }
    }

    override func tearDownWithError() throws {
        try? FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: root.appendingPathComponent("locked").path)
        try? FileManager.default.removeItem(at: root)
    }

    private func url(_ path: String) -> URL { root.appendingPathComponent(path).standardizedFileURL }

    // MARK: The message slot (W2, E2, D1)

    func testAnErrorStaysWholeAndASuccessHasALifetime() {
        let error = MarkdownNotice("The note could not be saved. Check that the file can be written and the disk has room, then save again.", tone: .error)
        XCTAssertNil(error.lifetime, "an error stays until it is closed")
        let success = MarkdownNotice("Replaced 3 matches", tone: .success)
        XCTAssertEqual(success.lifetime, 3, "a short success reads in the minimum 3 s")
        let undo = MarkdownNotice("Closed 4 tabs.", tone: .info, actions: [.button("Reopen 4 Tabs") {}])
        XCTAssertEqual(undo.lifetime, 8, "a note with a button stays long enough to reach it")
        XCTAssertEqual(MarkdownNotice("x", tone: .info).tone.pill, .success)
        XCTAssertEqual(MarkdownNotice("x", tone: .warning).tone.pill, .warning)
    }

    func testANewNoteReplacesTheOldAndAStaleDismissLeavesTheNewOne() {
        model.post(MarkdownNotice("first", tone: .success))
        let first = try? XCTUnwrap(model.notice?.id)
        model.post(MarkdownNotice("second", tone: .error))
        model.dismissNotice(first)
        XCTAssertEqual(model.notice?.text, "second", "the first note's timer must not close the second")
        XCTAssertEqual(model.exportError, "second")
        model.exportError = nil
        XCTAssertNil(model.notice)
    }

    func testReplaceAllPostsASuccessNotAnError() throws {
        model.open([url("a.md")])
        model.setMode(.source)
        model.openFind()
        model.findQuery = "a"
        model.replaceText = "z"
        model.replaceAll()
        XCTAssertEqual(model.notice?.tone, .success)
        XCTAssertNil(model.exportError, "a replace count is not an error")
    }

    func testReplaceAllOffersUndoThatPutsTheTextBack() throws {
        model.open([url("a.md")])
        model.setMode(.source)
        model.openFind()
        model.findQuery = "a"
        model.replaceText = "z"
        let doc = try XCTUnwrap(model.selected)
        let before = doc.displayText
        model.replaceAll()
        XCTAssertNotEqual(doc.displayText, before)
        let undo = try XCTUnwrap(model.notice?.actions.first)
        XCTAssertEqual(undo.label, "Undo")
        guard case .action(_, let perform) = undo.kind else { return XCTFail("no button") }
        perform()
        XCTAssertEqual(doc.displayText, before)
        XCTAssertFalse(doc.isDirty)
    }

    func testNextAndPreviousChangeAreSourceKeysThatClashWithNothing() {
        for layout in [TableKeyLayout.us] {
            let keys = Keymap(library: MarkdownKeymap.library, store: nil, layout: layout)
            XCTAssertEqual(keys.chord(for: "markdown.edit.nextChange"), .code(30, [.option, .command]))
            XCTAssertEqual(keys.chord(for: "markdown.edit.previousChange"), .code(33, [.option, .command]))
            XCTAssertEqual(keys.conflicts(), [])
        }
        XCTAssertEqual(MarkdownKeymap.library.command("markdown.edit.nextChange")?.scope, MarkdownKeymap.sourceScope)
    }

    func testAShareFailureKeepsItsSentenceAndPutsTheCommandsWordsBehindDetails() {
        let notice = MarkdownDocumentToolbar.shareNotice("The dev dashboard could not share this note. Details say why.",
                                                         detail: "error: ECONNREFUSED\nExit code 1.")
        XCTAssertEqual(notice.text, "The dev dashboard could not share this note. Details say why.")
        XCTAssertEqual(notice.more, "error: ECONNREFUSED\nExit code 1.")
        XCTAssertEqual(notice.tone, .error)
        XCTAssertNil(notice.lifetime)
    }

    func testMutedExportButtonsSayWhy() {
        XCTAssertEqual(MarkdownDocumentToolbar.exportTooltip("Save as PDF (⇧⌘S)", canExport: true, what: "PDF"), "Save as PDF (⇧⌘S)")
        let muted = MarkdownDocumentToolbar.exportTooltip("Save as PDF (⇧⌘S)", canExport: false, what: "PDF")
        XCTAssertEqual(muted, "Save as PDF (⇧⌘S). PDF needs the reading view with the Web renderer.")
        XCTAssertEqual(MarkdownDocumentActions.spokenLabel(muted), "Save as PDF", "VoiceOver still hears the action")
        XCTAssertFalse(muted.contains("\u{2014}") || muted.contains("\u{2013}"))
    }

    // MARK: Save in the unsaved-changes prompt (W1)

    func testAFailedSaveInTheClosePromptKeepsTheTabSaysWhyAndOffersTryAgain() throws {
        model.open([url("locked/note.md"), url("a.md")])
        let note = try XCTUnwrap(model.docs.first { $0.url == url("locked/note.md") })
        note.edit("changed")
        // A folder that cannot be written: the atomic save cannot create its temporary file.
        try FileManager.default.setAttributes([.posixPermissions: 0o555], ofItemAtPath: url("locked").path)

        XCTAssertFalse(model.close(note) { _ in .save })

        XCTAssertTrue(model.docs.contains { $0.id == note.id }, "the tab stays")
        XCTAssertEqual(model.selected?.id, note.id, "the failed tab is the one on screen")
        XCTAssertEqual(model.notice?.tone, .error)
        XCTAssertEqual(model.notice?.actions.map(\.label), ["Try Again"])
    }

    func testASaveRefusedByADiskChangeInTheWindowPromptSaysSo() throws {
        model.open([url("a.md"), url("b.md")])
        let a = try XCTUnwrap(model.docs.first { $0.url == url("a.md") })
        a.edit("mine")
        try "theirs".write(to: url("a.md"), atomically: true, encoding: .utf8)

        XCTAssertFalse(model.resolveUnsavedForClose { _ in .save })

        XCTAssertEqual(model.selected?.id, a.id)
        XCTAssertEqual(model.notice?.tone, .error)
        XCTAssertTrue(model.notice?.text.contains("changed on disk") == true)
    }

    // MARK: Batch close and Undo (W3)

    func testClosingSeveralTabsIsOneUndo() throws {
        model.open([url("a.md"), url("b.md"), url("c.md"), url("d.md")])
        let closing = model.docs.filter { $0.url != url("a.md") }

        XCTAssertTrue(model.closeTabs(closing) { _ in .discard })

        XCTAssertEqual(model.docs.map(\.url), [url("a.md")])
        XCTAssertEqual(model.notice?.text, "Closed 3 tabs.")
        XCTAssertEqual(model.notice?.actions.map(\.label), ["Reopen 3 Tabs"])
        model.reopenLastClosed()
        XCTAssertEqual(Set(model.docs.map(\.url)), Set([url("a.md"), url("b.md"), url("c.md"), url("d.md")]),
                       "⇧⌘T brings the whole batch back")
    }

    func testCloseOtherTabsIsOneUndoAndNamesTheCount() throws {
        model.open([url("a.md"), url("b.md"), url("c.md")])
        let keep = try XCTUnwrap(model.docs.first { $0.url == url("b.md") })
        XCTAssertEqual(model.closeOthersTitle, "Close 2 Other Tabs")
        model.closeOthers(keep) { _ in .discard }
        XCTAssertEqual(model.docs.map(\.url), [url("b.md")])
        XCTAssertEqual(model.notice?.actions.map(\.label), ["Reopen 2 Tabs"])
        XCTAssertEqual(model.closeOthersTitle, "Close 0 Other Tabs")
        model.reopenLastClosed()
        XCTAssertEqual(model.docs.count, 3)
        model.close(try XCTUnwrap(model.docs.first { $0.url == url("c.md") }))
        XCTAssertEqual(model.closeOthersTitle, "Close Other Tab")
    }

    func testTheFileMenuOffersCloseOtherTabs() throws {
        let keys = Keymap(library: MarkdownKeymap.library, store: nil, layout: TableKeyLayout.us)
        let file = try XCTUnwrap(MarkdownViewerMenu.submenu("File", in: MarkdownViewerMenu.build(appName: "Viewer", keymap: keys)))
        let titles = file.items.map(\.title)
        let close = try XCTUnwrap(titles.firstIndex(of: "Close Tab"))
        XCTAssertEqual(titles[close + 1], "Close Other Tabs")
    }

    func testADropSaysWhatHappenedInOneSentence() {
        let notes = [url("a.md"), url("b.md")]
        let pdf = url("paper.pdf")
        XCTAssertNil(MarkdownDocumentsModel.dropSummary(opened: notes, sent: [], folder: nil, gone: 0, held: []),
                     "tabs alone need no note")
        XCTAssertEqual(MarkdownDocumentsModel.dropSummary(opened: notes, sent: [("Preview", pdf)], folder: nil, gone: 0, held: []),
                       "Opened 2 notes and sent \u{201C}paper.pdf\u{201D} to Preview.")
        XCTAssertEqual(MarkdownDocumentsModel.dropSummary(opened: [url("a.md")], sent: [("Preview", pdf), ("Preview", url("b.pdf"))],
                                                          folder: url("locked"), gone: 1, held: []),
                       "Opened 1 note, sent 2 files to Preview, showed locked in the sidebar and 1 file was not found.")
        XCTAssertEqual(MarkdownDocumentsModel.dropSummary(opened: [], sent: [], folder: nil, gone: 0, held: [url("run.command")]),
                       "\u{201C}run.command\u{201D} is not a file this viewer shows, and opening it can start a program.")
    }

    func testASingleCloseAfterABatchReopensOnlyThatTab() throws {
        model.open([url("a.md"), url("b.md"), url("c.md"), url("d.md")])
        model.closeTabs(model.docs.filter { $0.url == url("b.md") || $0.url == url("c.md") }) { _ in .discard }
        let d = try XCTUnwrap(model.docs.first { $0.url == url("d.md") })
        model.close(d)

        model.reopenLastClosed()
        XCTAssertEqual(Set(model.docs.map(\.url)), [url("a.md"), url("d.md")])
        model.reopenLastClosed()
        XCTAssertEqual(model.docs.count, 3, "the stack walks back one entry at a time once the batch is no longer last")
    }

    func testTheReopenStackKeepsMoreThanTwentyTabs() {
        let urls = (0..<30).map { url("many-\($0).md") }
        for file in urls { try? "x".write(to: file, atomically: true, encoding: .utf8) }
        model.open(urls)
        model.closeTabs(model.docs) { _ in .discard }
        XCTAssertEqual(model.recentlyClosed.count, 30)
        model.reopenLastClosed()
        XCTAssertEqual(model.docs.count, 30)
    }

    // MARK: Tab keys and moves (W4, W6)

    func testCommandNumberSelectsByPlaceAndNineIsTheLastTab() {
        model.open([url("a.md"), url("b.md"), url("c.md")])
        model.selectTab(number: 1)
        XCTAssertEqual(model.selected?.url, url("a.md"))
        model.selectTab(number: 2)
        XCTAssertEqual(model.selected?.url, url("b.md"))
        model.selectTab(number: 9)
        XCTAssertEqual(model.selected?.url, url("c.md"))
        model.selectTab(number: 5)
        XCTAssertEqual(model.selected?.url, url("c.md"), "a number past the tabs does nothing")
    }

    func testMoveTabLeftAndRightIsTheKeyboardTwinOfADrag() throws {
        model.open([url("a.md"), url("b.md"), url("c.md")])
        let a = try XCTUnwrap(model.docs.first).id
        XCTAssertFalse(model.canShiftTab(a, by: -1))
        model.shiftTab(a, by: 1)
        XCTAssertEqual(model.docs.map(\.url), [url("b.md"), url("a.md"), url("c.md")])
        model.shiftTab(a, by: 1)
        XCTAssertEqual(model.docs.map(\.url), [url("b.md"), url("c.md"), url("a.md")])
        XCTAssertFalse(model.canShiftTab(a, by: 1))
        model.shiftTab(a, by: -1)
        XCTAssertEqual(model.docs.map(\.url), [url("b.md"), url("a.md"), url("c.md")])
    }

    func testTheNewKeysAreBoundAndConflictFree() throws {
        let keys = Keymap(library: MarkdownKeymap.library, store: nil, layout: TableKeyLayout.us)
        XCTAssertEqual(keys.chord(for: "markdown.file.open"), .character("o", .command))
        XCTAssertEqual(keys.chord(for: MarkdownKeymap.tabNumberCommand(1)), .character("1", .command))
        XCTAssertEqual(keys.chord(for: MarkdownKeymap.tabNumberCommand(9)), .character("9", .command))
        XCTAssertEqual(keys.conflicts(), [])

        model.open([url("a.md"), url("b.md")])
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 300, height: 200), styleMask: [.titled],
                              backing: .buffered, defer: true)
        let dispatcher = KeymapDispatcher()
        let held = MarkdownKeymap.registerWindowCommands(model: model, window: window, keymap: keys, dispatcher: dispatcher) {}
        defer { held.forEach { $0.cancel() } }
        XCTAssertTrue(dispatcher.handle(KeyStroke(keyCode: 18, character: "1", modifiers: .command), in: window, typing: false))
        XCTAssertEqual(model.selected?.url, url("a.md"))
    }

    // MARK: Menu bar (W4, W5)

    func testEveryWindowCommandWithAKeyIsAMenuItem() throws {
        let keys = Keymap(library: MarkdownKeymap.library, store: nil, layout: TableKeyLayout.us)
        let menu = MarkdownViewerMenu.build(appName: "Viewer", keymap: keys)
        func items(_ menu: NSMenu) -> [NSMenuItem] {
            menu.items.flatMap { [$0] + ($0.submenu.map(items) ?? []) }
        }
        let all = items(menu)
        let file = try XCTUnwrap(MarkdownViewerMenu.submenu("File", in: menu))
        XCTAssertEqual(file.items.first?.title, "Open…")
        XCTAssertEqual(file.items.first?.keyEquivalent, "o")
        XCTAssertNotNil(MarkdownViewerMenu.submenu("View", in: menu))
        let commands = all.compactMap { $0.representedObject as? String }
        let actions = MarkdownKeymap.windowActions(model: model, window: nil, keymap: keys) {}.map(\.0)
        let named: Set<String> = ["markdown.tab.close", "markdown.tab.reopen", "markdown.tab.next", "markdown.tab.previous",
                                  "markdown.history.back", "markdown.history.forward", "markdown.file.save",
                                  "markdown.file.copyPath", "markdown.file.goto", "markdown.window.close",
                                  "markdown.help.shortcuts"]
        for id in actions where !named.contains(id) {
            XCTAssertTrue(commands.contains(id), "\(id) has a key but no menu item")
        }
        for item in all where item.action == #selector(MarkdownDocumentWindowController.performCommand(_:)) {
            XCTAssertTrue(actions.contains(item.representedObject as? String ?? ""), "\(item.title) runs no command")
        }
    }

    // MARK: Links and drops (W8, W14)

    func testALinkToNothingSaysSo() throws {
        model.open([url("a.md")])
        let doc = try XCTUnwrap(model.selected)
        model.follow("[[Nowhere]]", from: doc)
        model.follow("Nowhere", from: doc)
        XCTAssertEqual(model.notice?.tone, .warning)
        XCTAssertTrue(model.notice?.text.contains("Nowhere") == true)
    }

    func testADroppedScriptWaitsForOpenAnyway() throws {
        let script = url("run.command")
        try "#!/bin/sh\necho hi".write(to: script, atomically: true, encoding: .utf8)
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: script.path)
        var opened: [URL] = []
        model.openExternally = { opened.append($0) }
        model.defaultApp = { _ in DefaultApp(url: URL(fileURLWithPath: "/System/Applications/Utilities/Terminal.app"),
                                             name: "Terminal", bundleIdentifier: "com.apple.Terminal", schemes: []) }

        model.acceptDrop([script])

        XCTAssertEqual(opened, [], "a stray drop does not start a program")
        let notice = try XCTUnwrap(model.notice)
        XCTAssertEqual(notice.tone, .warning)
        guard case .action(_, let perform) = try XCTUnwrap(notice.actions.first).kind else { return XCTFail("no button") }
        perform()
        XCTAssertEqual(opened, [script])
    }

    // MARK: Tab drags (W13)

    func testPlainTextFromElsewhereIsNoTabDrag() {
        let board = NSPasteboard(name: NSPasteboard.Name("md-window-ux-\(UUID().uuidString)"))
        defer { board.releaseGlobally() }
        MarkdownTabDrag.active = .tab("left over from a cancelled drag")
        board.clearContents()
        board.setString("some words from a page", forType: .string)
        XCTAssertNil(MarkdownTabDrag.inFlight(pasteboard: board))
        board.clearContents()
        board.setString(MarkdownTabDrag.tab("x"), forType: .string)
        XCTAssertEqual(MarkdownTabDrag.inFlight(pasteboard: board), .tab("x"))
        MarkdownTabDrag.active = nil
    }

    // MARK: Settings (W7)

    func testTheSettingsCardsBindTheTabAndPreviewKeys() {
        let configuration = GenesisKitMarkdownConfiguration(defaults: UserDefaults(suiteName: "md-window-ux-settings-\(UUID().uuidString)")!)
        XCTAssertTrue(configuration.previewTabs, "defaults stay as they were")
        XCTAssertTrue(configuration.hoverPreview)
        XCTAssertEqual(configuration.hoverPreviewDelay, 1.0)
        let hosting = NSHostingView(rootView: MarkdownSettingsView(configuration: configuration))
        hosting.frame = NSRect(x: 0, y: 0, width: 560, height: 1400)
        hosting.layoutSubtreeIfNeeded()
        XCTAssertGreaterThan(hosting.fittingSize.height, 0)
    }
}
