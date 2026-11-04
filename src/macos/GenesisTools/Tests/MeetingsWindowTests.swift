import Foundation
import XCTest
@testable import GenesisToolsMeetings

/// The Meetings part's logic: decoding what `tools meetings … --json` prints, the CLI's error sentence, the words and
/// times it shows, and which meetings each sidebar place lists.
@MainActor
final class MeetingsWindowTests: XCTestCase {
    private func overviewJSON() -> Data {
        Data("""
        {"generatedAt":"2026-11-05T12:00:00.000Z","days":14,"applyAbove":0.5,
         "meetings":[
          {"id":"a","title":"Weekly sync","start":"2026-11-05T08:00:00.000Z","end":"2026-11-05T09:00:00.000Z","durationSec":3600,
           "day":"2026-11-05","project":"work","labels":["Launch"],"hasTranscript":true,"hasRecording":true,"live":false,"frames":12,
           "contextCount":0,"badges":{"noProject":false,"openQuestions":2,"unclearSpeakers":0,"recordingOnly":false,
           "transcriptOnly":false,"suggestedAboveApply":0,"suggested":0}},
          {"id":"b","title":"","start":"2026-11-05T06:00:00.000Z","day":"2026-11-05","labels":[],"hasTranscript":true,
           "hasRecording":false,"live":false,"frames":0,"contextCount":0,"badges":{"noProject":true,"openQuestions":0,
           "unclearSpeakers":0,"recordingOnly":false,"transcriptOnly":true,"suggestedAboveApply":0,"suggested":0}},
          {"id":"c","title":"Planning","start":"2026-11-04T08:00:00.000Z","day":"2026-11-04","project":"side","labels":[],
           "hasTranscript":true,"hasRecording":true,"live":false,"frames":3,"contextCount":1,"badges":{"noProject":false,
           "openQuestions":0,"unclearSpeakers":0,"recordingOnly":false,"transcriptOnly":false,"suggestedAboveApply":0,"suggested":0}}],
         "projects":[{"name":"work","meetings":1},{"name":"side","meetings":1}],
         "needsYou":{"noProject":["b"],"questions":[{"id":"a","count":2}],"suggestions":[],"total":2}}
        """.utf8)
    }

    func testOverviewDecodesAndEachPlaceListsItsMeetings() throws {
        let overview = try JSONDecoder().decode(MeetingsOverview.self, from: overviewJSON())
        let suite = "meetings.tests.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let model = MeetingsWindowModel(defaults: defaults)

        XCTAssertEqual(model.place, .needs, "the window opens on Needs you by default")
        model.receive(overview)
        XCTAssertEqual(model.visibleMeetings.map(\.id), ["a", "b"])
        model.go(.all)
        XCTAssertEqual(model.meetingsByDay.map(\.day), ["2026-11-05", "2026-11-04"])
        XCTAssertEqual(model.meetingsByDay.first?.meetings.map(\.id), ["a", "b"])
        model.go(.project("side"))
        XCTAssertEqual(model.visibleMeetings.map(\.id), ["c"])
        XCTAssertEqual(model.selectedMeetingID, "c", "a selection the place does not show moves to its first meeting")
        XCTAssertEqual(overview.meetings[1].displayTitle, "Untitled meeting")
    }

    func testTheOpenOnSettingPicksTheFirstPlace() throws {
        let suite = "meetings.tests.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        defaults.set("all", forKey: MeetingsPreferences.openOnKey)
        defaults.set(30, forKey: MeetingsPreferences.daysKey)
        let model = MeetingsWindowModel(defaults: defaults)
        XCTAssertEqual(model.place, .all)
        XCTAssertEqual(model.days, 30)
    }

    func testConfigWithEveryDefaultDecodes() throws {
        let json = Data("""
        {"path":"/x/config.json","value":{"version":3,"global":{"dictionary":{"entries":[]},"language":"cs",
         "capture":{"backend":"native","displays":2,"activeFps":1,"idleFps":0.1,"threshold":0.02,"jpegQuality":0.75,
         "resolutionCap":2880,"retentionDays":30,"recorders":{}},"assign":{"ask":true,"lookbackHours":48,"maxProposals":5,
         "calendarSlackMin":15},"suggest":{"applyAbove":0.5,"listenBelow":0.6}},
         "projects":{"work":{"labels":["Launch"],"match":{"people":[{"name":"Alice","email":"alice@example.com",
         "pairedBy":[{"kind":"calendar","from":"apple-calendar","entryId":"e1","title":"Sync","at":"2026-11-04T10:00:00.000Z"}]}],
         "title":{"words":["sync"]}},"export":{"folder":"/x/notes"}}},
         "sources":{"wisprflow":{"match":{"work":{"folders":["Work"]}},"suggest":{"ignore":[]},
         "autoRecord":{"enabled":false,"liveWithinSec":30,"stopAfterSilenceSec":120,"notify":true}}},
         "languages":{"cs":{"ocr":["cs-CZ","en-US"],"render":{}}}}}
        """.utf8)
        let settings = try JSONDecoder().decode(ConfigShow.self, from: json).value
        XCTAssertEqual(settings.global.capture.displays, DisplayPolicy("2"), "a screen index reads as its number")
        XCTAssertEqual(settings.projects["work"]?.match?.people.first?.label, "Alice <alice@example.com>")
        XCTAssertEqual(settings.wispr?.match["work"]?.folders, ["Work"])
        XCTAssertEqual(settings.meetingLanguage?.ocr, ["cs-CZ", "en-US"])
        XCTAssertEqual(settings.projects["work"]?.export?.folder, "/x/notes")
    }

