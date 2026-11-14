import AppKit
import Foundation
import XCTest
@testable import GenesisToolsMeetings

/// The Meetings part's logic: decoding what `tools meetings … --json` prints, the CLI's error sentence, the words and
/// times it shows, and which meetings each sidebar place lists.
@MainActor
final class MeetingsWindowTests: XCTestCase {
    func testStemAndRemovalItemsDecodeWithoutLosingNativeReviewFields() throws {
        let source = #"{"id":"i1","kind":"term","status":"confirmed","heard":"fixture","proposed":"correct","heardStem":"fixture","proposedStem":"correct","rules":[],"suggestedAt":"2026-11-02T15:00:00.000Z"}"#
        let item = try JSONDecoder().decode(MeetingItem.self, from: Data(source.utf8))
        XCTAssertEqual(item.heardStem, "fixture")
        XCTAssertEqual(item.proposedStem, "correct")
        let removal = #"{"id":"i2","kind":"removal","status":"suggested","fromSec":5,"toSec":5,"heard":"Fixture done","rules":["local-speech"],"suggestedAt":"2026-11-02T15:00:00.000Z"}"#
        let removed = try JSONDecoder().decode(MeetingItem.self, from: Data(removal.utf8))
        XCTAssertEqual(MeetingsWords.itemKind(removed), "Local speech output")
        XCTAssertTrue(removed.isDecidable)
    }

    func testNativeSpeakerEvidenceDecodesTheSharedCompactFacts() throws {
        let source = #"{"meeting":"m1","gapSec":120,"timed":true,"speakers":[],"hints":[],"evidence":{"summary":["Indicator gap 60s to 120s"],"lines":"0|00:05|p1|mic?|e?|s[]|m[]|Fixture"}}"#
        let result = try JSONDecoder().decode(MeetingsAPI.MeetingSpeakers.Result.self, from: Data(source.utf8))
        XCTAssertEqual(result.evidence?.summary.count, 1)
        XCTAssertTrue(result.evidence?.lines.contains("mic?") == true)
    }

    func testNewWindowPreservesMeetingTabAndBackgroundRequest() {
        let request = MeetingsRequest.parse(["--meeting", "m2", "--new-window", "--tab", "items", "--no-focus"])
        XCTAssertTrue(request.newWindow)
        XCTAssertEqual(request.meeting, "m2")
        XCTAssertEqual(request.tab, .items)
        XCTAssertFalse(request.focus)
        XCTAssertFalse(MeetingsRequest.parse(["--meeting", "m1"]).newWindow)
    }

    func testNoServiceShowsStaleDataAndFailedReadsKeepLastSuccessfulAge() throws {
        let model = MeetingsWindowModel(loadDetail: { _ in })
        model.startLiveUpdates()
        XCTAssertTrue(model.liveUpdatesOff, "CLI fallback still needs an explicit stale-data notice")
        XCTAssertFalse(model.liveUpdates)
        let detail = MeetingDetailModel(id: "m", window: model)
        XCTAssertNil(detail.lastSuccessfulRead)
        let rows = ReviewRows(meeting: "m", rows: [], hidden: .init(lowPriority: 0, minPriority: 0.5))
        detail.settle(\.rows, .loaded(rows))
        let lastRead = try XCTUnwrap(detail.lastSuccessfulRead)
        detail.settle(\.rows, .failed(.init(sentence: "Offline", detail: "Offline"), previous: rows))
        XCTAssertEqual(detail.lastSuccessfulRead, lastRead, "an unsuccessful read cannot make stale data look fresh")
    }

    func testRoutedMomentRequestKeepsPlaybackOptions() throws {
        let json = #"{"meeting":"m1","target":{"kind":"time","atSec":12},"tone":false,"padSec":1,"padAfterSec":3,"lengthSec":5,"screen":false}"#
        let request = MeetingsRequest.parse(["--meeting", "m1", "--play-request", json])
        let play = try XCTUnwrap(request.playRequest)
        XCTAssertEqual(play.meeting, "m1")
        XCTAssertEqual(play.target, .time(12))
        XCTAssertEqual(play.tone, false)
        XCTAssertEqual(play.padSec, 1)
        XCTAssertEqual(play.padAfterSec, 3)
        XCTAssertEqual(play.lengthSec, 5)
        XCTAssertEqual(play.screen, false)
    }

