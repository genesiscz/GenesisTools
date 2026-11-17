import SwiftUI
import Vision
import XCTest
@testable import GenesisToolsMeetings

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
    private func rendered<V: View>(_ view: V, name: String, native: Bool = false) throws -> String {
        let content = view.frame(width: 460).padding(12).background(Color(white: 0.12)).environment(\.colorScheme, .dark)
        let renderer = ImageRenderer(content: content)
        renderer.scale = 2
        let image: CGImage
        if native {
            let host = NSHostingView(rootView: content)
            let panel = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 484, height: 460), styleMask: [.borderless], backing: .buffered, defer: false)
            panel.isReleasedWhenClosed = false; panel.contentView = host; panel.orderInForSnapshot()
            defer { panel.orderOut(nil); panel.close() }
            RunLoop.main.run(until: Date().addingTimeInterval(0.2)); host.layoutSubtreeIfNeeded()
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
}
