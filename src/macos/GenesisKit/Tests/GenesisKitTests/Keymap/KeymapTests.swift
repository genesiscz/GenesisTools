import AppKit
@testable import GenesisKit
import SwiftUI
import XCTest

/// What the Czech layout types on the keys these tests press (measured with UCKeyTranslate on 2026-10-15).
private let czech = TableKeyLayout(
    [18: "+", 19: "ě", 24: "", 27: "=", 29: "é", 30: ")", 33: "ú", 44: "-", 6: "y", 16: "z", 13: "w"],
    shifted: [18: "1", 19: "2", 30: "(", 33: "/"])

private func press(_ code: UInt16, _ character: String, _ modifiers: KeyModifiers) -> KeyStroke {
    KeyStroke(keyCode: code, character: character, modifiers: modifiers)
}

@MainActor
final class KeyChordTests: XCTestCase {
    func testAPositionMatchesWhateverTheLayoutTypesThere() {
        let back = KeyChord.code(33, .command)
        XCTAssertTrue(back.matches(press(33, "ú", .command)), "Czech")
        XCTAssertTrue(back.matches(press(33, "[", .command)), "US")
        XCTAssertFalse(back.matches(press(33, "/", [.command, .shift])), "⇧⌘ on the key is another chord")
        XCTAssertFalse(back.matches(press(30, ")", .command)))
    }

    func testALetterFollowsTheTypedLetterNotItsPosition() {
        let undo = KeyChord.character("z", .command)
        XCTAssertTrue(undo.matches(press(16, "z", .command)), "Z on a QWERTZ keyboard sits at the US Y")
        XCTAssertFalse(undo.matches(press(6, "y", .command)), "the US Z position types y on QWERTZ")
        XCTAssertFalse(undo.matches(press(16, "z", [.command, .shift])), "Shift counts for a letter")
        XCTAssertTrue(KeyChord.character("z", [.command, .shift]).matches(press(16, "Z", [.command, .shift])))
    }

    func testShiftDoesNotCountForASymbolTheLayoutPutsOnShift() {
        let bigger = KeyChord.character("+", .command)
        XCTAssertTrue(bigger.matches(press(18, "+", .command)), "Czech: + is its own key")
        XCTAssertTrue(bigger.matches(press(24, "+", [.command, .shift])), "US: + is Shift and =")
        XCTAssertFalse(bigger.matches(press(18, "+", [.command, .option])))
    }

    func testTheUSPositionIsAFallbackForKeysThatTypeNoASCII() {
        let two = KeyChord.character("2", .command)
        XCTAssertFalse(two.matches(press(19, "ě", .command)))
        XCTAssertTrue(two.matchesByUSPosition(press(19, "ě", .command)), "⌘ with the Czech ě key is ⌘2")
        XCTAssertTrue(KeyChord.character("=", .command).matchesByUSPosition(press(24, "", .command)), "a dead key")
        XCTAssertFalse(KeyChord.character("-", .command).matchesByUSPosition(press(27, "=", .command)),
                       "the Czech = key types ASCII, so it keeps its own meaning")
        XCTAssertFalse(KeyChord.character("z", .command).matchesByUSPosition(press(6, "y", .command)),
                       "letters never fall back")
    }

    func testLabelsShowWhatTheUsersKeyboardPrints() {
        XCTAssertEqual(KeyChord.code(33, .command).label(layout: czech), "⌘Ú")
        XCTAssertEqual(KeyChord.code(30, [.command, .shift]).label(layout: czech), "⇧⌘)")
        XCTAssertEqual(KeyChord.code(33, [.command, .shift]).label(layout: TableKeyLayout.us), "⇧⌘[")
        XCTAssertEqual(KeyChord.code(36, .command).label(layout: czech), "⌘↩")
        XCTAssertEqual(KeyChord.code(123, [.option, .command]).label(layout: czech), "⌥⌘←")
        XCTAssertEqual(KeyChord.code(97).label(layout: czech), "F6")
        XCTAssertEqual(KeyChord.character("w", [.control, .option, .shift, .command]).label(layout: czech), "⌃⌥⇧⌘W")
        XCTAssertEqual(KeyChord.code(24, .command).label(layout: czech), "⌘=", "a dead key falls back to the US cap")
    }

