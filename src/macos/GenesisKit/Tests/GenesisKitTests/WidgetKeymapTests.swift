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

    /// Up, Down and Return move in the list on screen (ux catalogue R7), never while typing and never without a list.
    func testArrowsAndReturnMoveInTheListOnScreen() {
        func press(_ keyCode: UInt16, list: Bool, editingText: Bool = false) -> WidgetCoordinator.PanelKey {
            WidgetCoordinator.panelKey(keyCode: keyCode, characters: "", context: .init(
                previewOpen: false, agents: true, editingText: editingText, answering: nil, list: list), keymap: keys())
        }
        XCTAssertEqual(press(126, list: true), .list(.up))
        XCTAssertEqual(press(125, list: true), .list(.down))
        XCTAssertEqual(press(36, list: true), .list(.open))
        XCTAssertEqual(press(125, list: false), .pass, "no list on screen: the scroll view keeps the arrow")
        XCTAssertEqual(press(126, list: true, editingText: true), .pass, "the caret keeps the arrows in a field")
        XCTAssertEqual(press(36, list: true, editingText: true), .pass, "Return in the composer is the composer's")
    }

    /// With a decision card open, Up and Down still reach the list (which walks the card's options first), and the
    /// digits still answer (judge round, R7).
    func testArrowsWalkAnOpenDecisionsOptionsAndDigitsStillAnswer() {
        let open = card()
        let context = WidgetCoordinator.PanelKeyContext(previewOpen: false, agents: true, editingText: false,
                                                        answering: open, list: true)
        func press(_ keyCode: UInt16, _ characters: String = "") -> WidgetCoordinator.PanelKey {
            WidgetCoordinator.panelKey(keyCode: keyCode, characters: characters, context: context, keymap: keys())
        }
        XCTAssertEqual(press(125), .list(.down), "Down goes to the model, which moves among the options")
        XCTAssertEqual(press(126), .list(.up))
        XCTAssertEqual(press(0x13, "ě"), .choose("drop"), "the number row still answers option 2")

        // The model's step through three options: in from the card row, down to the last, then out of the card.
        XCTAssertEqual(WidgetModel.optionMove(focused: nil, step: 1, count: 3), .option(0))
        XCTAssertEqual(WidgetModel.optionMove(focused: 0, step: 1, count: 3), .option(1))
        XCTAssertEqual(WidgetModel.optionMove(focused: 2, step: 1, count: 3), .leave, "past the last option: next row")
        XCTAssertEqual(WidgetModel.optionMove(focused: 0, step: -1, count: 3), .cardRow, "up from the first: the card")
        XCTAssertEqual(WidgetModel.optionMove(focused: nil, step: -1, count: 3), .leave, "up from the card: row above")
        XCTAssertEqual(WidgetModel.optionMove(focused: nil, step: 1, count: 0), .leave, "no options: the rows move")
    }

    /// ⌘H hides an app on every Mac; Open Hub moved to ⌘O, and J and K say what they move (R8, R9).
    func testOpenHubLeavesCommandHToHideAndJAndKNameTheSession() throws {
        let keys = Keymap(library: WidgetKeymap.library, store: nil, layout: TableKeyLayout.us)
        let commandH = KeyStroke(keyCode: 4, character: "h", modifiers: .command)
        XCTAssertEqual(keys.commands(for: commandH, in: [.app, .window]).map(\.id), [])
        let commandO = KeyStroke(keyCode: 31, character: "o", modifiers: .command)
        XCTAssertEqual(keys.commands(for: commandO, in: [.app]).map(\.id), [WidgetKeymap.hub])
        let titles = Dictionary(uniqueKeysWithValues: WidgetKeymap.library.commands.map { ($0.id, $0.title) })
        XCTAssertEqual(titles[WidgetKeymap.previous], "Previous Session")
        XCTAssertEqual(titles[WidgetKeymap.next], "Next Session")
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
