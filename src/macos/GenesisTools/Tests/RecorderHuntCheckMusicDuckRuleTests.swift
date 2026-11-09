import XCTest
@testable import GenesisToolsRecorder

/// The music settings' "nothing ducks" hint uses check()'s rule (voiceovers.ts `musicDucking`): the renderer's drop,
/// under the transcript unless the ducking object turns that off, under the voiceovers unless it turns those off.
final class RecorderHuntCheckMusicDuckRuleTests: XCTestCase {
    private func withMusic(duck: Double, ducking: EditProject.Ducking? = nil, voiced: Bool = false) -> EditProject {
        var project = EditProject.whole(video: "/tmp/x.mp4", durationUs: 10_000_000, width: 1920, height: 1080, cursor: nil, recording: nil)
        project.audio.music = EditProject.Music(file: "/m.m4a", volume: 0.25, duck: duck, fadeMs: 1500)
        project.audio.ducking = ducking
        if voiced {
            project.audio.voiceovers = [.init(id: "v1", atUs: 1_000_000, file: "/v.mp3", durationUs: 1_500_000)]
        }
        return project
    }

    private func asksForTranscript(_ project: EditProject) -> Bool {
        MusicDuckHint.text(project, hasTranscript: false)?.contains("no transcript") == true
    }

    func testTheNoTranscriptHintFollowsTheDuckingObject() {
        XCTAssertTrue(asksForTranscript(withMusic(duck: 0.6)), "the older share ducks under the transcript")
        XCTAssertTrue(asksForTranscript(withMusic(duck: 0, ducking: .init(db: 12))), "12 dB ducks although the share is 0")
        XCTAssertFalse(asksForTranscript(withMusic(duck: 0.6, ducking: .init(db: 12, transcript: false))),
                       "off under the transcript: a transcript changes nothing")
        XCTAssertNil(MusicDuckHint.text(withMusic(duck: 0.6, ducking: .init(db: 0)), hasTranscript: false), "0 dB asks for no duck")
        XCTAssertNil(MusicDuckHint.text(withMusic(duck: 0.6, voiced: true), hasTranscript: false), "the voiceover ducks the music")
        XCTAssertTrue(asksForTranscript(withMusic(duck: 0.6, ducking: .init(db: 12, voiceovers: false), voiced: true)),
                      "off under the voiceovers: only a transcript can duck it")
        XCTAssertNil(MusicDuckHint.text(withMusic(duck: 0.6), hasTranscript: true), "with a transcript it ducks")
    }

    func testOffUnderTheTranscriptWithNoVoiceoverSaysNothingDucks() {
        let off = withMusic(duck: 0.6, ducking: .init(db: 12, transcript: false))
        for hasTranscript in [false, true] {
            let hint = MusicDuckHint.text(off, hasTranscript: hasTranscript)
            XCTAssertNotNil(hint)
            XCTAssertFalse(hint?.contains("Transcribe") == true, "a transcript would change nothing")
        }
        XCTAssertNil(MusicDuckHint.text(withMusic(duck: 0.6, ducking: .init(db: 12, transcript: false), voiced: true), hasTranscript: false))
    }

    func testTheHintAgreesWithTheRenderersSpeechSpans() {
        // Whenever the hint is silent with a transcript line, the renderer has something to duck under, and the reverse.
        let lines = [CaptionTrack.Line(fromUs: 2_000_000, toUs: 3_000_000, text: "hello")]
        let cases: [EditProject] = [
            withMusic(duck: 0.6),
            withMusic(duck: 0, ducking: .init(db: 12)),
            withMusic(duck: 0.6, ducking: .init(db: 12, transcript: false)),
            withMusic(duck: 0.6, ducking: .init(db: 12, transcript: false), voiced: true),
            withMusic(duck: 0.6, ducking: .init(db: 12, voiceovers: false), voiced: true),
        ]
        for project in cases {
            let ducks = MusicMix.Duck.of(project).drop > 0 && !MusicMix.speech(lines: lines, project: project).isEmpty
            XCTAssertEqual(MusicDuckHint.text(project, hasTranscript: true) == nil, ducks, "\(String(describing: project.audio.ducking))")
        }
    }
}
