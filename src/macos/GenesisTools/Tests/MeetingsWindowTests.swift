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
         "calendarSlackMin":15,"calendarLookbehindHours":6,"folderWaitDays":30,"retryFailedMin":20},"suggest":{"applyAbove":0.5,"listenBelow":0.6}},
         "projects":{"work":{"labels":["Launch"],"match":{"people":[{"name":"Alice","email":"alice@example.com",
         "pairedBy":[{"kind":"calendar","from":"apple-calendar","entryId":"e1","title":"Sync","at":"2026-11-04T10:00:00.000Z"}]}],
         "title":{"words":["sync"]}},"export":{"folder":"/x/notes"}}},
         "sources":{"wisprflow":{"match":{"work":{"folders":["Work"]}},"suggest":{"ignore":[]},
         "autoRecord":{"enabled":false,"liveWithinSec":30,"stopAfterSilenceSec":120,"notify":true}}},
         "languages":{"cs":{"ocr":["cs-CZ","en-US"],"render":{},"fillers":{"sounds":["ehm","ach"],"words":["jako"]}}}}}
        """.utf8)
        let settings = try JSONDecoder().decode(ConfigShow.self, from: json).value
        XCTAssertEqual(settings.global.capture.displays, DisplayPolicy("2"), "a screen index reads as its number")
        XCTAssertEqual(settings.projects["work"]?.match?.people.first?.label, "Alice <alice@example.com>")
        XCTAssertEqual(settings.wispr?.match["work"]?.folders, ["Work"])
        XCTAssertEqual(settings.meetingLanguage?.ocr, ["cs-CZ", "en-US"])
        XCTAssertEqual(settings.meetingLanguage?.fillers, .init(sounds: ["ehm", "ach"], words: ["jako"]))
        XCTAssertEqual(settings.global.assign.calendarLookbehindHours, 6)
        XCTAssertEqual(settings.global.assign.folderWaitDays, 30)
        XCTAssertEqual(settings.global.assign.retryFailedMin, 20)
        XCTAssertEqual(settings.projects["work"]?.export?.folder, "/x/notes")
    }

    func testAConfigWithoutTheNewKeysDecodesAndShowsTodaysValues() throws {
        let json = Data("""
        {"path":"/x/config.json","value":{"version":3,"global":{"dictionary":{"entries":[]},"language":"cs",
         "capture":{"backend":"native","displays":"all","activeFps":1,"idleFps":0.1,"threshold":0.02,"retentionDays":30},
         "assign":{"ask":true,"lookbackHours":48,"maxProposals":5,"calendarSlackMin":15},
         "suggest":{"applyAbove":0.5}},"projects":{},"sources":{},"languages":{"cs":{"ocr":["cs-CZ"]}}}}
        """.utf8)
        let settings = try JSONDecoder().decode(ConfigShow.self, from: json).value
        XCTAssertNil(settings.global.assign.calendarLookbehindHours)
        XCTAssertNil(settings.meetingLanguage?.fillers)
        XCTAssertEqual(MeetingsSettings.Global.Assign.defaultCalendarLookbehindHours, 3)
        XCTAssertEqual(MeetingsSettings.Global.Assign.defaultFolderWaitDays, 14)
        XCTAssertEqual(MeetingsSettings.Global.Assign.defaultRetryFailedMin, 10)
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

    func testARenamedDictionaryEntryReplacesTheOldOneInOneCommand() {
        XCTAssertEqual(MeetingsSettingsModel.addEntryArgs(type: "abbr", value: "HBR", substitution: "HBR (Harbor)",
                                                          scope: "work", replacing: "NWD"),
                       ["dictionary", "add", "HBR", "HBR (Harbor)", "--type", "abbr", "--project", "work", "--replace", "NWD"])
        XCTAssertFalse(MeetingsSettingsModel.addEntryArgs(type: "fix", value: "Viky", substitution: "wiki", scope: nil,
                                                          replacing: "Viky").contains("--replace"),
                       "an edit that keeps the value is a plain add")
        XCTAssertFalse(MeetingsDictionaryRules.expansionHolds("MOP", "MOPsuffix"), "the schema wants the abbreviation as a word")
        XCTAssertTrue(MeetingsDictionaryRules.expansionHolds("MOP", "MOP (Obchodní partner)"))
    }

    func testASettingsWriteNamesTheValueItReplaces() throws {
        let raw = try JSONDecoder().decode(JSONValue.self, from: Data(#"""
        {"languages":{"cs":{"ocr":["cs-CZ","en-US"]}},"global":{"capture":{"activeFps":1}}}
        """#.utf8))
        XCTAssertEqual(MeetingsSettingsModel.expectArgs(["languages", "cs", "ocr"], in: raw), ["--expect", #"["cs-CZ","en-US"]"#])
        XCTAssertEqual(MeetingsSettingsModel.expectArgs(["projects", "work", "export"], in: raw), ["--expect", "null"],
                       "a key nobody set expects null")
        let edits = MeetingsSettingsModel.ruleEdits(
            "work", draft: MatchRulesDraft(folders: ["Harbor"], calendars: ["Northwind"], titleWords: ["Weekly"]),
            saved: MatchRulesDraft(folders: [], calendars: ["Northwind"], titleWords: []), raw: raw)
        XCTAssertEqual(edits.count, 2, "only the lists that changed, in one edit")
        XCTAssertEqual(edits.first?["path"] as? String, #"["sources","wisprflow","match","work","folders"]"#)
        XCTAssertTrue(edits.first?["expect"] is NSNull)
        let patched = raw.setting(["global", "capture", "activeFps"], to: JSONValue(foundation: 2))
        XCTAssertEqual(MeetingsSettingsModel.expectArgs(["global", "capture", "activeFps"], in: patched), ["--expect", "2"],
                       "the page's own write is the value its next write replaces")
        XCTAssertEqual(MeetingsCLI.code(fromStderr: "\u{1B}[31m✗ [config-stale] global.capture changed\u{1B}[0m\n"), "config-stale")
        XCTAssertEqual(MeetingsCLI.sentence(fromStderr: "✗ [config-stale] global.capture changed"), "Global.capture changed.")
        XCTAssertNil(MeetingsCLI.code(fromStderr: "✗ project work has no export folder"))
    }

    func testAnExportBesideAnEditedNoteSaysSo() throws {
        let beside = try JSONDecoder().decode(ExportResult.self, from: Data("""
        {"meeting":"m","folder":"/notes","path":"/notes/m.export-2026-11-05T0900.md","bytes":10,"replaced":false,
         "action":"beside","kept":"/notes/m.md","written":true}
        """.utf8))
        XCTAssertEqual(beside.noticeText, "Exported m.export-2026-11-05T0900.md beside your edited note")
        XCTAssertEqual(beside.kept, "/notes/m.md")
        let old = try JSONDecoder().decode(ExportResult.self, from: Data("""
        {"meeting":"m","folder":"/notes","path":"/notes/m.md","bytes":10,"replaced":true,"written":true}
        """.utf8))
        XCTAssertEqual(old.noticeText, "Replaced m.md", "a CLI without action still reads")
    }

    func testAnUndoNamesTheDecisionItTakesBack() throws {
        let result = try JSONDecoder().decode(DecideResult.self, from: Data("""
        {"decided":["i1"],"token":"t-1","skipped":[]}
        """.utf8))
        XCTAssertEqual(MeetingDetailModel.reopenArgs(meeting: "m", item: "i1", token: result.token),
                       ["reopen", "m", "i1", "--token", "t-1"])
        XCTAssertEqual(MeetingDetailModel.reopenArgs(meeting: "m", item: "i1", token: nil), ["reopen", "m", "i1"])
    }

    func testEditingADictionaryEntryKeepsItsSpokenFormsAndLetterCase() throws {
        let entries = try JSONDecoder().decode([DictionaryEntry].self, from: Data("""
        [{"type":"term","value":"SDK","spoken":["es dee kay"],"meaning":"old","level":"global"},
         {"type":"fix","value":"ID","substitution":"identity","caseSensitive":true,"level":"global"}]
        """.utf8))
        XCTAssertEqual(entries[1].caseSensitive, true)
        let term = entries[0]
        XCTAssertEqual(MeetingsSettingsModel.addEntryArgs(type: term.type, value: term.value, substitution: nil,
                                                          spoken: MeetingsDictionaryRules.spokenForms((term.spoken ?? []).joined(separator: ", ")),
                                                          meaning: "new meaning", scope: nil),
                       ["dictionary", "add", "SDK", "--type", "term", "--spoken", "es dee kay", "--meaning", "new meaning"])
        XCTAssertEqual(MeetingsSettingsModel.addEntryArgs(type: "fix", value: "ID", substitution: "identity",
                                                          caseSensitive: entries[1].caseSensitive == true, scope: nil),
                       ["dictionary", "add", "ID", "identity", "--type", "fix", "--case-sensitive"])
        XCTAssertEqual(MeetingsDictionaryRules.spokenForms(" zus tent, ,zu stand "), ["zus tent", "zu stand"])
    }

    func testADictionaryUndoNamesTheLevelItRestoresInto() {
        XCTAssertEqual(MeetingsSettingsModel.addEntryArgs(type: "fix", value: "Viky", substitution: "wiki", scope: "work", ifAbsent: true),
                       ["dictionary", "add", "Viky", "wiki", "--type", "fix", "--project", "work", "--if-absent"])
    }
}
