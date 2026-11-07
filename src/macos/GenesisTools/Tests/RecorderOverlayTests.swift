import AppKit
import AVFoundation
import CoreImage
import XCTest
@testable import GenesisToolsRecorder

/// Round 4, agent fx-overlay: voiceover clips, music ducking, animated captions and texts, cards, the progress bar.
final class RecorderOverlayTests: XCTestCase {
    private func edit(_ clips: [EditProject.Clip] = [.init(id: "c", fromUs: 0, toUs: 10_000_000)]) -> EditProject {
        var project = EditProject.whole(video: "/tmp/x.mp4", durationUs: 10_000_000, width: 1920, height: 1080, cursor: nil, recording: nil)
        project.clips = clips
        return project
    }

    // R4 voiceover clips
    func testVoiceoversPlayAtTheirOutputTimeAndStopAtTheMoviesEnd() {
        var project = edit([.init(id: "a", fromUs: 0, toUs: 3_000_000), .init(id: "b", fromUs: 5_000_000, toUs: 10_000_000)])
        project.audio.voiceovers = [
            .init(id: "v1", atUs: 1_000_000, file: "/v/one.mp3", durationUs: 1_500_000),
            .init(id: "v2", atUs: 4_000_000, file: "/v/cut.mp3", durationUs: 1_000_000),
            .init(id: "v3", atUs: 9_000_000, file: "/v/late.mp3", durationUs: 5_000_000),
        ]
        let placed = VoiceoverMix.placements(project)
        XCTAssertEqual(placed.map(\.clip.id), ["v1", "v3"], "a clip whose start is cut does not play")
        XCTAssertEqual(placed.map(\.outUs), [1_000_000, 7_000_000], "the cut of 2 s moves the late clip 2 s earlier")
        XCTAssertEqual(placed.map(\.playUs), [1_500_000, 1_000_000], "the late clip stops at the movie's end (8 s)")
    }

    // R4 8 music ducking
    func testDuckingInDecibelsDipsUnderVoiceoversWithItsOwnFade() {
        var project = edit()
        project.audio.music = EditProject.Music(file: "/m.mp3", volume: 0.5, duck: 0.6, fadeMs: 0)
        project.audio.voiceovers = [.init(id: "v1", atUs: 4_000_000, file: "/v.mp3", durationUs: 2_000_000)]
        guard let music = project.audio.music else { return XCTFail("no music") }

        // Without the object: the older share (to 40 %) over 0.3 s, now under the voiceover too.
        let older = MusicMix.speech(lines: [], project: project)
        XCTAssertEqual(older.map(\.fromUs), [4_000_000])
        XCTAssertEqual(MusicMix.gain(atUs: 5_000_000, music: music, speech: older, lengthUs: 10_000_000, duck: .of(project)), 0.2, accuracy: 0.001)

        project.audio.ducking = EditProject.Ducking(db: 12, fadeMs: 500, transcript: true, voiceovers: true)
        let duck = MusicMix.Duck.of(project)
        XCTAssertEqual(duck.rampUs, 500_000)
        XCTAssertEqual(duck.drop, 1 - pow(10, -12.0 / 20), accuracy: 0.0001)
        let speech = MusicMix.speech(lines: [], project: project)
        XCTAssertEqual(MusicMix.gain(atUs: 5_000_000, music: music, speech: speech, lengthUs: 10_000_000, duck: duck),
                       0.5 * pow(10, -12.0 / 20), accuracy: 0.001, "12 dB under the voiceover")
        XCTAssertEqual(MusicMix.gain(atUs: 3_750_000, music: music, speech: speech, lengthUs: 10_000_000, duck: duck),
                       0.5 * (1 - duck.drop * 0.5), accuracy: 0.001, "half way down 0.25 s before it")
        XCTAssertEqual(MusicMix.gain(atUs: 2_000_000, music: music, speech: speech, lengthUs: 10_000_000, duck: duck), 0.5, accuracy: 0.001)
        let frames = MusicMix.keyframes(music: music, speech: speech, lengthUs: 10_000_000, duck: duck)
        XCTAssertEqual(frames.map(\.us), [0, 3_500_000, 4_000_000, 6_000_000, 6_500_000, 10_000_000])

        // Off under the voiceovers: nothing left to dip under.
        project.audio.ducking?.voiceovers = false
        XCTAssertTrue(MusicMix.speech(lines: [], project: project).isEmpty)
        // The transcript's lines still duck unless that is off too.
        let lines = [CaptionTrack.Line(fromUs: 1_000_000, toUs: 2_000_000, text: "hello")]
        XCTAssertEqual(MusicMix.speech(lines: lines, project: project).count, 1)
        project.audio.ducking?.transcript = false
        XCTAssertTrue(MusicMix.speech(lines: lines, project: project).isEmpty)
    }

    func testAVoiceoverAndDuckingRoundTripThroughTheEditFile() throws {
        var project = edit()
        project.audio.voiceovers = [.init(id: "v1", atUs: 1_000_000, file: "/v.mp3", durationUs: 2_000_000, volume: 1.4, label: "Intro")]
        project.audio.ducking = EditProject.Ducking(db: 18, fadeMs: 200, transcript: false, voiceovers: true)
        let back = try EditProject.decode(project.encoded())
        XCTAssertEqual(back.audio, project.audio)
        var louder = project
        louder.audio.voiceovers?[0].volume = 0.5
        louder.audio.ducking = nil
        XCTAssertEqual(EditOpDiff.ops(from: project, to: louder),
                       [.voiceover(EditOp.Voiceover(id: "v1", volume: 0.5)), .ducking(EditOp.Ducking(enabled: false))])
    }
}
