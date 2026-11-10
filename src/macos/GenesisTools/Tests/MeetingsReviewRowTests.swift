import Foundation
import XCTest
@testable import GenesisToolsMeetings

/// The review rows of F6 and the layout around them: the trailing pane beside the rows, the window settings the rows
/// read, and the rows from `meeting.rows` with their decisions through the journal.
@MainActor
final class MeetingsReviewRowTests: XCTestCase {
    private func defaults() throws -> (UserDefaults, String) {
        let suite = "meetings.rows.tests.\(UUID().uuidString)"
        return (try XCTUnwrap(UserDefaults(suiteName: suite)), suite)
    }

    // MARK: The trailing pane (decision 2)

    func testTheTranscriptPaneShowsBesideTheRowsOnlyWhenTheColumnIsWideEnough() {
        let wide = MeetingDetailView.transcriptPaneMinWidth
        XCTAssertEqual(MeetingDetailView.trailingPane(tab: .items, width: wide, setting: .auto, sidePanelOpen: false), .transcript)
        XCTAssertNil(MeetingDetailView.trailingPane(tab: .items, width: wide - 1, setting: .auto, sidePanelOpen: false),
                     "a narrow column keeps the Transcript tab as today")
        XCTAssertNil(MeetingDetailView.trailingPane(tab: .transcript, width: 2000, setting: .always, sidePanelOpen: false),
                     "only the rows get the pane")
        XCTAssertEqual(MeetingDetailView.trailingPane(tab: .items, width: 400, setting: .always, sidePanelOpen: false), .transcript)
        XCTAssertNil(MeetingDetailView.trailingPane(tab: .items, width: 2000, setting: .never, sidePanelOpen: false))
        XCTAssertEqual(MeetingDetailView.trailingPane(tab: .screen, width: 400, setting: .never, sidePanelOpen: true), .settings,
                       "the open side panel replaces the pane on every tab")
        XCTAssertNil(MeetingDetailView.trailingPane(tab: .items, width: 2000, setting: .always, sidePanelOpen: false, hasTranscript: false),
                     "a meeting without a transcript has nothing for the pane: it was a second empty state beside No items yet")
        XCTAssertEqual(MeetingDetailView.trailingPane(tab: .items, width: 2000, setting: .auto, sidePanelOpen: true, hasTranscript: false),
                       .settings, "the settings panel does not need a transcript")
    }

    // MARK: Window settings

    func testTheTypedAnswerKeyMovesToTheRowsAndKeepsItsValue() throws {
        let (defaults, suite) = try defaults()
        defer { defaults.removePersistentDomain(forName: suite) }
        defaults.set("noChoices", forKey: MeetingsPreferences.legacyTypedAnswerKey)
        MeetingsPreferences.migrate(defaults)
        XCTAssertNil(defaults.object(forKey: MeetingsPreferences.legacyTypedAnswerKey))
        XCTAssertEqual(MeetingsPreferences.Rows.typedAnswer.value(defaults), .noChoices)
        XCTAssertEqual(MeetingsPreferences.typedAnswer(defaults), .noChoices)
    }

