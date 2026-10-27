import AppKit
import XCTest
@testable import GenesisKitBase
@testable import GenesisKit

/// The widget's text fields (Martin, 2026-10-27): a snapshot read before a draft save never takes typed text away, and
/// the standard editing shortcuts reach the field in a panel whose process has no Edit menu.
@MainActor
final class WidgetFieldEditingTests: XCTestCase {

    // MARK: - Drafts: the field the user edits owns its text

    /// Stores `draft-text` as `hub widget` does: the text, and state.json's revision one higher.
    private final class DraftStore {
        let stateFile: URL
        var revision: Int
        var texts: [String: String] = [:]
        init(stateFile: URL, revision: Int) {
            self.stateFile = stateFile
            self.revision = revision
            write()
        }
        func write() {
            try? Data(#"{"revision":\#(revision)}"#.utf8).write(to: stateFile, options: .atomic)
        }
        func run(_ value: WidgetJSON) async throws -> WidgetJSON {
            if case .object(let fields) = value, fields["action"] == .string("draft-text"),
               case .string(let key) = fields["key"], case .string(let text) = fields["text"] {
                texts[key] = text
                revision += 1
                write()
            }
            return ["ok": .bool(true)]
        }
    }

    private func line(revision: Int, key: String, text: String) -> String {
        let encoded = String(decoding: try! JSONEncoder().encode(text), as: UTF8.self)
        return #"{"version":1,"state":{"version":1,"revision":\#(revision),"preferences":{"excludedKeys":[],"projects":[],"sessions":[],"showChanges":true,"placement":"both","side":"right","quietSeconds":15,"voiceProvider":"xai","voiceLanguage":""},"assets":{},"drafts":{"\#(key)":{"text":\#(encoded),"assetIds":[]}},"outgoing":[]},"sessions":[],"cards":[],"manifests":{},"errors":[]}"#
    }

    private func until(_ condition: @autoclosure () -> Bool, _ message: String) async throws {
        let deadline = ContinuousClock.now + .seconds(4)
        while !condition() && ContinuousClock.now < deadline { try await Task.sleep(for: .milliseconds(20)) }
        XCTAssertTrue(condition(), message)
    }

    func testAnOlderSnapshotNeverReplacesTypedTextAndAnIdleFieldTakesExternalChanges() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("widget-field-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let store = DraftStore(stateFile: root.appendingPathComponent("state.json"), revision: 10)
        let defaults = try XCTUnwrap(UserDefaults(suiteName: "widget-field-\(UUID().uuidString)"))
        let appearance = NativeSettingsAppearance(defaults: defaults, notificationNamespace: "fixture.field.\(UUID())",
                                                  observeExternalChanges: false)
        let model = WidgetModel(binaryPath: "/fixture/no-process", stateRoot: root.path, defaults: defaults,
                                appearance: appearance)
        defer { model.stop() }
        model.actionRunner = store.run
        // Longer than the 350 ms save debounce, as the real 3 s is.
        model.draftOwnership.quietPeriod = 1
        model.selectedKey = "chosen"
        model.receive([line(revision: 10, key: "chosen", text: "a) but")])
        XCTAssertEqual(model.draft.text, "a) but", "an idle field shows the stored draft")

        // Martin's sequence: a save lands, he types on, and a snapshot read before the save arrives late.
        model.setText("a) but explain")
        try await until(store.texts["chosen"] == "a) but explain", "the debounced save landed")
        model.setText("a) but explain - when we build")
        model.receive([line(revision: 10, key: "chosen", text: "a) but")])
        XCTAssertEqual(model.draft.text, "a) but explain - when we build", "typing owns the field")

        // Saved and idle: the late snapshot read before the save still never writes the field.
        try await until(store.texts["chosen"] == "a) but explain - when we build", "the second save landed")
        try await Task.sleep(for: .milliseconds(1_100))
        model.receive([line(revision: 10, key: "chosen", text: "a) but")])
        XCTAssertEqual(model.draft.text, "a) but explain - when we build", "a snapshot older than the save is ignored")
        model.receive([line(revision: store.revision, key: "chosen", text: "a) but explain - when we build")])
        XCTAssertEqual(model.draft.text, "a) but explain - when we build", "the echo of the save changes nothing")

        // Another surface sends the draft: the idle field follows.
        model.receive([line(revision: store.revision + 1, key: "chosen", text: "")])
        XCTAssertEqual(model.draft.text, "", "an external change applies to an idle field")

        // With the keyboard in the field nothing writes into it, and leaving the field shows the newest stored text.
        model.draftFieldFocus("reply", focused: true)
        model.receive([line(revision: store.revision + 2, key: "chosen", text: "from the hub")])
        XCTAssertEqual(model.draft.text, "", "a focused field owns its text")
        model.draftFieldFocus("reply", focused: false)
        XCTAssertEqual(model.draft.text, "from the hub", "leaving the field applies what changed meanwhile")

        // A snapshot that arrives during the typing hold applies once the hold runs out.
        model.setText("typed")
        try await until(store.texts["chosen"] == "typed", "the third save landed")
        model.receive([line(revision: store.revision + 1, key: "chosen", text: "answered elsewhere")])
        XCTAssertEqual(model.draft.text, "typed", "inside the typing hold")
        try await until(model.draft.text == "answered elsewhere", "after the hold the newest stored text shows")
    }

