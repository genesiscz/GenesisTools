import AppKit
import Foundation
import XCTest
@testable import GenesisToolsMeetings

/// The transcript pane's line rows of the gap plan (P9): the indicator survives the threshold, an open question keeps
/// the guess form, the engine's unclear marks pass through, the band count, the range that named a line, the
/// indicator's words, the guess style and the spot-check rate. Invented people only.
@MainActor
final class MeetingsTranscriptRowsTests: XCTestCase {

    private func line(_ speaker: String, at start: Double, confidence: Double? = nil, suggested: String? = nil,
                      questioned: Bool? = nil, band: String? = nil,
                      indicator: TranscriptLine.Indicator? = nil) -> TranscriptLine {
        TranscriptLine(indicator: indicator, id: "l\(Int(start))", startSec: start, speaker: speaker, text: "Some words.",
                       confidence: confidence, suggestedSpeaker: suggested, questioned: questioned,
                       guess: speaker.hasSuffix(" %]"), band: band)
    }

    private func items(_ json: String) throws -> [MeetingItem] {
        try JSONDecoder().decode([MeetingItem].self, from: Data(json.utf8))
    }

    func testX10EngineThresholdMigratesOnlyAnUnsetValueAndRestoresAfterFailure() async throws {
        let defaults = try XCTUnwrap(UserDefaults(suiteName: "MeetingsTranscriptRowsTests.\(UUID().uuidString)"))
        defaults.set(80, forKey: MeetingsApplyThreshold.legacyKey)
        var saved = 0.7
        var writes = 0
        var refuses = false
        let model = MeetingsApplyThreshold(defaults: defaults, read: {
            .init(path: "fixture", value: .object(["global": .object(["suggest": .object(["applyAbove": .number(saved)])])]))
        }, write: { next, expected in
            XCTAssertEqual(expected, saved)
            if refuses { saved = 0.6; throw MeetingsService.Unavailable(reason: "refused") }
            writes += 1; saved = next; return saved
        })
        model.stored = { _ in .object([:]) }
        await model.load()
        XCTAssertEqual(model.percent, 80)
        XCTAssertNil(defaults.object(forKey: MeetingsApplyThreshold.legacyKey))
        await model.load()
        XCTAssertEqual(writes, 1, "migration writes once")
        refuses = true
        await model.set(90)
        XCTAssertEqual(model.percent, 60, "a refusal returns the control to the saved engine value")
        XCTAssertNotNil(model.failure)
        await model.load(clearFailure: false)
        XCTAssertNotNil(model.failure, "a background refresh cannot dismiss a refused write")
        defaults.set(90, forKey: MeetingsApplyThreshold.legacyKey)
        model.stored = { _ in .object(["global": .object(["suggest": .object(["applyAbove": .number(0.6)])])]) }
        await model.load()
        XCTAssertEqual(model.percent, 60, "a saved engine value wins over the legacy window preference")
        XCTAssertEqual(writes, 1)
        XCTAssertNil(model.failure)
        let row = SidePanelCatalog.thresholdRow(model)
        XCTAssertEqual(row.store, .engine(path: MeetingsApplyThreshold.path))
        XCTAssertEqual(row.value, .number(60))
        XCTAssertFalse(SidePanelCatalog.windowSections(defaults).flatMap(\.rows).contains { $0.id == MeetingsApplyThreshold.legacyKey })
        defaults.set(90, forKey: MeetingsApplyThreshold.legacyKey)
        let snapshot = MeetingsApplyThreshold(defaults: defaults, migrates: false, read: model.read, write: model.write)
        await snapshot.load()
        XCTAssertEqual(defaults.integer(forKey: MeetingsApplyThreshold.legacyKey), 90, "a picture never migrates live preferences")
        defaults.removeObject(forKey: MeetingsApplyThreshold.legacyKey)
    }