    func testEveryWindowSettingHasItsDefaultAndOffersIt() throws {
        let (defaults, suite) = try defaults()
        defer { defaults.removePersistentDomain(forName: suite) }
        typealias Rows = MeetingsPreferences.Rows
        typealias Playback = MeetingsPreferences.Playback
        typealias Panes = MeetingsPreferences.Panes
        XCTAssertEqual(Rows.returnKey.value(defaults), .edit)
        XCTAssertEqual(Rows.choiceKeys.value(defaults), .on)
        XCTAssertEqual(Rows.decided.value(defaults), .inPlace)
        XCTAssertEqual(Rows.order.value(defaults), .priority)
        XCTAssertEqual(Rows.lowPriority.value(defaults), .hide)
        XCTAssertEqual(Rows.askReach.value(defaults), .always)
        XCTAssertEqual(Rows.autoplayNext.value(defaults), .afterAnswer)
        XCTAssertEqual(Rows.autoplayDelaySec.value(defaults), 1)
        XCTAssertEqual(MeetingsPreferences.Notices.maxVisible.value(defaults), 3)
        XCTAssertEqual(Playback.view.value(defaults), .moment)
        XCTAssertEqual(Playback.speed.value(defaults), 1)
        XCTAssertEqual(Playback.repeatClip.value(defaults), .off)
        XCTAssertEqual(Playback.afterClip.value(defaults), .offerMore)
        XCTAssertEqual(Playback.moreSec.value(defaults), 30)
        XCTAssertEqual(Playback.contextSec.value(defaults), 120)
        XCTAssertEqual(Playback.rewindSec.value(defaults), 1)
        XCTAssertEqual(Playback.clickInQuestion.value(defaults), .push)
        XCTAssertEqual(Playback.onTopEnd.value(defaults), .return)
        XCTAssertEqual(Playback.stackDepth.value(defaults), 3)
        XCTAssertTrue(Panes.timelineShown.value(defaults))
        XCTAssertEqual(Panes.hoverDelayMs.value(defaults), 300)
        XCTAssertTrue(Panes.followPlayback.value(defaults))
        XCTAssertTrue(Panes.screenBesidePlayback.value(defaults))
        XCTAssertEqual(Panes.transcriptPane.value(defaults), .auto)

        XCTAssertTrue(Rows.autoplayDelaySec.choices.contains(Rows.autoplayDelaySec.defaultValue))
        XCTAssertTrue(Playback.speed.choices.contains(Playback.speed.defaultValue))
        XCTAssertTrue(Playback.stackDepth.choices.contains(Playback.stackDepth.defaultValue))
        XCTAssertTrue(Panes.hoverDelayMs.choices.contains(Panes.hoverDelayMs.defaultValue))

        defaults.set(false, forKey: Panes.followPlayback.key)
        defaults.set("confirm", forKey: Rows.returnKey.key)
        defaults.set(1.5, forKey: Playback.speed.key)
        XCTAssertFalse(Panes.followPlayback.value(defaults))
        XCTAssertEqual(Rows.returnKey.value(defaults), .confirm)
        XCTAssertEqual(Playback.speed.value(defaults), 1.5)
    }

    // MARK: F6 rows

    /// Three rows as `meeting.rows` answers them: an open question at 20:00, an open term at 05:09, and a confirmed
    /// speaker range at 00:12 that an agent decided.
    static let rowsJSON = Data("""
    {"meeting":"m","hidden":{"lowPriority":2,"minPriority":0.5},"rows":[
     {"id":"q1","label":"Q1","kind":"question","status":"suggested","what":"Who says this?","edit":"answer","sources":[],
      "parts":[{"kind":"when","from":{"sec":1200,"text":"20:00"},"target":{"kind":"item","id":"q1"}},
               {"kind":"asks","pieces":[{"text":"Who speaks at "},{"text":"20:10","target":{"kind":"time","atSec":1210}}]}],
      "choices":[{"value":"Dana Example","label":"Dana Example","role":"suggested","action":{"kind":"answer","answer":"Dana Example"}},
                 {"value":"none of these","label":"None of these","role":"none","action":{"kind":"answer","answer":"none of these"}}],
      "target":{"kind":"item","id":"q1"}},
     {"id":"i2","label":"i2","kind":"term","status":"suggested","confidence":0.82,"what":"OMP → EMP","edit":"spelling","sources":[],
      "parts":[{"kind":"when","from":{"sec":309,"text":"05:09"},"target":{"kind":"item","id":"i2"}}],
      "choices":[{"value":"EMP","label":"EMP","role":"suggested","action":{"kind":"confirm"},"confidence":0.82},
                 {"value":"OMP","label":"OMP","role":"heard","action":{"kind":"reject"}}],
      "target":{"kind":"item","id":"i2"}},
     {"id":"i3","label":"i3","kind":"speaker-range","status":"confirmed","what":"Speaker 3 00:12–00:30 → Alex Example","edit":"person",
      "sources":[],"parts":[{"kind":"when","from":{"sec":12,"text":"00:12"},"to":{"sec":30,"text":"00:30"},"target":{"kind":"item","id":"i3"}}],
      "choices":[],"target":{"kind":"item","id":"i3"},
      "decision":{"token":"t-agent","actor":{"kind":"agent","harness":"claude-code","session":"11111111-2222-4333-8444-555555555555"},
                  "by":"an agent (Claude Code, session 11111111)","action":"confirm","reason":"the calendar says so"}}]}
    """.utf8)

