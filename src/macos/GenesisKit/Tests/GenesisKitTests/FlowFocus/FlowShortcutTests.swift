// Copied from /Users/Martin/Tresors/Projects/GenesisPlayground/Genesis/apps/Genesis/Tests/GenesisTests/FlowShortcutTests.swift at 2026-10-08T05:04:08+02:00 at commit hash 7bd89a24c79510fb90ab0c2a0701c1d085f2023e
import XCTest
@testable import Genesis

/// D20: the dictation and voice-command chords, the move off ⌃⌥D / ⌃⌥C, the
/// menu titles, and the Labs switches.
@MainActor
final class FlowShortcutTests: XCTestCase {

    /// Magnet's shipped ⌃⌥ window chords (read from its prefs on this Mac,
    /// 2026-09-25; Rectangle ships the same set). Carbon lets a second app
    /// register any of them without an error and then hands the keystroke to
    /// Magnet, so a Genesis default may never be one of these.
    private let magnetChords: Set<UInt32> = [
        0x7B, 0x7C, 0x7E, 0x7D, // arrows
        0x20, 0x22, 0x26, 0x28, // U I J K
        0x02, 0x03, 0x05, // D F G (thirds)
        0x0E, 0x0F, 0x11, // E R T (two thirds)
        0x24, 0x08, 0x33, // Return C Delete
    ]
    private let controlOption: UInt32 = 0x1000 | 0x0800

    func testDefaultChordsAreNotWindowManagerChords() {
        let config = FlowConfig()
        XCTAssertFalse(config.modifiers == controlOption && magnetChords.contains(config.keyCode))
        XCTAssertFalse(VoiceCommandSession.modifiers == controlOption && magnetChords.contains(VoiceCommandSession.keyCode))
    }

    func testDefaultChordLabels() {
        let config = FlowConfig()
        XCTAssertEqual(FlowKeyNames.describe(keyCode: config.keyCode, modifiers: config.modifiers), "⌃⌥⌘D")
        XCTAssertEqual(VoiceCommandSession.chordLabel, "⌃⌥⌘C")
    }

    func testSavedLegacyChordMovesToTheNewDefault() throws {
        var legacy = FlowConfig()
        legacy.modifiers = FlowConfig.legacyModifiers
        legacy.showPill = false
        // Through Codable, the way FlowStore loads ~/.genesis/flow/config.json.
        let decoded = try JSONDecoder().decode(FlowConfig.self, from: JSONEncoder().encode(legacy))

        let migrated = decoded.migratingLegacyChord()
        XCTAssertEqual(migrated.keyCode, 0x02)
        XCTAssertEqual(migrated.modifiers, FlowConfig.defaultModifiers)
        XCTAssertFalse(migrated.showPill, "only the chord moves")
    }

    func testAChosenChordIsKept() {
        var custom = FlowConfig()
        custom.keyCode = 0x31 // Space
        custom.modifiers = controlOption
        XCTAssertEqual(custom.migratingLegacyChord(), custom)
        XCTAssertEqual(FlowConfig().migratingLegacyChord(), FlowConfig())
    }

    func testMenuTitlesCarryTheChordOrSayItIsUnavailable() {
        XCTAssertEqual(GlobalHotkeyStatus.registered(chord: "⌃⌥⌘D").menuTitle("Start dictation"), "Start dictation  ⌃⌥⌘D")
        XCTAssertEqual(
            GlobalHotkeyStatus.unavailable(chord: "⌃⌥⌘D").menuTitle("Start dictation"),
            "Start dictation  (shortcut unavailable)"
        )
        XCTAssertEqual(GlobalHotkeyStatus.off.menuTitle("Voice command"), "Voice command")
    }

    // MARK: - Labs

    func testLabsDefaultOn() {
        XCTAssertTrue(Labs.isOn(.dictation, in: [:]))
        XCTAssertTrue(Labs.isOn(.voiceCommands, in: ["labs": [:]]))
        XCTAssertTrue(Labs.isOn(.dictation, in: ["labs": ["dictation": "no"]]), "a non-bool is not a choice")
    }

    func testLabsOffIsPerFeature() {
        let app: [String: Any] = ["labs": ["dictation": false, "voiceCommands": true]]
        XCTAssertFalse(Labs.isOn(.dictation, in: app))
        XCTAssertTrue(Labs.isOn(.voiceCommands, in: app))
    }

    func testLabsKeysAreTheConfigKeys() {
        XCTAssertEqual(LabsFeature.allCases.map(\.rawValue), ["dictation", "voiceCommands"])
    }
}
