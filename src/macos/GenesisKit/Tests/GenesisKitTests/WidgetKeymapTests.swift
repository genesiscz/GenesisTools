import AppKit
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

    private func press(_ keyCode: UInt16, _ characters: String, editingText: Bool = false, answering: WidgetCard? = nil) -> WidgetCoordinator.PanelKey {
        WidgetCoordinator.panelKey(keyCode: keyCode, characters: characters, context: .init(
            previewOpen: false, agents: true, editingText: editingText, answering: answering))
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
}
