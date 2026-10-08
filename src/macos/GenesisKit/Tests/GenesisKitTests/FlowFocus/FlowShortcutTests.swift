// Copied from /Users/Martin/Tresors/Projects/GenesisPlayground/Genesis/apps/Genesis/Tests/GenesisTests/FlowShortcutTests.swift at 2026-10-08T05:04:08+02:00 at commit hash 7bd89a24c79510fb90ab0c2a0701c1d085f2023e
import XCTest
@testable import GenesisKit
#if canImport(Genesis)
@testable import Genesis
#endif

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
        #if canImport(Genesis)
        XCTAssertFalse(VoiceCommandSession.modifiers == controlOption && magnetChords.contains(VoiceCommandSession.keyCode))
        #endif
    }

    func testDefaultChordLabels() {
        let config = FlowConfig()
        XCTAssertEqual(FlowKeyNames.describe(keyCode: config.keyCode, modifiers: config.modifiers), "⌃⌥⌘D")
        #if canImport(Genesis)
        XCTAssertEqual(VoiceCommandSession.chordLabel, "⌃⌥⌘C")
        #endif
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

    func testOlderConfigurationKeepsChoicesWhenNewKeysAreMissing() throws {
        let data = Data(#"{"enabled":false,"keyCode":49,"modifiers":256,"localeIdentifier":"en-GB"}"#.utf8)
        let config = try JSONDecoder().decode(FlowConfig.self, from: data)
        XCTAssertFalse(config.enabled)
        XCTAssertEqual(config.keyCode, 49)
        XCTAssertEqual(config.modifiers, 256)
        XCTAssertEqual(config.localeIdentifier, "en-GB")
        XCTAssertEqual(config.preRoll, FlowConfig().preRoll)
        XCTAssertEqual(config.historyLimit, FlowConfig().historyLimit)
        XCTAssertEqual(try JSONDecoder().decode(FlowConfig.self, from: JSONEncoder().encode(config)), config)
        XCTAssertThrowsError(try JSONDecoder().decode(FlowConfig.self, from: Data(#"{"enabled":"invalid"}"#.utf8)))
    }

    func testOlderTransformsAndCountersReceiveOnlyMissingDefaults() throws {
        let transform = try JSONDecoder().decode(FlowTransform.self, from: Data(#"{"name":"Fixture rewrite","prompt":"Keep the meaning","enabled":false}"#.utf8))
        XCTAssertEqual(transform.name, "Fixture rewrite")
        XCTAssertFalse(transform.enabled)
        XCTAssertFalse(transform.isDefault)
        XCTAssertTrue(transform.appBundleIds.isEmpty)
        let stats = try JSONDecoder().decode(FlowStats.self, from: Data(#"{"totalWords":42}"#.utf8))
        XCTAssertEqual(stats.totalWords, 42)
        XCTAssertEqual(stats.sessionCount, 0)
        let rule = try JSONDecoder().decode(FlowDictionaryRule.self, from: Data(#"{"from":"spoken","to":"Written"}"#.utf8))
        XCTAssertTrue(rule.enabled)
        XCTAssertFalse(rule.learned)
        let snippet = try JSONDecoder().decode(FlowSnippet.self, from: Data(#"{"trigger":"insert fixture","body":"Fixture text"}"#.utf8))
        XCTAssertTrue(snippet.enabled)
    }

    func testOlderEntriesAndSuggestionsKeepRequiredContent() throws {
        let entry = try JSONDecoder().decode(FlowEntry.self, from: Data(#"{"text":"Fixture words","rawText":"fixture words","durationSeconds":1.5,"injected":false,"wordCount":2}"#.utf8))
        XCTAssertEqual(entry.text, "Fixture words")
        XCTAssertEqual(entry.rawText, "fixture words")
        XCTAssertEqual(entry.wordCount, 2)
        let suggestion = try JSONDecoder().decode(FlowSuggestion.self, from: Data(#"{"heard":"fixture","suggested":"Fixture","reason":"technicalTerm","occurrences":3}"#.utf8))
        XCTAssertEqual(suggestion.suggested, "Fixture")
        XCTAssertEqual(suggestion.occurrences, 3)
    }

    func testLoadingAnOlderConfigDoesNotQuarantineOrRewriteIt() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("flow-config-version-\(UUID())")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let file = root.appendingPathComponent("config.json")
        let data = Data(#"{"enabled":false,"localeIdentifier":"en-GB"}"#.utf8)
        try data.write(to: file)
        let config = FlowStore(directory: root).loadConfig()
        XCTAssertFalse(config.enabled)
        XCTAssertEqual(config.localeIdentifier, "en-GB")
        XCTAssertEqual(try Data(contentsOf: file), data)
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: root.path), ["config.json"])
    }

    func testMenuTitlesCarryTheChordOrSayItIsUnavailable() {
        XCTAssertEqual(GlobalHotkeyStatus.registered(chord: "⌃⌥⌘D").menuTitle("Start dictation"), "Start dictation  ⌃⌥⌘D")
        XCTAssertEqual(
            GlobalHotkeyStatus.unavailable(chord: "⌃⌥⌘D").menuTitle("Start dictation"),
            "Start dictation  (shortcut unavailable)"
        )
        XCTAssertEqual(GlobalHotkeyStatus.off.menuTitle("Voice command"), "Voice command")
    }

    #if canImport(Genesis)
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
    #endif
}