    func testT12SkippedSwapNamesTheSwapAndUsesSourceIndexes() throws {
        let swaps = try items("""
        [{"id":"i1","kind":"speaker-range","status":"suggested","fromSec":5,"toSec":30,"speaker":"Alice Example"}]
        """)
        var source = line("Bob Example", at: 10)
        source.sourceIndex = 42
        let evidence = WindowLineEvidence(index: 42, startSec: 10, endSec: 12, swapSkippedBy: ["i1"])
        let marks = TranscriptBlock.build(from: [source], evidence: [evidence], items: swaps)[0].lines[0].evidenceMarks
        XCTAssertEqual(marks.map(\.kind), [.swapSkipped])
        XCTAssertEqual(marks[0].text, "Skipped by swap to Alice Example at 00:05 to 00:30")
        var rejected = swaps; rejected[0].status = "rejected"
        XCTAssertTrue(TranscriptEvidenceMark.build(evidence, items: rejected, echoAbove: 70).isEmpty)
    }

    func testX6NoRemotePresenceHasItsOwnCauseAndMark() {
        let unknown = WindowLineEvidence(index: 0, startSec: 0, endSec: 1)
        XCTAssertTrue(TranscriptEvidenceMark.build(unknown, items: [], echoAbove: 70).isEmpty)
        var absent = unknown; absent.noRemotePresent = true
        let mark = TranscriptEvidenceMark.build(absent, items: [], echoAbove: 70)[0]
        XCTAssertEqual(mark.kind, .noRemotePresent)
        XCTAssertEqual(mark.text, "No remote person was in the call at this time")
    }