    func testTheSystemLayoutReadsTheCzechKeysRightOfP() throws {
        let layout = SystemKeyLayout(sourceID: "com.apple.keylayout.Czech")
        try XCTSkipIf(layout.character(for: 0) == nil, "the Czech layout is not installed")
        XCTAssertEqual(layout.character(for: 33), "ú")
        XCTAssertEqual(layout.character(for: 30), ")")
        XCTAssertEqual(layout.character(for: 18), "+")
        XCTAssertEqual(layout.shiftedCharacter(for: 33), "/")
        XCTAssertEqual(layout.shiftedCharacter(for: 18), "1")
    }

    func testTheSavedFormRoundTrips() throws {
        let chords: [KeyChord] = [
            .code(33, [.command, .shift]), .character("+", .command), .character("w", [.control, .option]),
            .code(97), .character("=", .command),
        ]
        for chord in chords {
            XCTAssertEqual(KeyChord(chord.description), chord, chord.description)
        }
        XCTAssertEqual(KeyChord.code(33, [.command, .shift]).description, "shift+cmd+code:33")
        XCTAssertEqual(KeyChord.character("+", .command).description, "cmd+char:+")
        XCTAssertNil(KeyChord("cmd+hyper+code:3"))
        XCTAssertNil(KeyChord("cmd+code:x"))
        let json = try JSONEncoder().encode(chords)
        XCTAssertEqual(try JSONDecoder().decode([KeyChord].self, from: json), chords)
    }

    func testARecorderKeepsLettersByCharacterAndOtherKeysByPosition() {
        XCTAssertEqual(KeyChord.recorded(press(6, "y", .command)), .character("y", .command))
        XCTAssertEqual(KeyChord.recorded(press(33, "ú", .command)), .code(33, .command), "ú is a letter, not ASCII")
        XCTAssertEqual(KeyChord.recorded(press(18, "+", .command)), .code(18, .command))
    }

    func testTheRecorderRefusesKeysThatOnlyTypeOrBelongToMacOS() {
        XCTAssertNotNil(KeyChordRecorderModel.problem(.character("k")))
        XCTAssertNotNil(KeyChordRecorderModel.problem(.character("k", .shift)))
        XCTAssertNil(KeyChordRecorderModel.problem(.code(97)), "a function key may stand alone")
        XCTAssertNotNil(KeyChordRecorderModel.problem(.code(49, .command)), "⌘Space is Spotlight")
        XCTAssertNil(KeyChordRecorderModel.problem(.code(33, .command)))
    }

    func testTheRecorderCancelsOnEscapeAndRecordsOnce() {
        let model = KeyChordRecorderModel()
        var recorded: [KeyChord] = []
        model.start { recorded.append($0) }
        XCTAssertEqual(KeymapDispatcher.shared.suspendedForTests, true)
        model.receive(press(40, "k", [])) { recorded.append($0) }
        XCTAssertTrue(model.recording, "a refused key keeps it listening")
        XCTAssertNotNil(model.problem)
        model.receive(press(33, "ú", .command)) { recorded.append($0) }
        XCTAssertEqual(recorded, [.code(33, .command)])
        XCTAssertFalse(model.recording)
        XCTAssertEqual(KeymapDispatcher.shared.suspendedForTests, false)
        model.start { recorded.append($0) }
        model.receive(press(53, "\u{1b}", [])) { recorded.append($0) }
        XCTAssertFalse(model.recording)
        XCTAssertEqual(recorded.count, 1)
    }

