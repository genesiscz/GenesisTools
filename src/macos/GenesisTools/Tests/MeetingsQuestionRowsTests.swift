import SwiftUI
import Darwin
import Vision
import XCTest
@testable import GenesisToolsMeetings

/// The scratch benchmarks connect to a Meetings service and may write decisions, so they start only in a disposable
/// Genesis home: a folder under /tmp or the temporary folder, never the real home or a folder inside it.
enum ScratchHome {
    struct Refused: Error, CustomStringConvertible {
        let home: String
        var description: String { "Refusing to run outside a scratch Genesis home (\(home)); point \(GenesisToolsHome.variable) under /tmp" }
    }

    static func isDisposable(_ path: String) -> Bool {
        guard !path.isEmpty else { return false }
        let home = canonicalHome(path), real = canonicalHome(NSHomeDirectory())
        guard home != real, !home.hasPrefix(real + "/") else { return false }
        return ["/tmp", FileManager.default.temporaryDirectory.path].contains { home.hasPrefix(canonicalHome($0) + "/") }
    }

    static func require() throws {
        let home = GenesisToolsHome.home()
        guard isDisposable(home) else { throw Refused(home: home) }
    }
}

/// A process's CPU time from `ps -o time=` (`[[h:]m:]s.cc`). A process that is gone, a failed `ps` or an answer that
/// is not a time throws, so a benchmark never records a stale pid as zero CPU.
struct ProcessCPUSample: Error, CustomStringConvertible {
    let pid: String, status: Int32, output: String
    var description: String { "No CPU sample for pid \(pid): ps exited \(status) with \"\(output)\"" }

