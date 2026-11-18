import AppKit
import Foundation
import SwiftUI
import Vision
import XCTest
@testable import GenesisToolsMeetings

/// The review rows of F6 and the layout around them: the trailing pane beside the rows, the window settings the rows
/// read, and the rows from `meeting.rows` with their decisions through the journal.
@MainActor
final class MeetingsReviewRowTests: XCTestCase {
    func testWordOccurrenceSheetRendersTheSharedPlacesListOffScreen() async throws {
        let reach = try JSONDecoder().decode(DecisionReach.self, from: Data(#"{"items":[],"dictionary":[],"spelling":{"occurrences":[{"line":2,"atSec":15,"speaker":"Speaker 1","text":"The zorb is ready.","selected":true,"primary":true},{"line":3,"atSec":20,"speaker":"Speaker 2","text":"Use the zorb again.","selected":true,"primary":false}],"dictionary":false}}"#.utf8))
        let (defaults, suite) = try defaults()
        defer { defaults.removePersistentDomain(forName: suite) }
        let model = MeetingsWindowModel(defaults: defaults, service: nil, loadDetail: { _ in })
        let detail = MeetingDetailModel(id: "m", window: model)
        let panel = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 520, height: 430), styleMask: [.borderless], backing: .buffered, defer: false)
        panel.isReleasedWhenClosed = false
        let hosting = NSHostingView(rootView: WordOccurrencesSheet(spelling: try XCTUnwrap(reach.spelling), detail: detail, close: {})
            .frame(width: 520, height: 430, alignment: .top).background(Color(white: 0.15)).environment(\.colorScheme, .dark))
        hosting.sizingOptions = []
        panel.contentView = hosting
        panel.orderInForSnapshot()
        defer { panel.orderOut(nil); panel.close() }
        // Capture until the sheet shows its words (a slow runner draws later), at most 10 s, instead of one fixed sleep.
        // Both places: the primary line ("The zorb is ready.") and its sibling ("Use the zorb again.").
        let expected = ["This also affects", "is ready", "zorb again", "Done"]
        let deadline = ContinuousClock.now + .seconds(10)
        var shot: NSBitmapImageRep?
        var text = ""
        repeat {
            if let captured = await WindowSnapshot.capture(panel), let image = captured.image.cgImage {
                let request = VNRecognizeTextRequest()
                request.recognitionLevel = .fast
                try VNImageRequestHandler(cgImage: image).perform([request])
                shot = captured.image
                text = (request.results ?? []).compactMap { $0.topCandidates(1).first?.string }.joined(separator: " ")
                if expected.allSatisfy(text.contains) { break }
            }
            try await Task.sleep(for: .milliseconds(100))
        } while ContinuousClock.now < deadline
        let capture = try XCTUnwrap(shot, "the window server never captured the sheet")
        for words in expected { XCTAssertTrue(text.contains(words), "the sheet shows \"\(words)\": \(text)") }
        if let folder = ProcessInfo.processInfo.environment["MEETINGS_UI_SNAPSHOTS"] {
            let png = try XCTUnwrap(capture.representation(using: .png, properties: [:]))
            try png.write(to: URL(fileURLWithPath: folder).appendingPathComponent("2026-11-17-P3-occurrence-sheet-fixture.png"))
        }
    }