    private func window() -> NSWindow {
        NSWindow(contentRect: NSRect(x: 0, y: 0, width: 40, height: 40), styleMask: [.titled], backing: .buffered,
                 defer: true)
    }

    func testAPressInAnotherWindowStopsRecordingAndIsNotTaken() {
        let mine = window()
        let other = window()
        let model = KeyChordRecorderModel()
        var recorded: [KeyChord] = []
        model.start(onRecord: { recorded.append($0) }, window: mine)
        XCTAssertFalse(model.take(press(1, "s", .command), in: other) { recorded.append($0) })
        XCTAssertFalse(model.recording)
        XCTAssertTrue(recorded.isEmpty)
        XCTAssertFalse(KeymapDispatcher.shared.suspendedForTests)
    }

    func testResigningTheKeyWindowStopsRecording() {
        let mine = window()
        let model = KeyChordRecorderModel()
        model.start(onRecord: { _ in }, window: mine)
        NotificationCenter.default.post(name: NSWindow.didResignKeyNotification, object: mine)
        XCTAssertFalse(model.recording)
        XCTAssertFalse(KeymapDispatcher.shared.suspendedForTests)
    }

    func testStartingASecondRecorderStopsTheFirst() {
        let mine = window()
        let first = KeyChordRecorderModel()
        let second = KeyChordRecorderModel()
        first.start(onRecord: { _ in }, window: mine)
        second.start(onRecord: { _ in }, window: mine)
        XCTAssertFalse(first.recording)
        XCTAssertTrue(second.recording)
        second.stop()
        XCTAssertFalse(KeymapDispatcher.shared.suspendedForTests)
    }

    func testReleasingARecorderResumesTheDispatcher() {
        var model: KeyChordRecorderModel? = KeyChordRecorderModel()
        let mine = window()
        model?.start(onRecord: { _ in }, window: mine)
        XCTAssertTrue(KeymapDispatcher.shared.suspendedForTests)
        model = nil
        XCTAssertFalse(KeymapDispatcher.shared.suspendedForTests)
    }
}

@MainActor
final class KeymapTests: XCTestCase {
    private let library = KeymapLibrary(
        id: "test", title: "Test",
        commands: [
            KeymapCommand("tab.next", "Next Tab", group: "Tabs", keys: [.code(30, [.command, .shift])]),
            KeymapCommand("tab.previous", "Previous Tab", group: "Tabs", keys: [.code(33, [.command, .shift])]),
            KeymapCommand("history.back", "Back", group: "History", keys: [.code(33, .command)]),
            KeymapCommand("zoom.in", "Bigger", group: "View", keys: [.character("+", .command), .character("=", .command)]),
            KeymapCommand("tab.two", "Second Tab", group: "Tabs", keys: [.character("2", .command)]),
            KeymapCommand("find.previous", "Previous Match", group: "Find", keys: [.character("g", [.command, .shift])],
                          scope: "find"),
            KeymapCommand("goto", "Go to Location", group: "Files", keys: [.character("g", [.command, .shift])]),
            KeymapCommand("sheet.go", "Go", group: "Files", keys: [.code(36)], scope: "sheet", configurable: false),
            KeymapCommand("quit", "Quit", group: "App", keys: [.character("q", .command)], scope: .app,
                          configurable: false),
            KeymapCommand("slash", "Slash", group: "Test", keys: [.character("/", .command)]),
        ])

    private func temporaryStore() -> KeymapStore {
        let folder = FileManager.default.temporaryDirectory
            .appendingPathComponent("keymap-tests-\(UUID().uuidString)", isDirectory: true)
        addTeardownBlock { try? FileManager.default.removeItem(at: folder) }
        return KeymapStore(fileURL: folder.appendingPathComponent("test.json"))
    }