    private func rows() throws -> ReviewRows { try JSONDecoder().decode(ReviewRows.self, from: Self.rowsJSON) }

    /// A journal entry as the service sends it, for `items` with the status after.
    private func entry(token: String, actor: String = #"{"kind":"window"}"#, action: String, changes: [(String, String, String)]) throws -> JournalEntry {
        let items = changes.map { id, before, after in
            #"{"id":"\#(id)","before":{"id":"\#(id)","kind":"term","status":"\#(before)"},"after":{"id":"\#(id)","kind":"term","status":"\#(after)"}}"#
        }.joined(separator: ",")
        let json = #"{"token":"\#(token)","at":"2026-11-09T17:32:38.000Z","meeting":"m","actor":\#(actor),"action":\#(action),"decided":[\#(changes.map { "\"\($0.0)\"" }.joined(separator: ","))],"changes":[\#(items)]}"#
        return try JSONDecoder().decode(JournalEntry.self, from: Data(json.utf8))
    }

    func testRowsKeepTheEnginesOrderOrGoByTimeAndDecidedRowsFoldOrLeave() throws {
        let rows = try rows().rows
        XCTAssertEqual(MeetingDetailModel.visibleRows(rows, order: .priority, decided: .inPlace).map(\.id), ["q1", "i2", "i3"],
                       "priority is the engine's order, the one listen asks in")
        XCTAssertEqual(MeetingDetailModel.visibleRows(rows, order: .time, decided: .inPlace).map(\.id), ["i3", "i2", "q1"])
        XCTAssertEqual(MeetingDetailModel.visibleRows(rows, order: .priority, decided: .hidden).map(\.id), ["q1", "i2"])
        XCTAssertEqual(rows[1].whenText, "05:09")
        XCTAssertEqual(rows[2].whenText, "00:12–00:30")
        XCTAssertEqual(ReviewRowView.decidedWords(rows[2]), "Confirmed by an agent (Claude Code, session 11111111): the calendar says so",
                       "R35: who decided it and why")
        XCTAssertEqual(ReviewRowView.actorGlyph(rows[2]), "sparkles", "a narrow folded row still marks a decision an agent made")
        XCTAssertNil(ReviewRowView.actorGlyph(rows[1]), "a row nobody decided, or the reader decided, has no mark")
    }

    func testTheNextOpenRowWrapsAndTheQueueEndsWhenNoneIsLeft() throws {
        let rows = try rows().rows
        XCTAssertEqual(MeetingDetailModel.nextOpenRow(after: "q1", in: rows)?.id, "i2")
        XCTAssertEqual(MeetingDetailModel.nextOpenRow(after: "i2", in: rows)?.id, "q1", "past the last open row it wraps")
        let one = rows.filter { $0.id != "i2" }
        XCTAssertNil(MeetingDetailModel.nextOpenRow(after: "q1", in: one), "G24: no other open row is the queue's end")
    }

    func testReturnEditsOrConfirmsAndNumberedChoicesCarryTheirDecision() throws {
        let rows = try rows().rows
        XCTAssertEqual(ItemsTab.returnAction(for: rows[1], key: .edit), .edit, "R11: Return opens the editor")
        XCTAssertEqual(ItemsTab.returnAction(for: rows[1], key: .confirm), .choose(rows[1].choices[0]), "or takes the suggestion")
        XCTAssertEqual(rows[1].choices[0].action.decision(on: rows[1]), .confirm(["i2"]))
        XCTAssertEqual(rows[1].choices[1].action.decision(on: rows[1]), .reject(["i2"]))
        XCTAssertEqual(rows[0].choices[0].action.decision(on: rows[0]), .answer("q1", "Dana Example"))
        XCTAssertEqual(rows[1].choices[0].confidence, 0.82, "R49: the suggestion's confidence")
        XCTAssertNil(rows[1].choices[1].confidence)
    }

