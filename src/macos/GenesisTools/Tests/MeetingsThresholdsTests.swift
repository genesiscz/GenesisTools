import Foundation
import XCTest
@testable import GenesisToolsMeetings

@MainActor
final class MeetingsThresholdsTests: XCTestCase {
    func testDraftEditsTheGlobalValueEvenWhenAMeetingOverridesIt() throws {
        let row = MeetingsAPI.ThresholdPreview.Row(name: "fuzzy.suggest", path: "global.suggest.terms.fuzzy.suggest",
            title: "Suggest dictionary matches", meaning: "Propose similar spellings.", source: "project Example dictionary.fuzzy.suggest",
            min: 0, step: 0.01, defaultValue: 0.8, globalValue: 0.8, value: 0.86, max: 1)
        XCTAssertTrue(row.detail.contains(row.value.formatted()))
        var draft = ThresholdDraft()
        draft.set(0.75, for: row)
        draft.set(0.7, for: row)
        XCTAssertEqual(draft.values, ["fuzzy.suggest": 0.7])
        XCTAssertEqual(draft.edits([row]), [.init(path: row.path, value: .number(0.7), expect: .number(0.8))])
        draft.set(row.globalValue, for: row)
        XCTAssertTrue(draft.edits([row]).isEmpty)
    }

    func testThresholdFailureReportKeepsTheServiceCommandAndStack() {
        let failure = MeetingsCLI.Failure(sentence: "Threshold preview failed.", detail: "Fixture refused the preview.",
                                          command: "meetings service meeting.thresholds.preview {}", stack: "fixture stack")
        let report = thresholdFailureReport(failure, outcome: "Could not preview thresholds",
                                            action: "Compare meeting thresholds", call: nil)
        XCTAssertEqual(report.log, "Fixture refused the preview.")
        XCTAssertEqual(report.command, "meetings service meeting.thresholds.preview {}")
        XCTAssertEqual(report.stack, "fixture stack")
    }

    func testFinishingAnOlderSaveKeepsEditsInTheNewDraft() {
        let row = MeetingsAPI.ThresholdPreview.Row(name: "term.applyAbove", path: "global.suggest.terms.applyAbove",
            title: "Apply proposed terms", meaning: "Set the term confidence.", source: "default",
            min: 0, step: 0.01, defaultValue: 0.7, globalValue: 0.7, value: 0.7, max: 1)
        var draft = ThresholdDraft()
        draft.set(0.8, for: row)
        let submitted = draft
        draft.set(0.85, for: row)
        draft.clearIfUnchanged(since: submitted)
        XCTAssertEqual(draft.values, ["term.applyAbove": 0.85])

        let latest = draft
        draft.clearIfUnchanged(since: latest)
        XCTAssertTrue(draft.values.isEmpty)
    }

    func testPreviewDecodesBothStatesAndTheAffectedLine() throws {
        let json = """
        {"thresholds":[],"warnings":[],"counts":[{"kind":"term proposal","added":0,"removed":0,"changed":1}],
         "changes":[{"key":"term|blenwick","kind":"term proposal","change":"changed","atSec":9,"text":"Read the blenwick.",
                     "before":{"status":"applied","confidence":0.79,"description":"blenwick → Blenwik"},
                     "after":{"status":"suggested","confidence":0.79,"description":"blenwick → Blenwik"},
                     "reason":"Apply proposed terms 0.7 → 0.8"}]}
        """
        let result = try JSONDecoder().decode(MeetingsAPI.ThresholdPreview.Result.self, from: Data(json.utf8))
        let change = try XCTUnwrap(result.changes.first)
        XCTAssertEqual(change.atSec, 9)
        XCTAssertEqual(change.text, "Read the blenwick.")
        XCTAssertEqual(change.before?.status, "applied")
        XCTAssertEqual(change.after?.status, "suggested")
        XCTAssertEqual(result.counts.first?.summary, "1 term proposal changed")
        XCTAssertEqual(MeetingsAPI.ThresholdPreview.name, "meeting.thresholds.preview")
    }
}