    func testTheUsersKeysReplaceTheDefaultsAndSurviveARestart() {
        let store = temporaryStore()
        let keymap = Keymap(library: library, store: store, layout: czech)
        XCTAssertEqual(keymap.label(for: "history.back"), "⌘Ú")
        keymap.setChords([.code(123, .command)], for: "history.back")
        XCTAssertEqual(keymap.label(for: "history.back"), "⌘←")
        XCTAssertTrue(keymap.isCustomized("history.back"))

        let restarted = Keymap(library: library, store: store, layout: czech)
        XCTAssertEqual(restarted.chords(for: "history.back"), [.code(123, .command)])

        restarted.setChords([], for: "zoom.in")
        XCTAssertNil(restarted.label(for: "zoom.in"), "an empty list turns the key off")
        restarted.setChords([.code(33, .command)], for: "history.back")
        XCTAssertFalse(restarted.isCustomized("history.back"), "the defaults again are no override")
        restarted.reset("zoom.in")
        XCTAssertEqual(Keymap(library: library, store: store, layout: czech).configuration, KeymapConfiguration())
    }

    func testAKeyChangedByAnotherProcessArrivesWhenTheAppBecomesActive() {
        let store = temporaryStore()
        let here = Keymap(library: library, store: store, layout: czech)
        let elsewhere = Keymap(library: library, store: store, layout: czech)
        let item = NSMenuItem(title: "Back", action: nil, keyEquivalent: "")
        here.bind(item, to: "history.back")
        elsewhere.setChords([.character("b", [.control, .command])], for: "history.back")
        XCTAssertEqual(here.label(for: "history.back"), "⌘Ú", "nothing is read until the app comes to the front")
        NotificationCenter.default.post(name: NSApplication.didBecomeActiveNotification, object: NSApp)
        XCTAssertEqual(here.label(for: "history.back"), "⌃⌘B")
        XCTAssertEqual(item.keyEquivalent, "b", "a bound menu item follows")
        XCTAssertEqual(item.keyEquivalentModifierMask, [.control, .command])
    }

    func testAFixedCommandCannotBeChanged() {
        let keymap = Keymap(library: library, store: nil, layout: czech)
        keymap.setChords([.character("x", .command)], for: "quit")
        XCTAssertEqual(keymap.chords(for: "quit"), [.character("q", .command)])
    }

    func testAnUnreadableFileFallsBackToTheDefaults() throws {
        let store = temporaryStore()
        try FileManager.default.createDirectory(at: store.fileURL.deletingLastPathComponent(), withIntermediateDirectories: true)
        try Data("{ not json".utf8).write(to: store.fileURL)
        let keymap = Keymap(library: library, store: store, layout: czech)
        XCTAssertEqual(keymap.configuration, KeymapConfiguration())
        XCTAssertEqual(keymap.label(for: "tab.next"), "⇧⌘)")
    }

    /// One chord this version cannot read, or a file with no version, does not drop the other keys. The unknown
    /// text is written back on the next change.
    func testOneUnreadableChordDoesNotDropTheRestAndIsWrittenBack() throws {
        let store = temporaryStore()
        try FileManager.default.createDirectory(at: store.fileURL.deletingLastPathComponent(), withIntermediateDirectories: true)
        let raw = #"{"overrides":{"history.back":["cmd+code:123","fn+char:x"],"zoom.in":[]}}"#
        try Data(raw.utf8).write(to: store.fileURL)
        let keymap = Keymap(library: library, store: store, layout: czech)
        XCTAssertEqual(keymap.chords(for: "history.back"), [.code(123, .command)])
        XCTAssertEqual(keymap.chords(for: "zoom.in"), [], "an empty list still turns the key off")
        XCTAssertEqual(keymap.chords(for: "tab.next"), [.code(30, [.command, .shift])])
        keymap.setChords([.character("n", .command)], for: "tab.next")
        let again = Keymap(library: library, store: store, layout: czech)
        XCTAssertEqual(again.chords(for: "history.back"), [.code(123, .command)])
        XCTAssertEqual(again.chords(for: "zoom.in"), [])
        XCTAssertEqual(again.chords(for: "tab.next"), [.character("n", .command)])
        let text = try String(contentsOf: store.fileURL, encoding: .utf8)
        XCTAssertTrue(text.contains("fn+char:x"), text)
    }

