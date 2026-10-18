import AppKit
@testable import GenesisToolsHost
@testable import GenesisToolsHub
import XCTest

/// The hub's keys through `HubKeymap` (Martin, 2026-10-15).
@MainActor
final class HubKeymapTests: XCTestCase {
    /// What a Czech layout types on the keys these tests press (UCKeyTranslate, 2026-10-15).
    private let czech = TableKeyLayout(
        [30: ")", 33: "ú", 18: "+", 19: "ě", 27: "=", 44: "-", 29: "é"],
        shifted: [30: "(", 33: "/", 18: "1", 29: "0"])

    override class func setUp() {
        super.setUp()
        HubDefaults.isolate()
    }

    private func keymap(_ layout: KeyLayout) -> Keymap {
        Keymap(library: HubKeymap.library, store: nil, layout: layout)
    }

    private func model() -> HubModel {
        let model = HubModel(wantedSession: nil, tab: .transcript)
        model.readSessionCache = { _ in nil }
        model.writeSessionCache = { _, _ in }
        model.readDecisions = { id in SessionDecisionsEnvelope(sessionId: id, decisions: []) }
        return model
    }

    private func items(in menu: NSMenu) -> [NSMenuItem] {
        menu.items.flatMap { item in
            [item] + (item.submenu.map { items(in: $0) } ?? [])
        }
    }

    func testTheHubsKeysHaveNoConflictOnACzechOrAUSKeyboard() {
        XCTAssertEqual(Keymap(library: HubKeymap.library, store: nil, layout: czech).conflicts(), [])
        XCTAssertEqual(Keymap(library: HubKeymap.library, store: nil, layout: TableKeyLayout.us).conflicts(), [])
    }

    func testEveryMenuItemsKeyEqualsTheLibrary() throws {
        _ = NSApplication.shared
        let keys = keymap(TableKeyLayout.us)
        AppMainMenu.install(hub: model(), keymap: keys)
        let menu = try XCTUnwrap(NSApp.mainMenu)
        let rows = items(in: menu)

        for item in rows where !item.keyEquivalent.isEmpty {
            let id = try XCTUnwrap(item.identifier?.rawValue, "\(item.title) has a key and no command")
            let chord = try XCTUnwrap(keys.chord(for: id), id)
            XCTAssertEqual(item.keyEquivalent, chord.menuKeyEquivalent, id)
            XCTAssertEqual(item.keyEquivalentModifierMask, chord.modifiers.eventFlags, id)
        }

        let shown = Set(rows.compactMap { $0.identifier?.rawValue })
        for command in HubKeymap.library.commands where !command.defaults.isEmpty && command.scope != HubKeymap.paletteScope
            && command.scope != HubKeymap.findScope && command.id != HubKeymap.promptSend {
            XCTAssertTrue(shown.contains(command.id), "\(command.id) is not in the menu")
            let item = try XCTUnwrap(rows.first { $0.identifier?.rawValue == command.id })
            let chord = try XCTUnwrap(keys.chord(for: command.id))
            XCTAssertEqual(item.keyEquivalent, chord.menuKeyEquivalent, command.id)
            XCTAssertEqual(item.keyEquivalentModifierMask, chord.modifiers.eventFlags, command.id)
        }

        let help = try XCTUnwrap(menu.items.first { $0.title == "Help" }?.submenu)
        XCTAssertNotNil(help.items.first { $0.identifier?.rawValue == "hub.help.shortcuts" })
        let back = try XCTUnwrap(rows.first { $0.identifier?.rawValue == "hub.go.back" })
        XCTAssertEqual(back.keyEquivalentModifierMask, .command)
        XCTAssertFalse(back.keyEquivalent.isEmpty)
        XCTAssertTrue(AppMainMenu.installedWithHub, "the hub menu is what gives a hosted session the host flag")
    }

