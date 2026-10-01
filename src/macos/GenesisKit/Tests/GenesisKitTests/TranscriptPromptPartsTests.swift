import AppKit
import SwiftUI
import Vision
import XCTest
@testable import GenesisKit

/// A user turn's parts, as `tools ai sessions tail --json` prints them (src/utils/ai/transcripts/prompt-parts.ts,
/// shapes of 2026-09-28, names and paths invented): decoding, the transcript row they become, and the card a
/// peer's message renders as.
final class TranscriptPromptPartsTests: XCTestCase {
    private let envelopeJSON = #"""
    {"provider":"claude","sessionId":"sess-1","filePath":"/tmp/gt/s.jsonl","byteSize":10,"truncated":false,"nextOffset":4,"turnCount":4,
     "turns":[
      {"id":"u1","role":"user","at":"2026-09-28T19:11:49.000Z","text":"fix the cache clock","tools":[]},
      {"id":"u2","role":"user","at":"2026-09-28T19:12:00.000Z",
       "text":"Another Claude session sent a message: <teammate-message teammate_id=\"builder\" color=\"cyan\"> {\"type\":\"idle_notification\",\"result\":\"**All moves are done.**\\n\\n| Name | Target |\\n|---|---|\\n| alpha | beta |\"}",
       "tools":[],
       "parts":[
        {"kind":"teammate","from":"builder","color":"cyan","type":"idle_notification","body":"**All moves are done.**\n\n| Name | Target |\n|---|---|\n| alpha | beta |"},
        {"kind":"system","text":"This came from another Claude session."}
       ]},
      {"id":"u3","role":"user","at":"2026-09-28T19:13:00.000Z","text":"<task-notification> <task-id>b1example</task-id> </task-notification>","tools":[],
       "parts":[{"kind":"task","id":"b1example","status":"completed","summary":"Background command \"Run the tests\" completed (exit code 0)","outputFile":"/tmp/gt/tasks/b1example.output"}]},
      {"id":"u4","role":"user","at":null,"text":"later","tools":[],
       "parts":[{"kind":"hologram","text":"a kind from a newer tools"},{"kind":"user","text":"so?","midTurn":true}]}
     ]}
    """#

    func testEnvelopeDecodesPartsAndAKindItDoesNotKnow() throws {
        let envelope = try SessionTranscriptClient.decode(Data(envelopeJSON.utf8))

        XCTAssertNil(envelope.turns[0].parts)
        XCTAssertEqual(envelope.turns[1].parts?.map(\.kind), ["teammate", "system"])
        XCTAssertEqual(envelope.turns[1].parts?.first?.from, "builder")
        XCTAssertEqual(envelope.turns[2].parts?.first?.status, "completed")
        XCTAssertEqual(envelope.turns[2].parts?.first?.outputFile, "/tmp/gt/tasks/b1example.output")
        XCTAssertEqual(envelope.turns[3].parts?.map(\.kind), ["hologram", "user"])
        XCTAssertEqual(envelope.turns[3].parts?.last?.midTurn, true)
    }

    func testAPromptRowCarriesItsPartsAndSearchesTheirWordsNotTheRawJSON() throws {
        let envelope = try SessionTranscriptClient.decode(Data(envelopeJSON.utf8))
        let document = TranscriptDocument.build(envelope.turns, fileExists: { _ in false })
        let prompts = document.sections.flatMap(\.rows).filter(\.isPrompt)

        XCTAssertEqual(prompts.map(\.id), ["p-u1", "p-u2", "p-u3", "p-u4"])
        XCTAssertTrue(prompts[0].parts.isEmpty)
        XCTAssertEqual(prompts[1].parts.map(\.kind), ["teammate", "system"])
        XCTAssertTrue(prompts[1].searchText.contains("all moves are done."))
        XCTAssertFalse(prompts[1].searchText.contains("\"type\""))
        XCTAssertTrue(prompts[2].searchText.contains("b1example"))
    }

    func testCollapsedCutsALongBodyAndKeepsAShortOne() {
        let long = (1...10).map { "line \($0)" }.joined(separator: "\n")

        XCTAssertEqual(TranscriptPromptParts.collapsed("short", lines: 6).cut, false)
        XCTAssertEqual(TranscriptPromptParts.collapsed(long, lines: 6).text, (1...6).map { "line \($0)" }.joined(separator: "\n"))
        XCTAssertEqual(TranscriptPromptParts.collapsed(long, lines: 6).lineCount, 10)
        XCTAssertEqual(TranscriptPromptParts.typeLabel("idle_notification"), "idle")
        XCTAssertEqual(TranscriptPromptParts.typeLabel("task_assignment"), "task assignment")
    }

    /// The row the transcript shows for a peer's message: a teammate card whose body is rendered markdown
    /// (the bold marks and table pipes are gone), not the prompt card with the raw `<teammate-message …>` text.
    @MainActor
    func testATeammateMessageRendersAsACardWithRenderedMarkdown() throws {
        let envelope = try SessionTranscriptClient.decode(Data(envelopeJSON.utf8))
        let document = TranscriptDocument.build(envelope.turns, fileExists: { _ in false })
        let row = try XCTUnwrap(document.sections.flatMap(\.rows).first { $0.id == "p-u2" })
        let view = TranscriptRowView(
            row: row,
            provider: AIProviders.meta(for: "claude"),
            modelName: nil,
            verbosity: .inputs,
            expanded: false,
            showAll: false,
            openMembers: [],
            services: .none,
            onToggle: { _ in }
        )
        .frame(width: 640)
        .environment(\.colorScheme, .dark)

        // Rendered offscreen and read back with text recognition: what a reader sees, with no window. The
        // accessibility tree was tried first; SwiftUI builds none for a hosting view in a test run, not even
        // in a window (measured 2026-09-28: empty, after a 5 s wait).
        let renderer = ImageRenderer(content: view)
        renderer.scale = 2
        let image = try XCTUnwrap(renderer.cgImage)
        let request = VNRecognizeTextRequest()
        request.recognitionLevel = .accurate
        request.usesLanguageCorrection = false
        try VNImageRequestHandler(cgImage: image).perform([request])
        let lines = (request.results ?? []).compactMap { $0.topCandidates(1).first?.string }
        let seen = lines.joined(separator: "\n")

        XCTAssertTrue(seen.contains("builder"), "read: \(lines)")
        XCTAssertTrue(seen.contains("All moves are done."), "read: \(lines)")
        XCTAssertTrue(seen.contains("idle"), "read: \(lines)")
        XCTAssertTrue(seen.contains("Target"), "read: \(lines)")
        // Rendered markdown: no bold marks, no raw tag, no JSON, no escaped line breaks.
        XCTAssertFalse(seen.contains("**"), "read: \(lines)")
        XCTAssertFalse(seen.contains("teammate-message"), "read: \(lines)")
        XCTAssertFalse(seen.contains("idle_notification"), "read: \(lines)")
        XCTAssertFalse(seen.contains("\\n"), "read: \(lines)")
    }
}