    func testExactMatchesWinOverTheUSPositionFallback() {
        let keymap = Keymap(library: library, store: nil, layout: czech)
        XCTAssertEqual(keymap.commands(for: press(18, "+", .command)).map(\.id), ["zoom.in"],
                       "Czech + key: zoom, not the US 1")
        XCTAssertEqual(keymap.commands(for: press(19, "ě", .command)).map(\.id), ["tab.two"], "Czech ě key: ⌘2")
        XCTAssertEqual(keymap.commands(for: press(33, "ú", .command)).map(\.id), ["history.back"])
        XCTAssertEqual(keymap.commands(for: press(33, "/", [.command, .shift])).map(\.id), ["tab.previous"],
                       "the position beats ⌘/ typed with Shift")
    }

    func testAKeySharedWithinOneScopeIsAConflict() {
        let keymap = Keymap(library: library, store: nil, layout: czech)
        XCTAssertEqual(keymap.conflicts().map { Set($0.commands) }, [["tab.previous", "slash"]],
                       "⌘/ is ⇧⌘ on the key right of P on a Czech keyboard")
        XCTAssertEqual(keymap.commands(using: .character("g", [.command, .shift]), besides: "goto"), [],
                       "the find bar's ⇧⌘G only shadows the window's while the bar is open")
        XCTAssertEqual(keymap.commands(using: .code(36), besides: "sheet.go"), [], "a sheet's Return is its own")
        XCTAssertEqual(keymap.commands(using: .character("ú", .command), besides: "tab.next").map(\.id), ["history.back"],
                       "a position and the character the layout types there are one key")
        XCTAssertEqual(keymap.commands(using: .character("q", .command), besides: "goto").map(\.id), ["quit"],
                       "the app's menu keys meet every window key")
    }

    func testHintsAndMenusShowTheKeyInForce() {
        let keymap = Keymap(library: library, store: nil, layout: czech)
        XCTAssertEqual(keymap.hint("Back", "history.back"), "Back (⌘Ú)")
        let item = NSMenuItem(title: "Next Tab", action: nil, keyEquivalent: "")
        keymap.bind(item, to: "tab.next")
        XCTAssertEqual(item.keyEquivalentModifierMask, [.command, .shift])
        XCTAssertFalse(item.keyEquivalent.isEmpty)
        keymap.setChords([.character("n", [.command, .option])], for: "tab.next")
        XCTAssertEqual(item.keyEquivalent, "n")
        XCTAssertEqual(item.keyEquivalentModifierMask, [.command, .option])
        keymap.setChords([], for: "tab.next")
        XCTAssertEqual(item.keyEquivalent, "")
        XCTAssertEqual(keymap.hint("Next Tab", "tab.next"), "Next Tab")
    }

    func testSwiftUIMenusGetTheKeyAsAKeyboardShortcut() {
        XCTAssertEqual(KeyChord.character("w", [.shift, .command]).keyboardShortcut,
                       KeyboardShortcut("w", modifiers: [.shift, .command]))
        XCTAssertEqual(KeyChord.code(126, .option).keyboardShortcut, KeyboardShortcut(.upArrow, modifiers: .option))
        XCTAssertEqual(KeyChord.code(36, .command).keyboardShortcut, KeyboardShortcut(.return, modifiers: .command))
        XCTAssertNil(KeyChord.code(76).keyboardShortcut, "keypad Enter has no SwiftUI name")
    }

    func testTheScopeRulesOfMeets() {
        XCTAssertTrue(KeymapScope.app.meets(.window))
        XCTAssertFalse(KeymapScope.app.meets(.global))
        XCTAssertFalse(KeymapScope("sheet").meets(.window))
        XCTAssertFalse(KeymapScope("find").meets(.window))
        XCTAssertTrue(KeymapScope.window.meets(.window))
    }

