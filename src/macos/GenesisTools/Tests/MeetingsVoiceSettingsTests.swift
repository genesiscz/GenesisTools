import AppKit
import Foundation
import GenesisKit
import SwiftUI
import Vision
import XCTest
@testable import GenesisToolsMeetings

/// The Speakers page's voice pass card (`global.speakerLabels.voice.compute`): what it reads from the config, the
/// worker count `auto` means, what each choice writes, and that the card draws the measured costs in words.
@MainActor
final class MeetingsVoiceSettingsTests: XCTestCase {
    private func raw(_ json: String) throws -> JSONValue {
        try JSONDecoder().decode(JSONValue.self, from: Data(json.utf8))
    }

    func testTheCardReadsTheConfigAndADefaultForAMissingBlock() throws {
        XCTAssertEqual(MeetingsVoiceCompute(raw: nil), MeetingsVoiceCompute(priority: .normal, workers: nil),
                       "no settings read yet: normal and auto")
        XCTAssertEqual(MeetingsVoiceCompute(raw: try raw(#"{"global":{"language":"cs"}}"#)), MeetingsVoiceCompute(),
                       "a config written before the block reads as the defaults")
        let set = try raw(#"{"global":{"speakerLabels":{"voice":{"compute":{"priority":"background","workers":3}}}}}"#)
        XCTAssertEqual(MeetingsVoiceCompute(raw: set), MeetingsVoiceCompute(priority: .background, workers: 3))
        let auto = try raw(#"{"global":{"speakerLabels":{"voice":{"compute":{"priority":"normal","workers":"auto"}}}}}"#)
        XCTAssertEqual(MeetingsVoiceCompute(raw: auto).workers, nil, "\"auto\" is no fixed number")
    }

    func testAutoTakesTheFreePerformanceCoresAtMostFour() {
        // The rule of `voiceWorkerCount` in src/utils/meetings/config.ts.
        XCTAssertEqual(MeetingsVoiceCompute.autoWorkers(performanceCores: 12, load1: 19.4), 1, "a busy Mac gets one worker")
        XCTAssertEqual(MeetingsVoiceCompute.autoWorkers(performanceCores: 12, load1: 9.6), 2)
        XCTAssertEqual(MeetingsVoiceCompute.autoWorkers(performanceCores: 12, load1: 0.5), 4, "never more than four")
        XCTAssertEqual(MeetingsVoiceCompute.autoWorkers(performanceCores: 4, load1: 1.2), 2, "the cores left, rounded down")
        XCTAssertEqual(MeetingsVoiceCompute.autoWorkers(performanceCores: 1, load1: 0), 1)
        let now = MeetingsVoiceCompute.autoWorkersNow()
        XCTAssertTrue((1...4).contains(now), "this Mac now: \(now)")
    }

    func testEachChoiceWritesTheConfigPathItShows() {
        var writes: [(String, String)] = []
        func card(_ compute: MeetingsVoiceCompute) -> MeetingsVoicePassCard {
            MeetingsVoicePassCard(compute: compute, autoNow: 2) { path, value in writes.append((path.joined(separator: "."), "\(value)")) }
        }
        let path = "global.speakerLabels.voice.compute.workers"
        card(MeetingsVoiceCompute()).chooseWorkers("fixed")
        XCTAssertEqual(writes.last?.0, path)
        XCTAssertEqual(writes.last?.1, "2", "a fixed number starts at what auto means now")
        card(MeetingsVoiceCompute(workers: 5)).chooseWorkers("fixed")
        XCTAssertEqual(writes.count, 1, "picking the fixed number again keeps the saved one")
        card(MeetingsVoiceCompute(workers: 5)).chooseWorkers("auto")
        XCTAssertEqual(writes.last?.0, path)
        XCTAssertEqual(writes.last?.1, "auto")
        XCTAssertEqual(MeetingsVoicePassCard.autoDetail(now: 1),
                       "Auto uses the cores that are free when the pass starts (at most 4), so a busy Mac gets one worker. "
                           + "Right now that is 1 worker; it changes with the load.")
    }

    func testTheCardExplainsEachPriorityWithItsMeasuredCost() throws {
        XCTAssertTrue(MeetingsVoicePassCard.normalDetail.contains("about 90 CPU seconds for a one-hour meeting"))
        XCTAssertTrue(MeetingsVoicePassCard.backgroundDetail.contains("32 minutes and 251 CPU seconds"))
        for (compute, expected) in [(MeetingsVoiceCompute(), ["Voice pass", "Normal", "90 CPU seconds", "Auto", "1 worker"]),
                                    (MeetingsVoiceCompute(priority: .background, workers: 6),
                                     // The number itself sits in an AppKit field, which an offscreen render leaves out.
                                     ["In the background", "251 CPU seconds", "A fixed number", "Number of workers", "workers"])] {
            let view = MeetingsVoicePassCard(compute: compute, autoNow: 1) { _, _ in }
                .frame(width: 680).padding(12).background(Color(white: 0.12)).environment(\.colorScheme, .dark)
                // A glass card draws nothing in an offscreen render; the Settings window's solid theme does.
                .environment(\.nativeSettingsTheme, .graphite)
            let renderer = ImageRenderer(content: view)
            renderer.scale = 2
            let image = try XCTUnwrap(renderer.cgImage)
            let request = VNRecognizeTextRequest()
            request.recognitionLevel = .accurate
            request.usesLanguageCorrection = false
            try VNImageRequestHandler(cgImage: image).perform([request])
            let text = (request.results ?? []).compactMap { $0.topCandidates(1).first?.string }.joined(separator: "\n")
            for word in expected {
                XCTAssertTrue(text.contains(word), "drawn: \(word) in\n\(text)")
            }
        }
    }
}