    func testDictionaryQuestionsStayInTheWordRowAndMatchTheCurrentSpelling() throws {
        func item(_ json: String) throws -> MeetingItem { try JSONDecoder().decode(MeetingItem.self, from: Data(json.utf8)) }
        let word = try item(#"{"id":"q","kind":"question","status":"confirmed","about":"term","group":"words","heard":"zorb","answer":"Zorb","decides":["t"],"choices":["Zorb"]}"#)
        let old = try item(#"{"id":"old","kind":"question","status":"confirmed","about":"dictionary","heard":"zorb","evidence":{"item":"t","fixed":"Zarb"}}"#)
        let pending = try item(#"{"id":"dict","kind":"question","status":"suggested","about":"dictionary","heard":"zorb","evidence":{"item":"t","fixed":"Zorb","occurrences":31}}"#)
        XCTAssertEqual(word.wordSuggestion, "Zorb")
        XCTAssertEqual(word.dictionaryQuestion(in: [old, pending])?.id, "dict")
        let rows = try rows().rows
        var dictionary = rows[0]
        dictionary = try JSONDecoder().decode(ReviewRow.self, from: Data(#"{"id":"dict","label":"Q2","kind":"question","kindWord":"Question","status":"suggested","priority":31,"group":"words","what":"Add Zorb?","parts":[],"choices":[],"edit":"none","sources":[],"target":{"kind":"item","id":"dict"}}"#.utf8))
        XCTAssertEqual(ItemsTab.wordRows(rows + [dictionary], items: [word, pending]).map(\.id), rows.map(\.id))
        let action = DecisionAction.answer("dict", "add")
        let encoded = try JSONDecoder().decode(DecisionAction.self, from: JSONEncoder().encode(action))
        XCTAssertEqual(encoded.answer, "add")
        let reach = try JSONDecoder().decode(DecisionReach.self, from: Data(#"{"items":[],"dictionary":[{"project":"work","heard":"zorb","fixed":"Zorb","seenBefore":0,"teaches":true,"adds":true}]}"#.utf8))
        XCTAssertEqual(ReachList.dictionaryWords(reach.dictionary[0]), "Adds “zorb” → “Zorb” to the work dictionary now")
    }

    func testRepeatedWordRowsDecodeCountsAndKeepTheEngineOrderAfterAnAnswer() throws {
        var rows = try JSONDecoder().decode(ReviewRows.self, from: Self.rowsJSON).rows
        rows[0].group = "words"
        rows[0].occurrences = 31
        rows[1].group = "words"
        rows[1].occurrences = 18
        rows[0].status = "confirmed"
        XCTAssertEqual(ItemsTab.wordRows(rows, items: []).map(\.id), ["q1", "i2", "i3"])
        let json = #"{"id":"q","label":"Q1","kind":"question","kindWord":"Question","status":"suggested","group":"words","occurrences":31,"what":"What is zorb?","parts":[],"choices":[],"edit":"answer","sources":[],"target":{"kind":"item","id":"q"}}"#
        let row = try JSONDecoder().decode(ReviewRow.self, from: Data(json.utf8))
        XCTAssertEqual(row.group, "words")
        XCTAssertEqual(row.occurrences, 31)
        XCTAssertNil(rows[2].occurrences, "older replies still decode")
        XCTAssertEqual(ItemsTab.questionGroups.map(\.title), ["Rules", "Spot check", "Long stretches", "Repeated words"])
    }

    func testWorkshopLineEvidenceKeepsRulesIgnoredIndicatorAndSkippedSwaps() throws {
        let json = #"{"id":"i1","kind":"speaker-range","status":"suggested","fromSec":20,"rules":["R20","energy"],"evidence":{"indicatorIgnored":"stretch-stuck","swap":{"skipped":[21,22]},"departure":{"name":"Carol Example"}}}"#
        let item = try JSONDecoder().decode(MeetingItem.self, from: Data(json.utf8))
        // The rules in the engine's sentences (`rules.names`); an id the table lacks is left out, never shown raw.
        let text = try XCTUnwrap(item.speakerEvidenceText(ruleNames: ["R20": "The recording shows how loud each track was."]))
        XCTAssertTrue(text.hasPrefix("The recording shows how loud each track was."), text)
        XCTAssertFalse(text.contains("R20") || text.contains("energy") || text.contains("stretch-stuck"), text)
        XCTAssertTrue(text.contains("stayed on one name through this stretch"), text)
        XCTAssertTrue(text.contains("2 contradictory lines"), text)
        XCTAssertEqual(item.departureText, "Carol Example said goodbye at 00:20")
    }

    private func defaults() throws -> (UserDefaults, String) {
        let suite = "meetings.rows.tests.\(UUID().uuidString)"
        return (try XCTUnwrap(UserDefaults(suiteName: suite)), suite)
    }

    func testCmsQuestionAndIndicatorContracts() throws {
        var finding = DecisionAction.Finding(kind: "question")
        finding.from = 10
        finding.to = 20
        finding.question = "Who owns the export?"
        finding.choices = ["Alice", "Bob"]
        finding.decides = []
        var action = DecisionAction(kind: "add")
        action.findings = [finding]
        let data = try JSONEncoder().encode(action)
        let decoded = try JSONDecoder().decode(DecisionAction.self, from: data)
        XCTAssertEqual(decoded.findings?.first?.decides, [])
        XCTAssertEqual(decoded.findings?.first?.from, 10)
        let line = try JSONDecoder().decode(TranscriptLine.self, from: Data(#"{"startSec":10,"speaker":"Alice","text":"Hello","indicator":{"names":["Bob"],"ignored":"meeting-dominance"}}"#.utf8))
        XCTAssertEqual(line.indicator?.text, "Bob · stuck, ignored (meeting-dominance)")
        let blocks = TranscriptBlock.build(from: [line])
        XCTAssertEqual(blocks.first?.lines.first?.indicator, line.indicator)
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
        // U15, U16: the decided rows follow the open ones, so 32 rejected questions no longer stand above the 9 open ones.
        XCTAssertEqual(Rows.decided.value(defaults).rawValue, "atEnd")
        XCTAssertEqual(Rows.decided.choices.map(\.rawValue), ["inPlace", "hidden", "atEnd"], "in place and hidden stay reachable")
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
     {"id":"q1","label":"Q1","kind":"question","kindWord":"Question","status":"suggested","what":"Who says this?","edit":"answer","sources":[],
      "parts":[{"kind":"when","from":{"sec":1200,"text":"20:00"},"target":{"kind":"item","id":"q1"}},
               {"kind":"asks","pieces":[{"text":"Who speaks at "},{"text":"20:10","target":{"kind":"time","atSec":1210}}]}],
      "choices":[{"value":"Dana Example","label":"Dana Example","role":"suggested","action":{"kind":"answer","answer":"Dana Example"}},
                 {"value":"none of these","label":"None of these","role":"none","action":{"kind":"answer","answer":"none of these"}}],
      "target":{"kind":"item","id":"q1"}},
     {"id":"i2","label":"i2","kind":"term","kindWord":"Word","status":"suggested","confidence":0.82,"what":"OMP → EMP","edit":"spelling","sources":[],
      "parts":[{"kind":"when","from":{"sec":309,"text":"05:09"},"target":{"kind":"item","id":"i2"}}],
      "choices":[{"value":"EMP","label":"EMP","role":"suggested","action":{"kind":"confirm"},"confidence":0.82},
                 {"value":"OMP","label":"OMP","role":"heard","action":{"kind":"reject"}}],
      "target":{"kind":"item","id":"i2"}},
     {"id":"i3","label":"i3","kind":"speaker-range","kindWord":"Speaker range","status":"confirmed","what":"Speaker 3 00:12–00:30 → Alex Example","edit":"person",
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

    private func rowPatch(_ changes: [ReviewRowsPatch.Change], order: [String], hiddenBefore: Int = 0,
                          hiddenAfter: Int = 0) -> ReviewRowsPatch {
        .init(meeting: "m", changes: changes, order: order,
              hidden: .init(before: .init(lowPriority: hiddenBefore, minPriority: 0.5),
                            after: .init(lowPriority: hiddenAfter, minPriority: 0.5)),
              fields: .init(before: .init(title: "Before", project: nil, labels: [], speakerLabels: [:]),
                            after: .init(title: "After", project: nil, labels: [], speakerLabels: [:])))
    }

    func testAChangedRowPatchReconcilesOptimisticStatusAndKeepsNewerDecisions() throws {
        let initial = try rows()
        let before = initial.rows[0]
        var after = before
        after.status = "confirmed"
        after.answer = "Dana Example"
        let patch = rowPatch([.init(id: before.id, before: before, after: after)], order: initial.rows.map(\.id))
        var optimistic = before
        optimistic.status = "confirmed"
        let current = ReviewRows(meeting: "m", rows: [optimistic] + initial.rows.dropFirst(), hidden: initial.hidden)
        XCTAssertEqual(patch.applying(to: current, token: "ours", latest: [before.id: "ours"]).rows[0], after,
                       "the event can set the status before the response brings the complete row")
        XCTAssertEqual(patch.applying(to: current, token: "ours", latest: [before.id: "later"]).rows[0], optimistic,
                       "a newer event can have exactly the same status, so its token must still protect it")
        var newer = after
        newer.answer = "Alex Example"
        let reloaded = ReviewRows(meeting: "m", rows: [newer] + initial.rows.dropFirst(), hidden: initial.hidden)
        XCTAssertEqual(patch.applying(to: reloaded, token: "ours", latest: [:]).rows[0], newer,
                       "a newer full read is protected by its row value too")
        XCTAssertEqual(patch.applying(to: initial, token: "ours", latest: [:]).rows[1], initial.rows[1],
                       "unrelated rows are kept")
    }

    func testAFullRowsReadReconcilesOldEventTokensBeforeTheNextPatch() throws {
        let detail = MeetingDetailModel(id: "m", window: nil)
        let full = try rows()
        let before = full.rows[2]
        detail.rowDecisionTokens[before.id] = "old-event"
        detail.rows = .loaded(full)
        detail.rowsLanded(full)
        XCTAssertEqual(detail.rowDecisionTokens[before.id], before.decision?.token)
        var after = before
        after.status = "rejected"
        let patch = rowPatch([.init(id: before.id, before: before, after: after)], order: full.rows.map(\.id))
        XCTAssertEqual(patch.applying(to: full, token: "ours", latest: detail.rowDecisionTokens).rows[2], after,
                       "a reconnect or full read must clear markers that predate its snapshot")
        let newer = try entry(token: "newer-event", action: #"{"kind":"reject","items":["i3"]}"#,
                              changes: [("i3", "confirmed", "rejected")])
        detail.markRows(newer)
        XCTAssertEqual(patch.applying(to: full, token: "ours", latest: detail.rowDecisionTokens).rows[2], before,
                       "an event after that full read still protects the newer decision")
    }

    func testARowPatchAddsRemovesOrdersAndUpdatesVisibilityWithoutDroppingConcurrentRows() throws {
        let initial = try rows()
        let current = ReviewRows(meeting: "m", rows: Array(initial.rows.prefix(2)), hidden: .init(lowPriority: 1, minPriority: 0.5))
        let patch = rowPatch([.init(id: "i2", before: initial.rows[1], after: nil),
                              .init(id: "i3", before: nil, after: initial.rows[2])], order: ["i3", "q1"], hiddenBefore: 1)
        let patched = patch.applying(to: current, token: "ours", latest: [:])
        XCTAssertEqual(patched.rows.map(\.id), ["i3", "q1"])
        XCTAssertEqual(patched.hidden.lowPriority, 0)
        let concurrent = ReviewRows(meeting: "m", rows: initial.rows, hidden: current.hidden)
        let remove = rowPatch([.init(id: "i2", before: initial.rows[1], after: nil)], order: ["q1"], hiddenBefore: 1)
        XCTAssertEqual(remove.applying(to: concurrent, token: "ours", latest: [:]).rows.map(\.id), ["q1", "i3"],
                       "an added row not present in the response's order survives")
        let protected = patch.applying(to: current, token: "ours", latest: ["i2": "later"])
        XCTAssertNotNil(protected.rows.first { $0.id == "i2" })
        XCTAssertEqual(protected.hidden.lowPriority, 1, "a rejected stale patch cannot replace newer visibility counts")
    }

    /// An answer that comes with no rows patch (an older service, a command's reply, another window's event) marks
    /// its row from the journal entry: a row held in place shows the answer it got and who gave it at once, and keeps
    /// them when the re-read fails. The complete row the service sends next still replaces the marked one.
    func testAMarkedRowShowsItsAnswerAndWhoGaveItBeforeTheReRead() throws {
        let detail = MeetingDetailModel(id: "m", window: nil)
        let initial = try rows()
        detail.rows = .loaded(initial)
        let json = #"""
        {"token":"t-answer","at":"2026-11-09T17:32:38.000Z","meeting":"m","actor":{"kind":"window"},"reason":"heard it twice",
         "action":{"kind":"answer","question":"q1","answer":"Dana Example"},"question":"q1","decided":["q1"],
         "changes":[{"id":"q1","before":{"id":"q1","kind":"question","status":"suggested"},
                     "after":{"id":"q1","kind":"question","status":"confirmed","answer":"Dana Example"}}]}
        """#
        detail.markRows(try JSONDecoder().decode(JournalEntry.self, from: Data(json.utf8)))
        let row = try XCTUnwrap(detail.rows.value?.rows.first)
        XCTAssertEqual(row.status, "confirmed")
        XCTAssertEqual(row.answer, "Dana Example", "the held row's choices mark the answer, and its fold shows it")
        XCTAssertEqual(DecisionState.of(row.choices[0], in: row), .confirmed)
        XCTAssertEqual(ReviewRowView.decidedWords(row), "Confirmed by you: heard it twice")

        var after = initial.rows[0]
        after.status = "confirmed"
        after.answer = "Dana Example"
        after.decision = .init(token: "t-answer", actor: .window, by: "you", action: "answer", reason: "heard it twice",
                               question: "q1", at: "2026-11-09T17:32:38.123Z")
        let patch = rowPatch([.init(id: "q1", before: initial.rows[0], after: after)], order: initial.rows.map(\.id))
        let current = try XCTUnwrap(detail.rows.value)
        XCTAssertEqual(patch.applying(to: current, token: "t-answer", latest: detail.rowDecisionTokens).rows[0], after,
                       "the marked row is this decision's row, so the service's complete row replaces it")
    }

    func testACommentOnlyAnswerUpdatesTheOpenCardBeforeTheRowsRead() throws {
        let detail = MeetingDetailModel(id: "m", window: nil)
        detail.rows = .loaded(try rows())
        let json = #"""
        {"token":"comment-1","at":"2026-01-01T10:00:00Z","meeting":"m","actor":{"kind":"window"},
         "action":{"kind":"answer","question":"q1","answer":"Too much noise"},"question":"q1","decided":[],
         "changes":[{"id":"q1","before":{"id":"q1","kind":"question","status":"suggested"},
                     "after":{"id":"q1","kind":"question","status":"suggested","comment":"Too much noise"}}]}
        """#
        let entry = try JSONDecoder().decode(JournalEntry.self, from: Data(json.utf8))
        detail.markRows(entry)
        let row = try XCTUnwrap(detail.rows.value?.rows.first)
        XCTAssertTrue(row.isOpen)
        XCTAssertNil(row.answer)
        XCTAssertEqual(row.comment, "Too much noise")
        XCTAssertEqual(MeetingsWords.entryAction(entry, label: { _ in "Q1" }), "commented on Q1")
        let card = try MeetingQuestionPicture.text(ReviewRowView(row: row, detail: detail, player: nil),
                                                   name: "L12-comment", native: false)
        XCTAssertTrue(card.contains("Too much noise"), card)
    }

    func testTheDecisionPatchUpdatesTheRecordAndAnOldReplyUsesTheReadPath() throws {
        let detail = MeetingDetailModel(id: "m", window: nil)
        let initial = try rows()
        detail.rows = .loaded(initial)
        detail.settleDecisionRecord(try JSONDecoder().decode(MeetingRecordView.self, from: Data("""
        {"id":"m","title":"Before","labels":[],"start":"2026-11-03T09:00:00Z","items":[{"id":"i2","kind":"term","status":"suggested"}],
         "context":[],"speakers":{"labels":{}},"sources":{}}
        """.utf8)))
        let entry = try entry(token: "ours", action: #"{"kind":"confirm","items":["i2"]}"#, changes: [("i2", "suggested", "confirmed")])
        let legacy = DecisionResult(entry: entry, skipped: [], warnings: nil)
        XCTAssertFalse(detail.patchDecision(legacy), "a response from an older service retains the full read fallback")
        var after = initial.rows[1]
        after.status = "confirmed"
        let patch = rowPatch([.init(id: "i2", before: initial.rows[1], after: after)], order: initial.rows.map(\.id))
        var result = legacy
        result.rows = patch
        detail.markRows(entry)
        XCTAssertTrue(detail.patchDecision(result))
        XCTAssertEqual(detail.rows.value?.rows[1], after)
        XCTAssertEqual(detail.record.value?.items[0].status, "confirmed")
        XCTAssertEqual(detail.record.value?.title, "After")
        var newer = try XCTUnwrap(detail.record.value)
        newer.title = "Someone else's title"
        detail.settleDecisionRecord(newer)
        XCTAssertTrue(detail.patchDecision(result))
        XCTAssertEqual(detail.record.value?.title, "Someone else's title", "a later field edit survives an older response")
    }

    func testTheKindFilterShowsOneKindAndHoldsOnlyWhileBothKindsWait() throws {
        let rows = try rows().rows
        XCTAssertEqual(ItemsFilter.all.rows(rows, atLine: ["i2"], applyAbove: 0.5).map(\.id), ["q1", "i2", "i3"])
        XCTAssertEqual(ItemsFilter.questions.rows(rows, atLine: ["i2"], applyAbove: 0.5).map(\.id), ["q1"])
        // A suggestion is an open item at the apply line (the meeting list's count); i3 is decided with no confidence.
        XCTAssertEqual(ItemsFilter.suggestions.rows(rows, atLine: ["i2"], applyAbove: 0.5).map(\.id), ["i2"])
        XCTAssertEqual(ItemsFilter.suggestions.rows(rows, atLine: [], applyAbove: 0.9).map(\.id), [], "below the line: under All only")
        var confirmed = rows[1]
        confirmed.status = "confirmed"
        XCTAssertTrue(ItemsFilter.isSuggestion(confirmed, atLine: [], applyAbove: 0.5), "a row confirmed here keeps its place in the filter")
        XCTAssertEqual(ItemsFilter.effective(.questions, questions: 1, suggestions: 1), .questions)
        XCTAssertEqual(ItemsFilter.effective(.questions, questions: 0, suggestions: 1), .all, "the last question is answered: the suggestions show")
        XCTAssertEqual(ItemsFilter.effective(.suggestions, questions: 2, suggestions: 0), .all, "no suggestion at the line: every row shows")
        XCTAssertEqual(ItemsTab.kindsTooltip(suggestions: 181, belowLine: 355, line: "50 %"),
                       "Suggestions: the 181 items at 50 % or more, which Confirm all takes and the meeting list counts. 355 more wait below 50 %; All shows them.")
        XCTAssertEqual(SelectionPopover.started("", with: "Fix the speaker"), "Fix the speaker: ")
        XCTAssertEqual(SelectionPopover.started("Fix the speaker: it is Mira", with: "Make this a question"), "Make this a question: it is Mira")
    }

    /// The filter bar builds one strip, picked from the room its slot has: counts while they fit, then the titles at
    /// their own width, then the titles sharing the room. The order the `ViewThatFits` it replaced tried them in.
    func testTheFilterBarPicksOneStripFromItsRoom() {
        XCTAssertEqual(ItemsFilter.Bar.pick(room: nil, counts: 260, titles: 200), .counts, "before the first layout")
        XCTAssertEqual(ItemsFilter.Bar.pick(room: 400, counts: 260, titles: 200), .counts)
        XCTAssertEqual(ItemsFilter.Bar.pick(room: 260, counts: 260, titles: 200), .counts, "a strip that fits exactly")
        XCTAssertEqual(ItemsFilter.Bar.pick(room: 259, counts: 260, titles: 200), .titles)
        XCTAssertEqual(ItemsFilter.Bar.pick(room: 199, counts: 260, titles: 200), .shared)
        XCTAssertEqual(ItemsFilter.Bar.pick(room: 0, counts: 260, titles: 200), .shared)
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

    func testAHeldDecidedRowKeepsItsChoicesAndHeight() throws {
        let detail = MeetingDetailModel(id: "m", window: nil)
        let open = try JSONDecoder().decode(ReviewRow.self, from: Data("""
        {"id":"q1","label":"Q1","kind":"question","kindWord":"Question","status":"suggested","what":"Who speaks?","edit":"answer","sources":[],"parts":[],
         "choices":[{"value":"Dana Example","label":"Dana Example","role":"suggested","action":{"kind":"answer","answer":"Dana Example"}},
                    {"value":"Alex Example","label":"Alex Example","role":"candidate","action":{"kind":"answer","answer":"Alex Example"}}],
         "target":{"kind":"item","id":"q1"}}
        """.utf8))
        var answered = open
        answered.status = "confirmed"
        answered.answer = "Dana Example"
        for width in [320.0, 680.0] {
            let before = ImageRenderer(content: ReviewRowView(row: open, detail: detail, player: nil, selected: true).frame(width: width).background(Color.white).environment(\.colorScheme, .light))
            let after = ImageRenderer(content: ReviewRowView(row: answered, detail: detail, player: nil, selected: true, held: true).frame(width: width).background(Color.white).environment(\.colorScheme, .light))
            before.scale = 2
            after.scale = 2
            let original = try XCTUnwrap(before.cgImage)
            let held = try XCTUnwrap(after.cgImage)
            XCTAssertEqual(held.height, original.height, "answering keeps the choices' layout at width \(width)")
            let request = VNRecognizeTextRequest()
            // These large Latin labels need the fast recognizer. The accurate recognizer initializes an unrelated
            // E5RT model that fails before recognition on some macOS builds; keep the same rendered-word assertions.
            request.recognitionLevel = .fast
            request.usesLanguageCorrection = false
            for (stage, devices) in try request.supportedComputeStageDevices {
                let cpu = try XCTUnwrap(devices.first { device in
                    if case .cpu = device { return true }
                    return false
                }, "OCR needs a CPU device for \(stage)")
                request.setComputeDevice(cpu, for: stage)
            }
            try VNImageRequestHandler(cgImage: held).perform([request])
            let text = (request.results ?? []).compactMap { $0.topCandidates(1).first?.string }.joined(separator: " ")
            XCTAssertTrue(text.contains("Dana Example"), text)
            XCTAssertTrue(text.contains("Alex Example"), "the other answer stays available: \(text)")
            XCTAssertFalse(text.contains("Revert and edit"), "the choices occupy their original slot: \(text)")
        }
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
        XCTAssertEqual(ItemsTab.returnAction(for: rows[1], key: .edit, editing: true), .submit,
                       "the second Return saves the existing draft instead of reopening its editor")
        XCTAssertEqual(ItemsTab.returnAction(for: rows[0], key: .confirm, editing: true), .submit,
                       "an active custom answer takes precedence over the suggested choice")
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

    func testCommentAndWordSplitReachTheJournalIntactWithoutTheService() throws {
        let comment = DecisionAction.answer("q1", "", comment: "Please listen again")
        var split = DecisionAction.answer("q2", "Alice Example, then Bob Example", segments: [
            .init(fromWord: 0, speaker: "Alice Example"), .init(fromWord: 4, speaker: "Bob Example")
        ])
        split.except = ["i3"]
        split.replaces = "previous"
        for action in [comment, split] {
            let args = try XCTUnwrap(MeetingDetailModel.commandArgs(meeting: "copy", action: action, reason: "by ear"))
            guard Array(args.prefix(3)) == ["decide", "copy", "--action"], args.count > 3 else {
                XCTFail("The fallback dropped the structured answer for \(action.question ?? "the question"): \(args)")
                continue
            }
            let payload = try JSONDecoder().decode(DecisionAction.self, from: Data(args[3].utf8))
            XCTAssertEqual(payload, action)
            XCTAssertEqual(Array(args.dropFirst(4)), ["--reason", "by ear", "--json"])
        }
    }

    func testOnlyThisQuestionKeepsItsWireKeyWithoutTheService() throws {
        var only = DecisionAction.answer("q1", "Dana Example")
        XCTAssertNotNil(MeetingDetailModel.commandArgs(meeting: "m", action: only, reason: nil))
        only.lookAlikes = "leave"
        let args = try XCTUnwrap(MeetingDetailModel.commandArgs(meeting: "m", action: only, reason: nil))
        XCTAssertEqual(Array(args.prefix(3)), ["decide", "m", "--action"])
        let decoded = try JSONDecoder().decode(DecisionAction.self, from: Data(args[3].utf8))
        XCTAssertEqual(decoded, only)
        let wire = try XCTUnwrap(String(data: JSONEncoder().encode(only), encoding: .utf8))
        XCTAssertTrue(wire.contains(#""lookAlikes":"leave""#), wire)
    }

    func testAReplacementAnswerKeepsItsStruckItemsWithoutTheService() {
        var action = DecisionAction.answer("q1", "Alex Example")
        action.except = ["q2", "i3"]
        action.replaces = "earlier-token"
        XCTAssertEqual(MeetingDetailModel.commandArgs(meeting: "m", action: action, reason: "heard it"),
                       ["listen", "m", "--item", "q1", "--answer", "Alex Example", "--except", "q2", "i3",
                        "--replaces", "earlier-token", "--reason", "heard it", "--json"])
    }

    // MARK: A decision and what it carries (genesiscz.md 6, 9, 12a)

    /// A plan's reach as `decision.plan` sends it: a target outside the asked span with its own row, a look-alike, the
    /// same question over the same span, and one item struck by the answer this one replaces.
    static let reachJSON = Data("""
    {"items":[
     {"id":"i3","match":"same","role":"sets","before":"Speaker 3","after":"Dana Example",
      "row":{"id":"i3","label":"i3","kind":"speaker-range","status":"suggested","what":"Speaker 3 00:12–00:30","edit":"person","sources":[],
             "parts":[{"kind":"said","text":"The button moved."},{"kind":"when","from":{"sec":12,"text":"00:12"},"to":{"sec":30,"text":"00:30"},"target":{"kind":"item","id":"i3"}}],
             "choices":[],"target":{"kind":"item","id":"i3"}}},
     {"id":"q2","match":"same","role":"look-alike","after":"Dana Example","struck":true},
     {"id":"q3","match":"same","role":"same","after":"Dana Example"}],
     "dictionary":[]}
    """.utf8)

    func testSpellingReachDecodesAndTheActionKeepsSelectedLines() throws {
        let reach = try JSONDecoder().decode(DecisionReach.self, from: Data(#"{"items":[],"dictionary":[],"spelling":{"occurrences":[{"line":2,"atSec":15,"speaker":"Alex","text":"Ada is here","selected":true,"primary":true},{"line":3,"atSec":20,"speaker":"Jordan","text":"Ada again","selected":false,"primary":false}],"dictionary":false}}"#.utf8))
        XCTAssertEqual(reach.spelling?.occurrences.map(\.line), [2, 3])
        XCTAssertEqual(reach.spelling?.dictionary, false)
        XCTAssertFalse(reach.isEmpty)
        var action = DecisionAction.respell("i1", to: "ADA")
        action.reach = .init(lines: [.init(atSec: 15, line: 2)], dictionary: false)
        let decoded = try JSONDecoder().decode(DecisionAction.self, from: JSONEncoder().encode(action))
        XCTAssertEqual(decoded, action)
        XCTAssertEqual(decoded.reach?.lines?.first?.line, 2)
    }

    func testTheReachSortsTargetsFromLookAlikesAndNeverAsksTheSameQuestionTwice() throws {
        let reach = try JSONDecoder().decode(DecisionReach.self, from: Self.reachJSON)
        XCTAssertEqual(reach.items.map(\.role), [.sets, .lookAlike, .same])
        XCTAssertEqual(reach.judged.map(\.id), ["i3", "q2"], "the same question over the same span is not judged again")
        XCTAssertEqual(reach.items[0].row?.whenText, "00:12–00:30", "each item carries its own time and play target")
        let onlySame = DecisionReach(items: [.init(id: "q3", role: .same)], lines: nil, dictionary: [])
        XCTAssertTrue(onlySame.isEmpty, "a reach that is only the asked question itself opens no sheet")
        let old = try JSONDecoder().decode(DecisionReach.self, from: Data(#"{"items":[{"id":"q2","match":"same"}],"dictionary":[]}"#.utf8))
        XCTAssertEqual(old.items.first?.role, .lookAlike, "an engine older than the roles listed only look-alikes")

        let pending = MeetingDetailModel.PendingReach(row: try rows().rows[0], action: .answer("q1", "Dana Example"), reason: nil, reach: reach)
        XCTAssertEqual(pending.initiallyStruck(), ["q2"], "what the replaced answer left out starts struck")
        XCTAssertEqual(pending.initiallyStruck(remembered: ["i3", "gone"]), ["q2", "i3"], "only items the sheet shows can start struck")
    }

    func testOnlyThisQuestionHonorsDoNotAskAgain() throws {
        let (defaults, suite) = try defaults()
        defer { defaults.removePersistentDomain(forName: suite) }
        let window = MeetingsWindowModel(defaults: defaults, service: nil, loadDetail: { _ in })
        let detail = MeetingDetailModel(id: "m", window: window)
        let row = try rows().rows[0]
        let pending = MeetingDetailModel.PendingReach(row: row, action: .answer("q1", "Dana Example"), reason: nil,
            reach: try JSONDecoder().decode(DecisionReach.self, from: Self.reachJSON))
        detail.busyItems.insert(row.id) // isolate the checkbox from the asynchronous write
        detail.applyOnlyThis(pending, askAgain: true)
        XCTAssertEqual(MeetingsPreferences.Rows.askReach.value(defaults), .always)
        detail.applyOnlyThis(pending, askAgain: false)
        XCTAssertEqual(MeetingsPreferences.Rows.askReach.value(defaults), .never)
    }

    func testAssignmentAndProjectJournalPayloadsInvalidateCorrectedSpeech() throws {
        func decode(_ extra: [String: Any]) throws -> JournalEntry {
            var value: [String: Any] = ["token": "t1", "at": "2026-11-12T00:00:00Z", "meeting": "m", "actor": ["kind": "window"],
                "action": ["kind": "revert", "token": "old"]]
            value.merge(extra) { _, new in new }
            return try JSONDecoder().decode(JournalEntry.self, from: JSONSerialization.data(withJSONObject: value))
        }
        let assignment: [String: Any] = ["id": "a1", "label": "Speaker 1", "fromSec": 10, "toSec": 20,
            "person": "Dana Example", "at": "2026-11-12T00:00:00Z"]
        let assigned = try decode(["assignments": [["id": "a1", "after": assignment]]])
        XCTAssertEqual(assigned.assignments.first?.after?.person, "Dana Example")
        XCTAssertTrue(assigned.changesTranscript)
        let undone = try decode(["assignments": [["id": "a1", "before": assignment]]])
        XCTAssertTrue(undone.changesTranscript, "Undo also changes the corrected speakers")
        XCTAssertTrue(try decode(["fields": [["field": "project", "after": "work"]]]).changesTranscript)
        XCTAssertFalse(try decode(["fields": [["field": "title", "after": "A new title"]]]).changesTranscript)
    }

    func testALongDecidedAnswerWrapsInANarrowColumn() throws {
        let detail = MeetingDetailModel(id: "m", window: nil)
        func height(_ answer: String) throws -> CGFloat {
            let json: [String: Any] = ["id": "q1", "label": "Q1", "kind": "question", "kindWord": "Question", "status": "confirmed", "answer": answer,
                "what": "Who owns the next action?", "edit": "answer", "sources": [], "parts": [], "choices": [],
                "target": ["kind": "item", "id": "q1"]]
            let row = try JSONDecoder().decode(ReviewRow.self, from: JSONSerialization.data(withJSONObject: json))
            let host = NSHostingView(rootView: ReviewRowView(row: row, detail: detail, player: nil, foldedFit: 2).frame(width: 350))
            return host.fittingSize.height
        }
        let short = try height("Dana Example")
        let long = try height(String(repeating: "The owner will verify the package, update the documentation and report the result. ", count: 4))
        XCTAssertGreaterThan(long, short + 30, "the saved answer must remain fully readable")
    }

    /// The sheet as a picture (`MEETINGS_UI_SNAPSHOTS=<folder>` keeps it): one target struck, one look-alike, the same
    /// question as a line, and the strike toggle comes undone with one more click.
    func testTheReachSheetStrikesAndUnstrikesAnItemAndRenders() throws {
        let window = MeetingsWindowModel(defaults: try XCTUnwrap(UserDefaults(suiteName: "meetings.rows.tests.\(UUID().uuidString)")),
                                         noticeClock: ManualNoticeClock(), service: nil, loadDetail: { _ in })
        let detail = MeetingDetailModel(id: "m", window: window)
        detail.rows = .loaded(try rows())
        let reach = try JSONDecoder().decode(DecisionReach.self, from: Self.reachJSON)
        let pending = MeetingDetailModel.PendingReach(row: try rows().rows[0], action: .answer("q1", "Dana Example"), reason: nil, reach: reach)
        detail.pendingReach = pending
        detail.pendingStruck = pending.initiallyStruck()
        detail.toggleStruck("i3")
        XCTAssertEqual(detail.pendingStruck, ["q2", "i3"])
        try TimelineSnapshot.write(ReachList(pending: pending, detail: detail).padding(18), name: "reach-sheet", width: 520, scheme: .dark)
        detail.toggleStruck("i3")
        XCTAssertEqual(detail.pendingStruck, ["q2"], "a second click puts the item back")
        try TimelineSnapshot.write(ReachList(pending: pending, detail: detail).padding(18), name: "reach-sheet-unstruck", width: 520, scheme: .light)
        // The card over the column (no window sheet): the backdrop, the card, its buttons; a narrow column narrows it.
        try TimelineSnapshot.write(ReachOverlay(detail: detail).frame(height: 560), name: "reach-card", width: 680, scheme: .dark)
        try TimelineSnapshot.write(ReachOverlay(detail: detail).frame(height: 560), name: "reach-card-narrow", width: 440, scheme: .dark)
        XCTAssertEqual(ReachSheet.lead(pending), "Besides Q1 (→ Dana Example), this decision also changes:")
        XCTAssertEqual(ReachList.sameLine(reach.items.filter { $0.role == .same }, detail: detail),
                       "It also closes 1 question, about the same span: the same question, not asked again.",
                       "a question no row names is counted, never shown by its item id")
        detail.cancelReach()
        XCTAssertTrue(detail.pendingStruck.isEmpty)
    }

    func testAStruckItemLeavesTheAnswerAndAChangedAnswerNamesTheOneItReplaces() throws {
        let rows = try rows().rows
        let answer = DecisionAction.answer("q1", "Dana Example")
        XCTAssertNil(MeetingDetailModel.striking(answer, []).except)
        let struck = MeetingDetailModel.striking(answer, ["q2", "i3"])
        XCTAssertEqual(struck.except, ["i3", "q2"])
        XCTAssertEqual(MeetingDetailModel.commandArgs(meeting: "m", action: struck, reason: nil),
                       ["listen", "m", "--item", "q1", "--answer", "Dana Example", "--except", "i3", "q2", "--json"])

        XCTAssertNil(MeetingDetailModel.changing(answer, on: rows[0]).replaces, "an open question is answered, not changed")
        let decided = try JSONDecoder().decode(ReviewRow.self, from: Data("""
        {"id":"q1","label":"Q1","kind":"question","kindWord":"Question","status":"confirmed","what":"Who says this?","edit":"answer","sources":[],"parts":[],
         "choices":[{"value":"Dana Example","label":"Dana Example","role":"suggested","action":{"kind":"answer","answer":"Dana Example"}},
                    {"value":"Alex Example","label":"Alex Example","role":"candidate","action":{"kind":"answer","answer":"Alex Example"}}],
         "target":{"kind":"item","id":"q1"},"answer":"Alex Example",
         "decision":{"token":"t-old","actor":{"kind":"window"},"by":"you","action":"answer"}}
        """.utf8))
        let changed = MeetingDetailModel.changing(answer, on: decided)
        XCTAssertEqual(changed.replaces, "t-old", "a choice on an answered question changes that answer in one entry")
        let wire = try XCTUnwrap(String(data: JSONEncoder().encode(MeetingDetailModel.striking(changed, ["i3"])), encoding: .utf8))
        XCTAssertTrue(wire.contains(#""replaces":"t-old""#) && wire.contains(#""except":["i3"]"#), wire)

        // Suggested, confirmed and rejected each have their own state, so their own hue and glyph.
        XCTAssertEqual(DecisionState.of(rows[0].choices[0], in: rows[0]), .suggested)
        XCTAssertEqual(DecisionState.of(decided.choices[1], in: decided), .confirmed, "the answer of a decided row is confirmed")
        XCTAssertEqual(DecisionState.of(decided.choices[0], in: decided), .suggested)
        for state in [DecisionState.suggested, .confirmed, .rejected] {
            XCTAssertNotNil(state.glyph(.hueAndGlyph))
            XCTAssertNotNil(state.hue(.hueAndGlyph))
        }
        XCTAssertNotEqual(DecisionState.suggested.glyph(.hueAndGlyph), DecisionState.confirmed.glyph(.hueAndGlyph))
        XCTAssertNotEqual(DecisionState.suggested.hue(.hueAndGlyph), DecisionState.confirmed.hue(.hueAndGlyph))
        XCTAssertNil(DecisionState.confirmed.hue(.shade), "the older look stays reachable as a setting")
        XCTAssertEqual(MeetingsPreferences.Rows.stateLook.defaultValue, .hueAndGlyph)
    }

    func testAFutureJournalActionExplainsItsOriginWithoutOfferingUndo() throws {
        let future = try entry(token: "future", action: #"{"kind":"unsupported","name":"future-action"}"#, changes: [])
        XCTAssertFalse(future.canUndo)
        XCTAssertEqual(MeetingsWords.entryAction(future), "made a decision with a newer build (future-action)")
        let known = try entry(token: "known", action: #"{"kind":"confirm","items":["i1"]}"#, changes: [("i1", "suggested", "confirmed")])
        XCTAssertTrue(known.canUndo)
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

    func testQuestionWordingAndAnswerDraftsStaySeparate() throws {
        let row = try rows().rows[0]
        let detail = MeetingDetailModel(id: "m", window: nil, service: nil)
        detail.drafts[row.id] = "An answer draft"
        detail.editQuestion(row)
        XCTAssertEqual(detail.questionDrafts[row.id]?.original, ReviewRowView.asked(row))
        detail.questionDrafts[row.id]?.text = "A clearer question?"
        detail.closeEditor()
        detail.editQuestion(row)
        XCTAssertEqual(detail.questionDrafts[row.id]?.text, "A clearer question?")
        XCTAssertEqual(detail.drafts[row.id], "An answer draft")
        detail.edit(row)
        XCTAssertNil(detail.editingQuestion)
        XCTAssertEqual(detail.questionDrafts[row.id]?.text, "A clearer question?")
        let action = DecisionAction.rephrase(row.id, text: "A clearer question?", was: "Old wording?")
        let encoded = try JSONEncoder().encode(action)
        XCTAssertEqual(try JSONDecoder().decode(DecisionAction.self, from: encoded), action)
        XCTAssertFalse(MeetingDetailModel.mayReach(action))
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
        XCTAssertEqual(MeetingDetailModel.commandArgs(meeting: "m", action: .respell("i2", to: "EMP"), reason: nil)?.first,
                       "decide", "respelling uses the complete decision command")
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
        // The fixture's decided row has no choices, so that line passes whatever the status does: the open row decided
        // keeps its candidates and still shows none.
        var confirmed = open
        confirmed.status = "confirmed"
        XCTAssertFalse(confirmed.choices.isEmpty, "the decided copy keeps its choices")
        XCTAssertTrue(PinCard.shownChoices(confirmed).isEmpty, "the decided status hides the choices it still holds")
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

    /// A Screen row lists what changed in the frame before its menu bar, which the OCR reads first.
    func testAScreenRowListsTheMenuBarLast() {
        func box(_ text: String, y: Double) -> OcrBox { OcrBox(x: 10, y: y, width: 80, height: 20, text: text, confidence: 1) }
        let lines = [box("Messages", y: 4), box("Edit", y: 4), box("Ship the DTO on Friday", y: 400), box("Window", y: 6),
                     box("Reply", y: 900)]
        XCTAssertEqual(FrameRow.listed(lines, frameHeight: 1200).map(\.text), ["Ship the DTO on Friday", "Reply", "Messages", "Edit", "Window"])
        let menuOnly = [box("Messages", y: 4), box("Edit", y: 4)]
        XCTAssertEqual(FrameRow.listed(menuOnly, frameHeight: 1200), menuOnly, "a frame whose new text is all menu words lists it as read")
    }

    /// The list keeps a row it selects after a Skip or an answer clear of the notice that the Skip left at its edge.
    func testTheListKeepsRoomForTheNoticesAtItsEdge() {
        XCTAssertEqual(ItemsTab.noticeRoom(count: 0, limit: nil), 0, "no notice, no room: the list ends at the window's edge")
        XCTAssertEqual(ItemsTab.noticeRoom(count: 1, limit: nil), 78)
        XCTAssertEqual(ItemsTab.noticeRoom(count: 2, limit: nil), 144)
        XCTAssertEqual(ItemsTab.noticeRoom(count: 5, limit: 2), 172, "folded notices take one chip, not a pill each")
        XCTAssertEqual(ItemsTab.noticeRoom(count: 8, limit: nil), 378, "reserve only the capped stack plus its outer inset")
    }

    /// A transcript line at the row's own time, whose words the row already quotes, is the header's time button again.
    func testTheFromLineLeavesOutTheRowsOwnTime() throws {
        let row = try JSONDecoder().decode(ReviewRow.self, from: Data("""
        {"id":"i9","label":"i9","kind":"term","kindWord":"Word","status":"suggested","what":"OMP → EMP","edit":"spelling","choices":[],
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
    func testTheDockNamesARowByItsKindAndTime() throws {
        let rows = try rows().rows
        let word = MomentLayer(meeting: "m", target: .item("i2"), source: .row, kind: .moment, label: "i2")
        XCTAssertEqual(TimelineDock.crumbTitle(of: word, meeting: "m", rows: rows), "Word 05:09", "an item id names nothing to a reader")
        let question = MomentLayer(meeting: "m", target: .item("q1"), source: .row, kind: .moment, label: "Q1")
        XCTAssertEqual(TimelineDock.crumbTitle(of: question, meeting: "m", rows: rows), "Q1", "a question keeps its label")
        let elsewhere = MomentLayer(meeting: "other", target: .item("i2"), source: .row, kind: .moment, label: "i2")
        XCTAssertEqual(TimelineDock.crumbTitle(of: elsewhere, meeting: "m", rows: rows), "i2", "the rows of another meeting name nothing here")
        let span = ZoomSpan(startSec: 308, endSec: 320, fromSec: 309, toSec: 311, spotSec: 309, label: "i2")
        XCTAssertEqual(TimelineDock.flagged(span, top: word, meeting: "m", rows: rows).label, "Word", "the flag's time stands before its words")
        XCTAssertEqual(TimelineDock.flagged(span, top: question, meeting: "m", rows: rows).label, "i2", "a question's span keeps its words")
    }

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
    func testAFoldedRowTakesTheWidestShapeItsRoomHoldsAsItsOwnLayoutMeasuresIt() throws {
        guard let decided = try rows().rows.first(where: { $0.id == "i3" }) else { return XCTFail("the fixture's decided row") }
        let shapes = ReviewRowView.foldedShapes(isQuestion: ReviewRowView.foldedAnswer(decided) != nil)
        let needs = shapes.map { ReviewRowView.foldedNeed(decided, shape: $0, busy: false) }
        XCTAssertEqual(needs, needs.sorted(by: >), "each shape needs less room than the one before it")
        XCTAssertEqual(ReviewRowView.foldedFit(decided, busy: false, room: nil), 0, "the widest before the first layout")
        XCTAssertEqual(ReviewRowView.foldedFit(decided, busy: false, room: needs[0]), 0, "a shape that fits exactly")
        XCTAssertEqual(ReviewRowView.foldedFit(decided, busy: false, room: needs[0] - 1), 1)
        XCTAssertEqual(ReviewRowView.foldedFit(decided, busy: false, room: needs[1] - 1), 2)
        XCTAssertEqual(ReviewRowView.foldedFit(decided, busy: false, room: 0), 2, "the narrowest when none fits, as ViewThatFits did")
        XCTAssertGreaterThan(ReviewRowView.foldedNeed(decided, shape: shapes[0], busy: true), needs[0], "a busy row's spinner takes room")
        // The arithmetic follows the line term by term: the row's own ideal width in each shape is what it computes.
        let detail = MeetingDetailModel(id: "m", window: nil)
        for (fit, need) in needs.enumerated() {
            let ideal = NSHostingView(rootView: ReviewRowView(row: decided, detail: detail, player: nil, foldedFit: fit)).fittingSize.width
            XCTAssertEqual(ideal, need, accuracy: 2, "shape \(fit)")
        }
    }

    func testARowSeesThePlayerOnlyThroughItsOwnMoments() {
        let layer = MomentLayer(meeting: "m", target: .item("i2"), source: .row, kind: .moment, label: "i2")
        var play = MomentPlay(top: layer, phase: .playing)
        XCTAssertEqual(play.button(.item("i2")), MomentButton.Shown(reason: nil, top: true, playing: true))
        XCTAssertEqual(play.button(.time(12)), MomentButton.Shown(), "another Moment of the row is neither top nor playing")
        play.phase = .paused
        XCTAssertEqual(play.button(.item("i2")), MomentButton.Shown(reason: nil, top: true, playing: false))
        XCTAssertNotEqual(play, .none, "a row whose Moment is on top differs from one without")
    }

    func testThePlayingBarNeedsRoomForItsLength() {
        XCTAssertGreaterThan(PlayingRowBar.smallestWidth(length: true), PlayingRowBar.smallestWidth(length: false) + 60,
                             "\"12 min clip\" needs about 60 pt")
        XCTAssertGreaterThanOrEqual(PlayingRowBar.smallestWidth(length: false), 4 * FlagMark.hitWidth,
                                    "a bar shorter than a few flags is only its flag")
        let text = PlayingRowBar.lengthText(TimelineFixture.span)
        XCTAssertTrue(text.hasSuffix(" clip"), text)
        XCTAssertFalse(text.contains("→"), "the clip's two ends stood one second from the row's own span beside the bar")
    }

    // MARK: The owner's Items round (U13 to U17)

    /// The reason one agent pass gave on many rows at once: long, so on one line it took the row's whole width.
    static let passReason = "Second pass (agent): the seat rule contradicts the audio of the call (the microphone held under a third of "
        + "the energy), so the seat mark is wrong on this line; replaced by agent findings and nine new questions about the stretch."

    /// A row as `meeting.rows` sends it, from its fields.
    private func row(_ fields: [String: Any]) throws -> ReviewRow {
        var json: [String: Any] = ["edit": "none", "sources": [Any](), "parts": [Any](), "choices": [Any]()]
        json.merge(fields) { _, new in new }
        if json["target"] == nil, let id = json["id"] as? String { json["target"] = ["kind": "item", "id": id] }
        return try JSONDecoder().decode(ReviewRow.self, from: JSONSerialization.data(withJSONObject: json))
    }

    private static func passDecision(_ action: String) -> [String: Any] {
        ["token": "t-pass", "actor": ["kind": "agent", "harness": "claude-code", "session": "11111111-2222-4333-8444-555555555555"],
         "by": "an agent (Claude Code, session 11111111)", "action": action, "reason": passReason, "at": "2026-11-18T17:15:07.000Z"]
    }

    /// i132 of the owner's shot 14: a speaker range an agent pass rejected.
    private func rejectedRange() throws -> ReviewRow {
        try row(["id": "i132", "label": "i132", "kind": "speaker-range", "kindWord": "Speaker range", "status": "rejected",
                 "confidence": 0.95, "what": "Speaker 5 18:03 → Alice Example", "edit": "person",
                 "parts": [["kind": "when", "from": ["sec": 1083, "text": "18:03"], "target": ["kind": "item", "id": "i132"]]],
                 "decision": Self.passDecision("reject")])
    }

    /// Q5 of the owner's shot 15: a question the same pass rejected.
    private func rejectedQuestion() throws -> ReviewRow {
        try row(["id": "q5", "label": "Q5", "kind": "question", "kindWord": "Question", "status": "rejected", "what": "Who speaks?",
                 "edit": "answer",
                 "parts": [["kind": "when", "from": ["sec": 1647, "text": "27:27"], "target": ["kind": "item", "id": "q5"]],
                           ["kind": "asks", "pieces": [["text": "Who speaks under Speaker 5 here?"]]]],
                 "decision": Self.passDecision("reject")])
    }

    /// i126 of the owner's shot 13: a speaker range the voice model named, with the voice behind it (`row.voice`) and
    /// the labeler's sentence that the voice line replaces.
    private func voiceRow() throws -> ReviewRow {
        try row(["id": "i126", "label": "i126", "kind": "speaker-range", "kindWord": "Speaker range", "status": "suggested",
                 "confidence": 0.6083, "rules": ["voice-embedding"], "what": "Speaker 2 17:11 → Alice Example", "edit": "person",
                 "parts": [["kind": "when", "from": ["sec": 1031, "text": "17:11"], "target": ["kind": "item", "id": "i126"]],
                           ["kind": "reason", "pieces": [["text": "Sounds like Alice Example: 0.61 match, next closest Bob Example 0.40"]]]],
                 "choices": [["value": "Alice Example", "label": "Alice Example", "role": "suggested", "action": ["kind": "confirm"],
                              "confidence": 0.6083]],
                 "voice": ["person": "Alice Example", "score": 0.6083, "next": ["person": "Bob Example", "score": 0.4021],
                           "samples": ["count": 6, "meetings": 2], "seat": "call", "support": false]])
    }

    /// The words a view shows, read from a picture of it: a hosted view has no accessibility tree in a test.
    private func shownText<V: View>(_ view: V, width: CGFloat) throws -> String {
        let renderer = ImageRenderer(content: view.frame(width: width).background(Color.white).environment(\.colorScheme, .light))
        renderer.scale = 3
        let request = VNRecognizeTextRequest()
        // The accurate recognizer initializes an E5RT model that fails on some macOS builds (see the held-row test).
        request.recognitionLevel = .fast
        request.usesLanguageCorrection = false
        for (stage, devices) in try request.supportedComputeStageDevices {
            let cpu = try XCTUnwrap(devices.first { device in
                if case .cpu = device { return true }
                return false
            }, "OCR needs a CPU device for \(stage)")
            request.setComputeDevice(cpu, for: stage)
        }
        try VNImageRequestHandler(cgImage: XCTUnwrap(renderer.cgImage)).perform([request])
        return (request.results ?? []).compactMap { $0.topCandidates(1).first?.string }.joined(separator: " ")
    }

    /// The Items tab in a window the screen does not show, with the probes on, for a click on a probed control.
    private func hostedItems(_ detail: MeetingDetailModel, defaults: UserDefaults, height: CGFloat = 420) -> NSWindow {
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 640, height: height), styleMask: [.borderless],
                              backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.alphaValue = 0
        window.ignoresMouseEvents = true
        window.level = .init(rawValue: Int(CGWindowLevelForKey(.desktopWindow)) - 1)
        window.contentView = NSHostingView(rootView: ItemsTab(detail: detail).defaultAppStorage(defaults).frame(width: 640, height: height))
        window.orderFrontRegardless()
        return window
    }

    private func settle() { RunLoop.main.run(until: Date().addingTimeInterval(0.4)) }

    /// One click at the middle of a probed frame (top-left origin, as SwiftUI's global space).
    private func click(_ frame: CGRect, in host: NSWindow) throws {
        let point = NSPoint(x: frame.midX, y: host.frame.height - frame.midY)
        for type in [NSEvent.EventType.mouseMoved, .leftMouseDown, .leftMouseUp] {
            let event = try XCTUnwrap(NSEvent.mouseEvent(with: type, location: point, modifierFlags: [],
                                                       timestamp: ProcessInfo.processInfo.systemUptime,
                                                       windowNumber: host.windowNumber, context: nil,
                                                       eventNumber: 0, clickCount: 1, pressure: 1))
            host.sendEvent(event)
            RunLoop.main.run(until: Date().addingTimeInterval(0.01))
        }
    }

    /// U15: the Questions tab counted 9 open questions and listed 41 rows, 32 of them rejected, first.
    func testTheQuestionsFilterListsOnlyOpenQuestionsSoTheListMatchesItsCount() throws {
        let rows = try rows().rows
        let mixed = [try rejectedQuestion()] + rows
        XCTAssertEqual(ItemsFilter.questions.rows(mixed, atLine: [], applyAbove: 0.5).map(\.id), ["q1"],
                       "only the open question, as the tab's count says")
        XCTAssertEqual(ItemsFilter.all.rows(mixed, atLine: [], applyAbove: 0.5).count, 4, "All keeps the decided history")
    }

    /// U15, U16: decided rows follow the open ones by default; a row this window just decided keeps its place (G33).
    func testDecidedRowsGoToTheEndAndARowJustDecidedKeepsItsPlace() throws {
        let atEnd = try XCTUnwrap(MeetingsPreferences.Rows.Decided(rawValue: "atEnd"), "a third way for meetings.rows.decided")
        // Q5 rejected at 27:27, q1 open at 20:00, i2 open at 05:09, i3 confirmed at 00:12.
        let rows = [try rejectedQuestion()] + (try rows().rows)
        XCTAssertEqual(MeetingDetailModel.visibleRows(rows, order: .priority, decided: atEnd).map(\.id), ["q1", "i2", "q5", "i3"])
        XCTAssertEqual(MeetingDetailModel.visibleRows(rows, order: .time, decided: atEnd).map(\.id), ["i2", "q1", "i3", "q5"],
                       "open rows by time, then decided rows by time")
        XCTAssertEqual(MeetingDetailModel.visibleRows(rows, order: .priority, decided: atEnd, keeping: ["q5"]).map(\.id),
                       ["q5", "q1", "i2", "i3"], "the row under the pointer does not jump to the end until the reader scrolls")
        XCTAssertEqual(MeetingDetailModel.visibleRows(rows, order: .priority, decided: .inPlace).map(\.id), ["q5", "q1", "i2", "i3"],
                       "in place keeps the engine's order")
        XCTAssertEqual(SidePanelWords.choiceTitles["atEnd"], "At the end", "the settings name the choice in words, not its key")
    }

    /// U14: the folded line of a rejected row showed "i132 …" and then the agent's whole reason, cut at the window's edge.
    func testAFoldedDecidedRowShowsItsItemTextAndAShortStatus() throws {
        let detail = MeetingDetailModel(id: "m", window: nil)
        let range = try shownText(ReviewRowView(row: try rejectedRange(), detail: detail, player: nil, foldedFit: 0), width: 900)
        XCTAssertTrue(range.contains("Speaker 5 18:03"), "the item text comes first: \(range)")
        XCTAssertTrue(range.contains("Alice Example"), range)
        XCTAssertTrue(range.contains("Rejected by an agent"), range)
        XCTAssertFalse(range.contains("seat rule"), "the reason waits for the unfolded row and the tooltip: \(range)")
        let question = try shownText(ReviewRowView(row: try rejectedQuestion(), detail: detail, player: nil, foldedFit: 0), width: 900)
        XCTAssertTrue(question.contains("Who speaks under Speaker 5"), "a rejected question shows what it asked: \(question)")
    }

    /// U14: a click on a folded row unfolds it with the whole reason as a paragraph; its chevron folds it again.
    func testAClickUnfoldsADecidedRowWithItsWholeReasonAndTheChevronFoldsIt() throws {
        FrameProbe.enabled = true
        FrameProbe.reset()
        defer { FrameProbe.enabled = false; FrameProbe.reset() }
        let (defaults, suite) = try defaults()
        defer { defaults.removePersistentDomain(forName: suite) }
        let window = MeetingsWindowModel(defaults: defaults, noticeClock: ManualNoticeClock(), service: nil, loadDetail: { _ in })
        let detail = MeetingDetailModel(id: "m", window: window)
        detail.rows = .loaded(.init(meeting: "m", rows: [try rejectedRange()], hidden: .init(lowPriority: 0, minPriority: 0.5)))
        let host = hostedItems(detail, defaults: defaults)
        defer { host.orderOut(nil); host.close() }
        settle()
        XCTAssertNil(FrameProbe.frames["meetings.row.i132.why"], "folded, the reason stays in the tooltip")
        try click(try XCTUnwrap(FrameProbe.frames["meetings.row.i132.folded"], "the folded line is one click target"), in: host)
        settle()
        let why = try XCTUnwrap(FrameProbe.frames["meetings.row.i132.why"], "a click unfolds the row with its reason")
        XCTAssertGreaterThan(why.height, 28, "the whole reason wraps as a paragraph, never cut: \(why)")
        XCTAssertEqual(detail.selectedRow, "i132", "the click also selects the row")

        let fold = try XCTUnwrap(FrameProbe.frames["meetings.row.i132.fold"], "the unfolded row has a chevron that folds it")
        FrameProbe.reset()
        try click(fold, in: host)
        settle()
        XCTAssertNotNil(FrameProbe.frames["meetings.row.i132.folded"], "folded again")
        XCTAssertNil(FrameProbe.frames["meetings.row.i132.why"])
    }

    /// U13: a voice row says whom it sounds like with the cosine, the next closest voice, and the samples behind it.
    func testAVoiceRowReadsItsCosineAndTheSamplesBehindIt() throws {
        let detail = MeetingDetailModel(id: "m", window: nil)
        let text = try shownText(ReviewRowView(row: try voiceRow(), detail: detail, player: nil), width: 760)
        XCTAssertFalse(text.contains("61 %") || text.contains("61%"), "a cosine is not a percent: \(text)")
        XCTAssertTrue(text.contains("Alice Example 0.61"), "the choice carries the cosine: \(text)")
        XCTAssertTrue(text.contains("Sounds like Alice Example: 0.61 match"), text)
        XCTAssertTrue(text.contains("Bob Example 0.40"), "the next closest voice: \(text)")
        XCTAssertTrue(text.contains("6 saved samples"), text)
        XCTAssertTrue(text.contains("from 2 meetings"), text)
        XCTAssertEqual(text.components(separatedBy: "Sounds like").count, 2, "one voice line, not the labeler's sentence too: \(text)")
    }

    /// U13: the sample count is a button that opens the Voices pane.
    func testTheSampleCountOpensTheVoicesPane() throws {
        FrameProbe.enabled = true
        FrameProbe.reset()
        defer { FrameProbe.enabled = false; FrameProbe.reset() }
        let (defaults, suite) = try defaults()
        defer { defaults.removePersistentDomain(forName: suite) }
        let window = MeetingsWindowModel(defaults: defaults, noticeClock: ManualNoticeClock(), service: nil, loadDetail: { _ in })
        let detail = MeetingDetailModel(id: "m", window: window)
        detail.rows = .loaded(.init(meeting: "m", rows: [try voiceRow()], hidden: .init(lowPriority: 0, minPriority: 0.5)))
        let host = hostedItems(detail, defaults: defaults)
        defer { host.orderOut(nil); host.close() }
        settle()
        XCTAssertFalse(detail.voices.open)
        try click(try XCTUnwrap(FrameProbe.frames["meetings.row.i126.samples"], "the sample count is a control"), in: host)
        settle()
        XCTAssertTrue(detail.voices.open, "the count opens the Voices pane")
    }

    /// U17: the kind word is the row's own (`kindWord`, one table in TS), so "Mixed voices" is gone from every surface.
    func testTheKindWordIsTheRowsOwnWord() throws {
        let detail = MeetingDetailModel(id: "m", window: nil)
        let label = try row(["id": "i972", "label": "i972", "kind": "label", "kindWord": "Unreliable label", "status": "suggested",
                             "what": "The label \"Alice Example\" does not belong to one person (00:00 to 1:41:43)",
                             "parts": [["kind": "when", "from": ["sec": 0, "text": "00:00"], "to": ["sec": 6103, "text": "1:41:43"],
                                        "target": ["kind": "item", "id": "i972"]]],
                             "choices": [["value": "unclear", "label": "Mark its lines unclear", "role": "suggested",
                                          "action": ["kind": "confirm"]]]])
        let text = try shownText(ReviewRowView(row: label, detail: detail, player: nil), width: 760)
        XCTAssertTrue(text.contains("Unreliable label"), text)
        XCTAssertFalse(text.contains("Mixed voices"), text)
        XCTAssertEqual(ReviewRowView.reference(label), "Unreliable label 00:00–1:41:43", "another row names it by the same word")
        XCTAssertEqual(MeetingsWords.rowName(label), "the unreliable label at 00:00–1:41:43")
        let item = try JSONDecoder().decode(MeetingItem.self, from: Data(#"{"id":"i972","kind":"label","status":"confirmed","label":"Alice Example","fromSec":0,"toSec":6103,"rules":[],"suggestedAt":"2026-11-18T10:00:00.000Z"}"#.utf8))
        XCTAssertEqual(MeetingsWords.itemTitle(item), "The label \"Alice Example\" does not belong to one person (00:00 to 1:41:43)",
                       "the notice after a confirm says what the row says")
    }
}