    func testKeyCapsSplitTheModifiersFromTheKeyName() {
        XCTAssertEqual(KeyCaps.parts("⇧⌘Ú"), ["⇧", "⌘", "Ú"])
        XCTAssertEqual(KeyCaps.parts("F6"), ["F6"])
        XCTAssertEqual(KeyCaps.parts("⌥⌘Space"), ["⌥", "⌘", "Space"])
        XCTAssertEqual(KeyCaps.parts("⌘"), ["⌘"], "a lone symbol is the key")
    }
}

@MainActor
final class KeymapDispatcherTests: XCTestCase {
    private let library = KeymapLibrary(
        id: "dispatch", title: "Dispatch",
        commands: [
            KeymapCommand("back", "Back", group: "History", keys: [.code(33, .command)]),
            KeymapCommand("help", "Shortcuts", group: "Help", keys: [.character("?")]),
            KeymapCommand("close.window", "Close Window", group: "Window", keys: [.character("w", [.command, .shift])],
                          scope: .app),
        ])

    private func window() -> NSWindow {
        NSWindow(contentRect: NSRect(x: 0, y: 0, width: 100, height: 100), styleMask: [.titled], backing: .buffered,
                 defer: true)
    }

    func testTheNewestEnabledHandlerOfTheKeyWindowRuns() {
        let dispatcher = KeymapDispatcher()
        let keymap = Keymap(library: library, store: nil, layout: czech)
        let main = window()
        let other = window()
        var ran: [String] = []
        let old = dispatcher.register("back", in: keymap, window: main) { ran.append("old") }
        var newEnabled = true
        let new = dispatcher.register("back", in: keymap, window: main, isEnabled: { newEnabled }) { ran.append("new") }
        let elsewhere = dispatcher.register("back", in: keymap, window: other) { ran.append("other") }

        XCTAssertTrue(dispatcher.handle(press(33, "ú", .command), in: main, typing: false))
        XCTAssertEqual(ran, ["new"])
        newEnabled = false
        XCTAssertTrue(dispatcher.handle(press(33, "ú", .command), in: main, typing: false))
        XCTAssertEqual(ran, ["new", "old"], "a disabled handler lets the key through to the next")
        new.cancel()
        old.cancel()
        XCTAssertFalse(dispatcher.handle(press(33, "ú", .command), in: main, typing: false), "no handler: the key goes on")
        withExtendedLifetime(elsewhere) {}
    }

    func testAReleasedRegistrationEnds() {
        let dispatcher = KeymapDispatcher()
        let keymap = Keymap(library: library, store: nil, layout: czech)
        let main = window()
        var ran = 0
        var registration: KeymapRegistration? = dispatcher.register("back", in: keymap, window: main) { ran += 1 }
        XCTAssertNotNil(registration)
        registration = nil
        XCTAssertFalse(dispatcher.handle(press(33, "ú", .command), in: main, typing: false))
        XCTAssertEqual(ran, 0)
    }

    func testAKeyThatTypesNeverFiresWhileTextHasTheFocus() {
        let dispatcher = KeymapDispatcher()
        let keymap = Keymap(library: library, store: nil, layout: czech)
        let main = window()
        var ran = 0
        let help = dispatcher.register("help", in: keymap, window: main) { ran += 1 }
        let back = dispatcher.register("back", in: keymap, window: main) { ran += 10 }
        XCTAssertFalse(dispatcher.handle(press(43, "?", .shift), in: main, typing: true))
        XCTAssertTrue(dispatcher.handle(press(43, "?", .shift), in: main, typing: false))
        XCTAssertTrue(dispatcher.handle(press(33, "ú", .command), in: main, typing: true), "⌘ keys still work in a field")
        XCTAssertEqual(ran, 11)
        withExtendedLifetime((help, back)) {}
    }

