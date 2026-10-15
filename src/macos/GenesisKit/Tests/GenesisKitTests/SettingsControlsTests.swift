import AppKit
import XCTest
@testable import GenesisKit

/// The settings controls added so every stored setting can be changed in the UI: each test proves a control writes
/// the key its reader reads, and refuses input the reader could not use.
@MainActor
final class SettingsControlsTests: XCTestCase {

    // MARK: - Widget session filter (preferences.sessions)

    private func session(_ key: String, title: String, project: String = "fixture-project", provider: String = "claude",
                         at activity: Double, agent: String? = nil) throws -> WidgetSession {
        let json: [String: Any] = [
            "key": key, "title": title, "project": project, "activityAt": activity, "status": "recent",
            "pinned": true, "visible": true, "hiddenByFilter": false,
            "target": ["hostId": "local", "provider": provider, "sessionId": key, "sourceHome": "/fixture/home",
                       "cwd": "/fixture/\(project)"],
        ].merging(agent.map { ["agentId": $0] } ?? [:]) { $1 }
        return try JSONDecoder().decode(WidgetSession.self, from: JSONSerialization.data(withJSONObject: json))
    }

    func testTheSessionFilterControlWritesTheKeyTheSnapshotReads() throws {
        let preferences = try JSONDecoder().decode(WidgetPreferences.self, from: Data(#"""
        {"excludedKeys":[],"projects":[],"sessions":[],"showChanges":true,"placement":"both","side":"right",
         "quietSeconds":15,"voiceProvider":"xai","voiceLanguage":""}
        """#.utf8))
        let added = WidgetSessionFilter.adding("claude:fixture-b", to: WidgetSessionFilter.adding("claude:fixture-a", to: []))
        XCTAssertEqual(added, ["claude:fixture-a", "claude:fixture-b"])
        XCTAssertEqual(WidgetSessionFilter.adding("claude:fixture-a", to: added), added, "adding twice keeps one entry")
        // The same merge WidgetModel.updatePreferences applies before it flushes the patch to `hub widget`.
        guard case .object(var fields) = try WidgetJSON.value(preferences) else { return XCTFail("preferences encode") }
        fields.merge(WidgetSessionFilter.patch(added)) { _, new in new }
        let merged = try JSONDecoder().decode(WidgetPreferences.self, from: JSONEncoder().encode(WidgetJSON.object(fields)))
        XCTAssertEqual(merged.sessions, added)
        XCTAssertEqual(WidgetSessionFilter.removing("claude:fixture-a", from: merged.sessions), ["claude:fixture-b"])
    }

    func testSessionCandidatesExcludeChosenOnesAndOfferSubagentsOnlyToASearch() throws {
        let sessions = [
            try session("a", title: "Older lead", at: 1_000),
            try session("b", title: "Newer lead", at: 3_000),
            try session("c", title: "Helper agent", at: 4_000, agent: "agent-1"),
            try session("d", title: "Chosen lead", at: 5_000),
        ]
        XCTAssertEqual(WidgetSessionFilter.candidates(sessions, excluding: ["d"], query: "").map(\.key), ["b", "a"],
                       "newest first, chosen and sub-agent sessions left out")
        XCTAssertEqual(WidgetSessionFilter.candidates(sessions, excluding: ["d"], query: "helper").map(\.key), ["c"])
        XCTAssertEqual(WidgetSessionFilter.candidates(sessions, excluding: [], query: "lead", limit: 2).map(\.key), ["d", "b"])
    }

    // MARK: - Settings face loading (S6)

    private func snapshotJSON(showWidget: Bool, revision: Int = 0) -> String {
        """
        {"version":1,"state":{"version":1,"revision":\(revision),"preferences":{"excludedKeys":[],"projects":[],"sessions":[],"showChanges":true,"showWidget":\(showWidget),"placement":"both","side":"right","quietSeconds":15,"voiceProvider":"xai","voiceLanguage":""},"assets":{},"drafts":{},"outgoing":[]},"sessions":[],"cards":[],"manifests":{},"errors":[]}
        """
    }

    func testTheSettingsFaceWaitsForTheStoredPreferencesAndFollowsLaterChanges() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("widget-settings-\(UUID())")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        try snapshotJSON(showWidget: true).write(to: directory.appendingPathComponent("snapshot.json"), atomically: true, encoding: .utf8)
        try Data("{}".utf8).write(to: directory.appendingPathComponent("state.json"))
        let calls = directory.appendingPathComponent("calls.log")
        let script = directory.appendingPathComponent("tools")
        // Each snapshot takes a moment, as the real one does, and is counted.
        try """
        #!/bin/sh
        echo call >> '\(calls.path)'
        sleep 0.3
        cat '\(directory.path)/snapshot.json'
        """.write(to: script, atomically: true, encoding: .utf8)
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: script.path)
        let domain = "settings-tests." + UUID().uuidString
        let defaults = try XCTUnwrap(UserDefaults(suiteName: domain))
        defer { defaults.removePersistentDomain(forName: domain) }
        let model = WidgetModel(binaryPath: script.path, stateRoot: directory.path, defaults: defaults,
                                appearance: NativeSettingsAppearance(defaults: defaults, notificationNamespace: domain,
                                                                     observeExternalChanges: false))
        defer { model.stop() }
        model.startSettings()
        XCTAssertFalse(model.settingsLoaded, "until the snapshot arrives the pages show loading, not defaults")
        // Opening pages while the first load runs must not kill and restart it.
        for _ in 0 ..< 5 { model.refreshSettings() }
        var deadline = ContinuousClock.now + .seconds(5)
        while model.snapshot == nil && ContinuousClock.now < deadline { try await Task.sleep(for: .milliseconds(50)) }
        XCTAssertTrue(model.settingsLoaded)
        XCTAssertEqual(model.snapshot?.state.preferences.showWidget, true, "the stored preference, not the default")
        try await Task.sleep(for: .milliseconds(700))
        let runs = try String(contentsOf: calls, encoding: .utf8).split(separator: "\n").count
        XCTAssertLessThanOrEqual(runs, 2, "five page opens during one load cost at most one more snapshot")

        // Another process turns the widget off: the settings face follows the state file without reopening.
        try snapshotJSON(showWidget: false).write(to: directory.appendingPathComponent("snapshot.json"), atomically: true, encoding: .utf8)
        try Data(#"{"preferences":{"showWidget":false}}"#.utf8).write(to: directory.appendingPathComponent("state.json"), options: .atomic)
        deadline = ContinuousClock.now + .seconds(5)
        while model.snapshot?.state.preferences.showWidget != false && ContinuousClock.now < deadline {
            try await Task.sleep(for: .milliseconds(50))
        }
        XCTAssertEqual(model.snapshot?.state.preferences.showWidget, false)
    }

    func testASnapshotReadBeforeAPreferenceWriteNeverUndoesIt() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("widget-settings-\(UUID())")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let stored = directory.appendingPathComponent("snapshot.json")
        try snapshotJSON(showWidget: true).write(to: stored, atomically: true, encoding: .utf8)
        try snapshotJSON(showWidget: false).write(to: directory.appendingPathComponent("after.json"), atomically: true, encoding: .utf8)
        try Data("{}".utf8).write(to: directory.appendingPathComponent("state.json"))
        let script = directory.appendingPathComponent("tools")
        // A snapshot reads the stored state first and answers late, as a real one does; a preferences call stores
        // the new state at once. So a snapshot that starts before the write answers with the old state after it.
        try """
        #!/bin/sh
        case "$*" in
        *snapshot*) content=$(cat '\(stored.path)'); sleep 0.6; printf '%s' "$content" ;;
        *) cp '\(directory.path)/after.json' '\(stored.path)'; echo '{}' ;;
        esac
        """.write(to: script, atomically: true, encoding: .utf8)
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: script.path)
        let domain = "settings-tests." + UUID().uuidString
        let defaults = try XCTUnwrap(UserDefaults(suiteName: domain))
        defer { defaults.removePersistentDomain(forName: domain) }
        let model = WidgetModel(binaryPath: script.path, stateRoot: directory.path, defaults: defaults,
                                appearance: NativeSettingsAppearance(defaults: defaults, notificationNamespace: domain,
                                                                     observeExternalChanges: false))
        defer { model.stop() }
        model.startSettings()
        var deadline = ContinuousClock.now + .seconds(5)
        while model.snapshot == nil && ContinuousClock.now < deadline { try await Task.sleep(for: .milliseconds(50)) }
        XCTAssertEqual(model.snapshot?.state.preferences.showWidget, true)

        // A load starts with the old state, then the user turns the widget off while it runs.
        model.refreshSettings()
        try await Task.sleep(for: .milliseconds(50))
        model.updatePreferences(["showWidget": .bool(false)])
        XCTAssertEqual(model.snapshot?.state.preferences.showWidget, false, "the switch moves at once")

        deadline = ContinuousClock.now + .seconds(4)
        var sawStaleValue = false
        while ContinuousClock.now < deadline {
            if model.snapshot?.state.preferences.showWidget == true { sawStaleValue = true }
            try await Task.sleep(for: .milliseconds(20))
        }
        XCTAssertFalse(sawStaleValue, "the load that read the old state was dropped, not shown")
        XCTAssertEqual(model.snapshot?.state.preferences.showWidget, false, "the next load carries the stored change")
    }

    func testAReadThatGoesStaleDuringAWriteWaitsForTheWriteInsteadOfRunningAgainAtOnce() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("widget-settings-\(UUID())")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let stored = directory.appendingPathComponent("snapshot.json")
        try snapshotJSON(showWidget: true).write(to: stored, atomically: true, encoding: .utf8)
        try snapshotJSON(showWidget: false).write(to: directory.appendingPathComponent("after.json"), atomically: true, encoding: .utf8)
        try Data("{}".utf8).write(to: directory.appendingPathComponent("state.json"))
        let calls = directory.appendingPathComponent("calls.log")
        let script = directory.appendingPathComponent("tools")
        // A snapshot answers quickly; the preference write takes 1.5 s to land.
        try """
        #!/bin/sh
        case "$*" in
        *snapshot*) echo snapshot >> '\(calls.path)'; sleep 0.1; cat '\(stored.path)' ;;
        *) sleep 1.5; cp '\(directory.path)/after.json' '\(stored.path)'; echo '{}' ;;
        esac
        """.write(to: script, atomically: true, encoding: .utf8)
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: script.path)
        let domain = "settings-tests." + UUID().uuidString
        let defaults = try XCTUnwrap(UserDefaults(suiteName: domain))
        defer { defaults.removePersistentDomain(forName: domain) }
        let model = WidgetModel(binaryPath: script.path, stateRoot: directory.path, defaults: defaults,
                                appearance: NativeSettingsAppearance(defaults: defaults, notificationNamespace: domain,
                                                                     observeExternalChanges: false))
        defer { model.stop() }
        func reads() throws -> Int {
            try String(contentsOf: calls, encoding: .utf8).split(separator: "\n").count
        }
        model.startSettings()
        var deadline = ContinuousClock.now + .seconds(5)
        while model.snapshot == nil && ContinuousClock.now < deadline { try await Task.sleep(for: .milliseconds(50)) }
        XCTAssertTrue(model.settingsLoaded)

        model.updatePreferences(["showWidget": .bool(false)])
        try await Task.sleep(for: .milliseconds(350))
        let before = try reads()
        model.refreshSettings()
        try await Task.sleep(for: .milliseconds(900))
        XCTAssertLessThanOrEqual(try reads() - before, 1, "one stale read while the write lands, not one after another")

        // Once the write lands, one more read brings what it stored.
        deadline = ContinuousClock.now + .seconds(4)
        while try reads() < before + 2 && ContinuousClock.now < deadline { try await Task.sleep(for: .milliseconds(50)) }
        XCTAssertGreaterThanOrEqual(try reads(), before + 2)
        XCTAssertEqual(model.snapshot?.state.preferences.showWidget, false)
    }

    /// The live widget's watch builds each snapshot from state it read earlier, so one read before a preference write
    /// can arrive after the write was saved. It must not undo the saved value; a later change made elsewhere still shows.
    func testAWatchSnapshotReadBeforeASavedPreferenceNeverUndoesIt() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("widget-watch-\(UUID())")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let stateFile = directory.appendingPathComponent("state.json")
        try Data(#"{"revision":3}"#.utf8).write(to: stateFile)
        let domain = "settings-tests." + UUID().uuidString
        let defaults = try XCTUnwrap(UserDefaults(suiteName: domain))
        defer { defaults.removePersistentDomain(forName: domain) }
        let model = WidgetModel(binaryPath: "/fixture/no-process", stateRoot: directory.path, defaults: defaults,
                                appearance: NativeSettingsAppearance(defaults: defaults, notificationNamespace: domain,
                                                                     observeExternalChanges: false))
        defer { model.stop() }
        model.actionRunner = { _ in
            // `hub widget` stores the preference as revision 5.
            try Data(#"{"revision":5}"#.utf8).write(to: stateFile)
            return ["ok": true]
        }
        model.receive([snapshotJSON(showWidget: true, revision: 3)])
        var saved = false
        model.updatePreferences(["showWidget": .bool(false)], saved: { saved = true })
        var deadline = ContinuousClock.now + .seconds(2)
        while !saved && ContinuousClock.now < deadline { try await Task.sleep(for: .milliseconds(10)) }
        XCTAssertTrue(saved)

        // The watch read revision 4 before the write and answers only now.
        model.receive([snapshotJSON(showWidget: true, revision: 4)])
        XCTAssertEqual(model.snapshot?.state.preferences.showWidget, false, "a snapshot read before the write keeps it")
        model.receive([snapshotJSON(showWidget: false, revision: 5)])
        // Another surface turns it back on afterwards: that shows, the saved patch no longer covers it.
        model.receive([snapshotJSON(showWidget: true, revision: 6)])
        deadline = ContinuousClock.now + .seconds(2)
        while model.snapshot?.state.preferences.showWidget != true && ContinuousClock.now < deadline {
            try await Task.sleep(for: .milliseconds(10))
        }
        XCTAssertEqual(model.snapshot?.state.preferences.showWidget, true, "a later change made elsewhere shows")
    }

    func testAPreferenceWriteReportsItsOwnOutcomeSoAPageConfirmsOnlyAStoredValue() async throws {
        let domain = "settings-tests." + UUID().uuidString
        let defaults = try XCTUnwrap(UserDefaults(suiteName: domain))
        defer { defaults.removePersistentDomain(forName: domain) }
        let model = WidgetModel(binaryPath: "/fixture/no-process", stateRoot: FileManager.default.temporaryDirectory.path,
                                defaults: defaults, appearance: NativeSettingsAppearance(
                                    defaults: defaults, notificationNamespace: domain, observeExternalChanges: false))
        defer { model.stop() }
        var refuse = true
        model.actionRunner = { _ in
            if refuse { throw ToolsBridgeError.refused("the widget state folder is not writable") }
            return ["ok": true]
        }
        var saved = 0
        var failed = 0
        func settle() async throws {
            let deadline = ContinuousClock.now + .seconds(2)
            let before = saved + failed
            while saved + failed == before && ContinuousClock.now < deadline { try await Task.sleep(for: .milliseconds(10)) }
        }

        model.updatePreferences(["voiceLanguage": .string("cs")], saved: { saved += 1 }, failed: { failed += 1 })
        try await settle()
        XCTAssertEqual([saved, failed], [0, 1], "a write that failed was reported as saved")

        refuse = false
        model.updatePreferences(["voiceLanguage": .string("cs")], saved: { saved += 1 }, failed: { failed += 1 })
        try await settle()
        XCTAssertEqual([saved, failed], [1, 1])
    }

    func testTheSettingsFaceWatchesTheStateFileHubWidgetReads() {
        XCTAssertEqual(WidgetModel.widgetStateFile(stateRoot: "/fixture/root/", environment: [:]), "/fixture/root/state.json")
        XCTAssertEqual(WidgetModel.widgetStateFile(stateRoot: nil, environment: ["GENESIS_TOOLS_HOME": "/fixture/home"]),
                       "/fixture/home/.genesis-tools/hub/widget/state.json")
        XCTAssertEqual(WidgetModel.widgetStateFile(stateRoot: nil, environment: [:]),
                       NSHomeDirectory() + "/.genesis-tools/hub/widget/state.json")
    }

    // MARK: - Dictation shortcut

    func testAShortcutNeedsAModifierUnlessItIsAFunctionKeyAndSystemChordsAreRefused() {
        let control = HotkeyChord.control, option = HotkeyChord.option, command = HotkeyChord.command
        XCTAssertNil(HotkeyChord(keyCode: 0x02, modifiers: control | option | command).problem)
        XCTAssertNil(HotkeyChord(keyCode: 0x61, modifiers: 0).problem, "F6 may stand alone")
        XCTAssertNotNil(HotkeyChord(keyCode: 0x02, modifiers: 0).problem, "a bare letter would type")
        XCTAssertNotNil(HotkeyChord(keyCode: 0x02, modifiers: HotkeyChord.shift).problem, "⇧D would type a capital D")
        XCTAssertNotNil(HotkeyChord(keyCode: 0x0C, modifiers: command).problem, "⌘Q quits apps")
        XCTAssertNotNil(HotkeyChord(keyCode: 0x31, modifiers: command).problem, "⌘Space is Spotlight")
        XCTAssertNil(HotkeyChord(keyCode: 0x31, modifiers: control | option).problem)
    }

    func testModifierFlagsBecomeTheCarbonMaskTheHotkeyRegisters() {
        XCTAssertEqual(HotkeyChord.carbonModifiers([.control, .option, .command]), FlowConfig.defaultModifiers)
        XCTAssertEqual(HotkeyChord.carbonModifiers([.shift, .command, .capsLock, .function]), 0x0200 | 0x0100,
                       "Caps Lock and Fn are not part of a chord")
        XCTAssertEqual(HotkeyChord(keyCode: 0x02, modifiers: FlowConfig.defaultModifiers).label, "⌃⌥⌘D")
        XCTAssertEqual(
            HotkeyChord(keyCode: 0x12, modifiers: HotkeyChord.control | HotkeyChord.shift).label(layout: TableKeyLayout.us),
            "⌃⇧1")
        XCTAssertEqual(HotkeyChord(keyCode: 0x7A, modifiers: 0).label, "F1")
    }

    func testTheRecorderSavesAValidChordRefusesAnInvalidOneAndEscapeCancels() {
        let model = HotkeyRecorderModel()
        var recorded: [HotkeyChord] = []
        model.start { recorded.append($0) }
        XCTAssertTrue(model.recording)
        model.receive(keyCode: 0x0C, flags: [.command]) { recorded.append($0) }
        XCTAssertTrue(model.recording, "a refused chord keeps listening")
        XCTAssertNotNil(model.problem)
        XCTAssertTrue(recorded.isEmpty)
        model.receive(keyCode: 0x31, flags: [.control, .option]) { recorded.append($0) }
        XCTAssertEqual(recorded, [HotkeyChord(keyCode: 0x31, modifiers: HotkeyChord.control | HotkeyChord.option)])
        XCTAssertFalse(model.recording)
        XCTAssertNil(model.problem)

        model.start { recorded.append($0) }
        model.receive(keyCode: 0x35, flags: []) { recorded.append($0) }
        XCTAssertFalse(model.recording, "Escape cancels")
        XCTAssertEqual(recorded.count, 1, "Escape records nothing")
    }

    func testTheRecorderTellsTheShortcutOwnerWhenListeningStartsAndEndsHoweverItEnds() {
        let model = HotkeyRecorderModel()
        var listening: [Bool] = []
        let chord: (HotkeyChord) -> Void = { _ in XCTAssertEqual(listening.last, true, "a chord is saved while the live one is let go") }
        model.start(onListening: { listening.append($0) }, onRecord: chord)
        model.receive(keyCode: 0x0C, flags: [.command], onRecord: chord)
        XCTAssertEqual(listening, [true], "a refused chord keeps listening, and the live shortcut stays let go")
        model.receive(keyCode: 0x31, flags: [.control, .option], onRecord: chord)
        XCTAssertEqual(listening, [true, false], "saving ends listening")

        model.start(onListening: { listening.append($0) }, onRecord: chord)
        model.receive(keyCode: 0x35, flags: [], onRecord: chord)
        XCTAssertEqual(listening, [true, false, true, false], "Escape ends listening")

        model.start(onListening: { listening.append($0) }, onRecord: chord)
        model.start(onListening: { listening.append($0) }, onRecord: chord)
        model.stop()
        model.stop()
        XCTAssertEqual(listening, [true, false, true, false, true, false, true, false],
                       "a restart ends the first listening once, and a second stop says nothing")
    }

    func testDictationShortcutLanguageAndGraceControlsPersistToTheFlowConfigTheSessionReads() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("flow-settings-\(UUID())")
        defer { try? FileManager.default.removeItem(at: root) }
        let session = FlowSession(store: FlowStore(directory: root))
        // The same writes FlowSettingsView's bindings make.
        var config = session.config
        config.keyCode = 0x31
        config.modifiers = HotkeyChord.control | HotkeyChord.option
        session.config = config
        session.config.localeIdentifier = "cs-CZ"
        session.config.trailingGraceMs = 750
        let stored = FlowStore(directory: root, writesEnabled: false).loadConfig()
        XCTAssertEqual(stored.keyCode, 0x31)
        XCTAssertEqual(stored.modifiers, HotkeyChord.control | HotkeyChord.option)
        XCTAssertEqual(stored.localeIdentifier, "cs-CZ")
        XCTAssertEqual(stored.trailingGraceMs, 750)
    }

    func testLanguageAndGracePickersAlwaysContainTheStoredValue() {
        let supported = [FlowRecognitionLanguages.Language(id: "en-US", name: "English (United States)")]
        XCTAssertEqual(FlowRecognitionLanguages.options(including: "en-US", supported: supported), supported)
        XCTAssertEqual(FlowRecognitionLanguages.options(including: "", supported: supported), supported)
        let options = FlowRecognitionLanguages.options(including: "xx-FIXTURE", supported: supported)
        XCTAssertEqual(options.map(\.id), ["en-US", "xx-FIXTURE"], "a stored language this Mac does not list stays selectable")
        XCTAssertTrue(FlowTrailingGrace.options(including: FlowConfig().trailingGraceMs).contains(350))
        XCTAssertEqual(FlowTrailingGrace.options(including: 425).filter { $0 == 425 }.count, 1)
        XCTAssertEqual(FlowTrailingGrace.label(350), "350 ms (default)")
    }

    // MARK: - Focus exclusions, project rules, retention, delete

    func testAnExcludedSiteIsStoredAsTheHostTheRecorderCompares() {
        XCTAssertEqual(FocusSettings.normalizedHost("https://www.Example.com/path?q=1"), "www.example.com")
        XCTAssertEqual(FocusSettings.normalizedHost(" *.example.com. "), "example.com")
        XCTAssertEqual(FocusSettings.normalizedHost("example.com:8443/x"), "example.com")
        XCTAssertEqual(FocusSettings.normalizedHost("localhost"), "localhost")
        XCTAssertNil(FocusSettings.normalizedHost(""))
        XCTAssertNil(FocusSettings.normalizedHost("two words"))
        XCTAssertNil(FocusSettings.normalizedHost("example..com"))
        var settings = FocusSettings()
        settings.excludedHosts = [FocusSettings.normalizedHost("https://example.com/a") ?? ""]
        XCTAssertFalse(settings.records(host: "docs.example.com"), "the stored host excludes its subdomains")
        XCTAssertTrue(settings.records(host: "example.org"))
    }

    func testTheRuleEditorSavesTheRuleItOpenedAfterAnEarlierRuleIsRemoved() throws {
        let alpha = FocusSettings.ProjectRule(name: "Alpha", cmuxSession: "alpha-")
        let beta = FocusSettings.ProjectRule(name: "Beta", cmuxSession: "beta-")
        let gamma = FocusSettings.ProjectRule(name: "Gamma", titleContains: "Gamma docs")
        var editor = FocusRuleEditor(rule: beta)
        editor.cmuxSession = "beta-edited"
        // Alpha is removed while Beta's editor is open.
        let remaining = [beta, gamma]
        XCTAssertEqual(editor.index(in: remaining), 0)
        let saved = try editor.committed(to: remaining)
        XCTAssertEqual(saved, [FocusSettings.ProjectRule(name: "Beta", cmuxSession: "beta-edited"), gamma],
                       "the edit lands on Beta; Gamma, now at Beta's old index, is untouched")

        var last = FocusRuleEditor(rule: gamma)
        last.host = "gamma.example.com"
        let lastSaved = try last.committed(to: remaining)
        XCTAssertEqual(lastSaved.count, 2, "the last rule is replaced, never appended as a copy")
        XCTAssertEqual(lastSaved[1].host, "gamma.example.com")

        var added = FocusRuleEditor()
        added.name = "Delta"
        added.host = "delta.example.com"
        XCTAssertTrue(added.isNew)
        XCTAssertEqual(try added.committed(to: [alpha]).map(\.name), ["Alpha", "Delta"])
    }

    func testTheRuleEditorEditsTheRowItOpenedWhenTwoRulesAreIdentical() throws {
        let copy = FocusSettings.ProjectRule(name: "Fixture", cmuxSession: "fixture-")
        let other = FocusSettings.ProjectRule(name: "Other", host: "other.example.com")
        var editor = FocusRuleEditor(rule: copy, at: 1)
        XCTAssertEqual(editor.index(in: [copy, copy]), 1, "the second row's editor stays under the second row")
        editor.name = "Fixture copy"
        XCTAssertEqual(try editor.committed(to: [copy, copy]).map(\.name), ["Fixture", "Fixture copy"],
                       "saving replaces the row that was edited, not the first equal one")
        // After a move the row no longer holds the rule, so the editor finds it where it went.
        XCTAssertEqual(FocusRuleEditor(rule: copy, at: 1).index(in: [copy, other]), 0)
    }

    func testTheRuleEditorStaysOnItsCopyOfADuplicatedRuleWhenTheListMovesOrShrinks() throws {
        let copy = FocusSettings.ProjectRule(name: "Fixture", cmuxSession: "fixture-")
        let other = FocusSettings.ProjectRule(name: "Other", host: "other.example.com")

        // The second copy is open and the row above both copies is removed here.
        var rules = [other, copy, copy]
        var editor = FocusRuleEditor(rule: copy, at: 2, in: rules)
        rules.remove(at: 0)
        editor.follow(removalOf: 0, in: rules)
        XCTAssertEqual(editor.index(in: rules), 1)
        editor.name = "Fixture copy"
        XCTAssertEqual(try editor.committed(to: rules).map(\.name), ["Fixture", "Fixture copy"])

        // The second copy is moved up past another rule.
        rules = [copy, other, copy]
        editor = FocusRuleEditor(rule: copy, at: 2, in: rules)
        rules.swapAt(2, 1)
        editor.follow(swapOf: 2, and: 1, in: rules)
        XCTAssertEqual(editor.index(in: rules), 1)

        // A reload (another window's save) drops the row above: the editor keeps the second copy.
        editor = FocusRuleEditor(rule: copy, at: 2, in: [other, copy, copy])
        XCTAssertEqual(editor.index(in: [copy, copy]), 1)
        // A reload drops the edited copy itself: saving adds it again rather than overwriting the other copy.
        XCTAssertNil(editor.index(in: [copy]))
    }

    func testTheRuleEditorTrimsDropsEmptyConditionsAndRefusesUnusableRules() throws {
        let rule = try FocusSettings.ProjectRule.validated(
            name: "  Fixture project ", cmuxSession: " fixture- ", titleContains: "  ", host: "https://fixture.example.com/x",
            existingNames: ["Other"])
        XCTAssertEqual(rule, FocusSettings.ProjectRule(name: "Fixture project", cmuxSession: "fixture-", host: "fixture.example.com"))
        XCTAssertThrowsError(try FocusSettings.ProjectRule.validated(name: " ", cmuxSession: "x", titleContains: "", host: "", existingNames: []))
        XCTAssertThrowsError(try FocusSettings.ProjectRule.validated(name: "Fixture", cmuxSession: "", titleContains: "", host: "", existingNames: []),
                             "a rule with no condition matches nothing")
        XCTAssertThrowsError(try FocusSettings.ProjectRule.validated(name: "other", cmuxSession: "x", titleContains: "", host: "", existingNames: ["Other"]),
                             "names are unique, ignoring case")
        XCTAssertThrowsError(try FocusSettings.ProjectRule.validated(name: "Fixture", cmuxSession: "", titleContains: "", host: "not a site", existingNames: []))
        var settings = FocusSettings()
        settings.projects = [rule]
        XCTAssertEqual(settings.project(cmuxSession: "fixture-main", title: nil, host: nil), "Fixture project")
    }

    func testRetentionAndForgetLabelsAreSentencesAndKeepAStoredValue() {
        XCTAssertEqual(FocusRetention.options(including: 365), FocusRetention.presets)
        XCTAssertTrue(FocusRetention.options(including: 45).contains(45))
        XCTAssertEqual(FocusRetention.label(365), "1 year")
        XCTAssertEqual(FocusRetention.duration(seconds: 0), "Off")
        XCTAssertEqual(FocusRetention.duration(seconds: 45), "45 s")
        XCTAssertEqual(FocusRetention.duration(seconds: 120), "2 min")
        XCTAssertEqual(FocusForgetRange.lastWeek.phrase, "the last 7 days")
        XCTAssertEqual(FocusForgetRange.summary(FocusForgetResult(segments: 0, sessions: 0)), "Nothing was recorded in that period.")
        XCTAssertEqual(FocusForgetRange.summary(FocusForgetResult(segments: 1, sessions: 2)), "Deleted 1 activity record and 2 sessions.")
        let now = Date(timeIntervalSince1970: 1_000_000)
        XCTAssertEqual(FocusForgetRange.lastHour.start(now: now), now.addingTimeInterval(-3_600))
        XCTAssertEqual(FocusForgetRange.everything.start(now: now), Date(timeIntervalSince1970: 0))
    }
}