    func testAQuestionFlowsAsWordsAroundItsTimesAndAFoldedQuestionShowsItsAnswer() throws {
        let rows = try rows().rows
        let pieces = [TextPiece(text: "Who asks 'Rename it?' ("), TextPiece(text: "20:10", target: .time(1210)),
                      TextPiece(text: "; the answer at "), TextPiece(text: "20:16", target: .time(1216)), TextPiece(text: " is 'Sure'?")]
        let flow = ReviewRowView.flow(pieces)
        XCTAssertEqual(flow.map(\.piece.text),
                       ["Who", "asks", "'Rename", "it?'", "(", "20:10", ";", "the", "answer", "at", "20:16", "is", "'Sure'?"],
                       "the text between two times is its words, so a time sits inside its sentence")
        XCTAssertEqual(flow.map(\.spaceAfter), [true, true, true, true, false, false, true, true, true, true, true, true, false],
                       "a space is the trailing room of the item before it: no line starts with one, and \"(\" keeps its time")
        XCTAssertEqual(flow[5].piece.target, .time(1210), "a time stays one piece and keeps its Moment")
        XCTAssertEqual(ReviewRowView.units(flow).map { $0.map(\.piece.text).joined() },
                       ["Who", "asks", "'Rename", "it?'", "(20:10;", "the", "answer", "at", "20:16", "is", "'Sure'?"],
                       "a line breaks only at a space: the bracket keeps its time, and the time keeps its semicolon")

        var answered = rows[0]
        answered.status = "confirmed"
        answered.answer = "Dana Example"
        XCTAssertEqual(ReviewRowView.foldedText(answered), "20:00 Who speaks at 20:10", "a folded question reads as its time and what it asked")
        XCTAssertEqual(ReviewRowView.foldedAnswer(answered), "Dana Example", "and its answer is its own text, which never truncates")
        XCTAssertEqual(ReviewRowView.title(answered), "Who speaks at 20:10", "the pin's card titles a question by what it asks")
        XCTAssertEqual(ReviewRowView.title(rows[1]), "OMP → EMP")
        XCTAssertEqual(ReviewRowView.foldedText(rows[2]), "Speaker 3 00:12–00:30 → Alex Example")
        XCTAssertNil(ReviewRowView.foldedAnswer(rows[2]), "a range's line already ends in its speaker")
        XCTAssertEqual(ReviewRowView.reference(rows[2]), "Speaker range 00:12–00:30", "another row names it in words, not by its item id")

        // A source line that the row already quotes shows its time only.
        let quoting = TimelineFixture.questionRow
        XCTAssertNil(ReviewRowView.sourceQuote("Can we rename working to staging before the…", in: quoting),
                     "the row's said line holds these words: the same sentence twice was noise")
        XCTAssertEqual(ReviewRowView.sourceQuote("We ship on Friday.", in: quoting), "We ship on Friday.")
        XCTAssertNil(ReviewRowView.sourceQuote(nil, in: quoting))
        XCTAssertEqual(ReviewRowView.sourceQuote("Who speaks?", in: rows[0]), "Who speaks?", "a row that quotes nothing keeps its source's words")
    }

