import AppKit
@testable import GenesisKitBase
@testable import GenesisKit
import XCTest

/// The agent widget's keys through `WidgetKeymap` (Martin, 2026-10-15).
@MainActor
final class WidgetKeymapTests: XCTestCase {
    /// What a Czech layout types on the number row (UCKeyTranslate, 2026-10-15).
    private let czech = TableKeyLayout(
        [30: ")", 33: "ú", 18: "+", 19: "ě", 27: "=", 44: "-", 29: "é"],
        shifted: [30: "(", 33: "/", 18: "1", 29: "0"])

    private func card() -> WidgetCard {
        WidgetCard(id: "decision:d_1_fixture", kind: "decision", sessionKey: "local:codex:fixture:", sourceId: "d_1_fixture",
                   at: 1, title: "Keep it?", body: "", status: "open", revision: 1, number: 1,
                   choices: [WidgetChoice(id: "keep", title: "Keep", recommended: true),
                             WidgetChoice(id: "drop", title: "Drop", recommended: false),
                             WidgetChoice(id: "ask", title: "Ask", recommended: false)],
                   attachments: [], refs: [], read: false)
    }

    private func keys() -> Keymap {
        Keymap(library: WidgetKeymap.library, store: nil, layout: czech)
    }

    private func press(_ keyCode: UInt16, _ characters: String, editingText: Bool = false, answering: WidgetCard? = nil) -> WidgetCoordinator.PanelKey {
        WidgetCoordinator.panelKey(keyCode: keyCode, characters: characters, context: .init(
            previewOpen: false, agents: true, editingText: editingText, answering: answering), keymap: keys())
    }

    func testTheWidgetsKeysHaveNoConflictOnACzechOrAUSKeyboard() {
        XCTAssertEqual(Keymap(library: WidgetKeymap.library, store: nil, layout: czech).conflicts(), [])
        XCTAssertEqual(Keymap(library: WidgetKeymap.library, store: nil, layout: TableKeyLayout.us).conflicts(), [])
    }

    /// The number row is a position. Czech types "+" and "ě" there, and those keys still answer 1 and 2.
    func testTheCzechNumberRowAnswersTheSameChoiceAsTheDigit() {
        let keys = Keymap(library: WidgetKeymap.library, store: nil, layout: czech)
        let one = keys.commands(for: KeyStroke(keyCode: 18, character: "+", modifiers: []), in: [.window])
        XCTAssertEqual(one.map(\.id), [WidgetKeymap.choiceID(1)])
        let two = keys.commands(for: KeyStroke(keyCode: 19, character: "ě", modifiers: []), in: [.window])
        XCTAssertEqual(two.map(\.id), [WidgetKeymap.choiceID(2)])

        let three = keys.commands(for: KeyStroke(keyCode: 0x14, character: "š", modifiers: []), in: [.window])
        XCTAssertEqual(three.map(\.id), [WidgetKeymap.choiceID(3)])
        XCTAssertEqual(keys.commands(for: KeyStroke(keyCode: 0, character: "0", modifiers: []), in: [.window]), [])

        let answering = card()
        XCTAssertEqual(press(18, "+", answering: answering), .choose("keep"))
        XCTAssertEqual(press(19, "ě", answering: answering), .choose("drop"))
        XCTAssertEqual(press(0x54, "2", answering: answering), .choose("drop"), "a key that types 2, such as the keypad")
        XCTAssertEqual(press(0, "a", answering: answering), .pass)
        XCTAssertEqual(press(0, "0", answering: answering), .pass, "0 is not a choice")
        XCTAssertEqual(press(0x14, "š", answering: answering), .choose("ask"))
    }

    func testJAndKDoNothingWhileTyping() {
        XCTAssertEqual(press(38, "j", editingText: true), .pass)
        XCTAssertEqual(press(40, "k", editingText: true), .pass)
        XCTAssertEqual(press(38, "j"), .previous)
        XCTAssertEqual(press(40, "k"), .next)
        XCTAssertEqual(press(53, "", editingText: true), .collapse, "Esc still collapses while a field has the focus")
    }

    /// Paste is every Command chord on V, including Shift and Option. A panel stroke drops Shift, so Shift J is J.
    func testPasteKeepsShiftAndOptionAndAPanelStrokeDropsShift() {
        let keys = keys()
        let sets: [KeyModifiers] = [.command, [.shift, .command], [.option, .command], [.option, .shift, .command]]
        for modifiers in sets {
            let stroke = KeyStroke(keyCode: 9, character: "v", modifiers: modifiers)
            XCTAssertEqual(keys.commands(for: stroke, in: [.window]).map(\.id), [WidgetKeymap.paste], "\(modifiers)")
        }
        let shifted = WidgetKeymap.plainStroke(keyCode: 38, characters: "J")
        XCTAssertEqual(shifted.modifiers, [])
        XCTAssertEqual(shifted.character, "j")
        XCTAssertEqual(press(38, "J"), .previous, "Shift J is still the previous message")
    }

    /// A saved Command chord runs. Shift alone still reaches the plain key. Command on the default key does not.
    func testACommandChordRunsPreviousAndShiftStillFallsBackToThePlainKey() {
        let agents = WidgetCoordinator.PanelKeyContext(previewOpen: false, agents: true, editingText: false, answering: nil)
        let rebound = keys()
        rebound.setChords([.character("j", .command)], for: WidgetKeymap.previous)
        let commandJ = KeyStroke(keyCode: 38, character: "j", modifiers: .command)
        XCTAssertEqual(WidgetCoordinator.panelKey(stroke: commandJ, context: agents, keymap: rebound), .previous)
        XCTAssertEqual(WidgetCoordinator.panelKey(stroke: commandJ, context: agents, keymap: keys()), .pass,
                       "Command J is not Previous until the user binds it")
        let shiftJ = KeyStroke(keyCode: 38, character: "J", modifiers: .shift)
        XCTAssertEqual(WidgetCoordinator.panelKey(stroke: shiftJ, context: agents, keymap: keys()), .previous)

        let state = MediaPreviewState()
        state.present([
            MediaPreviewItem(id: "a", path: "/tmp/a.png"),
            MediaPreviewItem(id: "b", path: "/tmp/b.png"),
        ], selectedID: "a")
        defer { state.dismiss() }
        let preview = keys()
        preview.setChords([.code(123, .command)], for: WidgetKeymap.previewPrevious)
        let commandLeft = KeyStroke(keyCode: 123, character: "", modifiers: .command)
        XCTAssertTrue(MediaPreviewKeyboard.handle(commandLeft, editingText: false, keymap: preview))
        XCTAssertEqual(state.current?.id, "b", "Command Left is the saved Previous Item")
        state.dismiss()
        state.present([
            MediaPreviewItem(id: "a", path: "/tmp/a.png"),
            MediaPreviewItem(id: "b", path: "/tmp/b.png"),
        ], selectedID: "a")
        let shiftLeft = KeyStroke(keyCode: 123, character: "", modifiers: .shift)
        XCTAssertTrue(MediaPreviewKeyboard.handle(shiftLeft, editingText: false, keymap: keys()))
        XCTAssertEqual(state.current?.id, "b", "Shift Left is still the plain arrow")
    }
}
