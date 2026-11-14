import AppKit
import Foundation
import Observation
import SwiftUI
import XCTest
@testable import GenesisToolsMeetings

/// What the user of the Meetings window meets: the menu bar, the layout at the window's smallest size, and the words
/// and states of the panes (the deep manual test of 2026-11-06, findings MU1 to MU19).
@MainActor
final class MeetingsUXTests: XCTestCase {
    func testSourceAudioStatusDecodesAlongsideOlderServiceReplies() throws {
        let old = try JSONDecoder().decode(MeetingsOverview.self, from: Self.overviewJSON())
        XCTAssertNil(old.meetings[0].sourceAudio)
        var document = try XCTUnwrap(JSONSerialization.jsonObject(with: Self.overviewJSON()) as? [String: Any])
        var rows = try XCTUnwrap(document["meetings"] as? [[String: Any]])
        rows[0]["sourceAudio"] = ["sources": ["wisprflow"], "bytes": 42]
        document["meetings"] = rows
        let current = try JSONDecoder().decode(MeetingsOverview.self, from: JSONSerialization.data(withJSONObject: document))
        XCTAssertEqual(current.meetings[0].sourceAudio?.bytes, 42)
        XCTAssertEqual(current.meetings[0].sourceAudio?.sources, ["wisprflow"])
        XCTAssertNil(current.meetings[1].sourceAudio)
    }

    // MARK: Fixtures

    static func overviewJSON() -> Data {
        Data("""
        {"generatedAt":"2026-11-05T12:00:00.000Z","days":14,"applyAbove":0.5,
         "meetings":[
          {"id":"a","title":"Weekly sync","start":"2026-11-05T08:00:00.000Z","end":"2026-11-05T09:00:00.000Z","durationSec":3600,
           "day":"2026-11-05","project":"work","labels":["Launch"],"hasTranscript":true,"hasRecording":true,"live":false,"frames":12,
           "contextCount":0,"badges":{"noProject":false,"openQuestions":2,"unclearSpeakers":0,"recordingOnly":false,
           "transcriptOnly":false,"suggestedAboveApply":3,"suggested":4}},
          {"id":"b","title":"Screen only","start":"2026-11-05T06:00:00.000Z","day":"2026-11-05","labels":[],"hasTranscript":false,
           "hasRecording":true,"live":false,"frames":1,"contextCount":0,"badges":{"noProject":true,"openQuestions":0,
           "unclearSpeakers":0,"recordingOnly":true,"transcriptOnly":false,"suggestedAboveApply":0,"suggested":0}}],
         "projects":[{"name":"work","meetings":1}],
         "needsYou":{"noProject":["b"],"questions":[{"id":"a","count":2}],"suggestions":[{"id":"a","count":3}],"total":2}}
        """.utf8)
    }

    private func defaults() throws -> (UserDefaults, String) {
        let suite = "meetings.tests.\(UUID().uuidString)"
        return (try XCTUnwrap(UserDefaults(suiteName: suite)), suite)
    }

    /// The window drawn off screen: alpha 0, below the desktop, never activated.
    private func hiddenWindow(_ model: MeetingsWindowModel, size: NSSize) -> NSWindow {
        let window = MeetingsWindow.makeWindow(model: model, size: size)
        window.alphaValue = 0
        window.ignoresMouseEvents = true
        window.level = .init(rawValue: Int(CGWindowLevelForKey(.desktopWindow)) - 1)
        window.orderFrontRegardless()
        return window
    }

    // MARK: MU3 the menu bar