    func testSnapshotReadinessReportsExpiry() async {
        let expired = await waitUntil(0) { false }
        let ready = await waitUntil(0) { true }
        XCTAssertFalse(expired)
        XCTAssertTrue(ready)
    }

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
        let model = MeetingsWindowModel(defaults: defaults, loadDetail: { _ in })

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
        let model = MeetingsWindowModel(defaults: defaults, loadDetail: { _ in })
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
         "autoRecord":{"enabled":false,"liveWithinSec":30,"notify":true}}},
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
        {"keptFrameCpuMs":368.6,"source":"bench","displays":[{"value":"all","maxCpuSecPerMin":22.1},{"value":2,"maxCpuSecPerMin":44.2}],
         "activeFps":[{"value":0.5,"maxCpuSecPerMin":11.1},{"value":1,"maxCpuSecPerMin":22.1}],
         "idleFps":[{"value":0.05,"maxCpuSecPerMin":1.1}],"threshold":[{"value":0.01}],"thresholdNote":"no shares stored"}
        """.utf8)
        let cost = try JSONDecoder().decode(CaptureCost.self, from: json)
        XCTAssertNil(cost.observed)
        XCTAssertEqual(cost.activeFps.first?.value, 0.5, "a frame rate below one decodes")
        XCTAssertEqual(cost.keptFrameCpuMs, 368.6)
        XCTAssertEqual(cost.displayCost("all"), 22.1)
        XCTAssertEqual(cost.displayCost("2"), 44.2, "a screen index reads as its number")
    }

    func testTheCLIsErrorLineBecomesTheSentence() {
        XCTAssertEqual(MeetingsCLI.sentence(fromStderr: "debug\n\u{1B}[31m✗ project work has no export folder\u{1B}[0m\n"),
                       "Project work has no export folder.")
        XCTAssertEqual(MeetingsCLI.sentence(fromStderr: "first\nlast line."), "Last line.")
        XCTAssertNil(MeetingsCLI.sentence(fromStderr: "  \n"))
    }

    func testCLIFallbackKeepsTheOriginalStackAndIssueInTheFailureReport() throws {
        let stderr = #"{"error":{"message":"[config-stale] global.capture changed","stack":"Error: refused\n    at originalThrow (/fixture/source.ts:12:3)","issue":{"tool":"meetings","title":"Original refusal"}}}"# + "\n✗ [config-stale] global.capture changed\n"
        let failure = MeetingsCLI.failure(ToolsRunResult(stdout: "", stderr: stderr, exitCode: 1, wallMs: 0), args: ["config", "set"])
        XCTAssertEqual(failure.sentence, "Global.capture changed.")
        XCTAssertEqual(failure.code, "config-stale")
        XCTAssertEqual(failure.command, "tools meetings config set")
        XCTAssertEqual(failure.stack, "Error: refused\n    at originalThrow (/fixture/source.ts:12:3)")
        XCTAssertEqual(failure.issue, FailureIssue(tool: "meetings", title: "Original refusal"))
        let report = failure.report()
        XCTAssertEqual(report.stack, failure.stack)
        XCTAssertEqual(report.issue, failure.issue)
        XCTAssertTrue(report.rawText().contains("at originalThrow"))

        let legacy = MeetingsCLI.failure(ToolsRunResult(stdout: "", stderr: "✗ [config-stale] global.capture changed\n", exitCode: 1, wallMs: 0), args: ["config", "set"])
        XCTAssertEqual(legacy.sentence, failure.sentence)
        XCTAssertEqual(legacy.code, failure.code)
        XCTAssertNil(legacy.stack)
        let invalid = MeetingsCLI.failure(ToolsRunResult(stdout: "", stderr: "{broken JSON}\n✗ refused\n", exitCode: 1, wallMs: 0), args: [])
        XCTAssertEqual(invalid.sentence, "Refused.")
        let multilineJSON = #"{"error":{"message":"[config-stale] global.capture changed\nTry tools meetings config show"}}"#
        let multiline = MeetingsCLI.failure(ToolsRunResult(stdout: "", stderr: multilineJSON, exitCode: 1, wallMs: 0), args: [])
        XCTAssertEqual(multiline.sentence, "Global.capture changed.")
        XCTAssertEqual(multiline.code, "config-stale")
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
        XCTAssertEqual(MeetingsFormat.clock(309), "05:09", "the CLI's formatClock form (candidate 7)")
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
        XCTAssertEqual(MeetingsWords.itemTitle(item), "S1 from 01:02 to 01:15 is Bob")
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
        XCTAssertEqual(MeetingsConfigWrite.set(["languages", "cs", "ocr"], .array([.string("cs-CZ")]), readFrom: raw).args,
                       ["config", "set", #"["languages","cs","ocr"]"#, #"["cs-CZ"]"#, "--expect", #"["cs-CZ","en-US"]"#])
        XCTAssertEqual(MeetingsConfigWrite.unset(["projects", "work", "export"], readFrom: raw).args,
                       ["config", "unset", #"["projects","work","export"]"#, "--expect", "null"], "a key nobody set expects null")
        XCTAssertEqual(MeetingsConfigWrite.set(["global", "capture", "activeFps"], .number(2), readFrom: nil).args,
                       ["config", "set", #"["global","capture","activeFps"]"#, "2"], "nothing read: no check")
        let edits = MeetingsSettingsModel.ruleEdits(
            "work", draft: MatchRulesDraft(folders: ["Harbor"], calendars: ["Northwind"], titleWords: ["Weekly"]),
            saved: MatchRulesDraft(folders: [], calendars: ["Northwind"], titleWords: []), raw: raw)
        XCTAssertEqual(edits.count, 2, "only the lists that changed, in one edit")
        XCTAssertEqual(edits.first?["path"] as? String, #"["sources","wisprflow","match","work","folders"]"#)
        XCTAssertTrue(edits.first?["expect"] is NSNull)
        let patched = raw.setting(["global", "capture", "activeFps"], to: JSONValue(foundation: 2))
        XCTAssertEqual(MeetingsConfigWrite.set(["global", "capture", "activeFps"], .number(1), readFrom: patched).args.suffix(2), ["--expect", "2"],
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

    func testAProjectChangeAndEitherDecisionMakeTheTranscriptStale() {
        XCTAssertTrue(MeetingDetailModel.reloadsTranscript(after: .project), "the project brings its dictionary")
        XCTAssertTrue(MeetingDetailModel.reloadsTranscript(after: .decision), "a reject can take an unclear mark away")
        XCTAssertFalse(MeetingDetailModel.reloadsTranscript(after: .label))
    }

    func testAFailedSideReadIsShownAndNotReadAsEmpty() {
        let failure = MeetingsCLI.Failure(sentence: "The config is not valid.", detail: "tools meetings config show exited 1")
        let proposals: Loadable<AssignProposals> = .failed(failure, previous: nil)
        let settings: Loadable<MeetingsSettings> = .idle
        let unread = MeetingsUnread.of([(.proposals, proposals.failure), (.projects, settings.failure)])
        XCTAssertEqual(unread.map(\.source), [.proposals])
        XCTAssertEqual(unread.first?.text, "The proposed projects did not load: The config is not valid.")
    }

    func testAQuotedTermCanBeConfirmedAndShowsItsLine() throws {
        let item = try JSONDecoder().decode(MeetingItem.self, from: Data("""
        {"kind":"term","id":"i4","status":"suggested","heard":"lomeno type","quote":{"text":"/{type}","source":"Harbor spec"},
         "rules":[],"suggestedAt":"2026-11-04T10:00:00.000Z"}
        """.utf8))
        XCTAssertFalse(item.needsSpelling, "the quote is what a confirm applies")
        XCTAssertEqual(MeetingsWords.itemTitle(item), "“lomeno type” → “/{type}” (from Harbor spec)")
    }

    func testAQuestionWithoutChoicesTakesATypedAnswer() {
        XCTAssertTrue(MeetingsPreferences.TypedAnswer.noChoices.shows(choices: []), "no choice: the field is the only answer")
        XCTAssertFalse(MeetingsPreferences.TypedAnswer.noChoices.shows(choices: ["wiki"]))
        XCTAssertTrue(MeetingsPreferences.TypedAnswer.always.shows(choices: ["wiki"]))
        let suite = "meetings.tests.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suite)!
        defer { defaults.removePersistentDomain(forName: suite) }
        XCTAssertEqual(MeetingsPreferences.typedAnswer(defaults), .always)
        XCTAssertEqual(MeetingsWords.typedAnswer("  Northwind \n"), "Northwind")
        XCTAssertNil(MeetingsWords.typedAnswer("   "))
    }

    func testASpeakerRenameCanGoBackToItsLabel() {
        XCTAssertEqual(MeetingDetailModel.renameTarget(label: "S1", saved: "Alice", typed: " S1 "), "S1", "the label's name takes the rename away")
        XCTAssertNil(MeetingDetailModel.renameTarget(label: "S1", saved: "Alice", typed: "Alice"))
        XCTAssertNil(MeetingDetailModel.renameTarget(label: "S1", saved: nil, typed: "S1"))
        XCTAssertEqual(MeetingDetailModel.renameTarget(label: "S1", saved: nil, typed: "Bob"), "Bob")
    }

    func testUnpairingACalendarEntryCountsEveryProjectItChanges() throws {
        let projects = try JSONDecoder().decode([String: ProjectSettings].self, from: Data("""
        {"work":{"labels":[],"match":{"people":[
           {"name":"Alice","email":"alice@example.com","pairedBy":[{"kind":"calendar","entryId":"e1"}]},
           {"name":"Bob","email":"bob@example.com","pairedBy":[{"kind":"calendar","entryId":"e1"},{"kind":"manual"}]}]}},
         "side":{"labels":[],"match":{"people":[
           {"name":"Alice","email":"alice@example.com","pairedBy":[{"kind":"calendar","entryId":"e1"}]}]}},
         "other":{"labels":[],"match":{"people":[
           {"name":"Carol","email":"carol@example.com","pairedBy":[{"kind":"calendar","entryId":"e2"}]}]}}}
        """.utf8))
        let preview = UnpairPreview.of(entry: "e1", in: projects)
        XCTAssertEqual(preview, UnpairPreview(pairings: 3, projects: 2, leaving: 2))
        XCTAssertEqual(preview.words, "3 pairings in 2 projects; 2 people leave a project")
    }

    func testAFoldedProjectCardSaysWhatTheProjectHolds() throws {
        let projects = try JSONDecoder().decode([String: ProjectSettings].self, from: Data("""
        {"shop":{"labels":["Checkout","Billing","Ops"],"export":{"folder":"/Users/alice/Notes/acme"},
                 "match":{"calendar":{"calendars":["Work"]},"title":{"words":[]},"people":[
                   {"name":"Alice","email":"alice@example.com","pairedBy":[{"kind":"manual"}]}]}},
         "empty":{"labels":[],"match":{"people":[]}}}
        """.utf8))
        XCTAssertEqual(ProjectCardSummary.line(projects["shop"], folders: 1),
                       "2 rules · 3 labels · 1 paired person · exports to Notes/acme")
        XCTAssertEqual(ProjectCardSummary.line(projects["empty"], folders: 0), "no rules yet")
    }

    func testAWouldMatchRowOffersWhatItsRulesAndItsProjectCallFor() {
        func row(_ project: String?, _ draft: [String]) -> MatchPreviewRow {
            MatchPreviewRow(id: "m", title: "Sync", start: "2026-11-10T08:00:00.000Z", project: project, now: draft, draft: draft, changed: false)
        }
        XCTAssertEqual(WouldMatchAction.of(row(nil, ["shop"])), .confirm("shop"))
        XCTAssertEqual(WouldMatchAction.of(row("side", ["shop"])), .update(from: "side", to: "shop"))
        XCTAssertEqual(WouldMatchAction.of(row("shop", ["shop"])), .matches("shop"))
        XCTAssertEqual(WouldMatchAction.of(row("shop", ["side", "shop"])), .matches("shop"), "its project is among the matches")
        XCTAssertEqual(WouldMatchAction.of(row(nil, ["side", "shop"])), .choose(["side", "shop"]))
        XCTAssertEqual(WouldMatchAction.of(row("shop", [])), .none, "matches none: only the project menu")
        XCTAssertEqual(row(nil, ["shop"]).with(project: "shop").project, "shop")
        XCTAssertEqual(MeetingsSettingsModel.projectNote("Sync", to: "shop"), "“Sync” is in shop now")
        XCTAssertEqual(MeetingsSettingsModel.projectNote("", to: nil), "“Untitled meeting” has no project now")
    }

    func testManualProjectPairingPolicyAsksByDefaultAndCanBeDisabled() throws {
        let suite = "meetings.tests.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let setting = MeetingsPreferences.Projects.pairOnAssignment
        XCTAssertEqual(setting.value(defaults), .ask)
        let notices = NoticeStackModel(announces: false)
        MeetingProjectPairing.offer(meeting: "m", project: "work", service: nil, notices: notices, defaults: defaults)
        let question = try XCTUnwrap(notices.notices.first)
        XCTAssertEqual(question.actions.map(\.label), ["Pair people", "Not now"])
        notices.press(try XCTUnwrap(question.actions.last), of: question.id)
        XCTAssertTrue(notices.notices.isEmpty)
        defaults.set("never", forKey: setting.key)
        MeetingProjectPairing.offer(meeting: "m", project: "work", service: nil, notices: notices, defaults: defaults)
        XCTAssertTrue(notices.notices.isEmpty)
        defaults.set("always", forKey: setting.key)
        MeetingProjectPairing.offer(meeting: "m", project: "work", service: nil, notices: notices, defaults: defaults)
        XCTAssertEqual(notices.notices.first?.tone, .error, "Always attempts pairing and reports an unavailable service")
        defaults.set("unknown", forKey: setting.key)
        XCTAssertEqual(setting.value(defaults), .ask)
    }

    func testPairingUndoKeepsItsCompleteSourceOnTheWire() throws {
        let source = try JSONDecoder().decode(PairedBy.self, from: Data(#"{"kind":"calendar","from":"calendar","entryId":"event-1","at":"2026-11-04T10:00:00.000Z","meetingId":"m"}"#.utf8))
        let request = MeetingsAPI.ProjectsUnpair.Params(project: "work", person: .init(name: "Alice Example"), by: source)
        let encoded = try JSONEncoder().encode(request)
        let restored = try JSONDecoder().decode(MeetingsAPI.ProjectsUnpair.Params.self, from: encoded)
        XCTAssertEqual(restored.by, source)
        XCTAssertEqual(restored.by?.from, "calendar")
        XCTAssertEqual(restored.by?.at, "2026-11-04T10:00:00.000Z")
        let scoped = MeetingsAPI.ProjectsPairFromMeetings.Params(project: "work", people: nil, meeting: "m")
        XCTAssertEqual(try JSONDecoder().decode(MeetingsAPI.ProjectsPairFromMeetings.Params.self, from: JSONEncoder().encode(scoped)).meeting, "m")
    }

    func testAPairingFromTheMeetingsNamesWhoItPaired() throws {
        let paired = try JSONDecoder().decode([MeetingsAPI.ProjectsPairFromMeetings.Paired].self, from: Data("""
        [{"name":"Alice Example","email":"alice@example.com","by":{"kind":"calendar","entryId":"e1","title":"Sync","at":"2026-11-10T08:00:00.000Z"}},
         {"name":"Carol Example","by":{"kind":"manual","at":"2026-11-10T08:00:00.000Z","note":"from the meeting “Sync” on 2026-11-03"}}]
        """.utf8))
        XCTAssertEqual(MeetingsSettingsModel.pairedNote(Array(paired.prefix(1)), project: "shop"), "Paired Alice Example with shop")
        XCTAssertEqual(MeetingsSettingsModel.pairedNote(paired, project: "shop"), "Paired 2 people with shop")
        XCTAssertEqual(MeetingsWords.pairedBy(paired[1].by), "by hand: from the meeting “Sync” on 2026-11-03")
    }

    func testAProjectCardKeepsItsOpenStateAcrossARename() throws {
        let suite = "meetings.tests.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        XCTAssertEqual(MeetingsPreferences.openProjects(defaults), [], "every card starts folded")
        MeetingsPreferences.setProject("shop", open: true, defaults)
        MeetingsPreferences.setProject("side", open: true, defaults)
        MeetingsPreferences.setProject("side", open: false, defaults)
        XCTAssertEqual(MeetingsPreferences.openProjects(defaults), ["shop"])
        MeetingsPreferences.renameOpenProject("shop", to: "store", defaults)
        XCTAssertEqual(MeetingsPreferences.openProjects(defaults), ["store"])
    }

    // MARK: Layout

    /// A failed overview shows the CLI's whole sentence in the list's error pill. The window must still show the sidebar's
    /// rows and the pill: a sentence of about 200 characters once made the split view 3193 pt tall in an 848 pt window,
    /// centred in it, so the sidebar and the list drew only their empty middle.
    func testAFailedOverviewWithALongSentenceKeepsTheSplitViewInTheWindow() throws {
        let suite = "meetings.tests.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let model = MeetingsWindowModel(defaults: defaults)
        model.go(.all)
        let path = "/tmp/example/" + String(repeating: "a-long-folder-name/", count: 4) + ".genesis-tools/meetings/config.json"
        model.receive(failure: MeetingsCLI.Failure(
            sentence: "Failed to parse config at \(path): Unexpected token 'b', \"{ \"version\": 3, \"projects\": [ broken\" is not valid JSON.",
            detail: "tools meetings overview --days 14 --json exited 1:\n✗ Failed to parse config at \(path)\n  The config file exists but contains invalid JSON."))

        let window = MeetingsWindow.makeWindow(model: model, size: NSSize(width: 1280, height: 820))
        // Never visible: alpha 0, below the desktop, ignores the mouse, the app is not activated.
        window.alphaValue = 0
        window.ignoresMouseEvents = true
        window.level = .init(rawValue: Int(CGWindowLevelForKey(.desktopWindow)) - 1)
        window.orderFrontRegardless()
        defer {
            window.orderOut(nil)
            window.close()
        }
        RunLoop.main.run(until: Date().addingTimeInterval(0.5))

        let content = try XCTUnwrap(window.contentView)
        let split = try XCTUnwrap(Self.firstView(NSSplitView.self, in: content), "the window holds the split view")
        let frame = split.convert(split.bounds, to: content)
        XCTAssertEqual(frame.height, content.bounds.height, accuracy: 1, "the split view is as tall as the window, \(frame)")
        XCTAssertEqual(frame.minY, 0, accuracy: 1, "the split view starts at the window's edge, \(frame)")
        let sidebar = try XCTUnwrap(Self.firstView(NSOutlineView.self, in: split), "the sidebar is a list")
        XCTAssertGreaterThanOrEqual(sidebar.numberOfRows, 2, "the sidebar lists Needs you and All meetings")
        XCTAssertEqual(sidebar.visibleRect.minY, 0, accuracy: 1, "the sidebar shows its first rows, \(sidebar.visibleRect)")
    }

    // MARK: Performance (the deep manual test of 2026-11-06, findings MP2, MP5, MP7, MP9, MP10)

    private func perfModel(_ seen: @escaping @MainActor (MeetingDetailModel) -> Void = { _ in }) throws -> (MeetingsWindowModel, () -> Void) {
        let suite = "meetings.tests.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defaults.set("all", forKey: MeetingsPreferences.openOnKey)
        let model = MeetingsWindowModel(defaults: defaults, loadDetail: seen)
        return (model, { defaults.removePersistentDomain(forName: suite) })
    }

    /// MP10: a refresh that reads the same list again set it again, and `@Observable` redrew every view of it; the
    /// overview's `generatedAt` made every answer differ.
    func testAnUnchangedOverviewIsNotSetAgain() throws {
        let (model, cleanup) = try perfModel()
        defer { cleanup() }
        model.receive(try JSONDecoder().decode(MeetingsOverview.self, from: overviewJSON()))
        let later = String(decoding: overviewJSON(), as: UTF8.self).replacingOccurrences(of: "2026-11-05T12:00:00.000Z", with: "2026-11-05T12:05:00.000Z")
        XCTAssertEqual(model.overviewSets, 1)
        model.receive(try JSONDecoder().decode(MeetingsOverview.self, from: Data(later.utf8)))
        XCTAssertEqual(model.overviewSets, 1, "the same meetings at a later generatedAt redraw nothing")

        // The positive control: a list that differs is set.
        let fewer = later.replacingOccurrences(of: "\"days\":14", with: "\"days\":7")
        model.receive(try JSONDecoder().decode(MeetingsOverview.self, from: Data(fewer.utf8)))
        XCTAssertEqual(model.overviewSets, 2, "a changed list is set")
    }

    /// MP7: a Needs you question opened the meeting on its first tab, which read the transcript, and then switched to
    /// Items. The tab is set before the first read now.
    func testANeedsYouQuestionOpensOnItemsBeforeAnyRead() throws {
        var firstTabs: [MeetingDetailModel.Tab] = []
        let (model, cleanup) = try perfModel { firstTabs.append($0.tab) }
        defer { cleanup() }
        model.receive(try JSONDecoder().decode(MeetingsOverview.self, from: overviewJSON()))
        model.select(needsTag: "q:c")
        XCTAssertEqual(firstTabs.last, .items, "the detail's first read is for Items")
        XCTAssertEqual(model.detail?.tab, .items)
    }

    /// MP5: switching meetings left the earlier meeting's reads running for nobody.
    func testOpeningAnotherMeetingDropsTheEarlierOne() throws {
        let (model, cleanup) = try perfModel()
        defer { cleanup() }
        model.receive(try JSONDecoder().decode(MeetingsOverview.self, from: overviewJSON()))
        let first = try XCTUnwrap(model.detail)
        model.select("c")
        XCTAssertTrue(first.isDropped, "the earlier meeting stops its reads")
        XCTAssertFalse(try XCTUnwrap(model.detail).isDropped)
    }

    /// MP2: on a return a part reads again only when its revision token changed or is unknown.
    func testAPartReadsAgainOnlyWhenItsRevisionChanged() {
        XCTAssertFalse(MeetingDetailModel.mustRead(seen: "t1", now: "t1"))
        XCTAssertTrue(MeetingDetailModel.mustRead(seen: "t1", now: "t2"))
        XCTAssertTrue(MeetingDetailModel.mustRead(seen: nil, now: "t1"), "a part read before any token reads once")
        XCTAssertTrue(MeetingDetailModel.mustRead(seen: "t1", now: nil), "a source that cannot tell always reads")
    }

    /// The timeline reads again when Settings switched its lines, though the source's revision is the same.
    func testTheTimelineReadsAgainWhenItsLinesSettingChanged() {
        let changed = MeetingDetailModel.timelineToken("t1", lines: .changed)
        XCTAssertFalse(MeetingDetailModel.mustRead(seen: changed, now: MeetingDetailModel.timelineToken("t1", lines: .changed)))
        XCTAssertTrue(MeetingDetailModel.mustRead(seen: changed, now: MeetingDetailModel.timelineToken("t1", lines: .all)))
        XCTAssertNil(MeetingDetailModel.timelineToken(nil, lines: .all), "no revision stays unknown, so the part reads")
    }

    /// MP6: every open ran `assign proposals` (a process and a Calendar read) for a menu.
    func testOnlyAMeetingWithoutAProjectReadsItsProposalsAtOpen() throws {
        let overview = try JSONDecoder().decode(MeetingsOverview.self, from: overviewJSON())
        XCTAssertFalse(MeetingDetailModel.readsProposalsAtOpen(project: overview.meetings.first { $0.id == "a" }?.project), "a has a project")
        XCTAssertTrue(MeetingDetailModel.readsProposalsAtOpen(project: overview.meetings.first { $0.id == "b" }?.project), "b has none")
    }

    /// R2-MP1: Up and Down in the Items list, which is a lazy stack now and moves its own selection.
    func testItemsArrowKeysStepThroughTheRows() {
        let rows = ["i1", "i2", "i3"]
        XCTAssertEqual(ItemsTab.step(from: nil, by: 1, in: rows), "i1")
        XCTAssertEqual(ItemsTab.step(from: nil, by: -1, in: rows), "i3")
        XCTAssertEqual(ItemsTab.step(from: "i2", by: 1, in: rows), "i3")
        XCTAssertEqual(ItemsTab.step(from: "i3", by: 1, in: rows), "i3", "the end holds")
        XCTAssertEqual(ItemsTab.step(from: "i1", by: -1, in: rows), "i1")
        XCTAssertEqual(ItemsTab.step(from: "gone", by: 1, in: rows), "i1", "a row that left the list starts again")
        XCTAssertNil(ItemsTab.step(from: nil, by: 1, in: []))
    }

    /// R2-MP2: a launch by id on the default Transcript tab read the transcript before the list moved a recording-only
    /// meeting to Screen.
    func testOnlyALaunchOnTheDefaultTranscriptWaitsForTheList() {
        XCTAssertTrue(MeetingDetailModel.firstReadWaitsForList(rowKnown: false, listLoaded: false, tabIsDefault: true, tab: .transcript))
        XCTAssertFalse(MeetingDetailModel.firstReadWaitsForList(rowKnown: true, listLoaded: true, tabIsDefault: true, tab: .transcript))
        XCTAssertFalse(MeetingDetailModel.firstReadWaitsForList(rowKnown: false, listLoaded: true, tabIsDefault: true, tab: .transcript),
                       "a meeting the loaded list does not hold reads at once")
        XCTAssertFalse(MeetingDetailModel.firstReadWaitsForList(rowKnown: false, listLoaded: false, tabIsDefault: false, tab: .transcript),
                       "a tab the request named reads at once")
        XCTAssertFalse(MeetingDetailModel.firstReadWaitsForList(rowKnown: false, listLoaded: false, tabIsDefault: true, tab: .screen))
    }

    /// MP9: reopening Settings read every Meetings page's data, the pages never shown included.
    func testReopeningSettingsReadsOnlyWhatAPageAlreadyRead() {
        let model = MeetingsSettingsModel(writes: false)
        model.reloadRead()
        XCTAssertEqual(model.settings, .idle)
        XCTAssertEqual(model.cost, .idle)
        XCTAssertEqual(model.preview, .idle)
        XCTAssertEqual(model.dictionary, .idle)
    }

    private static func firstView<V: NSView>(_ type: V.Type, in view: NSView) -> V? {
        if let match = view as? V { return match }
        for child in view.subviews {
            if let match = firstView(type, in: child) { return match }
        }
        return nil
    }
}

/// One overview read per burst of events that can change it, shared by every window model while it is in flight.
@MainActor
final class MeetingsOverviewRefreshTests: XCTestCase {
    func testOnlyAChangedRecordOrADecisionCanChangeTheOverview() {
        let timeline = MeetingsEvent.meetingChanged(.init(meeting: "m", parts: ["timeline"]))
        let record = MeetingsEvent.meetingChanged(.init(meeting: "m", parts: ["show", "transcript", "speakers", "timeline"]))
        XCTAssertFalse(MeetingsWindowModel.changesOverview(timeline), "a frame of a live recording reads nothing")
        XCTAssertTrue(MeetingsWindowModel.changesOverview(record))
    }

    func testABurstOfTheWindowsOwnDecisionsReadsNoOverview() {
        var burst = MeetingsWindowModel.OverviewBurst()
        burst.tokens = ["t1", "t2"]
        XCTAssertFalse(MeetingsWindowModel.burstNeedsOverview(burst, own: ["t1", "t2", "t0"]), "the decision's own path read it")
        XCTAssertTrue(MeetingsWindowModel.burstNeedsOverview(burst, own: ["t1"]), "another actor's decision")
        burst.tokens = []
        burst.other = true
        XCTAssertTrue(MeetingsWindowModel.burstNeedsOverview(burst, own: []), "a changed record")
    }

    /// Callers during a read join it when it started after their change, else wait and share the one read after it:
    /// four callers, two reads.
    func testCallersShareTheReadThatStartedAfterTheirChange() async throws {
        final class Gate {
            var runs = 0
            var waiting: [CheckedContinuation<Int, Never>] = []
        }
        let gate = Gate()
        let reads = MeetingsSharedRead<String, Int>()
        let run: @MainActor () async throws -> Int = {
            gate.runs += 1
            let run = gate.runs
            return await withCheckedContinuation { gate.waiting.append($0) } * 10 + run
        }
        func settle(within seconds: TimeInterval = 2, until done: () -> Bool) async {
            let deadline = Date().addingTimeInterval(seconds)
            while !done(), Date() < deadline { await Task.yield(); try? await Task.sleep(for: .milliseconds(5)) }
        }

        let beforeFirst = ContinuousClock.now
        let first = Task { try await reads.value(for: "k", changedAt: beforeFirst, run: run) }
        await settle { gate.waiting.count == 1 }
        let joins = Task { try await reads.value(for: "k", changedAt: beforeFirst, run: run) }
        let afterFirst = ContinuousClock.now
        let later = Task { try await reads.value(for: "k", changedAt: afterFirst, run: run) }
        let alsoLater = Task { try await reads.value(for: "k", changedAt: afterFirst, run: run) }
        await settle(within: 0.1) { false }
        XCTAssertEqual(gate.runs, 1, "a read is in flight: nobody starts another")

        gate.waiting.removeFirst().resume(returning: 1)
        let firstValue = try await first.value
        await settle { gate.waiting.count == 1 }
        await settle(within: 0.1) { false }
        XCTAssertEqual(gate.runs, 2, "the change before the read joined it, and the two later ones share one more read")

        // Every read still waiting is released, so a regression fails here instead of hanging.
        var round = 2
        while !gate.waiting.isEmpty, round < 8 {
            gate.waiting.removeFirst().resume(returning: round)
            round += 1
            await settle(within: 0.1) { false }
        }
        let values = [firstValue, try await joins.value, try await later.value, try await alsoLater.value]
        XCTAssertEqual(values, [11, 11, 22, 22])
        XCTAssertEqual(gate.runs, 2)
    }
}
