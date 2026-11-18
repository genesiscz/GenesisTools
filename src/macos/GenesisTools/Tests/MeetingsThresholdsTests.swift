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

    func testPreviewDecodesBothStatesAndTheAffectedLine() throws {
        let json = """
        {"thresholds":[],"warnings":[],"counts":[{"kind":"term proposal","added":0,"removed":0,"changed":1}],
         "changes":[{"key":"term|blenwick","kind":"term proposal","change":"changed","atSec":9,"text":"Read the blenwick.",
                     "before":{"status":"suggested","confidence":0.79,"description":"blenwick → Blenwik"},
                     "after":{"status":"applied","confidence":0.79,"description":"blenwick → Blenwik"},
                     "reason":"Apply proposed terms 0.8 → 0.7"}]}
        """
        let result = try JSONDecoder().decode(MeetingsAPI.ThresholdPreview.Result.self, from: Data(json.utf8))
        let change = try XCTUnwrap(result.changes.first)
        XCTAssertEqual(change.atSec, 9)
        XCTAssertEqual(change.text, "Read the blenwick.")
        XCTAssertEqual(change.before?.status, "suggested")
        XCTAssertEqual(change.after?.status, "applied")
        XCTAssertEqual(result.counts.first?.summary, "1 term proposal changed")
        XCTAssertEqual(MeetingsAPI.ThresholdPreview.name, "meeting.thresholds.preview")
    }
}
