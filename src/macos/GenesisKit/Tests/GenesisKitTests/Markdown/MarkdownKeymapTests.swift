import AppKit
@testable import GenesisKit
import XCTest

/// The markdown viewer's keys through `MarkdownKeymap` (Martin, 2026-10-15).
@MainActor
final class MarkdownKeymapTests: XCTestCase {
    /// What the Czech and US layouts type on the keys these tests press (UCKeyTranslate, 2026-10-15).
    private let czech = TableKeyLayout(
        [30: ")", 33: "ú", 13: "w", 11: "b", 7: "x", 32: "u", 27: "=", 44: "-", 18: "+", 29: "é"],
        shifted: [30: "(", 33: "/", 18: "1", 29: "0"])

    private func folder() throws -> URL {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("md-keymap-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        addTeardownBlock { try? FileManager.default.removeItem(at: dir) }
        return dir
    }

    private func notes(_ names: [String], in dir: URL) throws -> [URL] {
        try names.map { name in
            let url = dir.appendingPathComponent("\(name).md")
            try "# \(name)".write(to: url, atomically: true, encoding: .utf8)
            return url
        }
    }

    private func model() -> MarkdownDocumentsModel {
        let suite = "md-keymap-\(UUID().uuidString)"
        addTeardownBlock { UserDefaults.standard.removePersistentDomain(forName: suite) }
        return MarkdownDocumentsModel(defaults: UserDefaults(suiteName: suite)!)
    }

    private func stroke(_ code: UInt16, _ character: String, _ modifiers: KeyModifiers) -> KeyStroke {
        KeyStroke(keyCode: code, character: character, modifiers: modifiers)
    }

    func testTheViewersKeysHaveNoConflictOnACzechOrAUSKeyboard() {
        XCTAssertEqual(Keymap(library: MarkdownKeymap.library, store: nil, layout: czech).conflicts(), [])
        XCTAssertEqual(Keymap(library: MarkdownKeymap.library, store: nil, layout: TableKeyLayout.us).conflicts(), [])
    }

    /// PR #82 review, kept: ⇧⌘ on the two keys right of P switch tabs by position. With Shift a US layout types
    /// } and {, the Czech one ( and /, and a character match never fired. Now ⌘ alone on them is Back and Forward.
    func testTheTabAndHistoryKeysGoByPositionOnAnyLayout() throws {
        let dir = try folder()
        let model = model()
        model.open(try notes(["a", "b", "c"], in: dir))
        XCTAssertEqual(model.selected?.title, "c")
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 300, height: 200), styleMask: [.titled],
                              backing: .buffered, defer: true)
        let dispatcher = KeymapDispatcher()
        let keymap = Keymap(library: MarkdownKeymap.library, store: nil, layout: czech)
        var closed = 0
        let held = MarkdownKeymap.registerWindowCommands(
            model: model, window: window, keymap: keymap, dispatcher: dispatcher) { closed += 1 }
        defer { held.forEach { $0.cancel() } }
        func press(_ code: UInt16, _ character: String, _ modifiers: KeyModifiers = [.command, .shift]) -> Bool {
            dispatcher.handle(stroke(code, character, modifiers), in: window, typing: false)
        }

        XCTAssertTrue(press(30, "}"), "US ⇧⌘]")
        XCTAssertEqual(model.selected?.title, "a", "wraps past the last tab")
        XCTAssertTrue(press(30, "("), "Czech ⇧⌘ on the ) key")
        XCTAssertEqual(model.selected?.title, "b")
        XCTAssertTrue(press(33, "/"), "Czech ⇧⌘ on the ú key")
        XCTAssertEqual(model.selected?.title, "a")
        XCTAssertTrue(press(33, "{"), "US ⇧⌘[")
        XCTAssertEqual(model.selected?.title, "c", "wraps past the first tab")
        XCTAssertFalse(press(30, "’", [.command, .shift, .option]), "another modifier set is not the key")
        XCTAssertEqual(model.selected?.title, "c")

        // Shown: c, a, b, a, c. Back walks them in reverse, whatever the layout types on the key.
        XCTAssertTrue(press(33, "ú", .command), "Czech ⌘ú")
        XCTAssertEqual(model.selected?.title, "a")
        XCTAssertTrue(press(33, "[", .command), "US ⌘[")
        XCTAssertEqual(model.selected?.title, "b")
        XCTAssertTrue(press(30, ")", .command), "Czech ⌘)")
        XCTAssertEqual(model.selected?.title, "a")

