import XCTest
@testable import GenesisToolsRecorder

/// The music ducks under the kept part of a transcript line, the part whose caption shows, also when the line's start
/// or end lies in a cut. A line fully inside a cut still plays nowhere and ducks nothing.
final class RecorderHuntMusicDuckKeptPartsTests: XCTestCase {
    private func project(_ clips: [EditProject.Clip]) -> EditProject {
        var project = EditProject.whole(video: "/tmp/x.mp4", durationUs: 10_000_000, width: 1920, height: 1080, cursor: nil, recording: nil)
        project.clips = clips
        return project
    }

    /// The whole 10 s movie with the source from 3.8 s to 7.2 s cut away.
    private var cutInTheMiddle: EditProject {
        project([.init(id: "a", fromUs: 0, toUs: 3_800_000), .init(id: "b", fromUs: 7_200_000, toUs: 10_000_000)])
    }

    private func line(_ fromUs: Int64, _ toUs: Int64) -> CaptionTrack.Line {
        CaptionTrack.Line(fromUs: fromUs, toUs: toUs, text: "x")
    }

    func testALineWhoseStartIsCutDucksFromTheCutToItsEnd() {
        let edit = project([.init(id: "a", fromUs: 0, toUs: 3_900_000), .init(id: "b", fromUs: 4_400_000, toUs: 10_000_000)])
        let speech = MusicMix.speech(lines: [line(4_000_000, 7_500_000)], project: edit)
        XCTAssertEqual(speech.map(\.fromUs), [3_900_000])
        XCTAssertEqual(speech.map(\.toUs), [7_000_000])
    }

    func testALineThatStartsInsideALongCutDucksOnlyItsKeptPart() {
        let speech = MusicMix.speech(lines: [line(5_000_000, 9_000_000)], project: cutInTheMiddle)
        XCTAssertEqual(speech.map(\.fromUs), [3_800_000])
        XCTAssertEqual(speech.map(\.toUs), [5_600_000])
    }

    func testALineWhoseEndIsCutDucksFromItsStartToTheCut() {
        let speech = MusicMix.speech(lines: [line(2_000_000, 4_500_000)], project: cutInTheMiddle)
        XCTAssertEqual(speech.map(\.fromUs), [2_000_000])
        XCTAssertEqual(speech.map(\.toUs), [3_800_000])
    }

    func testALineWithACutInsideDucksAsOnePart() {
        let speech = MusicMix.speech(lines: [line(3_000_000, 8_000_000)], project: cutInTheMiddle)
        XCTAssertEqual(speech.map(\.fromUs), [3_000_000], "the two kept parts touch at the cut and merge")
        XCTAssertEqual(speech.map(\.toUs), [4_600_000])
    }

    func testALineFullyInsideACutDucksNothing() {
        XCTAssertTrue(MusicMix.speech(lines: [line(4_000_000, 7_000_000)], project: cutInTheMiddle).isEmpty)
    }

    func testTheMusicDipsUnderTheKeptPartOfALineWhoseStartIsCut() {
        let music = EditProject.Music(file: "/m.mp3", volume: 0.5, duck: 0.6, fadeMs: 0)
        let speech = MusicMix.speech(lines: [line(5_000_000, 9_000_000)], project: cutInTheMiddle)
        XCTAssertEqual(MusicMix.gain(atUs: 4_500_000, music: music, speech: speech, lengthUs: 6_400_000), 0.2, accuracy: 0.001,
                       "40 % under the caption that shows")
        XCTAssertEqual(MusicMix.gain(atUs: 6_000_000, music: music, speech: speech, lengthUs: 6_400_000), 0.5, accuracy: 0.001,
                       "full level after the line")
    }
}