    func testAnAppWideHandlerRunsInEveryWindowAndNothingRunsWhileSuspended() {
        let dispatcher = KeymapDispatcher()
        let keymap = Keymap(library: library, store: nil, layout: czech)
        var ran = 0
        let close = dispatcher.register("close.window", in: keymap, window: nil) { ran += 1 }
        XCTAssertTrue(dispatcher.handle(press(13, "W", [.command, .shift]), in: window(), typing: false))
        dispatcher.suspend()
        XCTAssertFalse(dispatcher.handle(press(13, "W", [.command, .shift]), in: window(), typing: false))
        dispatcher.resume()
        XCTAssertTrue(dispatcher.handle(press(13, "W", [.command, .shift]), in: window(), typing: false))
        XCTAssertEqual(ran, 2)
        withExtendedLifetime(close) {}
    }

    func testThisWindowsHandlerBeatsAnAppWideOne() {
        let dispatcher = KeymapDispatcher()
        let keymap = Keymap(library: library, store: nil, layout: czech)
        let main = window()
        var ran: [String] = []
        let own = dispatcher.register("close.window", in: keymap, window: main) { ran.append("own") }
        let appWide = dispatcher.register("close.window", in: keymap, window: nil) { ran.append("app") }
        XCTAssertTrue(dispatcher.handle(press(13, "w", [.command, .shift]), in: main, typing: false))
        XCTAssertTrue(dispatcher.handle(press(13, "w", [.command, .shift]), in: window(), typing: false))
        XCTAssertEqual(ran, ["own", "app"], "the newer app-wide handler does not take the key from the window's own")
        withExtendedLifetime((own, appWide)) {}
    }

    /// A real key goes through the monitor. Calling `handle` would hide a monitor that always calls `shared`.
    func testADispatchersMonitorRunsItsOwnHandlersAndEndsWhenTheDispatcherDoes() {
        let keymap = Keymap(library: library, store: nil, layout: czech)
        let main = window()
        main.alphaValue = 0
        main.orderBack(nil)
        defer { main.orderOut(nil) }
        XCTAssertGreaterThan(main.windowNumber, 0)
        let event = NSEvent.keyEvent(
            with: .keyDown, location: .zero, modifierFlags: .command, timestamp: 0, windowNumber: main.windowNumber,
            context: nil, characters: "ú", charactersIgnoringModifiers: "ú", isARepeat: false, keyCode: 33)!

        let others = monitorCalls { NSApp.sendEvent(event) }
        var ran = 0
        var dispatcher: KeymapDispatcher? = KeymapDispatcher()
        let registration = dispatcher!.register("back", in: keymap, window: main) { ran += 1 }
        NSApp.sendEvent(event)
        XCTAssertEqual(ran, 1, "the monitor runs this dispatcher's registration")
        registration.cancel()

        let installed = monitorCalls { NSApp.sendEvent(event) }
        XCTAssertEqual(installed, others + 1, "the registration's monitor is still installed after cancel")
        dispatcher = nil
        let released = monitorCalls { NSApp.sendEvent(event) }
        XCTAssertEqual(released, others, "releasing the dispatcher removes its monitor")
    }

    private func monitorCalls(_ body: () -> Void) -> Int {
        let before = KeymapDispatcher.monitorCallsForTests
        body()
        return KeymapDispatcher.monitorCallsForTests - before
    }

    func testTextInputIsATextViewThatEditsOrAWebView() {
        let editable = NSTextView()
        XCTAssertTrue(KeymapDispatcher.isTextInput(editable))
        editable.isEditable = false
        XCTAssertFalse(KeymapDispatcher.isTextInput(editable))
        XCTAssertFalse(KeymapDispatcher.isTextInput(NSView()))
        XCTAssertFalse(KeymapDispatcher.isTextInput(nil))
    }
}
