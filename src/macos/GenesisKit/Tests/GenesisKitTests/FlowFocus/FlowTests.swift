// Copied from /Users/Martin/Tresors/Projects/GenesisPlayground/Genesis/apps/Genesis/Tests/GenesisTests/FlowTests.swift at 2026-10-08T05:04:08+02:00 at commit hash 7bd89a24c79510fb90ab0c2a0701c1d085f2023e
import XCTest
@testable import GenesisKit
#if canImport(Genesis)
@testable import Genesis
#endif

/// Flow (dictation) — the pure text and bookkeeping logic.
///
/// Everything here runs without a microphone, without Accessibility, and
/// without touching the user's real `~/.genesis/flow`. The audio and injection
/// paths need a live machine and are covered by the UI harness instead.
final class FlowTests: XCTestCase {

    @MainActor
    func testDeletingHistoryAlsoRemovesTheRawTranscriptEvents() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("flow-retention-\(UUID())")
        defer { try? FileManager.default.removeItem(at: root) }
        let previousURL = FlowEvents.logURL
        FlowEvents.logURL = root.appendingPathComponent("events.jsonl")
        defer { FlowEvents.logURL = previousURL }
        let store = FlowStore(directory: root)
        let first = FlowEntry(text: "First output", rawText: "First raw fixture", targetBundleId: nil,
                              targetAppName: nil, durationSeconds: 2, injected: false, wordCount: 2)
        let second = FlowEntry(text: "Second output", rawText: "Second raw fixture", targetBundleId: nil,
                               targetAppName: nil, durationSeconds: 3, injected: false, wordCount: 2)
        store.saveHistory([first, second])
        FlowEvents.publish(first)
        FlowEvents.publish(second)
        let session = FlowSession(store: store)
        session.deleteEntry(first.id)
        let remaining = try String(contentsOf: FlowEvents.logURL, encoding: .utf8)
        XCTAssertFalse(remaining.contains(first.rawText))
        XCTAssertTrue(remaining.contains(second.rawText), "deleting one turn preserves other event consumers' data")
        session.clearHistory()
        XCTAssertTrue(try Data(contentsOf: FlowEvents.logURL).isEmpty)
        XCTAssertTrue(store.loadHistory().isEmpty)
    }

    @MainActor
    func testFailedEventRetentionKeepsHistoryRetryableAfterRepair() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("flow-retention-retry-\(UUID())")
        defer { try? FileManager.default.removeItem(at: root) }
        let previousURL = FlowEvents.logURL
        FlowEvents.logURL = root.appendingPathComponent("events.jsonl")
        defer { FlowEvents.logURL = previousURL }
        let store = FlowStore(directory: root)
        let entry = FlowEntry(text: "Retry fixture", rawText: "Raw retry fixture", targetBundleId: nil,
                              targetAppName: nil, durationSeconds: 2, injected: false, wordCount: 2)
        let kept = FlowEntry(text: "Kept fixture", rawText: "Raw kept fixture", targetBundleId: nil,
                             targetAppName: nil, durationSeconds: 1, injected: false, wordCount: 2)
        store.saveHistory([entry, kept])
        FlowEvents.publish(entry)
        FlowEvents.publish(kept)
        let saved = try Data(contentsOf: FlowEvents.logURL)
        FlowStore(directory: root, writesEnabled: false).saveHistory([])
        XCTAssertEqual(try Data(contentsOf: FlowEvents.logURL), saved, "a passive writer cannot compact the event log")
        XCTAssertEqual(store.loadHistory().map(\.id), [entry.id, kept.id])
        try FileManager.default.removeItem(at: FlowEvents.logURL)
        try FileManager.default.createDirectory(at: FlowEvents.logURL, withIntermediateDirectories: false)
        let session = FlowSession(store: store)
        session.configure(store: store)
        XCTAssertThrowsError(try store.verifyingWrites { session.deleteEntry(entry.id) })
        XCTAssertEqual(store.loadHistory().map(\.id), [entry.id, kept.id], "failed compaction keeps the primary history and its retry identity")
        XCTAssertEqual(session.history.map(\.id), [entry.id, kept.id])
        XCTAssertNotNil(session.lastError)
        try FileManager.default.removeItem(at: FlowEvents.logURL)
        try saved.write(to: FlowEvents.logURL)
        try store.verifyingWrites { session.deleteEntry(entry.id) }
        XCTAssertEqual(store.loadHistory().map(\.id), [kept.id])
        let remaining = try String(contentsOf: FlowEvents.logURL, encoding: .utf8)
        XCTAssertFalse(remaining.contains(entry.rawText))
        XCTAssertTrue(remaining.contains(kept.rawText))
    }

    @MainActor
    func testAppendingAnEventHardensAnExistingLogAndDirectory() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("flow-event-mode-\(UUID())")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let previousURL = FlowEvents.logURL
        FlowEvents.logURL = root.appendingPathComponent("events.jsonl")
        defer { FlowEvents.logURL = previousURL }
        try Data().write(to: FlowEvents.logURL)
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: root.path)
        try FileManager.default.setAttributes([.posixPermissions: 0o644], ofItemAtPath: FlowEvents.logURL.path)
        FlowEvents.publish(FlowEntry(text: "Fixture", rawText: "Fixture", targetBundleId: nil,
                                     targetAppName: nil, durationSeconds: 1, injected: false, wordCount: 1))
        let file = try FileManager.default.attributesOfItem(atPath: FlowEvents.logURL.path)
        let folder = try FileManager.default.attributesOfItem(atPath: root.path)
        XCTAssertEqual((file[.posixPermissions] as? NSNumber)?.intValue, 0o600)
        XCTAssertEqual((folder[.posixPermissions] as? NSNumber)?.intValue, 0o700)
        XCTAssertFalse(try Data(contentsOf: FlowEvents.logURL).isEmpty)
    }

    // MARK: - Starting a turn

    /// eve on PR #85 t3: the menu bar and the palette reached `beginTurn` with Flow's own Enabled
    /// switch off, and it opened the microphone. Every entry point starts a turn through this.
    func testATurnDoesNotStartWhileDictationIsOff() {
        XCTAssertEqual(
            FlowSession.turnStart(phase: .idle, labEnabled: true, enabled: false),
            .off("Dictation is off in Dictation → Settings.")
        )
        XCTAssertEqual(
            FlowSession.turnStart(phase: .error, labEnabled: false, enabled: true),
            .off("Dictation is off in Settings → Labs.")
        )
        XCTAssertEqual(FlowSession.turnStart(phase: .idle, labEnabled: true, enabled: true), .begin)
        XCTAssertEqual(FlowSession.turnStart(phase: .error, labEnabled: true, enabled: true), .begin)
        XCTAssertEqual(FlowSession.turnStart(phase: .listening, labEnabled: true, enabled: false), .busy, "a press during a turn starts nothing")
        XCTAssertNil(FlowSession.offReason(labEnabled: true, enabled: true))
    }

    // MARK: - Dictionary replacement

    func testAppliesReplacementOnWordBoundary() {
        let rules = [FlowDictionaryRule(from: "next js", to: "Next.js")]
        XCTAssertEqual(
            FlowDictionary.apply(rules, to: "I used next js for this"),
            "I used Next.js for this"
        )
    }

    func testReplacementIsCaseInsensitiveButOutputIsVerbatim() {
        let rules = [FlowDictionaryRule(from: "bridge mind", to: "BridgeMind")]
        XCTAssertEqual(
            FlowDictionary.apply(rules, to: "Bridge Mind and bridge mind"),
            "BridgeMind and BridgeMind"
        )
    }

    func testReplacementDoesNotMatchInsideAWord() {
        let rules = [FlowDictionaryRule(from: "js", to: "JS")]
        // "jsonify" must survive: a bare substring replace would maul it.
        XCTAssertEqual(FlowDictionary.apply(rules, to: "jsonify the js file"), "jsonify the JS file")
    }

    /// The ordering guarantee that makes overlapping rules usable: the longest
    /// `from` wins, so a short rule cannot eat a longer rule's match first.
    func testLongestRuleWinsOverOverlappingShorterOne() {
        let rules = [
            FlowDictionaryRule(from: "js", to: "JS"),
            FlowDictionaryRule(from: "next js", to: "Next.js"),
        ]
        XCTAssertEqual(FlowDictionary.apply(rules, to: "next js rocks"), "Next.js rocks")
    }

    func testDisabledRuleIsIgnored() {
        let rules = [FlowDictionaryRule(from: "cat", to: "dog", enabled: false)]
        XCTAssertEqual(FlowDictionary.apply(rules, to: "the cat"), "the cat")
    }

    func testReplacementTreatsSpecialCharactersLiterally() {
        // A regex-flavoured `from` must not be compiled as a pattern.
        let rules = [FlowDictionaryRule(from: "c++", to: "C++")]
        XCTAssertEqual(FlowDictionary.apply(rules, to: "I write c++ daily"), "I write C++ daily")
    }

    func testDollarInReplacementIsNotATemplateReference() {
        // NSRegularExpression templates treat `$1` as a capture reference;
        // a literal price must survive intact.
        let rules = [FlowDictionaryRule(from: "the price", to: "$1000")]
        XCTAssertEqual(FlowDictionary.apply(rules, to: "the price today"), "$1000 today")
    }

    // MARK: - Snippets

    func testSnippetExpands() {
        let snippets = [FlowSnippet(trigger: "my address", body: "1 Infinite Loop")]
        XCTAssertEqual(
            FlowDictionary.expand(snippets, in: "send it to my address please"),
            "send it to 1 Infinite Loop please"
        )
    }

    // MARK: - Snippet variables

    func testSnippetResolvesDateAndTimeVariables() {
        var components = DateComponents()
        components.year = 2026; components.month = 7; components.day = 29
        components.hour = 14; components.minute = 32
        let fixed = Calendar.current.date(from: components)!

        let snippets = [FlowSnippet(trigger: "log stamp", body: "[{{datetime}}]")]
        XCTAssertEqual(
            FlowDictionary.expand(snippets, in: "log stamp done", now: fixed),
            "[2026-07-29 14:32] done"
        )
    }

    func testSnippetNewlineVariableBecomesARealLineBreak() {
        let snippets = [FlowSnippet(trigger: "sign off", body: "Thanks,{{newline}}Martin")]
        XCTAssertEqual(
            FlowDictionary.expand(snippets, in: "sign off"),
            "Thanks,\nMartin"
        )
    }

    func testUnknownVariableIsLeftVisibleRatherThanBlanked() {
        // A typo must be obvious in the output, not silently delete text.
        let resolved = FlowDictionary.resolveVariables(in: "a {{nope}} b")
        XCTAssertEqual(resolved, "a {{nope}} b")
    }

    func testBodyWithoutVariablesIsUntouched() {
        XCTAssertEqual(FlowDictionary.resolveVariables(in: "plain body"), "plain body")
    }

    // MARK: - Tokenizing

    func testTokenizeDropsPunctuationShortWordsAndDigits() {
        let tokens = FlowDictionary.tokenize("The API, v2, handles OAuth — really.")
        XCTAssertTrue(tokens.contains("api"))
        XCTAssertTrue(tokens.contains("handles"))
        XCTAssertTrue(tokens.contains("oauth"))
        XCTAssertFalse(tokens.contains("v2"), "digits are not terms")
        XCTAssertFalse(tokens.contains("v"), "single letters are dropped")
        // "the" survives tokenizing on length; it is the common-word filter,
        // not the tokenizer, that keeps it out of suggestions.
        XCTAssertTrue(tokens.contains("the"))
        XCTAssertTrue(FlowDictionary.isCommonWord("the"))
    }

    // MARK: - Technical-term heuristic

    func testCommonWordsAreNotTechnical() {
        for word in ["because", "something", "really", "think"] {
            XCTAssertFalse(FlowDictionary.isLikelyTechnical(word), "\(word) should read as common")
        }
    }

    func testLowVowelDensityAndHyphensReadAsTechnical() {
        XCTAssertTrue(FlowDictionary.isLikelyTechnical("nginx"))
        XCTAssertTrue(FlowDictionary.isLikelyTechnical("read-only"))
        XCTAssertTrue(FlowDictionary.isLikelyTechnical("kubernetes"), "long and uncommon is enough")
    }

    func testVeryShortTokensAreNeverTechnical() {
        XCTAssertFalse(FlowDictionary.isLikelyTechnical("cat"))
    }

    // MARK: - Learning

    func testSuggestionIsRaisedOnlyAtTheOccurrenceThreshold() {
        var stats: [String: FlowDictionary.WordStats] = [:]
        var raised: [FlowSuggestion] = []
        for _ in 0..<2 {
            raised += FlowDictionary.learn(
                from: "deploy to kubernetes",
                stats: &stats,
                existingRules: [],
                dismissed: []
            )
        }
        XCTAssertTrue(raised.isEmpty, "two hearings is not yet a pattern")

        raised += FlowDictionary.learn(
            from: "deploy to kubernetes",
            stats: &stats,
            existingRules: [],
            dismissed: []
        )
        XCTAssertEqual(raised.map(\.heard), ["kubernetes"])
    }

    func testSuggestionIsNotRaisedTwiceForTheSameWord() {
        var stats: [String: FlowDictionary.WordStats] = [:]
        var raised: [FlowSuggestion] = []
        for _ in 0..<6 {
            raised += FlowDictionary.learn(
                from: "kubernetes again",
                stats: &stats,
                existingRules: [],
                dismissed: []
            )
        }
        XCTAssertEqual(raised.count, 1, "the threshold fires exactly once, not on every hearing after it")
    }

    func testAlreadyRuledAndDismissedWordsAreNeverSuggested() {
        var stats: [String: FlowDictionary.WordStats] = [:]
        var raised: [FlowSuggestion] = []
        for _ in 0..<4 {
            raised += FlowDictionary.learn(
                from: "kubernetes and postgres",
                stats: &stats,
                existingRules: [FlowDictionaryRule(from: "kubernetes", to: "Kubernetes")],
                dismissed: ["postgres"]
            )
        }
        XCTAssertTrue(raised.isEmpty)
    }

    // MARK: - Streak

    func testStreakStartsAtOneWithNoHistory() {
        XCTAssertEqual(FlowSession.streak(endingAt: Date(), previous: nil, current: 0), 1)
    }

    func testStreakIsUnchangedWithinTheSameDay() {
        // Anchored to midday, not to `Date()`: an hour before "now" is the PREVIOUS day for
        // the first hour after midnight, so this test was red between 00:00 and 01:00 and
        // green for the other 23 hours.
        let now = Calendar.current.startOfDay(for: Date()).addingTimeInterval(12 * 3600)
        let earlier = now.addingTimeInterval(-3600)
        XCTAssertEqual(FlowSession.streak(endingAt: now, previous: earlier, current: 4), 4)
    }

    func testStreakIncrementsOnConsecutiveDays() {
        let now = Date()
        let yesterday = Calendar.current.date(byAdding: .day, value: -1, to: now)!
        XCTAssertEqual(FlowSession.streak(endingAt: now, previous: yesterday, current: 4), 5)
    }

    func testStreakResetsAfterAGap() {
        let now = Date()
        let threeDaysAgo = Calendar.current.date(byAdding: .day, value: -3, to: now)!
        XCTAssertEqual(FlowSession.streak(endingAt: now, previous: threeDaysAgo, current: 9), 1)
    }

    // MARK: - Entry maths

    func testWordsPerMinuteIsNilForTurnsTooShortToMeanAnything() {
        let entry = FlowEntry(
            text: "yes", rawText: "yes", targetBundleId: nil, targetAppName: nil,
            durationSeconds: 0.4, injected: true, wordCount: 1
        )
        XCTAssertNil(entry.wordsPerMinute, "a 0.4s 'yes' reads as 150 wpm and would skew the average")
    }

    func testWordsPerMinuteComputesForARealTurn() {
        let entry = FlowEntry(
            text: "one two three four", rawText: "one two three four",
            targetBundleId: nil, targetAppName: nil,
            durationSeconds: 60, injected: true, wordCount: 60
        )
        XCTAssertEqual(entry.wordsPerMinute ?? 0, 60, accuracy: 0.001)
    }
}