    func testFocusedComposerRetargetsItsOwnershipWhenTheSessionChanges() throws {
        let defaults = try XCTUnwrap(UserDefaults(suiteName: "widget-field-switch-\(UUID())"))
        let model = WidgetModel(binaryPath: "/fixture/no-process", defaults: defaults,
                                appearance: NativeSettingsAppearance(defaults: defaults,
                                    notificationNamespace: "fixture.switch.\(UUID())", observeExternalChanges: false))
        defer { model.stop() }
        model.selectedKey = "first"
        model.draftFieldFocus("reply", focused: true, key: "first")
        model.selectedKey = "second"
        model.draftFieldFocus("reply", focused: true, key: "second")
        model.draftFieldFocus("reply", focused: false, key: "first")
        XCTAssertTrue(model.draftOwnership.accepts("first", revision: 1, now: Date()))
        XCTAssertFalse(model.draftOwnership.accepts("second", revision: 1, now: Date()), "a stale blur cannot release the new session")
        model.draftFieldFocus("reply", focused: false, key: "second")
        XCTAssertTrue(model.draftOwnership.accepts("second", revision: 1, now: Date()))
    }

    func testUnreadableSaveRevisionKeepsTheDraftUntilARealFloorArrives() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("widget-field-unreadable-\(UUID())")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let defaults = try XCTUnwrap(UserDefaults(suiteName: "widget-field-unreadable-\(UUID())"))
        let model = WidgetModel(binaryPath: "/fixture/no-process", stateRoot: root.path, defaults: defaults,
                                appearance: NativeSettingsAppearance(defaults: defaults,
                                    notificationNamespace: "fixture.unreadable.\(UUID())", observeExternalChanges: false))
        defer { model.stop() }
        model.actionRunner = { _ in ["ok": true] }
        model.draftOwnership.quietPeriod = 0
        model.selectedKey = "chosen"
        model.receive([line(revision: 10, key: "chosen", text: "old")])
        model.setText("new")
        try await until(!model.draftOwnership.isUnsaved("chosen"), "the save returned")
        model.receive([line(revision: 11, key: "chosen", text: "old")])
        XCTAssertEqual(model.draft.text, "new", "a newer pre-save snapshot is still held")
        try Data(#"{"revision":12}"#.utf8).write(to: root.appendingPathComponent("state.json"))
        try await until(model.draftOwnership.accepts("chosen", revision: 12, now: Date()), "the actual revision is read")
        model.receive([line(revision: 11, key: "chosen", text: "old")])
        XCTAssertEqual(model.draft.text, "new")
        model.receive([line(revision: 12, key: "chosen", text: "new")])
        XCTAssertEqual(model.draft.text, "new")
    }

    // MARK: - Standard editing shortcuts in a panel

    private func key(_ characters: String, code: UInt16, _ modifiers: NSEvent.ModifierFlags, in window: NSWindow) -> NSEvent {
        NSEvent.keyEvent(with: .keyDown, location: .zero, modifierFlags: modifiers, timestamp: 0,
                         windowNumber: window.windowNumber, context: nil, characters: characters,
                         charactersIgnoringModifiers: characters, isARepeat: false, keyCode: code)!
    }

    func testTheEditingChordsReachTheFieldInAPanelWithNoEditMenu() throws {
        let panel = EditingPanel(contentRect: NSRect(x: -4000, y: -4000, width: 300, height: 120),
                                 styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
        panel.alphaValue = 0
        let text = NSTextView(frame: NSRect(x: 0, y: 0, width: 300, height: 120))
        text.allowsUndo = true
        panel.contentView = text
        XCTAssertTrue(panel.makeFirstResponder(text))
        text.string = "hello world"
        text.setSelectedRange(NSRange(location: 3, length: 0))

        XCTAssertTrue(panel.performKeyEquivalent(with: key("a", code: 0, .command, in: panel)))
        XCTAssertEqual(text.selectedRange(), NSRange(location: 0, length: 11), "⌘A selects all")

        let undo = try XCTUnwrap(panel.undoManager)
        undo.groupsByEvent = false
        undo.beginUndoGrouping()
        text.setSelectedRange(NSRange(location: 11, length: 0))
        text.insertText("!", replacementRange: text.selectedRange())
        undo.endUndoGrouping()
        XCTAssertEqual(text.string, "hello world!")
        XCTAssertTrue(panel.performKeyEquivalent(with: key("z", code: 6, .command, in: panel)))
        XCTAssertEqual(text.string, "hello world", "⌘Z undoes")
        XCTAssertTrue(panel.performKeyEquivalent(with: key("z", code: 6, [.command, .shift], in: panel)))
        XCTAssertEqual(text.string, "hello world!", "⇧⌘Z redoes")

        // Other keys stay with the field and the widget: arrows, Option-arrows and unrelated chords.
        XCTAssertFalse(panel.performKeyEquivalent(with: key("k", code: 40, .command, in: panel)))
        XCTAssertNil(StandardEditing.action(for: key("\u{F702}", code: 123, [.option, .function], in: panel)))
        XCTAssertNil(StandardEditing.action(for: key("a", code: 0, [.command, .option], in: panel)))
        // A layout without Latin letters still finds the chord by the key's place.
        XCTAssertEqual(StandardEditing.action(for: key("с", code: 8, .command, in: panel)), #selector(NSText.copy(_:)))
        XCTAssertEqual(StandardEditing.action(for: key("x", code: 7, .command, in: panel)), #selector(NSText.cut(_:)))
        XCTAssertEqual(StandardEditing.action(for: key("v", code: 9, .command, in: panel)), #selector(NSText.paste(_:)))
        // Option-Left moves by word in the field itself (keyDown, not a key equivalent).
        text.setSelectedRange(NSRange(location: 11, length: 0))
        text.moveWordBackward(nil)
        XCTAssertEqual(text.selectedRange().location, 6)
        XCTAssertEqual(StandardEditing.menuItem().submenu?.items.compactMap(\.action).count, 6)
    }
}