    static func seconds(pid: String) throws -> Double {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/bin/ps")
        process.arguments = ["-p", pid, "-o", "time="]
        let capture = try process.runCapturing(timeout: 10)
        let text = String(decoding: capture.stdout, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
        let parts = text.split(separator: ":").map { Double($0) }
        guard capture.status == 0, !parts.isEmpty, parts.count <= 3, !parts.contains(nil) else {
            throw ProcessCPUSample(pid: pid, status: capture.status, output: text)
        }
        return parts.compactMap { $0 }.reduce(0) { $0 * 60 + $1 }
    }
}

@MainActor
final class MeetingsQuestionRowsTests: XCTestCase {
    private let present = KnownPerson(id: "alice", name: "Alice Example", sources: [.meetings], rank: .present)
    private let absent = KnownPerson(id: "bob", name: "Bob Example", sources: [.meetings], rank: .meeting)
    private func evidence() -> QuestionDetails {
        .init(id: "q", decidedLines: [.init(index: 42, startSec: 10, endSec: 14, speaker: "Alice Example",
            text: String(repeating: "Complete source words. ", count: 14) + "Final evidence marker")],
            impact: .init(lines: 1, words: 45, sameDoubtLines: 3),
            raisedLines: [.init(index: 99, startSec: 60, endSec: 62, speaker: "Bob Example", text: "Raised line")])
    }
    private func rendered<V: View>(_ view: V, name: String, width: CGFloat = 460, native: Bool = false, afterMount: () -> Void = {}) throws -> String {
        try MeetingQuestionPicture.text(view, name: name, native: native, width: width, afterMount: afterMount)
    }
}

@MainActor
enum MeetingQuestionPicture {
    static func text<V: View>(_ view: V, name: String, native: Bool, width: CGFloat = 460, afterMount: () -> Void = {}) throws -> String {
        let content = view.frame(width: width).padding(12).background(Color(white: 0.12)).environment(\.colorScheme, .dark)
        let renderer = ImageRenderer(content: content)
        renderer.scale = 2
        let image: CGImage
        if native {
            let host = NSHostingView(rootView: content)
            let panel = NSWindow(contentRect: NSRect(x: 0, y: 0, width: width + 24, height: 460), styleMask: [.borderless], backing: .buffered, defer: false)
            panel.isReleasedWhenClosed = false; panel.contentView = host; panel.orderInForSnapshot()
            defer { panel.orderOut(nil); panel.close() }
            RunLoop.main.run(until: Date().addingTimeInterval(0.2))
            afterMount()
            RunLoop.main.run(until: Date().addingTimeInterval(0.1)); host.layoutSubtreeIfNeeded()
            let bitmap = try XCTUnwrap(host.bitmapImageRepForCachingDisplay(in: host.bounds))
            host.cacheDisplay(in: host.bounds, to: bitmap); image = try XCTUnwrap(bitmap.cgImage)
        } else { image = try XCTUnwrap(renderer.cgImage) }
        let request = VNRecognizeTextRequest(); request.recognitionLevel = .accurate; request.usesLanguageCorrection = false
        try VNImageRequestHandler(cgImage: image).perform([request])
        if let folder = ProcessInfo.processInfo.environment["MEETINGS_P10_SHOTS"] {
            let bitmap = NSBitmapImageRep(cgImage: image)
            try XCTUnwrap(bitmap.representation(using: .png, properties: [:])).write(to: URL(fileURLWithPath: folder).appendingPathComponent("\(name).png"))
        }
        return (request.results ?? []).compactMap { $0.topCandidates(1).first?.string }.joined(separator: " ")
    }
}

extension MeetingsQuestionRowsTests {
    func testC13RefusalKeepsTheNearestLineSentence() throws {
        let error = MeetingsCLI.Failure(sentence: "No zorb at 08:28; heard at 08:33 (line 38). Correct the anchor.", detail: "engine detail")
        XCTAssertEqual(asFailure(error).sentence, error.sentence)
        XCTAssertEqual(asFailure(error).detail, "engine detail")
        XCTAssertTrue(try rendered(NoticePill(text: asFailure(error).sentence, more: error.detail, tone: .error), name: "C13-refusal").contains("08:33"))
    }
    func testC17DictionaryPreviewCarriesTheMeetingAndSourceLines() throws {
        let params = MeetingsAPI.DictionaryTest.Params(phrase: "", project: "work", meeting: "copy")
        XCTAssertEqual(try MeetingsService.paramsObject(params)["meeting"] as? String, "copy")
        let result = try JSONDecoder().decode(PhraseTest.self, from: Data(#"{"phrase":"","text":"","fired":[],"suggestions":[],"lines":[{"index":42,"startSec":10,"endSec":14,"speaker":"Alice Example","before":"zorb","after":"Zorb"}]}"#.utf8))
        XCTAssertEqual(result.lines?.first?.index, 42)
        XCTAssertEqual(result.lines?.first?.before, "zorb"); XCTAssertEqual(result.lines?.first?.after, "Zorb")
        let text = try rendered(DictionaryChangedLines(lines: try XCTUnwrap(result.lines)), name: "C17-preview")
        XCTAssertTrue(text.contains("Changes 1 source line"), text); XCTAssertTrue(text.contains("00:10"), text)
        XCTAssertNil(try JSONDecoder().decode(PhraseTest.self, from: Data(#"{"phrase":"old","text":"old","fired":[],"suggestions":[]}"#.utf8)).lines)
    }
    func testProjectQuestionHistoryHasItsLabelAndNoEmptyJournalMessage() throws {
        let detail = MeetingDetailModel(id: "copy", window: nil)
        let json = #"""
        {"id":"copy","title":"Practice","labels":[],"start":"2026-01-01T10:00:00Z","items":[],"context":[],
         "speakers":{"labels":{}},"sources":{},"history":[{"at":"2026-01-01T10:01:00Z","command":"assign sweep",
         "change":"project question withdrawn"}]}
        """#
        detail.settleDecisionRecord(try JSONDecoder().decode(MeetingRecordView.self, from: Data(json.utf8)))
        let history = MeetingDetailModel.HistorySheet(item: nil, entries: .loaded([]))
        let text = try MeetingQuestionPicture.text(HistorySheetView(detail: detail, history: history),
                                                   name: "C21-project-history", native: true, width: 560)
        XCTAssertTrue(text.contains("Project") && text.contains("question withdrawn"), text)
        XCTAssertFalse(text.contains("Nothing decided yet"), text)
        let rowHistory = MeetingDetailModel.HistorySheet(item: "q1", entries: .loaded([]))
        let empty = try MeetingQuestionPicture.text(HistorySheetView(detail: detail, history: rowHistory),
                                                    name: "C21-row-history", native: true, width: 560)
        XCTAssertTrue(empty.contains("Nothing decided yet"), empty)
        XCTAssertFalse(empty.contains("question withdrawn"), empty)
    }
    func testTheContextListShowsThePinnedDocumentsRevision() throws {
        let detail = MeetingDetailModel(id: "copy", window: nil)
        let record = #"""
        {"id":"copy","title":"Practice","labels":[],"start":"2026-01-01T10:00:00Z","items":[],"speakers":{"labels":{}},
         "sources":{},"context":[{"id":"c1","kind":"file","ref":"/tmp/meeting-glossary.md","title":"Practice glossary",
         "addedAt":"2026-01-01T10:00:00Z","file":{"revision":{"commit":"123456789012abcdefabcdefabcdefabcdefabcd","text":"Widget"}}}]}
        """#
        detail.settleDecisionRecord(try JSONDecoder().decode(MeetingRecordView.self, from: Data(record.utf8)))
        let text = try rendered(ContextTab(detail: detail).frame(height: 340), name: "C20-document-revision", native: true)
        XCTAssertTrue(text.contains("123456789012"), text)
        XCTAssertTrue(text.contains("saved text"), text)
    }

    func testL3QuestionChoicesLeadTheMeetingAndDirectoryPeople() {
        let own = KnownPerson(id: "dana", name: "Dana Example", sources: [.own], rank: .own)
        XCTAssertEqual(PeopleText.questionPeople([present, absent, own], choices: [absent.name], query: "", hideAbsent: false).map(\.id), [absent.id, present.id, own.id])
    }
    func testL4ReorderedNameOffersUseTheKnownPerson() throws {
        XCTAssertTrue(PeopleText.isExactMatch(present, "Example Alice"))
        XCTAssertNil(PeopleText.newName("Example Alice", people: [present]))
        XCTAssertTrue(try rendered(PersonPickerRow(person: present, use: true, action: {}), name: "L4-use-person").contains("Use Alice Example"))
    }
    func testX5AbsentPeopleStayHiddenUntilEverybodyIsShown() {
        XCTAssertEqual(PeopleText.questionPeople([present, absent], choices: [absent.name], query: "", hideAbsent: true).map(\.id), [present.id])
        XCTAssertEqual(PeopleText.questionPeople([present, absent], choices: [], query: "", hideAbsent: false).count, 2)
    }
    func testL17EveryDecidedLineKeepsItsFullText() throws {
        XCTAssertGreaterThan(evidence().decidedLines[0].text.count, 240)
        let row = try JSONDecoder().decode(ReviewRow.self, from: Data(#"{"id":"q","label":"Q1","kind":"question","status":"suggested","what":"Who?","parts":[{"kind":"said","text":"Old truncated quote"}],"choices":[],"edit":"answer","sources":[],"target":{"kind":"item","id":"q"}}"#.utf8))
        let detail = MeetingDetailModel(id: "copy", window: nil)
        detail.rows = .loaded(.init(meeting: "copy", rows: [row], hidden: .init(lowPriority: 0, minPriority: 0), questionDetails: [evidence()]))
        var answered = row; answered.decision = .init(token: "saved", actor: .window, by: "you", action: "answer", reason: nil, question: "q", at: nil)
        XCTAssertTrue(try XCTUnwrap(detail.rows.value).needsQuestionDetails(for: answered))
        XCTAssertFalse(ReviewRows(meeting: "copy", rows: [answered], hidden: .init(lowPriority: 0, minPriority: 0), questionDetails: [evidence()]).needsQuestionDetails(for: answered))
        XCTAssertTrue(ReviewRows(meeting: "copy", rows: [answered], hidden: .init(lowPriority: 0, minPriority: 0)).needsQuestionDetails(for: answered))
        let text = try rendered(ReviewRowView(row: row, detail: detail, player: nil), name: "L17-row")
        XCTAssertTrue(text.contains("Final evidence marker"), text)
        XCTAssertFalse(text.contains("Old truncated quote"), text)
        XCTAssertTrue(try rendered(PinCard(row: row).environment(\.meetingDetail, detail), name: "L17-card", native: true).contains("Final evidence marker"))
    }
    func testX11QuestionShowsLinesWordsAndTheSameDoubt() throws {
        let text = try rendered(QuestionLines(evidence: evidence(), expanded: true, answered: false), name: "X11-impact")
        XCTAssertTrue(text.contains("1 line, 45 words; same doubt on 3 lines"), text)
    }
    func testX13AnsweredCardCountsRaisedSourceLines() throws {
        let text = try rendered(QuestionLines(evidence: evidence(), expanded: false, answered: true), name: "X13-raised")
        XCTAssertTrue(text.contains("Raised confidence on 1 line"), text)
    }

    private func question(_ id: String = "q", status: String = "suggested", token: String? = nil, group: String? = nil) throws -> ReviewRow {
        let grouped = group.map { "\"group\":\"\($0)\"," } ?? ""
        var row = try JSONDecoder().decode(ReviewRow.self, from: Data("{\"id\":\"\(id)\",\(grouped)\"label\":\"Q1\",\"kind\":\"question\",\"status\":\"\(status)\",\"what\":\"Who?\",\"parts\":[],\"choices\":[],\"edit\":\"answer\",\"sources\":[],\"target\":{\"kind\":\"item\",\"id\":\"\(id)\"}}".utf8))
        if let token { row.decision = .init(token: token, actor: .window, by: "you", action: "answer", reason: nil, question: id, at: nil) }
        return row
    }

    func testX5TwoVoiceEditorUsesTheTimeScopedPeopleAndEverybodyEscape() throws {
        let row = try JSONDecoder().decode(ReviewRow.self, from: Data(#"{"id":"q","label":"Q1","kind":"question","status":"suggested","what":"Who?","parts":[{"kind":"when","from":{"sec":10,"text":"00:10"},"target":{"kind":"item","id":"q"}}],"choices":[],"edit":"answer","sources":[],"target":{"kind":"item","id":"q"}}"#.utf8))
        XCTAssertEqual(ListenVoicesEditor.offeredPeople([present, absent], row: row, everybody: false), [present.name])
        XCTAssertEqual(ListenVoicesEditor.offeredPeople([present, absent], row: row, everybody: true), [present.name, absent.name])
    }

    func testX13FreshAnswerFlashesOnceAndReopenAndDisabledDoNotFlash() throws {
        let before = ReviewRows(meeting: "copy", rows: [try question()], hidden: .init(lowPriority: 0, minPriority: 0), questionDetails: [evidence()])
        let after = ReviewRows(meeting: "copy", rows: [try question(status: "confirmed", token: "next")], hidden: before.hidden, questionDetails: [evidence()])
        var flash = RaisedLineFlash()
        XCTAssertTrue(flash.receive(before, enabled: true).isEmpty)
        XCTAssertEqual(flash.receive(after, enabled: true), [99])
        XCTAssertTrue(flash.receive(after, enabled: true).isEmpty)
        var reopened = RaisedLineFlash()
        XCTAssertTrue(reopened.receive(after, enabled: true).isEmpty)
        var disabled = RaisedLineFlash()
        _ = disabled.receive(before, enabled: false)
        XCTAssertTrue(disabled.receive(after, enabled: false).isEmpty)
        XCTAssertTrue(disabled.receive(after, enabled: true).isEmpty)
        XCTAssertTrue(MeetingsPreferences.Transcript.flashRaised.defaultValue)
        XCTAssertEqual(MeetingsPreferences.Transcript.raisedFlashSec.defaultValue, 1.2)
        let defaults = try XCTUnwrap(UserDefaults(suiteName: "test.raised.\(UUID().uuidString)"))
        let rows = SidePanelCatalog.windowSections(defaults).first { $0.id == "transcript" }?.rows ?? []
        XCTAssertTrue(rows.contains { $0.title == MeetingsPreferences.Transcript.flashRaised.title })
        let detail = MeetingDetailModel(id: "copy", window: nil)
        detail.comments = .loaded(.init(meeting: "copy", comments: [], listeners: []))
        detail.rows = .loaded(before)
        let entries = [TranscriptLine(id: "raised", startSec: 60, speaker: "Alice Example", text: "Raised source line", endSec: 62, sourceIndex: 99)]
        let view = TranscriptBlocksPane(detail: detail, entries: entries)
        XCTAssertTrue(try rendered(view, name: "X13-before", native: true).contains("Raised source line"))
        XCTAssertTrue(try rendered(view, name: "X13-after", native: true, afterMount: { detail.rows = .loaded(after) }).contains("Raised source line"))
    }

    func testX18GroupsCountAnsweredOfTotalAndTheBarShowsThem() throws {
        let items = try JSONDecoder().decode([MeetingItem].self, from: Data(#"[{"id":"q1","kind":"question","status":"confirmed"},{"id":"q2","kind":"question","status":"suggested"},{"id":"q3","kind":"question","status":"rejected","group":"spot-check"},{"id":"q4","kind":"question","status":"suggested","group":"spot-check"},{"id":"term","kind":"term","status":"confirmed"}]"#.utf8))
        let counts = QuestionGroupProgress.count(rows: [try question(status: "confirmed")], items: items)
        XCTAssertEqual(counts["rules"], .init(answered: 1, total: 2), "the record counts the questions the row filter hides")
        XCTAssertEqual(counts["spot-check"], .init(answered: 1, total: 2), "a rejected answer is an answer")
        XCTAssertEqual(QuestionGroupProgress.words("Spot check", try XCTUnwrap(counts["spot-check"])), "Spot check 1/2")

        let rows = [try question("q1", status: "confirmed", token: "t1"), try question("q2"), try question("q4", group: "spot-check")]
        var input = ItemsProjection.Input(rows: rows, items: items, group: "spot-check")
        var projection = ItemsProjection.make(input)
        XCTAssertTrue(projection.showsGroups, "two groups hold questions")
        XCTAssertEqual(projection.ids, ["q4"])
        input.group = "long-stretch"
        projection = ItemsProjection.make(input)
        XCTAssertEqual(projection.group, "all", "a group with no question in this meeting never empties the list")
        XCTAssertEqual(projection.ids, ["q1", "q2", "q4"])
        XCTAssertEqual(projection.open, 2)
        XCTAssertFalse(ItemsProjection.make(.init(rows: rows, items: Array(items.prefix(2)))).showsGroups, "one group: no strip")

        let detail = MeetingDetailModel(id: "copy", window: nil)
        let text = try rendered(ItemsBar(detail: detail, projection: projection, group: .constant("all"), applyAbove: 0.5),
                                name: "X18-bar", width: 800, native: true)
        XCTAssertTrue(text.contains("Rules 1/2"), text)
        XCTAssertTrue(text.contains("Spot check 1/2"), text)
        XCTAssertFalse(text.contains("samples"), "no system stepper is left: \(text)")

        input.group = "spot-check"
        let compact = try rendered(ItemsBar(detail: detail, projection: ItemsProjection.make(input), group: .constant(input.group), applyAbove: 0.5),
                                   name: "X18-bar-compact", width: 460, native: true)
        XCTAssertTrue(compact.contains("Spot check 1/2"), compact)
        XCTAssertFalse(compact.contains("Rules 1/2"), "the other groups are inside the compact menu: \(compact)")
    }

    func testTheQuestionCardAnswersFirstAndFoldsItsLines() throws {
        let lines = (0..<5).map { QuestionDetails.Line(index: $0, startSec: Double(60 * $0), endSec: Double(60 * $0 + 5),
                                                         speaker: "Alice Example", text: "Line number \($0) of the evidence") }
        let evidence = QuestionDetails(id: "q", decidedLines: lines, impact: .init(lines: 5, words: 30, sameDoubtLines: 2), raisedLines: nil)
        XCTAssertEqual(QuestionLines.allLinesWords(evidence), "All 5 lines (30 words)")
        let folded = try rendered(QuestionLines(evidence: evidence, expanded: true, answered: false, speaker: "Alice Example"), name: "card-lines")
        XCTAssertTrue(folded.contains("Line number 2"), folded)
        XCTAssertFalse(folded.contains("Line number 3"), "the fourth line waits behind All 5 lines: \(folded)")
        XCTAssertTrue(folded.contains("All 5 lines"), folded)
        XCTAssertFalse(folded.contains("Alice Example:"), "the question's own speaker is not repeated on each line: \(folded)")

        let row = try JSONDecoder().decode(ReviewRow.self, from: Data(#"{"id":"q","label":"Q1","kind":"question","status":"suggested","confidence":0.4,"priority":1.62,"what":"Who speaks?","parts":[{"kind":"who","text":"Alice Example"},{"kind":"asks","pieces":[{"text":"Who speaks under Alice Example?"}]}],"choices":[{"value":"Bob Example","label":"Bob Example","role":"suggested","action":{"kind":"answer","answer":"Bob Example"}},{"value":"several","label":"Several voices","role":"split","action":{"kind":"answer","answer":"several"}},{"value":"skip","label":"Skip","role":"skip","action":{"kind":"answer","answer":"skip"}}],"edit":"answer","sources":[],"target":{"kind":"item","id":"q"}}"#.utf8))
        let detail = MeetingDetailModel(id: "copy", window: nil)
        detail.rows = .loaded(.init(meeting: "copy", rows: [row], hidden: .init(lowPriority: 0, minPriority: 0), questionDetails: [evidence]))
        let card = try rendered(ReviewRowView(row: row, detail: detail, player: nil, asksSpeaker: true), name: "card-answers-first")
        XCTAssertEqual(card.components(separatedBy: "Somebody else").count - 1, 1, "one Somebody else: \(card)")
        XCTAssertFalse(card.contains("Priority"), card)
        XCTAssertTrue(card.contains("40 % sure"), card)
        let answer = try XCTUnwrap(card.range(of: "Bob Example")), decides = try XCTUnwrap(card.range(of: "Decides"))
        XCTAssertLessThan(answer.lowerBound, decides.lowerBound, "the answers come before the evidence: \(card)")
        // H4: the rare answers wait in More, and Skip stands last, apart from the answers.
        XCTAssertFalse(card.contains("Several voices"), "a rare answer nobody suggested is in More: \(card)")
        let more = try XCTUnwrap(card.range(of: "More"), card), skip = try XCTUnwrap(card.range(of: "Skip"), card)
        XCTAssertLessThan(more.lowerBound, skip.lowerBound, "Skip comes after the answers: \(card)")
    }

    func testTheOpenQuestionPinShowsItsPriorityWithoutAddingAColumnToTheList() throws {
        let ranked = ReviewRow(id: "q", label: "Q1", kind: "question", status: "suggested", confidence: 0.4,
                               priority: 7, what: "Who speaks?", parts: [], choices: [], edit: "answer",
                               needs: nil, sources: [], target: .item("q"))
        let open = try rendered(PinCard(row: ranked), name: "C7-priority", native: true)
        XCTAssertTrue(open.contains("Priority 7"), open)
        XCTAssertFalse(try rendered(PinCard(row: question()), name: "C7-unranked", native: true).contains("Priority"))
    }

    func testCheckByEarHoldsBothChecksWithTheirNumbersAndTheRate() throws {
        XCTAssertEqual(SpotCheckRate(changed: 1, answered: 3).percent, 33)
        let defaults = try XCTUnwrap(UserDefaults(suiteName: "test.listen.\(UUID().uuidString)"))
        let detail = MeetingDetailModel(id: "copy", window: nil)
        let popover = ListenCheckPopover(detail: detail, rate: SpotCheckRate(changed: 3, answered: 20)) { _ in }.defaultAppStorage(defaults)
        let text = try rendered(popover, name: "check-by-ear", native: true)
        for words in ["Spot check", "Long stretches", "20 lines", "50 words", "Prepare", "changed the speaker (15 %)"] {
            XCTAssertTrue(text.contains(words), "\(words): \(text)")
        }
        XCTAssertEqual(MeetingsPreferences.Listen.spotCheckCount.defaultValue, 20)
        XCTAssertTrue(MeetingsPreferences.Listen.showPrepared.defaultValue)
        let rows = SidePanelCatalog.windowSections(defaults).first { $0.id == "rows" }?.rows ?? []
        XCTAssertTrue(rows.contains { $0.title == MeetingsPreferences.Listen.showPrepared.title })
        XCTAssertEqual(rows.first { $0.title == MeetingsPreferences.Listen.spotCheckCount.title }?.valueTitle, "20 lines")
    }

    func testC22FailedServiceStartReportsOnceWhileTheCommandWorks() async throws {
        var timing = MeetingsService.Timing(); timing.startThrottle = 0
        let service = MeetingsService(folder: URL(fileURLWithPath: "/nonexistent-service-\(UUID().uuidString)"), timing: timing,
            startService: { throw MeetingsCLI.Failure(sentence: "Start refused", detail: "launch detail") })
        var failures: [MeetingsCLI.Failure] = []
        let listening = service.listenForStartFailure { failures.append($0) }
        defer { listening.cancel() }
        let read = MeetingsRead<ReviewRows>.service(MeetingsAPI.MeetingRows.self, .init(meeting: "copy"), orRun: ["rows", "copy", "--json"])
        let expected = ReviewRows(meeting: "copy", rows: [], hidden: .init(lowPriority: 0, minPriority: 0))
        for _ in 0..<2 {
            let value = try await read.run(service: service, command: { _, _ in expected })
            XCTAssertEqual(value, expected)
        }
        for _ in 0..<10 { await Task.yield() }
        XCTAssertEqual(failures.count, 1)
        XCTAssertTrue(try XCTUnwrap(failures.first).sentence.contains("uses its command instead"))
        XCTAssertEqual(failures.first?.detail, "launch detail")
    }

    func testPinPlacementInputsCoverPinsZoomWidthLanesAndCaptions() {
        let pins = [TimelinePin(id: "a", sec: 10, text: "First", state: .question), TimelinePin(id: "b", sec: 11, text: "Second", state: .open)]
        let input = TimelinePinLayout(pins: pins, view: 0...100, width: 400, lanes: 1, showsText: false)
        XCTAssertEqual(input.make(), PinCluster.clusters(pins, in: 0...100, width: 400))
        XCTAssertNotEqual(input, TimelinePinLayout(pins: pins, view: 0...20, width: 400, lanes: 1, showsText: false))
        XCTAssertNotEqual(input, TimelinePinLayout(pins: [], view: 0...100, width: 400, lanes: 1, showsText: false))
        let lanes = TimelinePinLayout(pins: pins, view: 0...100, width: 800, lanes: 2, showsText: true)
        XCTAssertEqual(lanes.make(), PinCluster.laid(pins, in: 0...100, width: 800, lanes: 2, markWidth: 72))
    }

    func testReopenOffersCachedRowsBeforeTheRefreshAndKeepsFailures() async throws {
        let service = MeetingsService(folder: URL(fileURLWithPath: "/nonexistent-service-\(UUID().uuidString)"))
        let saved = ReviewRows(meeting: "copy", rows: [try question()], hidden: .init(lowPriority: 0, minPriority: 0))
        let defaults = try XCTUnwrap(UserDefaults(suiteName: "test.reopen.\(UUID().uuidString)"))
        let key = MeetingsAPI.MeetingRows.Params(meeting: "copy", lowPriority: nil)
        _ = try await service.rowsRefresh.read(key) { saved }
        let window = MeetingsWindowModel(defaults: defaults, service: service, loadDetail: { $0.rows = .loading(previous: nil) })
        window.select("copy", tab: .items)
        let detail = try XCTUnwrap(window.detail)
        XCTAssertTrue(detail.rows.isLoading)
        XCTAssertNil(detail.rows.value)
        XCTAssertEqual(detail.rowsForReopen.value, saved)
        detail.restoreRowsForReopen()
        XCTAssertEqual(detail.rows.value, saved)
        let fresh = ReviewRows(meeting: "copy", rows: [], hidden: saved.hidden)
        detail.rows = .loaded(fresh)
        XCTAssertEqual(detail.rowsForReopen.value, fresh)
        let failure = MeetingsCLI.Failure(sentence: "Read failed", detail: "read detail")
        detail.rows = .failed(failure, previous: nil)
        XCTAssertEqual(detail.rowsForReopen.failure, failure)
        XCTAssertEqual(detail.rowsForReopen.value, saved)
        detail.restoreRowsForReopen()
        XCTAssertEqual(detail.rows.failure, failure, "a reopened failure keeps its sentence and Details, not a loading state no read ends")
        XCTAssertEqual(detail.rows.value, saved)
    }

    func testRepeatedIDsFailTheRowsReadInsteadOfTrapping() throws {
        let row = #"{"id":"q","label":"Q1","kind":"question","status":"suggested","what":"Who?","parts":[],"choices":[],"edit":"answer","sources":[],"target":{"kind":"item","id":"q"}}"#
        let details = #"{"id":"q","decidedLines":[],"impact":{"lines":0,"words":0,"sameDoubtLines":0}}"#
        func decode(rows: [String], details: [String]) throws -> ReviewRows {
            try JSONDecoder().decode(ReviewRows.self, from: Data(#"{"meeting":"copy","hidden":{"lowPriority":0,"minPriority":0},"rows":[\#(rows.joined(separator: ","))],"questionDetails":[\#(details.joined(separator: ","))]}"#.utf8))
        }
        XCTAssertEqual(try decode(rows: [row], details: [details]).questionDetailsByID.count, 1)
        XCTAssertThrowsError(try decode(rows: [row, row], details: [details]), "a repeated row id is a broken reply")
        XCTAssertThrowsError(try decode(rows: [row], details: [details, details]), "a repeated details id is a broken reply")
        let built = ReviewRows(meeting: "copy", rows: [try question(token: "first"), try question(token: "second")],
                               hidden: .init(lowPriority: 0, minPriority: 0), questionDetails: [evidence(), evidence()])
        XCTAssertEqual(built.questionDetailsTokens["q"], "first", "a value built in code keeps the first")
        XCTAssertEqual(built.questionDetailsByID.count, 1)
    }

    func testPatchPreservesEveryOptionalRowAndEvidenceField() throws {
        let row = try JSONDecoder().decode(ReviewRow.self, from: Data(#"{"id":"q","label":"Q1","kind":"question","status":"suggested","confidence":0.8,"priority":0.9,"group":"rules","occurrences":3,"reach":0.7,"comment":"Keep the source","what":"Who?","parts":[],"choices":[],"edit":"answer","needs":"listen","sources":[],"target":{"kind":"item","id":"q"},"answer":"Earlier","decision":{"token":"earlier","actor":{"kind":"window"},"by":"you","action":"answer","reason":"Checked","question":"q","at":"2026-01-01T00:00:00Z"}}"#.utf8))
        let hidden = ReviewRows.Hidden(lowPriority: 2, minPriority: 0.5)
        let fields = ReviewRowsPatch.Fields.Value(title: "Example", project: "work", labels: ["sample"], speakerLabels: [:])
        let line = WindowLineEvidence(index: 42, startSec: 10, endSec: 14, swapSkippedBy: ["rule"], noRemotePresent: false,
            micShare: 0.5, callRms: 0.1, echoOfCall: 0.2, acousticQuality: "quiet")
        let current = ReviewRows(meeting: "copy", rows: [row], hidden: hidden, attendanceWarning: "Attendance unavailable",
            lineEvidence: [line], questionDetails: [evidence()])
        var after = row; after.status = "confirmed"
        let patch = ReviewRowsPatch(meeting: "copy", changes: [.init(id: row.id, before: row, after: after)], order: [row.id],
            hidden: .init(before: hidden, after: hidden), fields: .init(before: fields, after: fields))
        let updated = patch.applying(to: current, token: "next", latest: [:])
        XCTAssertEqual(updated.rows, [after])
        XCTAssertEqual(updated.attendanceWarning, current.attendanceWarning)
        XCTAssertEqual(updated.lineEvidence, current.lineEvidence)
        XCTAssertEqual(updated.questionDetails, current.questionDetails)
        XCTAssertEqual(updated.questionDetailsByID, current.questionDetailsByID)
        XCTAssertEqual(updated.questionDetailsTokens, current.questionDetailsTokens)
        XCTAssertEqual(patch.applying(to: current, token: "next", latest: [row.id: "newer"]), current)
    }

    func testAnswerBurstSharesOneRowsReadAndKeepsTheLastReply() async throws {
        let refresh = MeetingsRowsRefresh(quietWindow: .zero)
        let key = MeetingsAPI.MeetingRows.Params(meeting: "copy", lowPriority: "show")
        let rows = ReviewRows(meeting: "copy", rows: [], hidden: .init(lowPriority: 0, minPriority: 0))
        var loads = 0
        refresh.beginWrite()
        let readers = (0..<10).map { _ in Task {
            try await refresh.read(key) {
                loads += 1
                try await Task.sleep(for: .milliseconds(20))
                return rows
            }
        } }
        for _ in 0..<10 { await Task.yield() }
        XCTAssertEqual(loads, 0, "Rows wait while an answer is in flight")
        refresh.endWrite()
        for reader in readers { let value = try await reader.value; XCTAssertEqual(value, rows) }
        XCTAssertEqual(loads, 1)
        XCTAssertEqual(refresh.cached(key), rows)
        XCTAssertNil(refresh.cached(.init(meeting: "copy", lowPriority: nil)), "Priority views never share a snapshot")
    }

    func testAReadAfterAnAnswerNeverJoinsALoadThatStartedBeforeIt() async throws {
        let refresh = MeetingsRowsRefresh(quietWindow: .zero)
        let key = MeetingsAPI.MeetingRows.Params(meeting: "copy", lowPriority: nil)
        let old = ReviewRows(meeting: "copy", rows: [try question()], hidden: .init(lowPriority: 0, minPriority: 0))
        let fresh = ReviewRows(meeting: "copy", rows: [try question(status: "confirmed", token: "next")], hidden: old.hidden)
        var loads = 0
        var release: CheckedContinuation<Void, Never>?
        let held = expectation(description: "the first load is in flight")
        let first = Task { try await refresh.read(key) {
            loads += 1
            guard loads == 1 else { return fresh }
            await withCheckedContinuation { release = $0; held.fulfill() }
            return old
        } }
        await fulfillment(of: [held], timeout: 5)
        guard release != nil else {
            first.cancel()
            return XCTFail("The first rows load never started")
        }
        refresh.beginWrite()
        refresh.endWrite()
        let second = Task { try await refresh.read(key) { loads += 1; return fresh } }
        // A second read that joined the held load would wait for it forever: bound the wait, then free the load.
        let settled = expectation(description: "the read after the answer settles without the held load")
        let watch = Task { _ = try? await second.value; settled.fulfill() }
        await fulfillment(of: [settled], timeout: 5)
        release?.resume()
        let secondValue = try await second.value
        let firstValue = try await first.value
        _ = await watch.value
        XCTAssertEqual(secondValue, fresh, "The read after the answer must not take rows loaded before it")
        XCTAssertEqual(firstValue, fresh, "A load the answer overtook reads again instead of returning pre-answer rows")
        XCTAssertEqual(loads, 3)
        XCTAssertEqual(refresh.cached(key), fresh, "Rows loaded before a write are never cached")
    }

    /// Opt-in scratch driver: exercises the window's apply/patch/evidence-read path on an isolated duplicate only.
    func testTenAnswerServicePath() async throws {
        guard let input = ProcessInfo.processInfo.environment["MEETINGS_ANSWER_BENCH"] else { throw XCTSkip("Scratch benchmark only") }
        let values = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: URL(fileURLWithPath: input))) as? [String: String])
        let meeting = try XCTUnwrap(values["meeting"]), output = try XCTUnwrap(values["output"])
        try ScratchHome.require()
        let service = MeetingsService(folder: GenesisToolsHome.url("meetings-service"), startService: { throw CancellationError() })
        let detail = MeetingDetailModel(id: meeting, window: nil, service: service)
        detail.settleDecisionRecord(try await service.call(MeetingsAPI.Show.self, .init(ref: meeting)))
        detail.rows = .loaded(try await MeetingDetailModel.rowsRead(meeting, lowPriority: .show).run(service: service))
        let pid = try XCTUnwrap(values["pid"])
        func serviceCPU() throws -> Double { try ProcessCPUSample.seconds(pid: pid) }
        let cpuStart = try serviceCPU()
        let readStart = service.rowsRefresh.completedReadCount
        let start = ProcessInfo.processInfo.systemUptime
        var lastRow: ReviewRow?
        for _ in 0..<10 {
            let row = try XCTUnwrap(detail.rows.value?.rows.first { row in
                row.isQuestion && row.isOpen && row.group != "words" && row.choices.contains { $0.action.kind == "answer" && $0.action.answer?.isEmpty == false }
            })
            var action = try XCTUnwrap(row.choices.first { $0.action.kind == "answer" && $0.action.answer?.isEmpty == false }).action.decision(on: row)
            action.lookAlikes = "leave"
            let result = try await MeetingDetailModel.applyDecision(meeting: meeting, action: action, reason: nil, service: service, lowPriority: .show)
            XCTAssertNotNil(result.entry)
            XCTAssertTrue(detail.patchDecision(result))
            lastRow = detail.rows.value?.rows.first { $0.id == row.id }
            detail.readRows(quiet: true)
        }
        let last = try XCTUnwrap(lastRow)
        let deadline = ProcessInfo.processInfo.systemUptime + 60
        while detail.rows.value?.needsQuestionDetails(for: last) == true, ProcessInfo.processInfo.systemUptime < deadline {
            try await Task.sleep(for: .milliseconds(20))
        }
        XCTAssertFalse(try XCTUnwrap(detail.rows.value).needsQuestionDetails(for: last))
        let result: [String: Any] = ["answers": 10, "wallSeconds": ProcessInfo.processInfo.systemUptime - start,
                                   "fullRowsReads": service.rowsRefresh.completedReadCount - readStart,
                                   "serviceCPUSeconds": try serviceCPU() - cpuStart]
        try JSONSerialization.data(withJSONObject: result, options: [.sortedKeys]).write(to: URL(fileURLWithPath: output))
        detail.cancelReads()
    }

    func testScratchReopenAndProjectionPerformance() async throws {
        guard let input = ProcessInfo.processInfo.environment["MEETINGS_READ_BENCH"] else { throw XCTSkip("Scratch benchmark only") }
        let values = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: URL(fileURLWithPath: input))) as? [String: String])
        let meeting = try XCTUnwrap(values["meeting"]), output = try XCTUnwrap(values["output"])
        try ScratchHome.require()
        let service = MeetingsService(folder: GenesisToolsHome.url("meetings-service"), startService: { throw CancellationError() })
        let priority = MeetingsPreferences.Rows.lowPriority.value()
        let rows = try await MeetingDetailModel.rowsRead(meeting, lowPriority: priority).run(service: service)
        let record = try await service.call(MeetingsAPI.Show.self, .init(ref: meeting))
        let people = try await service.call(MeetingsAPI.PeopleKnown.self, .init(query: "", meeting: meeting, atSec: 10, limit: 20)).people
        let pins = rows.rows.compactMap { TimelinePin(row: $0) }
        let layout = TimelinePinLayout(pins: pins, view: 0...10320, width: 1400, lanes: 2, showsText: true)
        func cpu() -> Double {
            var usage = rusage(); getrusage(RUSAGE_SELF, &usage)
            return Double(usage.ru_utime.tv_sec + usage.ru_stime.tv_sec) + Double(usage.ru_utime.tv_usec + usage.ru_stime.tv_usec) / 1_000_000
        }
        let pid = try XCTUnwrap(values["pid"])
        func serviceCPU() throws -> Double { try ProcessCPUSample.seconds(pid: pid) }
        var samples: [[String: Any]] = []
        func measure(_ name: String, call: Int, _ work: () throws -> Int) rethrows {
            let cpuStart = cpu(), start = ProcessInfo.processInfo.systemUptime
            let count = try work()
            samples.append(["path": name, "call": call, "wallSeconds": ProcessInfo.processInfo.systemUptime - start, "cpuSeconds": cpu() - cpuStart, "count": count])
        }
        let question = try XCTUnwrap(rows.rows.first(where: \.isQuestion))
        let fields = ReviewRowsPatch.Fields.Value(title: record.title, project: record.project, labels: record.labels, speakerLabels: record.speakers.labels)
        var after = question; after.status = "confirmed"
        let patch = ReviewRowsPatch(meeting: meeting, changes: [.init(id: question.id, before: question, after: after)], order: rows.rows.map(\.id),
                                    hidden: .init(before: rows.hidden, after: rows.hidden), fields: .init(before: fields, after: fields))
        for call in 1...2 {
            measure("row patch", call: call) { patch.applying(to: rows, token: "probe", latest: [:]).rows.count }
            measure("items projection", call: call) { ItemsProjection.make(.init(rows: rows.rows, items: record.items)).shown.count }
            measure("voice picker", call: call) { ListenVoicesEditor.offeredPeople(people, row: question, everybody: false).count }
            measure("pin layout", call: call) { layout.make().count }
            measure("raised lines", call: call) { var flash = RaisedLineFlash(); _ = flash.receive(rows, enabled: true); return flash.receive(rows, enabled: true).count }
            let detail = MeetingDetailModel(id: meeting, window: nil, service: service); detail.rows = .loading(previous: nil)
            measure("reopen cached rows", call: call) { detail.rowsForReopen.value?.rows.count ?? 0 }
            let serverStart = try serviceCPU(), start = ProcessInfo.processInfo.systemUptime
            detail.readRows(quiet: true)
            let deadline = ProcessInfo.processInfo.systemUptime + 30
            while detail.rows.isLoading, ProcessInfo.processInfo.systemUptime < deadline { try await Task.sleep(for: .milliseconds(10)) }
            XCTAssertNotNil(detail.rows.value)
            samples.append(["path": "reopen refresh", "call": call, "wallSeconds": ProcessInfo.processInfo.systemUptime - start, "cpuSeconds": try serviceCPU() - serverStart])
            detail.cancelReads()
        }
        try JSONSerialization.data(withJSONObject: ["rows": rows.rows.count, "pins": pins.count, "samples": samples], options: [.sortedKeys, .prettyPrinted]).write(to: URL(fileURLWithPath: output))
    }
}