    func testX17AcousticMeasurementsStayOptionalAndEchoGateIsConfigurable() throws {
        let old = try JSONDecoder().decode(ReviewRows.self, from: Data(#"{"meeting":"fixture","rows":[],"hidden":{"lowPriority":0,"minPriority":0}}"#.utf8))
        XCTAssertNil(old.lineEvidence)
        let evidence = WindowLineEvidence(index: 0, startSec: 0, endSec: 1, micShare: 0.4, callRms: 0.0123, echoOfCall: 0.8, acousticQuality: "linear-estimate")
        XCTAssertEqual(evidence.acousticText, ["Microphone share: 40 %", "Call level (RMS): 0.0123", "Linear acoustic estimate"])
        XCTAssertEqual(evidence.echoText, "Echo of call: 80 % of microphone power")
        XCTAssertNil(WindowLineEvidence(index: 0, startSec: 0, endSec: 1).echoText)
        XCTAssertTrue(WindowLineEvidence(index: 0, startSec: 0, endSec: 1).acousticText.isEmpty)
        XCTAssertEqual(TranscriptEvidenceMark.build(evidence, items: [], echoAbove: 70).map(\.kind), [.callEcho])
        XCTAssertTrue(TranscriptEvidenceMark.build(evidence, items: [], echoAbove: 90).isEmpty)
        XCTAssertTrue(TranscriptEvidenceMark.build(evidence, items: [], echoAbove: 0).isEmpty)
        let kinds: [TranscriptLineMark] = [.swapSkipped, .noRemotePresent, .callEcho]
        XCTAssertEqual(Set(kinds.map { TranscriptEvidenceMark(kind: $0, text: "").symbol }).count, 3)
        for kind in kinds { XCTAssertNotNil(NSImage(systemSymbolName: TranscriptEvidenceMark(kind: kind, text: "").symbol, accessibilityDescription: nil)) }
        let enriched = try JSONDecoder().decode(ReviewRows.self, from: Data(#"{"meeting":"fixture","rows":[],"hidden":{"lowPriority":0,"minPriority":0},"attendanceWarning":"Not available","lineEvidence":[{"index":42,"startSec":10,"endSec":12,"callRms":0}],"questionDetails":[{"id":"q1","decidedLines":[{"index":42,"speaker":"Alice Example","text":"Words"}],"impact":{"lines":1,"words":1,"sameDoubtLines":1},"raisedLines":[]}]}"#.utf8))
        XCTAssertEqual(enriched.attendanceWarning, "Not available")
        XCTAssertEqual(enriched.questionDetails?.first?.decidedLines.first?.index, 42)
        XCTAssertEqual(enriched.lineEvidence?.first?.acousticText, ["Call level (RMS): 0.0000"], "a measured zero is different from a missing value")
        XCTAssertEqual(Set(kinds.map { TranscriptEvidenceMark(kind: $0, text: "").color }).count, 3)
    }

    /// C1, C2, T7, T8: a line under an open suggestion is rebuilt with the name, and keeps its indicator.
    func testASuggestedLineKeepsItsIndicator() {
        let indicator = TranscriptLine.Indicator(names: ["Bob Example"], ignored: "stretch-stuck")
        let shown = TranscriptBlocksPane.shownLines(
            [line("Speaker 2", at: 10, confidence: 0.8, suggested: "Alice Example", band: "applied", indicator: indicator)],
            applyAbove: 70)
        XCTAssertEqual(shown[0].speaker, "Alice Example")
        XCTAssertEqual(shown[0].indicator, indicator)
        let below = TranscriptBlocksPane.shownLines(
            [line("Speaker 2", at: 10, confidence: 0.6, suggested: "Alice Example", band: "applied", indicator: indicator)],
            applyAbove: 70)
        XCTAssertEqual(below[0].speaker, "[Alice Example: 60 %]")
        XCTAssertEqual(below[0].indicator, indicator)
        let block = TranscriptBlock.build(from: below)[0]
        XCTAssertEqual(block.lines[0].indicator, indicator, "the block line draws the glyph from it")
    }

    /// C15: a line an open question decides shows the guess form even above the threshold.
    func testAQuestionedLineStaysAGuess() {
        let shown = TranscriptBlocksPane.shownLines(
            [line("Speaker 2", at: 10, confidence: 0.9, suggested: "Alice Example", questioned: true, band: "applied")],
            applyAbove: 70)
        XCTAssertEqual(shown[0].speaker, "[Alice Example: 90 %]")
        XCTAssertEqual(shown[0].guess, true)
    }

    /// X8: the engine's unclear mark (no suggested name) and a confirmed name reach the pane unchanged.
    func testTheEnginesUnclearMarkPassesThrough() {
        let unclear = line("[unclear: \"Speaker 2\"; 1) Alice Example 2) Bob Example]", at: 10, confidence: 0.4, band: "applied")
        let confirmed = line("Alice Example", at: 20, confidence: 0.4, suggested: "Alice Example", band: "confirmed")
        XCTAssertEqual(TranscriptBlocksPane.shownLines([unclear, confirmed], applyAbove: 90), [unclear, confirmed])
    }

    /// X9: the count per band follows the threshold and leaves out lines no suggestion covers.
    func testTheBandCountFollowsTheThreshold() {
        let entries = [
            line("Alice Example", at: 1),
            line("Speaker 2", at: 2, confidence: 0.95, suggested: "Alice Example", band: "applied"),
            line("Speaker 2", at: 3, confidence: 0.75, suggested: "Bob Example", band: "applied"),
            line("Speaker 2", at: 4, confidence: 0.55, suggested: "Bob Example", band: "guess"),
            line("[unclear: \"Speaker 3\"]", at: 5, confidence: 0.3, band: "applied"),
            line("Bob Example", at: 6, confidence: 0.3, suggested: "Bob Example", band: "confirmed"),
        ]
        let at70 = TranscriptBlocksPane.BandCount(TranscriptBlocksPane.shownLines(entries, applyAbove: 70))
        XCTAssertEqual(at70, .init(applied: 3, guesses: 1, open: 1))
        XCTAssertEqual(at70.words, "3 applied · 1 guess · 1 open")
        let at90 = TranscriptBlocksPane.BandCount(TranscriptBlocksPane.shownLines(entries, applyAbove: 90))
        XCTAssertEqual(at90.words, "2 applied · 2 guesses · 1 open")
    }

    /// T3: the popover names the one range that set the line's name, not every range over its time.
    func testTheNamingRangeIsTheOneTheEnginePicks() throws {
        let all = try items("""
        [{"id":"i1","kind":"speaker-range","status":"rejected","fromSec":0,"toSec":60,"speaker":"Alice Example","confidence":0.8,"rules":["old-rule"]},
         {"id":"i2","kind":"speaker-range","status":"suggested","fromSec":0,"toSec":60,"speaker":"Bob Example","confidence":0.7,"rules":["other-voice"]},
         {"id":"i3","kind":"speaker-range","status":"suggested","fromSec":5,"toSec":30,"speaker":"Alice Example","confidence":0.8,"rules":["roster-solo"]},
         {"id":"i4","kind":"speaker-range","status":"suggested","fromSec":40,"toSec":50,"speaker":"Alice Example","confidence":0.8,"rules":["far-away"]}]
        """)
        let named = line("Speaker 2", at: 10, confidence: 0.8, suggested: "Alice Example", band: "applied")
        XCTAssertEqual(TranscriptBlocksPane.namingRange(of: named, in: all)?.id, "i3")
        XCTAssertNil(TranscriptBlocksPane.namingRange(of: line("Alice Example", at: 10), in: all), "no suggestion, no range")
        let evidence = TranscriptBlocksPane.lineEvidence([named, named], items: all)
        XCTAssertEqual(evidence, ["Named by the speaker range 00:05 to 00:30 · Rules: roster-solo"])

        let confirmed = try items("""
        [{"id":"c1","kind":"speaker-range","status":"confirmed","fromSec":0,"toSec":60,"speaker":"Alice Example","confidence":0.8,"rules":["answer"]},
         {"id":"c2","kind":"speaker-range","status":"suggested","fromSec":0,"toSec":60,"speaker":"Alice Example","confidence":0.8,"rules":["later"]}]
        """)
        XCTAssertEqual(TranscriptBlocksPane.namingRange(of: named, in: confirmed)?.id, "c1", "a confirmed range wins")
    }

    /// C2, T7: the indicator's reason in words, in the popover too.
    func testTheIndicatorSaysWhyItIsIgnored() {
        XCTAssertEqual(TranscriptLine.Indicator(names: ["Bob Example"], ignored: nil).shownText, "Bob Example")
        let stuck = TranscriptLine.Indicator(names: ["Bob Example"], ignored: "meeting-dominance").shownText
        XCTAssertTrue(stuck.contains("most of the meeting"), stuck)
        XCTAssertFalse(stuck.contains("meeting-dominance"))
        XCTAssertFalse(TranscriptLine.Indicator(names: [], ignored: "stretch-stuck").shownText.contains("stretch-stuck"))
        let lines = [line("Bob Example", at: 3, indicator: .init(names: ["Bob Example"], ignored: nil))]
        XCTAssertEqual(TranscriptBlocksPane.lineEvidence(lines, items: []), ["Speaking indicator: Bob Example"])
    }

    /// L21: a guessed block takes the guess style; a name or an unclear mark does not.
    func testOnlyAGuessTakesTheGuessStyle() {
        XCTAssertTrue(TranscriptBlock(id: "b", speaker: "[Alice Example: 60 %]", lines: []).isGuess)
        XCTAssertFalse(TranscriptBlock(id: "b", speaker: "Alice Example", lines: []).isGuess)
        XCTAssertFalse(TranscriptBlock(id: "b", speaker: "[unclear: \"Speaker 2\"]", lines: []).isGuess)
    }

    /// L23: the spot check's measured share, from the answered spot-check questions.
    func testTheSpotCheckRate() throws {
        XCTAssertNil(TranscriptBlocksPane.spotCheckRate([]))
        let answered = try items("""
        [{"id":"q1","kind":"question","status":"confirmed","group":"spot-check","answer":"Bob Example","evidence":{"originalSpeaker":"Alice Example"}},
         {"id":"q2","kind":"question","status":"confirmed","group":"spot-check","answer":"Alice Example","evidence":{"originalSpeaker":"Alice Example"}},
         {"id":"q3","kind":"question","status":"suggested","group":"spot-check"},
         {"id":"q4","kind":"question","status":"confirmed","group":"long-stretch","answer":"Bob Example","evidence":{"originalSpeaker":"Alice Example"}}]
        """)
        let rate = try XCTUnwrap(TranscriptBlocksPane.spotCheckRate(answered))
        XCTAssertEqual(rate.changed, 1)
        XCTAssertEqual(rate.checked, 2)
    }
}
