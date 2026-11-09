import Foundation
import XCTest
@testable import GenesisToolsRecorder

/// A part export sounds like the same stretch of the whole export: a voiceover that started before the part plays its
/// rest, and the music goes on from its place in the whole without a new fade-in. The case is shared with
/// recording-editor.test.ts (__fixtures__/part-audio.json), so partOf and TimelineMap.part fail together.
final class RecorderHuntR2PartExportAudioTests: XCTestCase {
    private func fixture() throws -> (root: [String: Any], whole: EditProject, part: EditProject) {
        let root = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: SharedEditorFixture.url("part-audio.json"))) as? [String: Any])
        let whole = try JSONDecoder().decode(EditProject.self, from: JSONSerialization.data(withJSONObject: try XCTUnwrap(root["edit"])))
        let range = try XCTUnwrap(root["part"] as? [String: Any])
        let fromUs = try XCTUnwrap((range["fromUs"] as? NSNumber)?.int64Value)
        let toUs = try XCTUnwrap((range["toUs"] as? NSNumber)?.int64Value)
        // The window's export: the part, without the cards around it.
        let part = EditorModel.exportedProject(whole, part: (fromUs: fromUs, toUs: toUs))
        return (root, whole, part)
    }

    func testThePartKeepsTheVoiceoversThatPlayAcrossItsStartAsTypeScriptDoes() throws {
        let (root, _, part) = try fixture()
        let expected = try XCTUnwrap(root["voiceovers"] as? [[String: Any]]).map { clip in
            "\(clip["id"] ?? "") \(clip["atUs"] ?? "") \(clip["skipUs"] ?? "-") \(clip["durationUs"] ?? "")"
        }
        XCTAssertEqual(part.audio.voiceovers?.map { "\($0.id) \($0.atUs) \($0.skipUs.map(String.init) ?? "-") \($0.durationUs)" }, expected)
        let spans = try XCTUnwrap(root["spans"] as? [[String: Any]]).map { "\($0["id"] ?? "") \($0["startUs"] ?? "") \($0["playUs"] ?? "")" }
        let placed = VoiceoverMix.exportPlacements(part, cards: CardSpans(project: part, enabled: true))
        XCTAssertEqual(placed.map { "\($0.clip.id) \($0.outUs) \($0.playUs)" }, spans)
        let inWhole = try XCTUnwrap(root["inWhole"] as? [String: Any])
        XCTAssertEqual(part.audio.music?.inWhole?.atUs, (inWhole["atUs"] as? NSNumber)?.int64Value)
        XCTAssertEqual(part.audio.music?.inWhole?.lengthUs, (inWhole["lengthUs"] as? NSNumber)?.int64Value)
    }

    func testThePartsMusicStartsAtTheWholesLevelThereWithNoNewFadeIn() throws {
        let (_, whole, part) = try fixture()
        let wholeMusic = try XCTUnwrap(whole.audio.music)
        let partMusic = try XCTUnwrap(part.audio.music)
        let inWhole = try XCTUnwrap(partMusic.inWhole)
        let partUs = part.outputDurationUs
        let frames = MusicMix.keyframes(music: partMusic, speech: [], lengthUs: partUs)
        let wholeThere = MusicMix.gain(atUs: inWhole.atUs, music: wholeMusic, speech: [], lengthUs: inWhole.lengthUs)
        XCTAssertEqual(try XCTUnwrap(frames.first).volume, wholeThere, accuracy: 1e-9)
        XCTAssertEqual(wholeThere, wholeMusic.volume, accuracy: 1e-9, "the part starts 8 s into the whole: no fade there")
        XCTAssertEqual(try XCTUnwrap(frames.last).volume, wholeMusic.volume, accuracy: 1e-9, "and no fade-out at the part's end")
        // The whole itself still fades in from silence.
        XCTAssertEqual(try XCTUnwrap(MusicMix.keyframes(music: wholeMusic, speech: [], lengthUs: inWhole.lengthUs).first).volume, 0, accuracy: 1e-9)
    }
}