        XCTAssertTrue(press(13, "w", .command))
        XCTAssertEqual(closed, 1, "⌘W is the tab")
        XCTAssertFalse(press(1, "s", [.command, .option]))
    }

    func testBackAndForwardWalkTheNotesShownAndReopenAClosedTab() throws {
        let dir = try folder()
        let model = model()
        let urls = try notes(["a", "b", "c"], in: dir)
        model.open(urls)
        model.select(urls[0].standardizedFileURL.path)
        XCTAssertEqual(model.history.entries.map { URL(fileURLWithPath: $0).lastPathComponent },
                       ["a.md", "b.md", "c.md", "a.md"])
        XCTAssertFalse(model.canGoForward)

        model.goBack()
        XCTAssertEqual(model.selected?.title, "c")
        model.goBack()
        XCTAssertEqual(model.selected?.title, "b")
        model.goForward()
        XCTAssertEqual(model.selected?.title, "c")

        // b's tab closes; Back opens it again.
        let b = try XCTUnwrap(model.docs.first { $0.title == "b" })
        XCTAssertTrue(model.close(b))
        XCTAssertFalse(model.docs.contains { $0.title == "b" })
        model.goBack()
        XCTAssertEqual(model.selected?.title, "b")
        XCTAssertTrue(model.docs.contains { $0.title == "b" }, "the closed tab is open again")

        // A note shown after going back drops the notes ahead.
        model.select(urls[0].standardizedFileURL.path)
        XCTAssertFalse(model.canGoForward)
    }

    func testBackStepsOverAFileThatIsGone() throws {
        let dir = try folder()
        let model = model()
        let urls = try notes(["a", "b", "c"], in: dir)
        model.open(urls)
        let b = try XCTUnwrap(model.docs.first { $0.title == "b" })
        XCTAssertTrue(model.close(b))
        try FileManager.default.removeItem(at: urls[1])
        model.goBack()
        XCTAssertEqual(model.selected?.title, "a", "b is gone, so Back skips it")
        XCTAssertFalse(model.canGoBack)
    }

    func testTheHistoryKeepsAHundredNotesAndIgnoresARepeat() {
        var history = MarkdownNavigationHistory()
        history.visit("a")
        history.visit("a")
        XCTAssertEqual(history.entries, ["a"])
        for index in 0..<150 { history.visit("n\(index)") }
        XCTAssertEqual(history.entries.count, MarkdownNavigationHistory.limit)
        XCTAssertEqual(history.current, "n149")
        XCTAssertEqual(history.back { _ in true }, "n148")
        XCTAssertEqual(history.forward { _ in true }, "n149")
        XCTAssertNil(history.forward { _ in true })
        XCTAssertEqual(history.current, "n149", "no move when there is nowhere to go")
    }

    func testTheSourceEditorsKeysComeFromTheKeymap() throws {
        let keymap = Keymap(library: MarkdownKeymap.library, store: nil, layout: czech)
        func event(_ code: UInt16, _ character: String, _ flags: NSEvent.ModifierFlags) throws -> NSEvent {
            try XCTUnwrap(NSEvent.keyEvent(
                with: .keyDown, location: .zero, modifierFlags: flags, timestamp: 0, windowNumber: 0, context: nil,
                characters: character, charactersIgnoringModifiers: character, isARepeat: false, keyCode: code))
        }
        XCTAssertEqual(MarkdownKeymap.sourceCommand(for: try event(11, "b", .command), keymap: keymap), "markdown.edit.bold")
        XCTAssertEqual(MarkdownKeymap.sourceCommand(for: try event(7, "X", [.command, .shift]), keymap: keymap),
                       "markdown.edit.task")
        XCTAssertNil(MarkdownKeymap.sourceCommand(for: try event(7, "x", .command), keymap: keymap), "⌘X is Cut")
        keymap.setChords([.character("u", .command)], for: "markdown.edit.bold")
        XCTAssertEqual(MarkdownKeymap.sourceCommand(for: try event(32, "u", .command), keymap: keymap), "markdown.edit.bold")
        XCTAssertNil(MarkdownKeymap.sourceCommand(for: try event(11, "b", .command), keymap: keymap))
    }

    func testTheMenuShowsTheKeysInForceAndOffersBackForwardAndTheShortcutList() throws {
        let menu = MarkdownViewerMenu.build(appName: "Viewer")
        let go = try XCTUnwrap(menu.items.first { $0.title == "Go" }?.submenu)
        let back = try XCTUnwrap(go.items.first { $0.title == "Back" })
        XCTAssertEqual(back.keyEquivalentModifierMask, [.command])
        XCTAssertEqual(back.keyEquivalent, MarkdownKeymap.shared.chord(for: "markdown.history.back")?.menuKeyEquivalent)
        XCTAssertFalse(back.keyEquivalent.isEmpty, "the key right of P types a character on every layout")
        XCTAssertEqual(go.items.first { $0.title == "Next Tab" }?.keyEquivalentModifierMask, [.command, .shift])
        let help = try XCTUnwrap(menu.items.first { $0.title == "Help" }?.submenu)
        let shortcuts = try XCTUnwrap(help.items.first { $0.title == "Keyboard Shortcuts" })
        XCTAssertEqual(shortcuts.action, #selector(MarkdownDocumentWindowController.showKeyboardShortcuts(_:)))
        XCTAssertEqual(shortcuts.keyEquivalent, "k")
        XCTAssertEqual(shortcuts.keyEquivalentModifierMask, [.command, .shift])
    }
}