    /// ⌘ on the key right of P is Back, whatever that key types. US types "[", Czech types "ú".
    func testCommandOnKeyCode33RunsBackWhateverCharacterItTypes() {
        let model = model()
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 300, height: 200), styleMask: [.titled],
                              backing: .buffered, defer: true)
        window.alphaValue = 0
        window.orderBack(nil)
        let keys = keymap(czech)
        let held = HubKeymap.registerWindowCommands(model: model, window: window, keymap: keys)
        defer { held.forEach { $0.cancel() } }

        func seed() {
            var history = HubNavHistory()
            history.visit(HubNavEntry(mode: .sessions, selection: "fixture-a"))
            history.visit(HubNavEntry(mode: .sessions, selection: "fixture-b"))
            model.replaceHistory(history)
        }
        func press(_ code: UInt16, _ character: String, _ flags: NSEvent.ModifierFlags = .command) -> Bool {
            let event = NSEvent.keyEvent(
                with: .keyDown, location: .zero, modifierFlags: flags, timestamp: 0, windowNumber: window.windowNumber,
                context: nil, characters: character, charactersIgnoringModifiers: character, isARepeat: false, keyCode: code)
            return KeymapDispatcher.shared.handle(event!)
        }

        for character in ["ú", "[", "x", ")"] {
            seed()
            XCTAssertTrue(press(33, character), "⌘ on key 33 types \(character)")
            XCTAssertEqual(model.history.current?.selection, "fixture-a", character)
        }
        seed()
        XCTAssertFalse(press(33, "ú", [.command, .option]), "another modifier set is not Back")
        XCTAssertEqual(model.history.current?.selection, "fixture-b")
        XCTAssertFalse(press(0, "a"), "⌘A is Select All, not a hub-window command")
    }

    /// The review window has no hub. File > Close Window is still ⌘W, and the handler is that window's.
    func testTheReviewWindowBindsCloseWindowToTheKeymap() throws {
        _ = NSApplication.shared
        let keys = keymap(TableKeyLayout.us)
        AppMainMenu.install(keymap: keys)
        XCTAssertFalse(AppMainMenu.installedWithHub, "the review menu has no hub, so a session there keeps its own Command keys")
        let menu = try XCTUnwrap(NSApp.mainMenu)
        let rows = items(in: menu)
        let close = try XCTUnwrap(rows.first { $0.identifier?.rawValue == "hub.window.close" })
        let chord = try XCTUnwrap(keys.chord(for: "hub.window.close"))
        XCTAssertEqual(close.title, "Close Window")
        XCTAssertEqual(close.keyEquivalent, chord.menuKeyEquivalent)
        XCTAssertEqual(close.keyEquivalentModifierMask, chord.modifiers.eventFlags)
        let help = try XCTUnwrap(menu.items.first { $0.title == "Help" }?.submenu)
        XCTAssertEqual(help.items.first { $0.title == "Keyboard Shortcuts" }?.action, #selector(AppMenuTarget.showKeyboardShortcuts(_:)))

        let review = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 300, height: 200), styleMask: [.titled, .closable],
                              backing: .buffered, defer: true)
        review.alphaValue = 0
        review.orderBack(nil)
        let probe = CloseProbe()
        review.delegate = probe
        let held = HubKeymap.registerCloseWindow(review, keymap: keys)
        defer { held.cancel() }
        XCTAssertTrue(press(review, 13, "w"))
        XCTAssertTrue(probe.closed, "⌘W closes the review window")

        probe.closed = false
        let other = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 200, height: 100), styleMask: [.titled, .closable],
                             backing: .buffered, defer: true)
        other.alphaValue = 0
        other.orderBack(nil)
        XCTAssertFalse(press(other, 13, "w"), "⌘W in another window is not the review window's handler")
        XCTAssertFalse(probe.closed)
    }

    /// A command with no library key is still registered, so a key the user adds runs it.
    func testACommandWithNoDefaultKeyRunsOnceTheUserBindsOne() {
        let model = model()
        let window = quietWindow()
        let keys = keymap(TableKeyLayout.us)
        keys.setChords([.character("s", [.option, .command])], for: "hub.go.session")
        let dispatcher = KeymapDispatcher()
        let held = HubKeymap.registerWindowCommands(model: model, window: window, keymap: keys, dispatcher: dispatcher)
        defer { held.forEach { $0.cancel() } }
        XCTAssertTrue(press(dispatcher, window, 1, "s", [.option, .command]))
        XCTAssertEqual(model.paletteRequest, "session ")
    }

    /// The session view registers after the hub. Command R then reloads the transcript, and the list again once
    /// that registration ends.
    func testAnOpenSessionsReloadBeatsTheHubsReload() {
        let window = quietWindow()
        let hub = keymap(TableKeyLayout.us)
        let sessions = Keymap(library: SessionsKeymap.library, store: nil, layout: TableKeyLayout.us)
        let dispatcher = KeymapDispatcher()
        var ran: [String] = []
        let list = dispatcher.register("hub.view.reload", in: hub, window: window) { ran.append("list") }
        let transcript = dispatcher.register("sessions.reload", in: sessions, window: window) { ran.append("transcript") }
        defer { list.cancel() }
        XCTAssertTrue(press(dispatcher, window, 15, "r", .command))
        XCTAssertEqual(ran, ["transcript"])
        transcript.cancel()
        ran = []
        XCTAssertTrue(press(dispatcher, window, 15, "r", .command))
        XCTAssertEqual(ran, ["list"])
    }

    /// Back rebound onto the session's Option-Command key is a conflict the shortcut list can see.
    func testRebindingHubBackOntoTheSessionAltIsAConflict() {
        let hub = keymap(czech)
        let chord = KeyChord.code(33, [.option, .command])
        hub.setChords([chord], for: "hub.go.back")
        let sessions = Keymap(library: SessionsKeymap.library, store: nil, layout: czech)
        let shown = SessionsKeymap.shownCommandIDs(hostOwns: true)
        XCTAssertEqual(
            sessions.commands(meeting: .window, using: chord, ids: shown).map(\.id),
            [SessionsKeymap.previousPromptAlt])
        let reload = KeyChord.character("r", .command)
        XCTAssertEqual(hub.commands(meeting: .window, using: reload).map(\.id), ["hub.view.reload"])
        XCTAssertEqual(
            sessions.commands(meeting: .window, using: reload, ids: shown).map(\.id),
            [SessionsKeymap.reload])
    }

    /// The review list is Close Window, panel find and the session keys that window runs. The hub list adds the
    /// Option-Command prompts and keeps Reload.
    func testReviewAndHubShortcutPagesListTheKeysEachWindowRuns() {
        let review = HubKeymap.reviewCommandIDs
        XCTAssertTrue(review.contains("hub.window.close"))
        XCTAssertTrue(review.contains(HubKeymap.findOpen))
        XCTAssertTrue(review.contains(HubKeymap.findNext))
        XCTAssertTrue(review.contains(HubKeymap.findPrevious))
        XCTAssertTrue(review.contains(HubKeymap.findClose))
        XCTAssertFalse(review.contains("hub.go.back"))
        XCTAssertFalse(review.contains(HubKeymap.commandPalette))
        XCTAssertFalse(review.contains("hub.find.files"))

        let hubPages = HubKeymap.shortcutPages(review: false)
        XCTAssertNil(hubPages[0].commandIDs, "the hub lists its whole library")
        XCTAssertEqual(hubPages[1].commandIDs, SessionsKeymap.shownCommandIDs(hostOwns: true))
        XCTAssertTrue(hubPages[1].commandIDs?.contains(SessionsKeymap.reload) == true)
        XCTAssertTrue(hubPages[1].commandIDs?.contains(SessionsKeymap.previousPromptAlt) == true)
        XCTAssertFalse(hubPages[1].commandIDs?.contains(SessionsKeymap.previousPrompt) == true)

        let reviewPages = HubKeymap.shortcutPages(review: true)
        XCTAssertEqual(reviewPages[0].commandIDs, review)
        XCTAssertEqual(reviewPages[1].commandIDs, SessionsKeymap.shownCommandIDs(hostOwns: false))
        XCTAssertTrue(reviewPages[1].commandIDs?.contains(SessionsKeymap.previousPrompt) == true)
        XCTAssertFalse(reviewPages[1].commandIDs?.contains(SessionsKeymap.previousPromptAlt) == true)
        XCTAssertTrue(reviewPages[1].commandIDs?.contains(SessionsKeymap.reload) == true)
    }

    /// Glass steps an open find bar only when the pressed chord is also Previous Match.
    func testGlassStepsFindOnlyWhenThePressedKeyIsPreviousMatch() {
        let model = model()
        let window = quietWindow()
        let keys = keymap(TableKeyLayout.us)
        let dispatcher = KeymapDispatcher()
        var stepped = 0
        let previous = HubKeymap.redirectGlassToPreviousMatch
        HubKeymap.redirectGlassToPreviousMatch = { _ in
            stepped += 1
            return true
        }
        let glass = HubDefaults.preferences.glass
        defer {
            HubKeymap.redirectGlassToPreviousMatch = previous
            HubDefaults.preferences.glass = glass
        }
        let held = HubKeymap.registerWindowCommands(model: model, window: window, keymap: keys, dispatcher: dispatcher)
        defer { held.forEach { $0.cancel() } }

        XCTAssertTrue(press(dispatcher, window, 5, "g", [.shift, .command]))
        XCTAssertEqual(stepped, 1, "Shift-Command G is Previous Match, so Glass steps the open find bar")

        keys.setChords([.character("g", [.option, .command])], for: HubKeymap.glass)
        stepped = 0
        XCTAssertTrue(press(dispatcher, window, 5, "g", [.option, .command]))
        XCTAssertEqual(stepped, 0, "Option-Command G is only Glass, so it does not step the find bar")
    }

    private func quietWindow() -> NSWindow {
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 300, height: 200), styleMask: [.titled],
                              backing: .buffered, defer: true)
        window.alphaValue = 0
        window.orderBack(nil)
        return window
    }

    private func press(_ window: NSWindow, _ code: UInt16, _ character: String) -> Bool {
        press(.shared, window, code, character, .command)
    }

    /// The public event handler. `typing` follows the window's first responder, which these windows leave empty.
    private func press(
        _ dispatcher: KeymapDispatcher, _ window: NSWindow, _ code: UInt16, _ character: String,
        _ flags: NSEvent.ModifierFlags
    ) -> Bool {
        let event = NSEvent.keyEvent(
            with: .keyDown, location: .zero, modifierFlags: flags, timestamp: 0, windowNumber: window.windowNumber,
            context: nil, characters: character, charactersIgnoringModifiers: character, isARepeat: false, keyCode: code)
        return dispatcher.handle(event!)
    }
}

private final class CloseProbe: NSObject, NSWindowDelegate {
    var closed = false

    func windowShouldClose(_ sender: NSWindow) -> Bool {
        closed = true
        return false
    }
}
