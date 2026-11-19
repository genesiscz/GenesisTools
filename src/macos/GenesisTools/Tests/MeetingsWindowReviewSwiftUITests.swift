import Foundation
import XCTest
@testable import GenesisToolsFeatures
@testable import GenesisToolsMeetings

/// The Meetings window's pure rules behind the review fixes of its views: the speaker question a block answers, the
/// apply line before the record arrives, the empty state of the Items tab, the split words, the ruler marks, the
/// indicator's extra names, the settings destination in argv and the number reads that must not trap. Invented
/// people only.
@MainActor
final class MeetingsWindowReviewSwiftUITests: XCTestCase {
    private func items(_ json: String) throws -> [MeetingItem] {
        try JSONDecoder().decode([MeetingItem].self, from: Data(json.utf8))
    }

    private func row(_ id: String, kind: String = "speaker-range", confidence: Double?) -> ReviewRow {
        ReviewRow(id: id, label: id, kind: kind, status: "suggested", confidence: confidence, priority: nil, what: "",
                  parts: [], choices: [], edit: "confirm", needs: nil, sources: [], target: .item(id))
    }

    func testABlockAtASharedBoundaryAnswersTheQuestionThatStartsThere() throws {
        let questions = try items(#"""
        [{"id":"q1","kind":"question","status":"suggested","about":"speaker","fromSec":10,"toSec":20},
         {"id":"q2","kind":"question","status":"suggested","about":"speaker","fromSec":20,"toSec":30}]
        """#)
        XCTAssertEqual(SpeakerChip.speakerQuestion(in: questions, at: 20, label: "Speaker 1")?.id, "q2")
        XCTAssertEqual(SpeakerChip.speakerQuestion(in: questions, at: 15, label: "Speaker 1")?.id, "q1")
        XCTAssertNil(SpeakerChip.speakerQuestion(in: questions, at: 30, label: "Speaker 1"), "the end is outside")
        let instant = try items(#"[{"id":"q3","kind":"question","status":"suggested","about":"speaker","fromSec":5,"toSec":5}]"#)
        XCTAssertEqual(SpeakerChip.speakerQuestion(in: instant, at: 5, label: "Speaker 1")?.id, "q3")
    }

    func testOverlappingSpeakerQuestionsPreferTheBlocksSourceLabel() throws {
        let questions = try items(#"""
        [{"id":"other","kind":"question","status":"suggested","about":"speaker","fromSec":0,"toSec":60,"evidence":{"labels":["Speaker 2"]}},
         {"id":"own","kind":"question","status":"suggested","about":"speaker","fromSec":10,"toSec":40,"evidence":{"labels":["Speaker 1"]}}]
        """#)
        XCTAssertEqual(SpeakerChip.speakerQuestion(in: questions, at: 20, label: "Speaker 1")?.id, "own")
        XCTAssertEqual(SpeakerChip.speakerQuestion(in: questions, at: 20, label: "Speaker 3")?.id, "other")
    }

    func testTheApplyLineFallsBackToRowConfidenceBeforeTheRecordArrives() throws {
        let rows = [row("high", confidence: 0.9), row("low", confidence: 0.2), row("q", kind: "question", confidence: 0.9)]
        XCTAssertEqual(MeetingDetailModel.atLine(rows, items: nil, applyAbove: 0.5), ["high"])
        let record = try items(#"[{"id":"low","kind":"term","status":"suggested","proposed":"Example","confidence":0.8}]"#)
        XCTAssertEqual(MeetingDetailModel.atLine(rows, items: record, applyAbove: 0.5), ["low"], "the record's items decide once they arrive")
        let projection = ItemsProjection.make(.init(rows: rows, items: nil, applyAbove: 0.5))
        XCTAssertEqual(projection.suggestions, 1)
        XCTAssertEqual(projection.belowLine, 1)
        XCTAssertTrue(projection.suggestionsWait)
    }

    func testRowsHiddenAsLowPriorityShowTheListAndItsRunStrip() {
        let hidden = ReviewRows(meeting: "m", rows: [], hidden: .init(lowPriority: 3, minPriority: 20))
        XCTAssertFalse(ItemsTab.showsEmptyState(hidden), "the banner and the run strip show, not the empty state")
        XCTAssertTrue(ItemsTab.showsEmptyState(ReviewRows(meeting: "m", rows: [], hidden: .init(lowPriority: 0, minPriority: 20))))
    }

    func testSplitWordsComeOnlyFromTheOriginalLine() {
        XCTAssertEqual(ListenVoicesEditor.splitWords([], at: 10), [], "no original line: no split offset")
        let line = QuestionDetails.Line(index: 0, startSec: 8, endSec: 12, speaker: "Speaker 1", text: "we moved the button")
        XCTAssertEqual(ListenVoicesEditor.splitWords([line], at: 10), ["we", "moved", "the", "button"])
    }

    func testInnerRulerLabelsNeverOverlapEachOther() {
        for duration in [95.0, 1_800, 3_725, 8_770] {
            for width in stride(from: CGFloat(80), through: 900, by: 7) {
                let marks = SpeakerTalkTimeLanes.innerRulerMarks(durationSec: duration, width: width)
                let spans = marks.map { sec -> ClosedRange<CGFloat> in
                    let x = CGFloat(sec / duration) * width
                    let half = SpeakerTalkTimeLanes.rulerLabelWidth(MeetingsFormat.clock(sec)) / 2
                    return (x - half)...(x + half)
                }
                for (left, right) in zip(spans, spans.dropFirst()) {
                    XCTAssertLessThan(left.upperBound, right.lowerBound, "\(duration) s at \(width) pt: \(marks)")
                }
            }
        }
    }

    func testAnIndicatorNamingSomeoneBesideTheSpeakerShows() {
        XCTAssertTrue(TranscriptLine.Indicator(names: ["Alex Example", "Sam Example"], ignored: nil).addsTo(speaker: "Alex Example"))
        XCTAssertFalse(TranscriptLine.Indicator(names: ["Alex Example"], ignored: nil).addsTo(speaker: "Alex Example"))
    }

    func testSettingsDestinationsRoundTripThroughArguments() {
        let request = FeatureSettingsRequest(pageID: "meetings.window", context: "--draft=a b")
        XCTAssertEqual(FeatureSettingsRequest(arguments: ["--features"] + request.arguments), request)
        XCTAssertEqual(FeatureSettingsRequest(arguments: ["--features", "--page", "general"]).pageID, "general",
                       "the spaced form a person types still reads")
        XCTAssertNil(FeatureSettingsRequest(arguments: ["--features", "--page", "--headless"]).pageID)
    }

    func testRawNumbersPastIntsRangeDoNotTrap() {
        let raw = JSONValue.object(["global": .object(["speakerLabels": .object(["voice": .object(["compute": .object(["workers": .number(1e300)])])])])])
        XCTAssertEqual(MeetingsVoiceCompute(raw: raw).workers, MeetingsVoiceCompute.maxWorkers)
        XCTAssertEqual(PersonStay.Clock("1e308:00"), .invalid, "a clock that overflows to infinity is not a time")
        XCTAssertEqual(PersonStay.Clock("1:05:30"), .seconds(3_930))
        XCTAssertEqual(SidePanelWords.number(1e300, key: "meetings.notices.count"), "1e+300")
    }
}