    func testTheCaptureCostDecodesFrameRatesAndDisplayPolicies() throws {
        // The shape of `tools meetings record cost --json` with no recording yet: no `observed`, no kept shares.
        let json = Data("""
        {"keptFrameCpuMs":268.6,"source":"bench","displays":[{"value":"all","maxCpuSecPerMin":16.1},{"value":2,"maxCpuSecPerMin":8}],
         "activeFps":[{"value":0.5,"maxCpuSecPerMin":8.1},{"value":1,"maxCpuSecPerMin":16.1}],
         "idleFps":[{"value":0.05,"maxCpuSecPerMin":0.8}],"threshold":[{"value":0.01}],"thresholdNote":"no shares stored"}
        """.utf8)
        let cost = try JSONDecoder().decode(CaptureCost.self, from: json)
        XCTAssertNil(cost.observed)
        XCTAssertEqual(cost.activeFps.first?.value, 0.5, "a frame rate below one decodes")
        XCTAssertEqual(cost.displayCost("all"), 16.1)
        XCTAssertEqual(cost.displayCost("2"), 8, "a screen index reads as its number")
    }

    func testTheCLIsErrorLineBecomesTheSentence() {
        XCTAssertEqual(MeetingsCLI.sentence(fromStderr: "debug\n\u{1B}[31m✗ project work has no export folder\u{1B}[0m\n"),
                       "Project work has no export folder.")
        XCTAssertEqual(MeetingsCLI.sentence(fromStderr: "first\nlast line."), "Last line.")
        XCTAssertNil(MeetingsCLI.sentence(fromStderr: "  \n"))
    }

    func testAConfigPathKeepsAProjectNameWithADotWhole() {
        XCTAssertEqual(MeetingsCLI.path("projects", "side.quest", "labels"), #"["projects","side.quest","labels"]"#)
        XCTAssertEqual(MeetingsCLI.jsonArgument(0.05), "0.05")
        XCTAssertEqual(MeetingsCLI.jsonArgument("/x/y"), #""/x/y""#)
        XCTAssertEqual(MeetingsCLI.jsonArgument(true), "true")
    }

    func testTimesAndLengthsReadAsWords() {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "Europe/Prague")!
        let now = MeetingsFormat.date("2026-11-05T12:00:00.000Z")!
        XCTAssertEqual(MeetingsFormat.dayTitle("2026-11-05", now: now, calendar: calendar), "Today")
        XCTAssertEqual(MeetingsFormat.dayTitle("2026-11-04", now: now, calendar: calendar), "Yesterday")
        XCTAssertEqual(MeetingsFormat.dayTitle("2026-11-02", now: now, calendar: calendar), "Mon 2 Nov")
        XCTAssertEqual(MeetingsFormat.clock(3909), "1:05:09")
        XCTAssertEqual(MeetingsFormat.clock(309), "5:09")
        XCTAssertEqual(MeetingsFormat.length(3900), "1 h 05 min")
        XCTAssertEqual(MeetingsFormat.length(50), "50 s")
        XCTAssertNil(MeetingsFormat.length(nil))
    }

    func testAnItemReadsAsWordsNotAsData() throws {
        let item = try JSONDecoder().decode(MeetingItem.self, from: Data("""
        {"kind":"speaker-range","id":"i3","status":"suggested","label":"S1","fromSec":62,"toSec":75,"speaker":"Bob",
         "confidence":0.83,"rules":["E1"],"evidence":{"reason":"the call channel held it"},"suggestedAt":"2026-11-04T10:00:00.000Z"}
        """.utf8))
        XCTAssertEqual(MeetingsWords.itemKind(item), "Speaker range")
        XCTAssertEqual(MeetingsWords.itemTitle(item), "S1 1:02–1:15 is Bob")
        XCTAssertEqual(MeetingsWords.confidence(item.confidence), "83 %")
        XCTAssertEqual(item.reason, "the call channel held it")
    }
}