    func testTheMenuBarClosesQuitsMinimizesAndEditsText() {
        let bar = MeetingsMenu.build(appName: "GenesisTools")
        func item(_ key: String, _ mask: NSEvent.ModifierFlags = .command) -> NSMenuItem? {
            bar.items.compactMap(\.submenu).flatMap(\.items).first {
                $0.keyEquivalent == key && $0.keyEquivalentModifierMask == mask
            }
        }
        XCTAssertEqual(item("w")?.action, #selector(NSWindow.performClose(_:)), "⌘W closes the window")
        XCTAssertEqual(item("m")?.action, #selector(NSWindow.performMiniaturize(_:)), "⌘M minimizes it")
        XCTAssertEqual(item("q")?.action, #selector(NSApplication.terminate(_:)), "⌘Q quits")
        XCTAssertEqual(item("c")?.action, #selector(NSText.copy(_:)), "⌘C reaches a text field through Edit")
        XCTAssertEqual(item("v")?.action, #selector(NSText.paste(_:)), "⌘V reaches a text field through Edit")
        XCTAssertEqual(item("a")?.action, #selector(NSText.selectAll(_:)))
        XCTAssertNotNil(item("z"), "⌘Z undoes typing")
        XCTAssertEqual(item("1")?.title, "Needs You")
        XCTAssertEqual(item("2")?.title, "All Meetings")
        XCTAssertEqual(item("r")?.title, "Reload")
        XCTAssertEqual(bar.items.map(\.title), ["GenesisTools", "File", "Edit", "View", "Window"])
    }

    func testTheViewMenuMovesTheWindowsPlace() throws {
        let (defaults, suite) = try defaults()
        defer { defaults.removePersistentDomain(forName: suite) }
        let model = MeetingsWindowModel(defaults: defaults, loadDetail: { _ in })
        model.receive(try JSONDecoder().decode(MeetingsOverview.self, from: Self.overviewJSON()))
        MeetingsMenuTarget.shared.model = model
        defer { MeetingsMenuTarget.shared.model = nil }
        MeetingsMenuTarget.shared.showAll(nil)
        XCTAssertEqual(model.place, .all)
        MeetingsMenuTarget.shared.showNeeds(nil)
        XCTAssertEqual(model.place, .needs)
    }

    // MARK: MU2 nothing is cut off at the smallest size

    /// At the window's minimum size the detail column got about 438 pt and its header and tabs needed 464 or more:
    /// the split view drew it wider than the window, so Export, the last tab and the ends of lines were cut off.
    func testAtTheMinimumSizeTheDetailFitsTheWindow() throws {
        let (defaults, suite) = try defaults()
        defer { defaults.removePersistentDomain(forName: suite) }
        let model = MeetingsWindowModel(defaults: defaults, loadDetail: { _ in })
        model.receive(try JSONDecoder().decode(MeetingsOverview.self, from: Self.overviewJSON()))
        model.select("a")
        FrameProbe.enabled = true
        FrameProbe.reset()
        defer { FrameProbe.enabled = false; FrameProbe.reset() }

        let window = hiddenWindow(model, size: NSSize(width: 900, height: 560))
        defer { window.orderOut(nil); window.close() }
        RunLoop.main.run(until: Date().addingTimeInterval(0.6))

        let width = try XCTUnwrap(window.contentView).bounds.width
        XCTAssertEqual(MeetingsWindow.floored(NSSize(width: 600, height: 400)), MeetingsWindow.minimumSize,
                       "a live resize stops at the minimum")
        XCTAssertEqual(window.frame.width, MeetingsWindow.minimumSize.width, accuracy: 1, "the test runs at the window's own minimum")
        let header = try XCTUnwrap(FrameProbe.frames["meetings.detail.header"], "the detail's header is on screen")
        XCTAssertLessThanOrEqual(header.maxX, width + 1, "the header ends inside the window: \(header) in \(width) pt")
        let tabs = try XCTUnwrap(FrameProbe.frames["meetings.detail.tabs"])
        XCTAssertLessThanOrEqual(tabs.maxX, width + 1, "the last tab is inside the window: \(tabs) in \(width) pt")
    }

    // MARK: R15, R31 notices float over the pane, stack, and each keeps its Undo

    func testTwoDecisionsInARowKeepTwoUndoButtons() throws {
        let (defaults, suite) = try defaults()
        defer { defaults.removePersistentDomain(forName: suite) }
        let clock = ManualNoticeClock()
        let model = MeetingsWindowModel(defaults: defaults, noticeClock: clock, loadDetail: { _ in })
        model.receive(try JSONDecoder().decode(MeetingsOverview.self, from: Self.overviewJSON()))
        model.select("a")
        let detail = try XCTUnwrap(model.detail)
        let items = try JSONDecoder().decode([MeetingItem].self, from: Self.itemsJSON())

        detail.showDecided(items[0], confirm: true, token: "t-1")
        clock.advance(by: 10)
        detail.showDecided(items[3], confirm: false, token: "t-2")
        XCTAssertEqual(detail.notices.notices.map(\.text),
                       ["Confirmed \(MeetingsWords.itemTitle(items[0]))", "Rejected \(MeetingsWords.itemTitle(items[3]))"],
                       "the second decision adds a notice; it does not replace the first")
        XCTAssertEqual(detail.notices.notices.map { $0.actions.map(\.label) }, [["Undo"], ["Undo"]],
                       "each decision keeps its own Undo")

        clock.advance(by: 19.9)
        XCTAssertEqual(detail.notices.notices.count, 2, "a notice with Undo stays 30 s by default (R15)")
        clock.advance(by: 0.1)
        XCTAssertEqual(detail.notices.notices.map(\.text), ["Rejected \(MeetingsWords.itemTitle(items[3]))"],
                       "each notice leaves after its own time")
        detail.showDecided(items[0], confirm: true, token: nil)
        XCTAssertEqual(detail.notices.notices.last?.actions.count, 0, "no token, no Undo: it could take back a decision made elsewhere")
    }

    func testTheNoticeTimeIsAWindowSettingAndTheOldUndoTimeIsRemoved() throws {
        let (defaults, suite) = try defaults()
        defer { defaults.removePersistentDomain(forName: suite) }
        defaults.set(15, forKey: MeetingsPreferences.legacyUndoSecondsKey)
        let clock = ManualNoticeClock()
        let model = MeetingsWindowModel(defaults: defaults, noticeClock: clock, loadDetail: { _ in })
        XCTAssertNil(defaults.object(forKey: MeetingsPreferences.legacyUndoSecondsKey), "the replaced key is removed once")
        XCTAssertEqual(MeetingsPreferences.noticeSeconds(defaults), 30, "R15: about 30 s, longer than any old choice")
        XCTAssertEqual(MeetingsPreferences.plainNoticeSeconds(defaults), 6)
        XCTAssertEqual(MeetingsPreferences.noticePlace(defaults), .bottom)

        defaults.set(8, forKey: MeetingsPreferences.noticeSecondsKey)
        model.receive(try JSONDecoder().decode(MeetingsOverview.self, from: Self.overviewJSON()))
        model.select("a")
        let detail = try XCTUnwrap(model.detail)
        let items = try JSONDecoder().decode([MeetingItem].self, from: Self.itemsJSON())
        let id = detail.showDecided(items[0], confirm: true, token: "t-1")
        XCTAssertEqual(detail.notices.remaining(id), 8, "the setting decides how long the Undo stays")
    }

    /// The notice used to sit between the header and the tabs, so each answer pushed the rows down (R15). Now the
    /// pane's content keeps its frame and the stack floats inside it.
    func testNoticesFloatOverTheContentAndMoveNothing() throws {
        let (defaults, suite) = try defaults()
        defer { defaults.removePersistentDomain(forName: suite) }
        let model = MeetingsWindowModel(defaults: defaults, noticeClock: ManualNoticeClock(), loadDetail: { _ in })
        model.receive(try JSONDecoder().decode(MeetingsOverview.self, from: Self.overviewJSON()))
        model.select("a")
        let detail = try XCTUnwrap(model.detail)
        FrameProbe.enabled = true
        FrameProbe.reset()
        defer { FrameProbe.enabled = false; FrameProbe.reset() }

        let window = hiddenWindow(model, size: NSSize(width: 1100, height: 700))
        defer { window.orderOut(nil); window.close() }
        RunLoop.main.run(until: Date().addingTimeInterval(0.5))
        let before = try XCTUnwrap(FrameProbe.frames["meetings.detail.content"], "the pane's content is on screen")
        XCTAssertNil(FrameProbe.frames["notice-stack"], "no notices, no stack")

        let items = try JSONDecoder().decode([MeetingItem].self, from: Self.itemsJSON())
        detail.showDecided(items[0], confirm: true, token: "t-1")
        detail.showDecided(items[3], confirm: false, token: "t-2")
        RunLoop.main.run(until: Date().addingTimeInterval(0.5))

        let after = try XCTUnwrap(FrameProbe.frames["meetings.detail.content"])
        XCTAssertEqual(after, before, "two notices moved the content: \(before) → \(after)")
        let stack = try XCTUnwrap(FrameProbe.frames["notice-stack"], "the notices are on screen")
        XCTAssertTrue(before.insetBy(dx: -1, dy: -1).contains(stack), "the stack floats inside the content: \(stack) in \(before)")
        XCTAssertGreaterThan(stack.height, 40, "two notices, both drawn")
        XCTAssertEqual(stack.maxY, before.maxY - 8, accuracy: 2, "the stack sits at the content's bottom edge by default")
    }

    // MARK: MU4 confirm all at or above a line, with one Undo

    static func itemsJSON() -> Data {
        Data("""
        [{"id":"r1","kind":"speaker-range","status":"suggested","confidence":0.9,"fromSec":20,"toSec":30,"speaker":"Alice"},
         {"id":"r2","kind":"speaker-range","status":"suggested","confidence":0.95,"fromSec":40,"toSec":50},
         {"id":"t1","kind":"term","status":"suggested","confidence":0.9,"heard":"jason"},
         {"id":"t2","kind":"term","status":"suggested","confidence":0.85,"heard":"jason","proposed":"JSON"},
         {"id":"q1","kind":"question","status":"suggested","confidence":0.99,"question":"Which one?"},
         {"id":"l1","kind":"label","status":"suggested","confidence":0.6,"label":"Launch"},
         {"id":"n1","kind":"label","status":"suggested","label":"Retro"},
         {"id":"c1","kind":"label","status":"confirmed","confidence":0.99,"label":"Done"}]
        """.utf8)
    }

    func testConfirmAllPicksWhatTheCliDecidesAndLeavesTheRest() throws {
        let items = try JSONDecoder().decode([MeetingItem].self, from: Self.itemsJSON())
        XCTAssertEqual(MeetingDetailModel.confirmable(items, atOrAbove: 0.8).map(\.id), ["r1", "t2"],
                       "a range with no speaker, a term with no spelling and a question wait for the reader")
        XCTAssertEqual(MeetingDetailModel.confirmable(items, atOrAbove: 0.5).map(\.id), ["r1", "t2", "l1"])
        XCTAssertEqual(MeetingDetailModel.confirmable(items, atOrAbove: 0).map(\.id), ["r1", "t2", "l1", "n1"],
                       "any confidence takes an item with none, as the CLI does")
    }

    func testReturnConfirmsOnlyWhatAPlainConfirmCanApply() throws {
        let items = try JSONDecoder().decode([MeetingItem].self, from: Self.itemsJSON())
        let byID = Dictionary(uniqueKeysWithValues: items.map { ($0.id, $0) })
        XCTAssertFalse(ItemsTab.keyActs(on: try XCTUnwrap(byID["t1"]), confirm: true), "a term with no spelling waits for an answer by ear")
        XCTAssertTrue(ItemsTab.keyActs(on: try XCTUnwrap(byID["t1"]), confirm: false), "Delete still rejects it")
        XCTAssertFalse(ItemsTab.keyActs(on: try XCTUnwrap(byID["r2"]), confirm: true), "a range with no speaker waits for its menu")
        XCTAssertFalse(ItemsTab.keyActs(on: try XCTUnwrap(byID["q1"]), confirm: false), "a question is answered, not decided")
        XCTAssertFalse(ItemsTab.keyActs(on: try XCTUnwrap(byID["c1"]), confirm: true), "a decided item is reopened first")
        XCTAssertEqual(items.filter(\.canConfirm).map(\.id), ["r1", "t2", "l1", "n1"])
    }

    func testADecisionTheCliSkippedIsNotMarkedAndOffersNoUndo() {
        let skipped = DecideResult(decided: [], token: nil, skipped: [.init(id: "i7", reason: "it is confirmed already")])
        XCTAssertEqual(MeetingDetailModel.decideOutcome(skipped, item: "i7"), .skipped(reason: "it is confirmed already"))
        XCTAssertEqual(MeetingDetailModel.skipNote(title: "“jason” → “JSON”", confirm: true, reason: "it is confirmed already"),
                       "“jason” → “JSON” was not confirmed: it is confirmed already.")
        let decided = DecideResult(decided: ["i7"], token: "t-7", skipped: [])
        XCTAssertEqual(MeetingDetailModel.decideOutcome(decided, item: "i7"), .decided(undoToken: "t-7"))
        let tokenless = DecideResult(decided: ["i7"], token: nil, skipped: [])
        XCTAssertEqual(MeetingDetailModel.decideOutcome(tokenless, item: "i7"), .decided(undoToken: nil),
                       "with no token an Undo could take back a decision made elsewhere, so none is offered")
    }

    func testADecisionKeepsTheTranscriptOnScreenAndReadsItQuietly() {
        XCTAssertEqual(MeetingDetailModel.transcriptRefresh(read: true, showing: true), .readQuietly,
                       "the lines and the scroll place stay until the new answer lands")
        XCTAssertEqual(MeetingDetailModel.transcriptRefresh(read: true, showing: false), .markStale,
                       "a hidden tab keeps its lines and reads quietly when it shows again")
        XCTAssertEqual(MeetingDetailModel.transcriptRefresh(read: false, showing: false), .none, "never read: its first show reads it")
    }

    func testABulkConfirmSaysHowManyAndWhatWaits() {
        let both = DecideResult(decided: ["r1", "t2"], token: "tok", skipped: [.init(id: "r2", reason: "it has no speaker yet.")])
        XCTAssertEqual(MeetingDetailModel.bulkNote(both, threshold: 0.8), "Confirmed 2 items at 80 % or more; 1 item still waits for you")
        let none = DecideResult(decided: [], token: nil, skipped: [])
        XCTAssertEqual(MeetingDetailModel.bulkNote(none, threshold: 0), "Nothing to confirm")
        XCTAssertEqual(MeetingDetailModel.reopenArgs(meeting: "a", items: ["r1", "t2"], token: "tok"),
                       ["reopen", "a", "r1", "t2", "--token", "tok"], "one Undo gives back every item the confirm took")
    }

    // MARK: MU1 a meeting with no transcript source

    func testAScreenOnlyMeetingOpensOnItsScreenAndOffersIt() throws {
        let (defaults, suite) = try defaults()
        defer { defaults.removePersistentDomain(forName: suite) }
        let model = MeetingsWindowModel(defaults: defaults, loadDetail: { _ in })
        model.receive(try JSONDecoder().decode(MeetingsOverview.self, from: Self.overviewJSON()))
        model.select("b")
        let detail = try XCTUnwrap(model.detail)
        XCTAssertEqual(detail.tab, .screen, "the transcript, speakers and items all need a source with audio")
        let empty = detail.noTranscriptSource("transcript")
        XCTAssertNotNil(empty.showScreen, "the empty state offers the screen recording")
        empty.showScreen?()
        XCTAssertEqual(detail.tab, .screen)
        XCTAssertEqual(NoTranscriptSource.code, "no-transcript-source", "the CLI's code (src/meetings README)")

        model.select("a")
        XCTAssertEqual(model.detail?.tab, .transcript)
    }

    // MARK: Minor findings

    func testTheOpenMeetingHasItsRowInNeedsYou() throws {
        let needs = try JSONDecoder().decode(MeetingsOverview.self, from: Self.overviewJSON()).needsYou
        XCTAssertEqual(needs.row(for: "a"), "q:a", "a meeting opened by its id selects its first row (MU6)")
        XCTAssertEqual(needs.row(for: "s:a"), "q:a", "a meeting has one row, so its suggestions lead to that row")
        XCTAssertEqual(needs.row(for: "b"), "b")
        XCTAssertNil(needs.row(for: "c"), "a meeting outside Needs you has no row, and the list says so")
    }

    func testNeedsYouListsAMeetingOnceWithAllItWaitsFor() throws {
        let needs = try JSONDecoder().decode(MeetingsOverview.self, from: Self.overviewJSON()).needsYou
        XCTAssertEqual(needs.groups.map(\.title), ["Without a project", "Questions to answer"],
                       "the meeting with questions and suggestions stands once, so no group is left for its suggestions")
        XCTAssertEqual(needs.groups.flatMap(\.rows).count, needs.total, "the list has as many rows as the sidebar counts")
        let both = try XCTUnwrap(needs.groups.last?.rows.first)
        XCTAssertEqual(both.reason(applyAbove: 0.5), "2 questions · 3 suggestions at 50 % or more")
        typealias Row = MeetingsOverview.NeedsYou.Row
        XCTAssertEqual(Row(id: "x", noProject: false, questions: 1, suggestions: 0).reason(applyAbove: 0.5), "1 question to answer by ear")
        XCTAssertEqual(Row(id: "x", noProject: false, questions: 0, suggestions: 3).reason(applyAbove: 0.5), "3 suggestions at 50 % or more")
        XCTAssertEqual(Row(id: "x", noProject: true, questions: 2, suggestions: 3).reason(applyAbove: 0.5),
                       "Choose its project · 2 questions · 3 suggestions")
        XCTAssertEqual(Row(id: "x", noProject: true, questions: 0, suggestions: 0).tag, "x", "a bare id opens the meeting's first tab")
        XCTAssertEqual(Row(id: "x", noProject: true, questions: 0, suggestions: 3).tag, "s:x", "suggestions open Items")
    }

    func testARangeReadsFromAndToWithNoDash() throws {
        let items = try JSONDecoder().decode([MeetingItem].self, from: Data("""
        [{"id":"r1","kind":"speaker-range","status":"suggested","fromSec":20,"toSec":30,"label":"Speaker 1","speaker":"Alice"},
         {"id":"r2","kind":"speaker-range","status":"suggested","fromSec":20.2,"toSec":20.8,"label":"Speaker 1"}]
        """.utf8))
        XCTAssertEqual(MeetingsWords.itemTitle(items[0]), "Speaker 1 from 00:20 to 00:30 is Alice", "MU17")
        XCTAssertEqual(MeetingsWords.itemTitle(items[1]), "Speaker 1 at 00:20 is someone else")
    }

    func testTheMeetingLanguageReadsAsItsName() {
        XCTAssertEqual(MeetingsLanguage.name("cs"), "Czech", "MU14")
        XCTAssertEqual(MeetingsLanguage.name("en"), "English")
    }

    func testASpeakerShowsItsSpanWordsAndHints() throws {
        let stats = try JSONDecoder().decode(SpeakerStats.self, from: Data("""
        {"speakers":[{"label":"Speaker 1","turns":7,"lines":7,"words":120,"spokenSec":40,"firstSec":12,"lastSec":1540},
                     {"label":"Speaker 2","turns":427,"lines":430,"spokenSec":900}],
         "hints":[{"kind":"several-people","label":"Speaker 2","share":0.4,"strength":"weak"},
                  {"kind":"label-drift","label":"Speaker 2"}]}
        """.utf8))
        XCTAssertEqual(MeetingsWords.speakerSpan(stats.speakers[0]), "00:12 to 25:40", "MU8")
        XCTAssertNil(MeetingsWords.speakerSpan(stats.speakers[1]))
        let line = MeetingsWords.factsLine(["1 h 02 min spoken", "00:03 to 2:25:58"])
        XCTAssertEqual(line.components(separatedBy: " "), ["1\u{00A0}h\u{00A0}02\u{00A0}min\u{00A0}spoken", "·", "00:03\u{00A0}to\u{00A0}2:25:58"],
                       "the line may break only around the dot between two facts")
        XCTAssertEqual(MeetingsWords.speakerHints(stats.hints ?? [], for: "Speaker 2"),
                       ["May hold several people (weak evidence)", "Silent while in the call, so the voice is under other labels"])
        XCTAssertEqual(MeetingsWords.speakerHints(stats.hints ?? [], for: "Speaker 1"), [])
    }

    func testContextTakesLinksAndNotesAndARemoveCanBeUndone() throws {
        XCTAssertEqual(MeetingDetailModel.contextAddArgs(meeting: "a", .link("https://example.com/spec"), title: "Spec"),
                       ["context", "add", "a", "https://example.com/spec", "--title", "Spec"], "MU12")
        XCTAssertEqual(MeetingDetailModel.contextAddArgs(meeting: "a", .note("Budget is fixed"), title: nil),
                       ["context", "add", "a", "--note", "Budget is fixed"])
        let refs = try JSONDecoder().decode([MeetingContextRef].self, from: Data("""
        [{"id":"c1","kind":"note","ref":"Budget is fixed","title":"Budget","addedAt":"2026-11-05T12:00:00.000Z"},
         {"id":"c2","kind":"file","ref":"/tmp/spec.md","note":"the second part","addedAt":"2026-11-05T12:00:00.000Z"}]
        """.utf8))
        XCTAssertEqual(MeetingDetailModel.readdArgs(meeting: "a", refs[0]), ["context", "add", "a", "--note", "Budget is fixed", "--title", "Budget"])
        XCTAssertEqual(MeetingDetailModel.readdArgs(meeting: "a", refs[1]), ["context", "add", "a", "/tmp/spec.md", "--note", "the second part"])
    }

    func testARecordKnowsWhyItsRecordingStopped() throws {
        let recording = try JSONDecoder().decode(MeetingRecordView.Recording.self, from: Data("""
        {"frames":120,"status":"stopped","stopReason":"failed"}
        """.utf8))
        XCTAssertEqual(recording.stopReason, "failed", "MU19: the header shows Recording failed")
    }

    func testAScreenOnlyMeetingOpenedBeforeItsListMovesToScreenWhenTheListLands() throws {
        let (defaults, suite) = try defaults()
        defer { defaults.removePersistentDomain(forName: suite) }
        let model = MeetingsWindowModel(defaults: defaults, loadDetail: { _ in })
        model.select("b")
        XCTAssertEqual(model.detail?.tab, .transcript, "no list row yet")
        model.receive(try JSONDecoder().decode(MeetingsOverview.self, from: Self.overviewJSON()))
        model.detail?.listLanded(model.meeting("b"))
        XCTAssertEqual(model.detail?.tab, .screen, "the row says it has only a screen recording")

        let asked = MeetingsWindowModel(defaults: defaults, loadDetail: { _ in })
        asked.select("b", tab: .transcript)
        asked.receive(try JSONDecoder().decode(MeetingsOverview.self, from: Self.overviewJSON()))
        asked.detail?.listLanded(asked.meeting("b"))
        XCTAssertEqual(asked.detail?.tab, .transcript, "a tab a request named stays")
    }

    func testOneHomeGivesOneNotificationNameHoweverItIsSpelled() throws {
        let base = NativePreview.namespace + ".meetings"
        XCTAssertEqual(meetingsNotificationPrefix(home: "/Users/alice/", realHome: "/Users/alice"), base, "a trailing slash is the real home")
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent("meetings-home-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        let link = FileManager.default.temporaryDirectory.appendingPathComponent("meetings-link-\(UUID().uuidString)")
        try FileManager.default.createSymbolicLink(at: link, withDestinationURL: folder)
        defer {
            try? FileManager.default.removeItem(at: link)
            try? FileManager.default.removeItem(at: folder)
        }
        XCTAssertEqual(meetingsNotificationPrefix(home: link.path, realHome: "/Users/alice"),
                       meetingsNotificationPrefix(home: folder.path + "/", realHome: "/Users/alice"), "a symlink names its folder")
        XCTAssertEqual(meetingsNotificationPrefix(home: link.path, realHome: folder.path), base)
        XCTAssertNotEqual(meetingsNotificationPrefix(home: "/tmp/one", realHome: "/Users/alice"),
                          meetingsNotificationPrefix(home: "/tmp/two", realHome: "/Users/alice"), "distinct homes stay apart")
    }

    private func dictionaryDraft(_ value: String, _ substitution: String = "Kubernetes", scope: String? = nil) -> DictionaryFormDraft {
        DictionaryFormDraft(type: "fix", value: value, substitution: substitution, meaning: "", spoken: [],
                            caseSensitive: false, scope: scope)
    }

    private func entry(_ value: String, _ substitution: String = "Kubernetes", level: String? = nil) -> DictionaryEntry {
        DictionaryEntry(type: "fix", value: value, substitution: substitution, spoken: nil, meaning: nil, caseSensitive: nil,
                        level: level)
    }

    func testDictionaryFormForgetsAValueThatNeverLanded() {
        var pending = SentDraft<DictionaryFormDraft>()
        let sent = dictionaryDraft("kubernetis")
        func holds(_ entries: [DictionaryEntry]) -> (DictionaryFormDraft) -> Bool {
            { draft in entries.contains(where: draft.isSaved(as:)) }
        }

        pending.send(sent)
        XCTAssertFalse(pending.clears(form: sent, saved: holds([entry("kubernetis", "Kubernetis")])),
                       "an older entry with the same value is not the saved one")
        XCTAssertTrue(pending.clears(form: sent, saved: holds([entry("kubernetis")])), "the entry arrived: the form clears once")
        XCTAssertFalse(pending.clears(form: sent, saved: holds([entry("kubernetis")])))

        pending.send(sent)
        XCTAssertFalse(pending.clears(form: dictionaryDraft("kafka"), saved: holds([entry("kubernetis")])),
                       "the next entry typed while the save ran stays in the form")
        XCTAssertFalse(pending.clears(form: sent, saved: holds([entry("kubernetis")])), "and the send is forgotten")

        pending.send(sent)
        XCTAssertFalse(pending.clears(form: dictionaryDraft("kubernetis", "Kubernetes cluster"), saved: holds([entry("kubernetis")])),
                       "a substitution edited while the save ran stays too")

        pending.send(dictionaryDraft("kubernetis", scope: "work"))
        XCTAssertFalse(pending.clears(form: dictionaryDraft("kubernetis", scope: "work"),
                                      saved: holds([entry("kubernetis", level: "global")])), "a global entry is not the project's")
        XCTAssertTrue(pending.clears(form: dictionaryDraft("kubernetis", scope: "work"),
                                     saved: holds([entry("kubernetis", level: "project work")])))

        pending.send(sent)
        pending.reset()
        XCTAssertFalse(pending.clears(form: sent, saved: holds([entry("kubernetis")])), "Cancel or a new edit drops it")
    }

    /// The label field and the context composer stay editable while their add runs: the answer clears only what it sent.
    func testAnAddAnswerClearsOnlyTheDraftItSent() {
        var label = SentDraft<String>()
        label.send("review")
        XCTAssertFalse(label.clears(form: "demo", saved: { ["review"].contains($0) }), "label B typed while A was added stays")
        XCTAssertNil(label.sent)

        var context = SentDraft<[String]>()
        let first = ["note A", ""], second = ["note B", ""]
        context.send(first)
        context.send(second)
        XCTAssertFalse(context.clears(form: second, saved: { $0 == first }), "A's answer leaves B, sent after it, in the composer")
        XCTAssertTrue(context.clears(form: second, saved: { $0 == second }), "B's own answer clears it")
    }

    func testAPreviewSendsNoDraftOfAProjectRenamedOrRemovedSince() {
        let saved = MatchRulesDraft(folders: [], calendars: [], titleWords: [])
        let edited = MatchRulesDraft(folders: ["Work"], calendars: [], titleWords: [])
        let drafts = ["wrok": edited, "work": edited, "side": saved]
        let sent = MeetingsSettingsModel.previewDrafts(drafts, exists: { $0 != "wrok" }, saved: { _ in saved })
        XCTAssertEqual(sent, ["work": edited], "a renamed project's draft stays in the model, not in the preview; an unchanged one is not sent")
    }

    func testALabelTheMeetingHasClosesThePopoverInsteadOfWaiting() {
        XCTAssertEqual(LabelCommit(typed: "  ", labels: []), .nothing)
        XCTAssertEqual(LabelCommit(typed: " demo ", labels: ["demo"]), .present)
        XCTAssertEqual(LabelCommit(typed: "review", labels: ["demo"]), .add("review"))
    }

    func testSpeakersFollowTheChosenOrderMostSpokenFirstByDefault() throws {
        let stats = try JSONDecoder().decode(SpeakerStats.self, from: Data(#"""
        {"speakers":[{"label":"A","turns":7,"lines":7,"spokenSec":20},{"label":"B","turns":427,"lines":430,"spokenSec":900}]}
        """#.utf8))
        let defaults = try XCTUnwrap(UserDefaults(suiteName: "meetings-speaker-order-\(UUID().uuidString)"))
        XCTAssertEqual(MeetingsPreferences.speakerOrder(defaults), .spoken)
        XCTAssertEqual(MeetingsPreferences.SpeakerOrder.spoken.ordered(stats.speakers).map(\.label), ["B", "A"])
        XCTAssertEqual(MeetingsPreferences.SpeakerOrder.transcript.ordered(stats.speakers).map(\.label), ["A", "B"])
        defaults.set("transcript", forKey: MeetingsPreferences.speakerOrderKey)
        XCTAssertEqual(MeetingsPreferences.speakerOrder(defaults), .transcript)
    }

    func testANoticePlaceChangedInSettingsMovesTheOpenPanesStack() throws {
        let (defaults, suite) = try defaults()
        defer { defaults.removePersistentDomain(forName: suite) }
        let model = MeetingsWindowModel(defaults: defaults, loadDetail: { _ in })
        XCTAssertEqual(model.noticePlace, .bottom)

        var redraws = 0
        // lint-rules-ignore: one shot on purpose, the test counts the first change only
        withObservationTracking { _ = model.noticePlace } onChange: { redraws += 1 }
        defaults.set(MeetingsPreferences.NoticePlace.top.rawValue, forKey: MeetingsPreferences.noticePlaceKey)
        model.windowSettingsChanged()
        XCTAssertEqual(model.noticePlace, .top)
        XCTAssertEqual(redraws, 1, "a view that reads the place draws again")

        // lint-rules-ignore: one shot on purpose, the test checks that no change arrives
        withObservationTracking { _ = model.noticePlace } onChange: { redraws += 1 }
        model.windowSettingsChanged()
        XCTAssertEqual(redraws, 1, "an unchanged place draws nothing again")
    }

    func testAPhraseTestFailureNoticeGoesWhenALaterTestWorksOrThePhraseIsEmptied() async throws {
        let notices = NoticeStackModel(clock: ManualNoticeClock(), announces: false)
        var fails = true
        let model = MeetingsSettingsModel(writes: false, notices: notices, command: { args in
            let phrase = args[2]
            if fails { throw MeetingsCLI.Failure(sentence: "The dictionary test failed.", detail: phrase) }
            return Data("""
            {"phrase":"\(phrase)","text":"\(phrase)","fired":[],"suggestions":[]}
            """.utf8)
        })

        model.testPhrase("ship it")
        for _ in 0..<100 where notices.notices.isEmpty { try await Task.sleep(nanoseconds: 20_000_000) }
        XCTAssertEqual(notices.notices.map(\.text), ["The dictionary test failed."])

        fails = false
        model.testPhrase("ship it now")
        for _ in 0..<100 where model.phraseResult == nil { try await Task.sleep(nanoseconds: 20_000_000) }
        XCTAssertEqual(model.phraseResult?.phrase, "ship it now")
        XCTAssertTrue(notices.notices.isEmpty, "a test that worked takes the failure away")

        fails = true
        model.testPhrase("again")
        for _ in 0..<100 where notices.notices.isEmpty { try await Task.sleep(nanoseconds: 20_000_000) }
        XCTAssertEqual(notices.notices.count, 1)
        model.testPhrase("  ")
        XCTAssertTrue(notices.notices.isEmpty, "an emptied phrase takes the failure away at once")
        XCTAssertNil(model.phraseResult)
    }

    func testASandboxWindowNeverFollowsTheRealWindowsRequests() {
        let real = meetingsNotificationPrefix(home: "/Users/alice", realHome: "/Users/alice")
        let sandbox = meetingsNotificationPrefix(home: "/tmp/sandbox", realHome: "/Users/alice")
        XCTAssertEqual(real, NativePreview.namespace + ".meetings", "the real home keeps the name older builds listen to")
        XCTAssertNotEqual(sandbox, real, "a sandbox window listens to its own requests only")
        XCTAssertEqual(meetingsNotificationPrefix(home: "/tmp/sandbox", realHome: "/Users/alice"), sandbox, "one home, one name")
    }

    func testAProjectRenamesAndRemovesWithItsMeetingsInMind() throws {
        XCTAssertEqual(MeetingsSettingsModel.renameArgs("wrok", to: "work"), ["projects", "rename", "wrok", "work"], "MU11")
        XCTAssertEqual(MeetingsSettingsModel.removeArgs("wrok", unassign: false), ["projects", "remove", "wrok", "--json"])
        XCTAssertEqual(MeetingsSettingsModel.removeArgs("wrok", unassign: true), ["projects", "remove", "wrok", "--json", "--unassign"])
        let refused = MeetingsCLI.Failure(sentence: "2 meetings have the project wrok: a, b.", detail: "",
                                          code: MeetingsCLI.code(fromStderr: "✗ [project-in-use] 2 meetings have the project wrok: a, b."))
        XCTAssertTrue(MeetingsSettingsModel.offersUnassign(refused), "the note then offers the removal that unassigns")
        XCTAssertFalse(MeetingsSettingsModel.offersUnassign(MeetingsCLI.Failure(sentence: "remove it with --unassign", detail: "")),
                       "the words alone decide nothing: a reworded refusal keeps the action through its code")
        XCTAssertFalse(MeetingsSettingsModel.offersUnassign(MeetingsCLI.Failure(sentence: "No project wrok. The known ones: work", detail: "")))
        let removal = try JSONDecoder().decode(ProjectRemoval.self, from: Data(#"{"name":"wrok","unassigned":["a","b"],"backup":"/tmp/b.json"}"#.utf8))
        XCTAssertEqual(MeetingsSettingsModel.removalNote(removal), "Removed the project wrok; 2 meetings now have no project")
    }

    // MARK: Round 2

    /// Hosts a view at a width in an off-screen window and returns the frame a probe recorded.
    private func probe(_ name: String, width: CGFloat, _ view: some View) throws -> CGRect {
        FrameProbe.enabled = true
        FrameProbe.reset()
        defer { FrameProbe.enabled = false; FrameProbe.reset() }
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: width, height: 300), styleMask: [.borderless],
                              backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.alphaValue = 0
        window.ignoresMouseEvents = true
        window.level = .init(rawValue: Int(CGWindowLevelForKey(.desktopWindow)) - 1)
        window.contentView = NSHostingView(rootView: view.frame(width: width, alignment: .leading).frame(maxHeight: .infinity, alignment: .top))
        window.orderFrontRegardless()
        defer { window.orderOut(nil); window.close() }
        RunLoop.main.run(until: Date().addingTimeInterval(0.4))
        return try XCTUnwrap(FrameProbe.frames[name], "\(name) is on screen")
    }

    func testFourDisplaysFitANarrowScreenTab() throws {
        // A probe written in the test body is built here, so probing is on before the view is.
        FrameProbe.enabled = true
        let displays = [(1, "MSI G27CQ4"), (2, "BenQ EX3501R"), (3, "Built-in Retina Display")]
        let segments = try probe("old", width: 400, GenSegmentedTabs("Display", items: [GenSegmentedTabs.Item(-1, "All displays")]
            + displays.map { GenSegmentedTabs.Item($0.0, $0.1) }, selection: .constant(-1), minSegmentWidth: 70).frameProbe("old"))
        XCTAssertGreaterThan(segments.width, 401, "the cause: four displays as segments are wider than the column")
        let picker = try probe("meetings.screen.display", width: 400, DisplayPicker(displays: displays, selection: .constant(-1)))
        XCTAssertLessThanOrEqual(picker.width, 401, "R2-MU4: the picker fits the column: \(picker)")
    }

    /// The questions' row and the ruler's row had a wider lane than the speakers' rows (a width set on an empty
    /// name or share is a width on nothing), so no banner and no clock time stood over the second it names.
    func testTheQuestionsAndTheRulerShareTheSpeakersLane() throws {
        let speakers = try JSONDecoder().decode([MeetingsAPI.MeetingSpeakers.Speaker].self, from: Data("""
        [{"label":"Alice","origin":"call","turns":2,"lines":2,"words":40,"spokenSec":600,"firstSec":0,"lastSec":3600,
          "spans":[{"fromSec":0,"toSec":300,"turns":1},{"fromSec":3300,"toSec":3600,"turns":1}]}]
        """.utf8))
        for width in [900.0, 440.0] {
            let lanes = SpeakerTalkTimeLanes(speakers: speakers, durationSec: 3600, timed: true,
                                             questions: [TalkTimeQuestion(id: "i1", atSec: 1800, label: "Q1")],
                                             playSpan: { _, _ in }, zoom: { _, _ in })
            let lane = try probe("meetings.lanes.lane", width: width, lanes)
            let banners = try probe("meetings.lanes.banners", width: width, lanes)
            let ruler = try probe("meetings.lanes.ruler", width: width, lanes)
            XCTAssertGreaterThan(lane.width, 100, "the lane has room at \(width) pt: \(lane)")
            XCTAssertEqual(banners.minX, lane.minX, accuracy: 0.5, "the banners start where the lane starts at \(width) pt")
            XCTAssertEqual(banners.width, lane.width, accuracy: 0.5, "and end where it ends: \(banners) against \(lane)")
            XCTAssertEqual(ruler.minX, lane.minX, accuracy: 0.5, "the ruler starts where the lane starts at \(width) pt")
            XCTAssertEqual(ruler.width, lane.width, accuracy: 0.5, "and ends where it ends: \(ruler) against \(lane)")
        }
    }

    func testAStretchOfOneSecondNamesOneTime() {
        XCTAssertEqual(HintChip(fromSec: 7632, toSec: 7632.4, lines: 1, action: .play, present: []).rangeText, "2:07:12",
                       "2:07:12 to 2:07:12 read as a mistake")
        XCTAssertEqual(HintChip(fromSec: 724, toSec: 751, lines: 3, action: .play, present: []).rangeText, "12:04 to 12:31")
    }

    /// Two people who take turns: the lanes draw the turns. From the spans (turns up to two minutes apart joined)
    /// each drew as one bar over the whole meeting.
    func testALaneDrawsTheTurnsNotTheJoinedSpans() throws {
        let speaker = try JSONDecoder().decode(MeetingsAPI.MeetingSpeakers.Speaker.self, from: Data("""
        {"label":"Alice","origin":"call","turns":3,"lines":3,"words":30,"spokenSec":12,"firstSec":0,"lastSec":40,
         "spans":[{"fromSec":0,"toSec":42,"turns":3}],
         "talk":[{"fromSec":0,"toSec":5,"turns":1},{"fromSec":26,"toSec":31,"turns":1},{"fromSec":40,"toSec":42,"turns":1}]}
        """.utf8))
        XCTAssertEqual(speaker.talkSpans.count, 3)
        let blocks = TalkTimeLayout.blocks(speaker.talkSpans, durationSec: 43, width: 430)
        XCTAssertEqual(blocks.map(\.x), [0, 260, 400], "three blocks where the label talks, with the pauses between them")
        XCTAssertEqual(TalkTimeLayout.blocks(speaker.spans, durationSec: 43, width: 430).count, 1, "the cause: one span over the meeting")
        let old = try JSONDecoder().decode(MeetingsAPI.MeetingSpeakers.Speaker.self, from: Data("""
        {"label":"Bob","origin":"call","turns":1,"lines":1,"words":3,"spokenSec":2,"spans":[{"fromSec":0,"toSec":2,"turns":1}]}
        """.utf8))
        XCTAssertEqual(old.talkSpans, old.spans, "a service that does not send the turns still draws its spans")
    }

    func testAJoinedBlockDrawsItsTurnTicksApart() {
        let dense = TalkTimeBlock(fromSec: 0, toSec: 100, x: 10, width: 40, spans: 9, ticks: [11, 12, 14, 17, 20, 24, 30, 44, 48])
        XCTAssertEqual(TalkTimeLayout.shownTicks(dense), [17, 24, 30, 44],
                       "a tick every point or two read as a barcode: ticks keep 6 pt from each other and from the block's ends")
        let few = TalkTimeBlock(fromSec: 0, toSec: 100, x: 0, width: 100, spans: 3, ticks: [30, 60])
        XCTAssertEqual(TalkTimeLayout.shownTicks(few), [30, 60])
    }

    func testAProjectListsOnlyTheRulesItHas() {
        XCTAssertTrue(ProjectSummary.rules(folders: [], calendars: [], words: [], labels: []).isEmpty,
                      "four lines that each said none told nothing: a project without a rule says so in one sentence")
        let rules = ProjectSummary.rules(folders: [], calendars: ["Work"], words: [], labels: ["design", "ops"])
        XCTAssertEqual(rules.map(\.title), ["Calendars", "Labels"])
        XCTAssertEqual(rules.map(\.values), [["Work"], ["design", "ops"]])
    }

    /// "No rule finds this project's meetings yet" only when nothing does: paired people propose the project, labels
    /// find nothing.
    func testAProjectWithPairedPeopleIsFoundAndOneWithOnlyLabelsIsNot() {
        let none = ProjectSummary.rules(folders: [], calendars: [], words: [], labels: [])
        let labels = ProjectSummary.rules(folders: [], calendars: [], words: [], labels: ["design"])
        let words = ProjectSummary.rules(folders: [], calendars: [], words: ["Standup"], labels: [])
        XCTAssertFalse(ProjectSummary.findsMeetings(none, pairedPeople: 0))
        XCTAssertTrue(ProjectSummary.findsMeetings(none, pairedPeople: 2), "paired people alone said no rule finds it")
        XCTAssertFalse(ProjectSummary.findsMeetings(labels, pairedPeople: 0), "a label is not a rule that finds a meeting")
        XCTAssertTrue(ProjectSummary.findsMeetings(words, pairedPeople: 0))
    }

    func testANarrowSpeakerRowKeepsItsNumbersReadable() throws {
        let speaker = try JSONDecoder().decode(SpeakerStat.self, from: Data("""
        {"label":"Speaker 2","turns":42,"lines":42,"words":3779,"spokenSec":1440,"firstSec":375,"lastSec":3152}
        """.utf8))
        let beside = try probe("meetings.speaker.labels", width: 330, SpeakerRow(speaker: speaker, rename: nil, stacked: false, hints: [],
                                                                          play: {}, commit: { _ in }))
        XCTAssertLessThan(beside.width, 100, "the cause: beside the field and Play the numbers get almost nothing")
        let stacked = try probe("meetings.speaker.labels", width: 330, SpeakerRow(speaker: speaker, rename: nil, stacked: true, hints: [],
                                                                           play: {}, commit: { _ in }))
        XCTAssertGreaterThan(stacked.width, 280, "R2-MU1: stacked, the numbers have the row's width: \(stacked)")
    }

    func testANarrowFrameRowKeepsItsTextReadable() throws {
        let frame = try JSONDecoder().decode(TimelineFrame.self, from: Data("""
        {"file":"f1.png","path":"/tmp/none/f1.png","at":"2026-11-05T12:00:00.000Z","meetingSec":1609,"displayId":2,
         "width":1920,"height":1080,"lineCount":2,"lines":null,
         "changed":[{"x":0,"y":0,"width":100,"height":20,"text":"Invented changed line","confidence":0.9}]}
        """.utf8))
        let beside = try probe("meetings.frame.text", width: 330, FrameRow(frame: frame, displayName: "Display 2", showAll: false,
                                                                           stacked: false, open: {}))
        XCTAssertLessThan(beside.width, 100, "the cause: beside a 220 pt thumbnail the text gets almost nothing")
        let stacked = try probe("meetings.frame.text", width: 330, FrameRow(frame: frame, displayName: "Display 2", showAll: false,
                                                                            stacked: true, open: {}))
        XCTAssertGreaterThan(stacked.width, 280, "R2-MU5: stacked, the time and the lines have the row's width: \(stacked)")
    }

    func testEverySpeakerHintKindReadsAsASentence() throws {
        let hints = try JSONDecoder().decode([SpeakerHint].self, from: Data("""
        [{"kind":"label-drift","label":"Alice","strength":"weak","person":"Alice","fromSec":375,"toSec":1800},
         {"kind":"absent-speaker","label":"Bob","strength":"strong","ranges":[{"fromSec":10,"toSec":20,"lines":2},
          {"fromSec":30,"toSec":40,"lines":1}]},
         {"kind":"sole-attendee","label":"Speaker 1","strength":"strong","person":"Alice","self":true,
          "ranges":[{"fromSec":0,"toSec":60,"lines":12}]},
         {"kind":"sole-attendee","label":"Speaker 2","strength":"normal","person":"Bob","self":false,
          "ranges":[{"fromSec":0,"toSec":60,"lines":1}]},
         {"kind":"leave-then-continues","label":"Carol","strength":"normal","leaves":[{"atSec":100,"text":"bye","continuesAtSec":110},
          {"atSec":200,"text":"bye","continuesAtSec":210}]},
         {"kind":"split-voice","label":"Speaker 3","strength":"weak","neighbour":"Speaker 4","turns":1,"spokenSec":4},
         {"kind":"several-people","label":"Speaker 5","strength":"normal","spans":3,"share":0.4},
         {"kind":"a-future-kind","label":"Dan"}]
        """.utf8))
        func words(_ label: String) -> [String] { MeetingsWords.speakerHints(hints, for: label) }
        XCTAssertEqual(words("Alice"), ["Silent from 06:15 to 30:00 while in the call, so the voice is under other labels (weak evidence)"],
                       "R2-MU7: label-drift is the person's own label staying silent, not a switch partway")
        XCTAssertEqual(words("Bob"), ["Speaks while not in the call, so 3 lines are someone else (strong evidence)"])
        XCTAssertEqual(words("Speaker 1"), ["Only you were in the call, so its 12 lines are you (strong evidence)"])
        XCTAssertEqual(words("Speaker 2"), ["Only Bob was in the call, so its 1 line is Bob"])
        XCTAssertEqual(words("Carol"), ["Says goodbye and speaks again 2 times, so another voice may follow"])
        XCTAssertEqual(words("Speaker 3"), ["One turn next to Speaker 4, maybe one voice split in two (weak evidence)"])
        XCTAssertEqual(words("Speaker 5"), ["May hold several people"])
        XCTAssertEqual(words("Dan"), ["A future kind"], "a kind this build does not know still shows its name")

        // Each line carries the stretches its chips play or show; a silence's times are a chip, not plain text.
        XCTAssertEqual(MeetingsWords.speakerHintLines(hints, for: "Alice").map(\.ranges),
                       [[SpeakerHint.Range(lines: 0, fromSec: 375, toSec: 1800)]])
        XCTAssertEqual(MeetingsWords.speakerHintLines(hints, for: "Bob")[0].ranges.count, 2)
        XCTAssertEqual(MeetingsWords.speakerHintLines(hints, for: "Carol")[0].ranges, [])
    }

    func testSeveralSilencesOfOneLabelAreOneLineWithAChipEach() throws {
        let hints = try JSONDecoder().decode([SpeakerHint].self, from: Data("""
        [{"kind":"label-drift","label":"Alice","strength":"normal","fromSec":74,"toSec":3128},
         {"kind":"several-people","label":"Alice","strength":"weak"},
         {"kind":"label-drift","label":"Alice","strength":"weak","fromSec":3167,"toSec":4561},
         {"kind":"label-drift","label":"Alice","strength":"normal","fromSec":4594,"toSec":8769},
         {"kind":"label-drift","label":"Bob","strength":"normal","fromSec":10,"toSec":20}]
        """.utf8))
        let lines = MeetingsWords.speakerHintLines(hints, for: "Alice")
        XCTAssertEqual(lines.map(\.text), ["Silent 3 times while in the call, so the voice is under other labels",
                                           "May hold several people (weak evidence)"],
                       "three sentences with the same words were a wall of text; the line takes the strongest of their signs")
        XCTAssertEqual(lines.map(\.sentence), ["Silent 3 times while in the call, so the voice is under other labels", "May hold several people"],
                       "the weight is not part of the sentence: it draws after it, quieter")
        XCTAssertEqual(lines.map(\.isWeak), [false, true], "a weak sign draws as a note, so a stronger one stands out")
        XCTAssertEqual(lines.map(\.symbol), ["exclamationmark.triangle", "info.circle"])
        XCTAssertEqual(SpeakerHintLine(sentence: "Speaks while not in the call", strength: "strong", ranges: []).symbol,
                       "exclamationmark.triangle.fill")
        let mixed = try JSONDecoder().decode([SpeakerHint].self, from: Data("""
        [{"kind":"leave-then-continues","label":"Alice","strength":"weak","leaves":[{"atSec":10}]},
         {"kind":"several-people","label":"Alice","strength":"normal"},
         {"kind":"absent-speaker","label":"Alice","strength":"strong","ranges":[{"lines":2,"fromSec":5,"toSec":9}]}]
        """.utf8))
        XCTAssertEqual(MeetingsWords.speakerHintLines(mixed, for: "Alice").map(\.strength), ["strong", "normal", "weak"],
                       "the strongest sign stands first; a weak note stood above the warning it sat with")
        XCTAssertEqual(lines[0].ranges.map(\.fromSec), [74, 3167, 4594])
        XCTAssertEqual(HintChip.chips(for: lines[0].ranges).chips.map(\.action), [.show, .show, .show], "a long silence zooms the timeline")
        XCTAssertEqual(MeetingsWords.speakerHintLines(hints, for: "Bob").map(\.text),
                       ["Silent from 00:10 to 00:20 while in the call, so the voice is under other labels"])
    }

    func testATitledNoteShowsItsText() throws {
        let refs = try JSONDecoder().decode([MeetingContextRef].self, from: Data("""
        [{"id":"c1","kind":"note","ref":"Budget is fixed","title":"Budget","addedAt":"2026-11-05T12:00:00.000Z"},
         {"id":"c2","kind":"note","ref":"Budget is fixed","addedAt":"2026-11-05T12:00:00.000Z"},
         {"id":"c3","kind":"url","ref":"https://example.com","note":"the spec","addedAt":"2026-11-05T12:00:00.000Z"}]
        """.utf8))
        XCTAssertEqual(MeetingsWords.contextNote(refs[0]), "Budget is fixed", "R2-MU2: the title alone hid the note")
        XCTAssertNil(MeetingsWords.contextNote(refs[1]), "an untitled note's text is already its title")
        XCTAssertEqual(MeetingsWords.contextNote(refs[2]), "the spec")
    }
}