    func testOnlyThisQuestionNeedsTheServiceAndKeepsItsWireKey() throws {
        var only = DecisionAction.answer("q1", "Dana Example")
        XCTAssertNotNil(MeetingDetailModel.commandArgs(meeting: "m", action: only, reason: nil))
        only.lookAlikes = "leave"
        XCTAssertNil(MeetingDetailModel.commandArgs(meeting: "m", action: only, reason: nil),
                     "R22: the command always settles the look-alikes, so this answer waits for the service")
        let wire = try XCTUnwrap(String(data: JSONEncoder().encode(only), encoding: .utf8))
        XCTAssertTrue(wire.contains(#""lookAlikes":"leave""#), wire)
    }

    func testANoticeNamesAQuestionByItsLabel() throws {
        let answer = try entry(token: "t1", action: #"{"kind":"answer","question":"q1","answer":"Dana Example"}"#, changes: [("q1", "suggested", "confirmed")])
        XCTAssertEqual(MeetingsWords.entryAction(answer), "answered q1: Dana Example")
        XCTAssertEqual(MeetingsWords.entryAction(answer, label: { $0 == "q1" ? "Q1" : $0 }), "answered Q1: Dana Example",
                       "the notice and the history name the question as its row does")
        let confirm = try entry(token: "t2", action: #"{"kind":"confirm","items":["q1","i2"]}"#,
                                changes: [("q1", "suggested", "confirmed"), ("i2", "suggested", "confirmed")])
        XCTAssertEqual(MeetingsWords.entryAction(confirm, label: { $0 == "q1" ? "Q1" : $0 }), "confirmed Q1 and i2")
    }

    func testADraftDecidesByTheRowsEditKind() throws {
        let rows = try rows().rows
        XCTAssertEqual(MeetingDetailModel.draftDecision("  EMP ", on: rows[1]), .respell("i2", to: "EMP"), "a spelling is a respell")
        XCTAssertEqual(MeetingDetailModel.draftDecision("Dana Example", on: rows[0]), .answer("q1", "Dana Example"))
        XCTAssertEqual(MeetingDetailModel.draftDecision("Bob", on: rows[2]), .respell("i3", to: "Bob"), "a person is a respell")
        XCTAssertNil(MeetingDetailModel.draftDecision("   ", on: rows[1]))
        XCTAssertTrue(MeetingDetailModel.mayReach(.answer("q1", "x")))
        XCTAssertFalse(MeetingDetailModel.mayReach(.reject(["i2"])))
    }

    func testWithoutAServiceTheCommandMakesTheDecisionsItHas() {
        XCTAssertEqual(MeetingDetailModel.commandArgs(meeting: "m", action: .confirm(["i2"], speaker: "Dana Example"), reason: "heard it"),
                       ["confirm", "m", "i2", "--speaker", "Dana Example", "--reason", "heard it", "--json"])
        XCTAssertEqual(MeetingDetailModel.commandArgs(meeting: "m", action: .reject(["i2"]), reason: nil), ["reject", "m", "i2", "--json"])
        XCTAssertEqual(MeetingDetailModel.commandArgs(meeting: "m", action: .answer("Q1", "JSON"), reason: nil),
                       ["listen", "m", "--item", "Q1", "--answer", "JSON", "--json"])
        var bulk = DecisionAction.confirm([])
        bulk.minConfidence = 0.8
        XCTAssertEqual(MeetingDetailModel.commandArgs(meeting: "m", action: bulk, reason: nil), ["confirm", "m", "--min-confidence", "0.8", "--json"])
        XCTAssertNil(MeetingDetailModel.commandArgs(meeting: "m", action: .respell("i2", to: "EMP"), reason: nil),
                     "a respell needs the service")
    }

    func testTheActorAndTheActionReadAsTheEnginesWords() throws {
        XCTAssertEqual(MeetingsWords.actor(.window), "you")
        XCTAssertEqual(MeetingsWords.actor(DecisionActor(kind: "listen")), "you in the terminal")
        XCTAssertEqual(MeetingsWords.actor(DecisionActor(kind: "agent", harness: "claude-code", session: "3f98b772-aaaa")),
                       "an agent (Claude Code, session 3f98b772)")
        XCTAssertEqual(MeetingsWords.actor(DecisionActor(kind: "agent", harness: "grok")), "an agent (Grok)")
        XCTAssertEqual(MeetingsWords.actor(DecisionActor(kind: "agent", harness: "other-agent")), "an agent (other-agent)")
        XCTAssertEqual(MeetingsWords.actor(DecisionActor(kind: "rule", rule: "E2")), "rule E2")
        XCTAssertEqual(MeetingsWords.actor(DecisionActor(kind: "unknown")), "someone, before the history existed")
        let confirm = try entry(token: "t1", action: #"{"kind":"confirm","items":["i2","i4"]}"#,
                                changes: [("i2", "suggested", "confirmed"), ("i4", "suggested", "confirmed")])
        XCTAssertEqual(MeetingsWords.entryAction(confirm), "confirmed i2 and i4")
        let answer = try entry(token: "t2", action: #"{"kind":"answer","question":"Q1","answer":"JSON"}"#, changes: [])
        XCTAssertEqual(MeetingsWords.entryAction(answer), "answered Q1: JSON")
    }

    func testAnEventFromElsewhereFoldsTheRowAndKeepsAnOpenDraftWithUseMine() throws {
        let window = MeetingsWindowModel(defaults: try XCTUnwrap(UserDefaults(suiteName: "meetings.rows.tests.\(UUID().uuidString)")),
                                         noticeClock: ManualNoticeClock(), service: nil, loadDetail: { _ in })
        let detail = MeetingDetailModel(id: "m", window: window)
        detail.rows = .loaded(try rows())
        let row = try XCTUnwrap(detail.rows.value?.rows.first { $0.id == "i2" })
        detail.edit(row)
        XCTAssertEqual(detail.drafts["i2"], "EMP", "the editor starts with the suggestion")
        detail.drafts["i2"] = "EMPs"
        let theirs = try entry(token: "t-agent-2", actor: #"{"kind":"agent","harness":"codex","session":"22222222-3333"}"#,
                               action: #"{"kind":"confirm","items":["i2"]}"#, changes: [("i2", "suggested", "confirmed")])
        detail.receive(.decisionApplied(MeetingsAPI.DecisionApplied(meeting: "m", entry: theirs)))
        detail.cancelReads()
        XCTAssertEqual(detail.rows.value?.rows.first { $0.id == "i2" }?.status, "confirmed", "the row folds in place at once")
        XCTAssertEqual(detail.drafts["i2"], "EMPs", "the draft stays (G47)")
        XCTAssertEqual(detail.decidedMeanwhile["i2"]?.token, "t-agent-2", "and the row offers Use mine instead (G48)")
        XCTAssertEqual(MeetingDetailModel.draftDecision(detail.drafts["i2"], on: row), .respell("i2", to: "EMPs"))
    }

    func testOneActorsDecisionsWithinFiveSecondsShareOneNoticeThatNamesAnotherMeeting() throws {
        let suite = "meetings.rows.tests.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let window = MeetingsWindowModel(defaults: defaults, noticeClock: ManualNoticeClock(), service: nil, loadDetail: { _ in })
        window.receive(try JSONDecoder().decode(MeetingsOverview.self, from: MeetingsUXTests.overviewJSON()))
        XCTAssertEqual(window.selectedMeetingID, "a")
        let agent = #"{"kind":"agent","harness":"claude-code","session":"11111111-2222"}"#
        let now = Date()
        window.noteDecision(try entry(token: "t1", actor: agent, action: #"{"kind":"confirm","items":["i1"]}"#,
                                      changes: [("i1", "suggested", "confirmed")]), meeting: "b", now: now)
        window.noteDecision(try entry(token: "t2", actor: agent, action: #"{"kind":"confirm","items":["i2"]}"#,
                                      changes: [("i2", "suggested", "confirmed")]), meeting: "b", now: now.addingTimeInterval(2))
        XCTAssertEqual(window.notices.notices.map(\.text), ["Screen only: An agent (Claude Code, session 11111111) decided 2 items"],
                       "G38: one notice for the burst; G34: it names the meeting that is not open")
        XCTAssertEqual(window.notices.notices.first?.actions.map(\.label), ["Undo"])
        window.noteDecision(try entry(token: "t3", actor: agent, action: #"{"kind":"reject","items":["i9"]}"#,
                                      changes: [("i9", "suggested", "rejected")]), meeting: "a", now: now.addingTimeInterval(3))
        XCTAssertEqual(window.notices.notices.last?.text, "An agent (Claude Code, session 11111111) rejected i9",
                       "the open meeting is not named, and another meeting is another burst")
        XCTAssertEqual(window.newestUndo, "An agent (Claude Code, session 11111111) rejected i9", "⌘Z takes back the newest (G39)")
    }

    /// G39: with no text field in focus, ⌘Z presses the newest notice's Undo, and the menu item names it.
    func testCommandZPressesTheNewestNoticesUndo() throws {
        let suite = "meetings.rows.tests.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let window = MeetingsWindowModel(defaults: defaults, noticeClock: ManualNoticeClock(), service: nil, loadDetail: { _ in })
        let undo = MeetingsUndoManager(model: window)
        XCTAssertFalse(undo.canUndo, "no notice, nothing to undo")
        var undone: [String] = []
        window.notices.push(StackedNotice(text: "Confirmed i1", actions: [.undo { _ in undone.append("i1") }]))
        window.notices.push(StackedNotice(text: "Label Launch added"))
        window.notices.push(StackedNotice(text: "Answered Q2: JSON", actions: [.undo { _ in undone.append("Q2") }]))
        XCTAssertTrue(undo.canUndo)
        XCTAssertEqual(undo.undoMenuItemTitle, "Undo Answered Q2: JSON")
        undo.undo()
        XCTAssertEqual(undone, ["Q2"], "the newest notice with an Undo")
        XCTAssertEqual(undo.undoMenuItemTitle, "Undo Confirmed i1", "a notice that waits for its Undo is not offered again")
        undo.undo()
        XCTAssertEqual(undone, ["Q2", "i1"])
    }

    func testClockTextIsTheTerminals() {
        XCTAssertEqual(MeetingsFormat.clock(309), "05:09")
        XCTAssertEqual(MeetingsFormat.clock(6588), "1:49:48")
        XCTAssertEqual(MeetingsFormat.clock(0), "00:00")
    }

    /// At the window's smallest size a folded line had 15 pt for its text and its status: one character and an
    /// ellipsis. Each narrower shape drops one thing, and a question keeps its answer to the last.
    func testAFoldedLineDropsItsStatusThenItsRevertWordsThenAQuestionsText() {
        let question = ReviewRowView.foldedShapes(isQuestion: true)
        XCTAssertEqual(question.map(\.words), [true, false, false], "who decided it goes first: the mark says it is decided")
        XCTAssertEqual(question.map(\.revertWords), [true, true, false], "then Revert and edit becomes its glyph")
        XCTAssertNil(question[2].textWidth, "a question's answer outlives its text")
        XCTAssertNotNil(ReviewRowView.foldedShapes(isQuestion: false)[2].textWidth, "a row without an answer of its own is its text")
        let widths = question.compactMap(\.textWidth)
        XCTAssertEqual(widths, widths.sorted(by: >), "each shape asks for less text room than the one before")
    }

    /// The pin's card informs, it does not answer: it lists the candidates of an open row, never the actions, and a
    /// decided row shows how it was decided in their place.
    func testThePinCardListsCandidatesNotActions() throws {
        let rows = try rows().rows
        let open = try XCTUnwrap(rows.first { $0.id == "q1" })
        XCTAssertEqual(PinCard.shownChoices(open).map(\.label), ["Dana Example"], "None of these is an action of the row, not a candidate")
        let decided = try XCTUnwrap(rows.first { !$0.isOpen })
        XCTAssertTrue(PinCard.shownChoices(decided).isEmpty, "a decided row's choices made it read as open: \(decided.id)")
    }

    func testTheBarAboveTheRowsSaysWhatWaitsOnOneLine() {
        XCTAssertEqual(ItemsTab.barWords(open: 430, atLine: 348, line: "50 %", compact: false),
                       "430 rows wait for you · 348 suggestions at 50 % or more")
        XCTAssertEqual(ItemsTab.barWords(open: 430, atLine: 348, line: "50 %", compact: true), "430 wait · 348 at 50 % or more",
                       "a narrow column keeps both counts")
        XCTAssertEqual(ItemsTab.barWords(open: 1, atLine: 0, line: "50 %", compact: false), "1 row waits for you · none at 50 % or more")
        XCTAssertEqual(ItemsTab.barWords(open: 0, atLine: 0, line: "50 %", compact: false), "No suggestion at 50 % or more")
        XCTAssertEqual(ItemsTab.waitingWords(open: 0), "Nothing waits for you in this meeting")
    }

    /// A transcript line at the row's own time, whose words the row already quotes, is the header's time button again.
    func testTheFromLineLeavesOutTheRowsOwnTime() throws {
        let row = try JSONDecoder().decode(ReviewRow.self, from: Data("""
        {"id":"i9","label":"i9","kind":"term","status":"suggested","what":"OMP → EMP","edit":"spelling","choices":[],
         "target":{"kind":"item","id":"i9"},
         "parts":[{"kind":"when","from":{"sec":600,"text":"10:00"},"target":{"kind":"item","id":"i9"}},
                  {"kind":"said","text":"We ship the OMP today.","speaker":"Bob Example"}],
         "sources":[{"kind":"line","at":{"sec":600,"text":"10:00"},"index":4,"text":"We ship the OMP today."},
                    {"kind":"line","at":{"sec":630,"text":"10:30"},"index":7,"text":"We ship the OMP today."},
                    {"kind":"document","path":"/tmp/notes.md","line":3}]}
        """.utf8))
        XCTAssertEqual(row.whenSec, 600)
        XCTAssertEqual(ReviewRowView.shownSources(row).count, 2, "the line at 10:00 is the header's time; the line at 10:30 and the document stay")
        XCTAssertTrue(ItemsTab.ruleAbove(row, first: "q1", held: false), "an open row that is not the first gets a hairline")
        XCTAssertFalse(ItemsTab.ruleAbove(row, first: "i9", held: false), "the first row has the bar above it")
        XCTAssertFalse(ItemsTab.ruleAbove(row, first: "q1", held: true), "a row that keeps its place after an answer does not move by a line")
    }

    /// A sentence names a suggestion by what it is and where; its id is the terminal's handle.
    func testAnUndoComesBackToTheRowItReopened() throws {
        let rows = try rows().rows
        let undo = try entry(token: "t9", action: #"{"kind":"revert","token":"t1"}"#, changes: [("gone", "confirmed", "suggested"), ("i2", "confirmed", "suggested")])
        XCTAssertEqual(MeetingDetailModel.rowToShow(afterUndo: undo, in: rows), "i2", "the first changed row the list holds")
        let nothing = try entry(token: "t9", action: #"{"kind":"revert","token":"t1"}"#, changes: [("gone", "confirmed", "suggested")])
        XCTAssertNil(MeetingDetailModel.rowToShow(afterUndo: nothing, in: rows), "no row of the list: the selection stays")
    }

    func testASentenceNamesARowInWords() throws {
        let rows = try rows().rows
        let names = Dictionary(uniqueKeysWithValues: rows.map { ($0.id, MeetingsWords.rowName($0)) })
        XCTAssertEqual(names["q1"], "Q1", "a question keeps its label")
        XCTAssertEqual(names["i2"], "the word at 05:09")
        XCTAssertEqual(names["i3"], "the speaker range at 00:12–00:30")
        let confirm = try entry(token: "t1", action: #"{"kind":"confirm","items":["i2","i3"]}"#,
                                changes: [("i2", "suggested", "confirmed"), ("i3", "suggested", "confirmed")])
        XCTAssertEqual(MeetingsWords.entryAction(confirm, label: { names[$0] ?? $0 }),
                       "confirmed the word at 05:09 and the speaker range at 00:12–00:30", "it read: confirmed i2 and i3")
        XCTAssertEqual(MeetingDetailModel.sentenceStart("the word at 05:09"), "The word at 05:09")
    }

    func testASpeakerRangeDoesNotSayItsTwoNamesTwice() {
        XCTAssertTrue(ReviewRowView.whoRepeatsTitle("Speaker 2 → Alice Example", title: "Speaker 2 01:12 → Alice Example", when: "01:12"),
                      "the title holds both names: the who line under it said them again")
        XCTAssertTrue(ReviewRowView.whoRepeatsTitle("Speaker 2 → Alice Example", title: "Speaker 2 01:12–01:40 → Alice Example", when: "01:12–01:40"))
        XCTAssertFalse(ReviewRowView.whoRepeatsTitle("Bob Example", title: "OMP → EMP", when: "10:00"),
                       "a word's who line names the speaker of its line, which the title does not")
        XCTAssertFalse(ReviewRowView.whoRepeatsTitle("Speaker 2", title: "Speaker 2 01:12 → Alice Example", when: "01:12"))
    }

    /// The playing row's bar is left out below the width it reads at: squeezed, its flag drew over its text.
    func testThePlayingBarNeedsRoomForItsLength() {
        XCTAssertGreaterThan(PlayingRowBar.smallestWidth(length: true), PlayingRowBar.smallestWidth(length: false) + 60,
                             "\"12 min clip\" needs about 60 pt")
        XCTAssertGreaterThanOrEqual(PlayingRowBar.smallestWidth(length: false), 4 * FlagMark.hitWidth,
                                    "a bar shorter than a few flags is only its flag")
        let text = PlayingRowBar.lengthText(TimelineFixture.span)
        XCTAssertTrue(text.hasSuffix(" clip"), text)
        XCTAssertFalse(text.contains("→"), "the clip's two ends stood one second from the row's own span beside the bar")
    }
}

