import AppKit
@testable import GenesisTools
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

    private func press(_ window: NSWindow, _ code: UInt16, _ character: String) -> Bool {
        let event = NSEvent.keyEvent(
            with: .keyDown, location: .zero, modifierFlags: .command, timestamp: 0, windowNumber: window.windowNumber,
            context: nil, characters: character, charactersIgnoringModifiers: character, isARepeat: false, keyCode: code)
        return KeymapDispatcher.shared.handle(event!)
    }
}

private final class CloseProbe: NSObject, NSWindowDelegate {
    var closed = false

    func windowShouldClose(_ sender: NSWindow) -> Bool {
        closed = true
        return false
    }
}
