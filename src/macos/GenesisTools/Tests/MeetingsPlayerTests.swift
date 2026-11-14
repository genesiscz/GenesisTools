import AudioToolbox
import Foundation
import XCTest
@testable import GenesisToolsMeetings

/// A sound that plays nothing: the test moves its time and ends it.
@MainActor
private final class FakeSound: MomentSound {
    let url: URL
    var currentTime: TimeInterval = 0
    let duration: TimeInterval
    var rate: Float = 1
    private(set) var isPlaying = false
    var onEnd: (@MainActor () -> Void)?
    private(set) var stopped = false
    /// False: a format the system player opens but cannot seek in (Ogg Opus).
    let seeksExactly: Bool

    init(url: URL, duration: TimeInterval, seeksExactly: Bool = true) {
        self.url = url
        self.duration = duration
        self.seeksExactly = seeksExactly
    }

    func play() { isPlaying = true }
    func pause() { isPlaying = false }
    func stop() {
        isPlaying = false
        stopped = true
        onEnd = nil
    }

    /// The sound reached its end.
    func finish() {
        currentTime = duration
        isPlaying = false
        onEnd?()
    }
}

/// The Moment engine in the test: each cut answers a Moment of the target's time with a 5 s pad and the tone 0.4 s
/// before the spot, and records what it was asked.
@MainActor
private final class FakeEngine {
    var cuts: [MeetingsAPI.MomentParams] = []
    var plans: [MeetingsAPI.MomentParams] = []
    var cutFailure: Error?
    var planAnswer = MeetingsAPI.MomentPlan.Result(moment: nil, cannot: nil)
    var audio: MeetingsAPI.MeetingAudio.Result?
    /// A cut waits until the test lets it go.
    var holdCuts = false
    var cancelledCuts = 0
    private var held: [CheckedContinuation<Void, Never>] = []
    let folder: URL

    init() throws {
        folder = FileManager.default.temporaryDirectory.appendingPathComponent("moment-player-\(UUID().uuidString.prefix(8))")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
    }

    func release() {
        let waiting = held
        held = []
        for continuation in waiting { continuation.resume() }
    }

    static func moment(_ meeting: String, _ target: MomentTarget, spot: Double, pad: Double = 5, length: Double = 10) -> Moment {
        Moment(meeting: meeting, target: target, label: MomentPlayer.provisionalLabel(target), fromSec: spot, toSec: spot + length,
               padSec: pad, startSec: max(0, spot - pad), endSec: spot + length + pad, spotSec: spot,
               tone: .init(atSec: spot - 0.4, sound: ToneSound(hz: 880, sec: 0.15, volume: 0.6)), delaySec: 2, repeatGapSec: 1, screen: nil)
    }

    var engine: MomentPlayer.Engine {
        MomentPlayer.Engine(
            cut: { [unowned self] params in
                self.cuts.append(params)
                if self.holdCuts { await withCheckedContinuation { self.held.append($0) } }
                if Task.isCancelled { self.cancelledCuts += 1 }
                try Task.checkCancellation()
                if let cutFailure = self.cutFailure { throw cutFailure }
                let spot: Double
                switch params.target {
                case .item: spot = 100
                case .range(let from, _): spot = from
                default: spot = params.target.startSec ?? 0
                }
                var moment = Self.moment(params.meeting, params.target, spot: spot, pad: params.padSec ?? 5)
                if case .range(let from, let to) = params.target {
                    moment = Moment(meeting: params.meeting, target: params.target, label: moment.label, fromSec: from, toSec: to,
                                    padSec: params.padSec ?? 5, startSec: from - (params.padSec ?? 5), endSec: to + (params.padSec ?? 5),
                                    spotSec: from, tone: moment.tone, delaySec: 2, repeatGapSec: 1, screen: nil)
                }
                let path = self.folder.appendingPathComponent("\(UUID().uuidString.prefix(6)).wav")
                FileManager.default.createFile(atPath: path.path, contents: Data())
                return MomentClip(moment: moment, path: path.path)
            },
            plan: { [unowned self] params in
                self.plans.append(params)
                return self.planAnswer
            },
            audio: { [unowned self] _ in
                guard let audio = self.audio else { throw MeetingsService.Unavailable(reason: "no service in the test") }
                return audio
            })
    }
}

@MainActor
final class MeetingsPlayerTests: XCTestCase {
    private var defaults: UserDefaults!
    private var suite = ""
    private var engine: FakeEngine!
    private var sounds: [FakeSound] = []
    /// Whether the player seeks in the recording's own file (the clips it cuts always seek).
    private var recordingSeeks = true

    override func setUp() async throws {
        suite = "meetings.player.tests.\(UUID().uuidString)"
        defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        engine = try FakeEngine()
        sounds = []
        recordingSeeks = true
    }

    override func tearDown() async throws {
        defaults.removePersistentDomain(forName: suite)
        try? FileManager.default.removeItem(at: engine.folder)
    }

    private func makePlayer() -> MomentPlayer {
        MomentPlayer(engine: engine.engine, load: { [unowned self] url in
            let sound = FakeSound(url: url, duration: 20, seeksExactly: self.recordingSeeks || url.pathExtension == "wav")
            self.sounds.append(sound)
            return sound
        }, defaults: defaults)
    }

    private var playingCount: Int { sounds.filter(\.isPlaying).count }

    // MARK: The table and the rules

    func testOneTableDecidesPushOrReplacePerClickSource() {
        let push = MeetingsPreferences.Playback.ClickInQuestion.push
        XCTAssertEqual(MomentPlayer.placement(for: .row, clickInQuestion: push), .replaceAll)
        XCTAssertEqual(MomentPlayer.placement(for: .autoplay, clickInQuestion: push), .replaceAll)
        XCTAssertEqual(MomentPlayer.placement(for: .pin, clickInQuestion: push), .replaceAll)
        XCTAssertEqual(MomentPlayer.placement(for: .questionTime, clickInQuestion: push), .push, "R38: a time in a question layers up")
        XCTAssertEqual(MomentPlayer.placement(for: .questionTime, clickInQuestion: .replace), .replaceTop)
        XCTAssertEqual(MomentPlayer.placement(for: .speakerChip, clickInQuestion: push), .push)
        XCTAssertEqual(MomentPlayer.placement(for: .selection, clickInQuestion: push), .push)
        XCTAssertEqual(MomentPlayer.placement(for: .transcript, clickInQuestion: push), .replaceTop)
        XCTAssertEqual(MomentPlayer.placement(for: .more, clickInQuestion: push), .replaceTop)
        XCTAssertEqual(MomentPlayer.placement(for: .outside, clickInQuestion: push), .replaceTop)
    }

    /// G-STACK-3: Play on after a pause goes back 1 s, but never into the tone once it has played.
    func testTheRewindNeverReplaysTheTone() {
        // The clip starts at 95; the tone sounds at 99.6 and ends at 99.75.
        XCTAssertEqual(MomentPlayer.resumeOffset(pausedAt: 100.2, startSec: 95, rewindSec: 1, toneEndSec: 99.75), 4.75, accuracy: 0.0001,
                       "paused 0.45 s after the tone: it plays on from the tone's end, not before it")
        XCTAssertEqual(MomentPlayer.resumeOffset(pausedAt: 104, startSec: 95, rewindSec: 1, toneEndSec: 99.75), 8, accuracy: 0.0001)
        XCTAssertEqual(MomentPlayer.resumeOffset(pausedAt: 97, startSec: 95, rewindSec: 1, toneEndSec: 99.75), 1, accuracy: 0.0001,
                       "before the tone the rewind is plain; the tone plays as part of the clip")
        XCTAssertEqual(MomentPlayer.resumeOffset(pausedAt: 95.4, startSec: 95, rewindSec: 1, toneEndSec: nil), 0)
    }

    /// The clip key is the same text for the same Moment every time: a JSON encoder may order keys differently between
    /// two encodes, which made a pre-cut clip miss and cut again.
    func testTheClipKeyNeverChangesForTheSameMoment() {
        let params = MeetingsAPI.MomentParams(meeting: "m", target: .selection(from: LinePoint(atSec: 2, line: 0, fraction: 0.5),
                                                                               to: LinePoint(atSec: 9, line: 1)))
        let first = MomentPlayer.key(params)
        for _ in 0..<200 { XCTAssertEqual(MomentPlayer.key(params), first) }
        XCTAssertNotEqual(MomentPlayer.key(MeetingsAPI.MomentParams(meeting: "m", target: .item("i1"), lengthSec: 5)),
                          MomentPlayer.key(MeetingsAPI.MomentParams(meeting: "m", target: .item("i1"))))
    }

    func testClipIdentityAndCommandKeepEveryPlaybackOverride() {
        let plain = MeetingsAPI.MomentParams(meeting: "m", target: .item("i1"))
        let quiet = MeetingsAPI.MomentParams(meeting: "m", target: .item("i1"), tone: false)
        let padded = MeetingsAPI.MomentParams(meeting: "m", target: .item("i1"), padAfterSec: 7)
        XCTAssertNotEqual(MomentPlayer.key(plain), MomentPlayer.key(quiet))
        XCTAssertNotEqual(MomentPlayer.key(plain), MomentPlayer.key(padded))
        let rolling = MomentPlayer.rollingParams("m", from: 20)
        XCTAssertEqual(rolling.tone, false)
        let args = MomentPlayer.Engine.command(rolling)
        XCTAssertTrue(args.contains("--no-tone"))
        XCTAssertTrue(args.contains("--no-screen"))
        XCTAssertTrue(args.contains("--pad-before"))
        let bounded = MeetingsAPI.MomentParams(meeting: "m", target: .item("i1"), padSec: 2, padAfterSec: 7, lengthSec: 5)
        let command = MomentPlayer.Engine.command(bounded)
        XCTAssertEqual(Array(command.suffix(6)), ["--pad-before", "2.0", "--pad-after", "7.0", "--length", "5.0"])
    }

    func testCuttingWordsWaitTwoHundredMillisecondsAndCancelFiveSeconds() {
        XCTAssertFalse(MomentPlayer.cuttingShows(elapsed: 0.15).words)
        XCTAssertTrue(MomentPlayer.cuttingShows(elapsed: 0.2).words)
        XCTAssertFalse(MomentPlayer.cuttingShows(elapsed: 4.9).cancel)
        XCTAssertTrue(MomentPlayer.cuttingShows(elapsed: 5).cancel)
    }

    // MARK: Playing a Moment

    func testARowPlaysItsClipFromTheStartAndASecondClickPausesIt() async throws {
        let player = makePlayer()
        player.play(.item("i3"), in: "m", from: .row)
        guard case .cutting = player.phase else { return XCTFail("the clip is cut first, got \(player.phase)") }
        try await until("it plays") { player.phase == .playing }
        XCTAssertEqual(engine.cuts.map(\.target), [.item("i3")], "one moment.clip of the row's target")
        XCTAssertEqual(player.top?.label, "i3")
        XCTAssertEqual(player.top?.startSec, 95)
        XCTAssertEqual(player.top?.toneEndSec ?? 0, 99.75, accuracy: 0.0001)
        XCTAssertEqual(sounds.first?.currentTime, 0, "the clip plays from its start: the pad, then the tone at the spot")
        XCTAssertTrue(player.isPlaying(.item("i3"), in: "m"))

        sounds[0].currentTime = 5.2
        player.play(.item("i3"), in: "m", from: .row)
        XCTAssertEqual(player.phase, .paused, "a second click on the same row pauses (R14)")
        XCTAssertEqual(player.top?.pausedAt ?? 0, 100.2, accuracy: 0.0001)
        XCTAssertEqual(engine.cuts.count, 1, "and cuts nothing again")
        player.resume()
        XCTAssertEqual(player.phase, .playing)
        XCTAssertEqual(sounds[0].currentTime, 4.75, accuracy: 0.0001, "play on goes back to the tone's end, not into the tone")
    }

    func testAPushedMomentPausesTheOneBelowAndGivesItBackWhenItEnds() async throws {
        let player = makePlayer()
        player.play(.item("q1"), in: "m", from: .row)
        try await until("the question plays") { player.phase == .playing }
        sounds[0].currentTime = 8

        player.play(.range(from: 730, to: 750), in: "m", from: .questionTime)
        XCTAssertEqual(player.stack.count, 2, "the question's own time layers up (R38)")
        XCTAssertFalse(sounds[0].isPlaying, "the Moment below paused at once")
        XCTAssertEqual(player.stack[0].pausedAt ?? 0, 103, accuracy: 0.0001)
        try await until("the pushed Moment plays") { player.phase == .playing && self.sounds.count == 2 }
        XCTAssertEqual(playingCount, 1, "two sounds never play at once")
        XCTAssertEqual(player.top?.label, "12:10–12:30")

        sounds[1].finish()
        XCTAssertEqual(player.stack.count, 1, "the pushed Moment left when it ended")
        XCTAssertTrue(sounds[1].stopped)
        XCTAssertEqual(player.phase, .playing, "the one below plays again")
        XCTAssertTrue(sounds[0].isPlaying)
        XCTAssertEqual(sounds[0].currentTime, 7, accuracy: 0.0001, "from where it stopped, 1 s earlier")
        XCTAssertEqual(playingCount, 1)
    }

    func testTheStackKeepsAtMostItsDepthBelowTheTop() async throws {
        defaults.set(2, forKey: MeetingsPreferences.Playback.stackDepth.key)
        let player = makePlayer()
        player.play(.item("i1"), in: "m", from: .row)
        for second in [10.0, 20, 30, 40] {
            player.play(.stretch(atSec: second, speaker: nil), in: "m", from: .speakerChip)
        }
        XCTAssertEqual(player.stack.count, 3, "two below the top")
        XCTAssertEqual(player.stack.map(\.target), [.stretch(atSec: 20, speaker: nil), .stretch(atSec: 30, speaker: nil),
                                                    .stretch(atSec: 40, speaker: nil)])
        player.play(.item("i2"), in: "m", from: .row)
        XCTAssertEqual(player.stack.map(\.target), [.item("i2")], "a row starts over")
    }

    func testFrameReviewDragDoesNotSeekUntilRelease() async throws {
        engine.audio = .init(path: engine.folder.appendingPathComponent("upload.wav").path, tracks: 1, channels: 2, durationSec: 3600)
        let player = makePlayer()
        player.playMeeting("m", at: 30)
        try await until("recording plays") { player.phase == .playing }
        player.pause()
        let before = sounds.last?.currentTime
        let review = FrameReviewModel(meeting: "m", file: "a.png", at: 30, player: player, defaults: defaults)
        review.sourceDuration = 3600
        review.beginScrub()
        for step in 0..<1000 { review.scrub(to: Double(step), seek: true) }
        XCTAssertEqual(sounds.last?.currentTime, before)
        XCTAssertTrue(review.isScrubbing)
        review.endScrub(seek: true)
        XCTAssertEqual(sounds.last?.currentTime, 999)
        XCTAssertEqual(player.phase, .paused)
        XCTAssertFalse(review.isScrubbing)
    }

    func testFrameReviewSeekingKeepsAPausedRecordingPaused() async throws {
        engine.audio = .init(path: engine.folder.appendingPathComponent("upload.ogg").path, tracks: 1, channels: 2, durationSec: 3600)
        let player = makePlayer()
        player.play(.item("i1"), in: "m", from: .row)
        try await until("first moment plays") { player.phase == .playing }
        player.pause()
        let review = FrameReviewModel(meeting: "m", file: "a.png", at: 600, player: player, defaults: defaults)
        review.sourceDuration = 3600
        review.selectTime(600)
        review.seekPlayback()
        try await until("recording is positioned and paused") { player.phase == .paused && player.top?.kind == .file }
        XCTAssertEqual(player.position, 600)
        XCTAssertEqual(playingCount, 0)
    }

    func testRoutedMomentPushesAndKeepsItsPlaybackOptions() async throws {
        let player = makePlayer()
        player.play(.item("i1"), in: "m", from: .row)
        try await until("first moment plays") { player.phase == .playing }
        let request = MeetingsAPI.MomentParams(meeting: "m", target: .time(600), padSec: 1, padAfterSec: 3,
                                              tone: false, screen: false, lengthSec: 5)
        player.play(request, from: .link)
        try await until("routed moment plays") { player.phase == .playing && self.engine.cuts.count == 2 }
        XCTAssertEqual(engine.cuts.last, request)
        XCTAssertEqual(player.stack.map(\.target), [.item("i1"), .time(600)])
        XCTAssertEqual(playingCount, 1)
    }

    func testResumeKeepsExplicitPausedSeekButNormalPauseStillRewinds() async throws {
        defaults.set("selectedTime", forKey: "meetings.playback.resumeAfterSeek")
        defaults.set(1.0, forKey: MeetingsPreferences.Playback.rewindSec.key)
        let player = makePlayer()
        player.play(.item("i3"), in: "m", from: .row)
        try await until("it plays") { player.phase == .playing }
        player.pause()
        player.seek(to: 108)
        XCTAssertEqual(player.phase, .paused)
        XCTAssertEqual(sounds[0].currentTime, 13, accuracy: 0.0001)
        player.resume()
        XCTAssertEqual(sounds[0].currentTime, 13, accuracy: 0.0001, "Play must keep the explicitly chosen time")
        sounds[0].currentTime = 14
        player.pause()
        player.resume()
        XCTAssertEqual(sounds[0].currentTime, 13, accuracy: 0.0001, "an ordinary pause still uses the one-second rewind")
    }

    func testReturningToAPausedSeekKeepsItsChosenTime() async throws {
        let player = makePlayer()
        player.play(.item("i3"), in: "m", from: .row)
        try await until("the first clip plays") { player.phase == .playing }
        player.pause()
        player.seek(to: 108)
        player.play(.time(40), in: "m", from: .questionTime)
        try await until("the pushed clip plays") { self.sounds.count == 2 && player.phase == .playing }
        player.pop()
        XCTAssertEqual(sounds[0].currentTime, 13, accuracy: 0.0001)
        XCTAssertEqual(player.phase, .playing)
    }

    func testLegacyResumeRewindCanApplyAfterAPausedSeek() async throws {
        defaults.set("rewind", forKey: "meetings.playback.resumeAfterSeek")
        defaults.set(1.0, forKey: MeetingsPreferences.Playback.rewindSec.key)
        let player = makePlayer()
        player.play(.item("i3"), in: "m", from: .row)
        try await until("it plays") { player.phase == .playing }
        player.pause()
        player.seek(to: 108)
        player.resume()
        XCTAssertEqual(sounds[0].currentTime, 12, accuracy: 0.0001)
    }

    func testATranscriptTimeSeeksInsideTheClipAndReplacesTheTopOutsideIt() async throws {
        let player = makePlayer()
        player.play(.item("i3"), in: "m", from: .row)
        try await until("it plays") { player.phase == .playing }
        player.playTime(108, in: "m")
        XCTAssertEqual(sounds[0].currentTime, 13, accuracy: 0.0001, "inside the clip: a seek, no new cut")
        XCTAssertEqual(engine.cuts.count, 1)

        player.playTime(600, in: "m", from: .row)
        XCTAssertEqual(player.stack.count, 1)
        XCTAssertEqual(player.top?.target, .time(600), "outside the clip: the Moment at that time takes the top's place (G-PLAY-1)")
        try await until("the new Moment plays") { player.phase == .playing && self.sounds.count == 2 }
        XCTAssertTrue(sounds[0].stopped)
        XCTAssertEqual(engine.cuts.last?.tone, false, "outside playback must not add a tone")
    }

    func testTheEndOfAClipOffersMoreAndPlaysTheNextStretch() async throws {
        let player = makePlayer()
        player.play(.time(60), in: "m", from: .transcript)
        try await until("it plays") { player.phase == .playing }
        sounds[0].finish()
        XCTAssertEqual(player.phase, .ended(offerMore: true), "the default afterClip offers more")
        player.playMore()
        XCTAssertEqual(player.top?.target, .range(from: 75, to: 105), "30 s from the clip's end")

        defaults.set("stop", forKey: MeetingsPreferences.Playback.afterClip.key)
        try await until("it plays") { player.phase == .playing && self.sounds.count == 2 }
        sounds[1].finish()
        XCTAssertEqual(player.phase, .ended(offerMore: false))
    }

    func testAFailedCutSaysWhyAndTheMeetingsPlayControlsKnowIt() async throws {
        engine.cutFailure = MeetingsCLI.Failure(sentence: "No source keeps the recording.", detail: "unplayable", code: "unplayable")
        engine.planAnswer = .init(moment: nil, cannot: MomentCannot(code: "no-audio", message: "No source keeps the recording on this Mac."))
        let player = makePlayer()
        player.play(.item("i3"), in: "m", from: .row)
        try await until("it failed") { if case .failed = player.phase { return true } else { return false } }
        try await until("the reason is known") { player.reason(.item("i9"), in: "m") != nil }
        XCTAssertEqual(player.reason(.item("i9"), in: "m")?.code, "no-audio", "a state reason disables every play control of the meeting")
        XCTAssertNil(player.reason(.item("i9"), in: "other"))
        player.dismissFailure()
        XCTAssertEqual(player.phase, .idle)
        XCTAssertTrue(player.stack.isEmpty)
    }

    func testPoppingACuttingTopCancelsItsEngineRequest() async throws {
        let player = makePlayer()
        player.play(.item("i1"), in: "m", from: .row)
        try await until("the first clip plays") { player.phase == .playing }
        engine.holdCuts = true
        player.play(.stretch(atSec: 40, speaker: "Dana Example"), in: "m", from: .speakerChip)
        try await until("the pushed request is waiting") { self.engine.cuts.count == 2 }
        player.pop()
        XCTAssertEqual(player.top?.target, .item("i1"))
        XCTAssertEqual(player.phase, .playing)
        engine.release()
        try await until("the request sees cancellation") { self.engine.cancelledCuts == 1 }
        XCTAssertEqual(player.top?.target, .item("i1"))
        XCTAssertEqual(player.phase, .playing)
    }

    func testTargetRefusalsAreFoundWithScreenSuppressed() async throws {
        engine.planAnswer = .init(moment: nil, cannot: MomentCannot(code: "unknown-item", message: "No such item."))
        let player = makePlayer()
        player.checkPlayable(.item("missing"), in: "m")
        try await until("the target refusal is known") { player.reason(.item("missing"), in: "m") != nil }
        XCTAssertEqual(player.reason(.item("missing"), in: "m")?.code, "unknown-item")
        XCTAssertNil(player.reason(.item("other"), in: "m"))
    }

    func testChangedPlaybackSettingsCutTheNextClipAgain() async throws {
        let player = makePlayer()
        player.play(.item("i1"), in: "m", from: .row)
        try await until("the first clip plays") { player.phase == .playing }
        player.stop()
        player.invalidateClipCache()
        player.play(.item("i1"), in: "m", from: .row)
        try await until("the changed clip plays") { player.phase == .playing }
        XCTAssertEqual(engine.cuts.count, 2, "a cached tone or pad must not outlive its setting")
    }

    func testARowsPlayControlCutsAgainAfterAFailedCut() async throws {
        engine.cutFailure = MeetingsCLI.Failure(sentence: "The clip could not be cut.", detail: "ffmpeg exited 1")
        let player = makePlayer()
        player.play(.item("i3"), in: "m", from: .row)
        try await until("it failed") { if case .failed = player.phase { return true } else { return false } }
        engine.cutFailure = nil
        player.play(.item("i3"), in: "m", from: .row)
        try await until("the second click plays") { player.phase == .playing }
        XCTAssertEqual(engine.cuts.count, 2, "a click on the failed Moment's control is a retry, not a pause")
        XCTAssertEqual(player.stack.count, 1)
    }

    func testCancelStopsTheCutAndKeepsWhatPlayedBefore() async throws {
        let player = makePlayer()
        player.play(.item("i1"), in: "m", from: .row)
        try await until("it plays") { player.phase == .playing }
        engine.holdCuts = true
        player.play(.stretch(atSec: 40, speaker: "Dana Example"), in: "m", from: .speakerChip)
        try await until("the cut runs") { self.engine.cuts.count == 2 }
        player.cancelCut()
        XCTAssertEqual(player.stack.count, 1, "the Moment being cut left")
        XCTAssertEqual(player.phase, .paused, "the one below waits, paused")
        engine.release()
    }

    func testAPreCutWaitsWhileAPlaysCutRunsSoTheServiceNeverCancelsThePlay() async throws {
        engine.holdCuts = true
        let player = makePlayer()
        player.play(.item("i1"), in: "m", from: .row)
        try await until("the play's cut runs") { self.engine.cuts.count == 1 }
        player.precut(.item("i2"), in: "m")
        XCTAssertEqual(engine.cuts.count, 1, "no second moment.clip while the first runs")
        engine.release()
        try await until("it plays") { player.phase == .playing }
        engine.holdCuts = false
        player.precut(.item("i2"), in: "m")
        try await until("the next row is cut") { self.engine.cuts.count == 2 }
        try await Task.sleep(for: .milliseconds(30))
        player.play(.item("i2"), in: "m", from: .autoplay)
        try await until("the next row plays") { player.phase == .playing && player.top?.target == .item("i2") }
        XCTAssertEqual(engine.cuts.count, 2, "the pre-cut clip plays without another cut")
    }

    func testStopEndsEverySound() async throws {
        let player = makePlayer()
        player.play(.item("i1"), in: "m", from: .row)
        try await until("it plays") { player.phase == .playing }
        player.play(.time(10), in: "m", from: .selection)
        try await until("the selection plays") { self.sounds.count == 2 && player.phase == .playing }
        player.stop()
        XCTAssertEqual(player.phase, .idle)
        XCTAssertTrue(player.stack.isEmpty)
        XCTAssertTrue(sounds.allSatisfy(\.stopped))
        XCTAssertNil(player.meeting)
    }

    // MARK: Whole-meeting mode (decision 16)

    func testOneTrackPlaysTheRecordingItselfFromTheTime() async throws {
        engine.audio = .init(path: engine.folder.appendingPathComponent("upload.ogg").path, tracks: 1, channels: 2, durationSec: 3600)
        let player = makePlayer()
        player.playMeeting("m", at: 1234)
        try await until("it plays") { player.phase == .playing }
        XCTAssertEqual(player.top?.kind, .file)
        XCTAssertEqual(sounds[0].url.lastPathComponent, "upload.ogg")
        XCTAssertEqual(sounds[0].currentTime, 1234, "the file plays from the time: no cut")
        XCTAssertTrue(engine.cuts.isEmpty)
        player.playTime(2000, in: "m")
        XCTAssertEqual(sounds[0].currentTime, 2000, "a seek in the whole meeting is instant")
    }

    func testSeveralTracksPlayAsSixtySecondMomentsOneAfterTheOther() async throws {
        engine.audio = .init(path: "/x/two.mka", tracks: 2, channels: 2, durationSec: 3600)
        let player = makePlayer()
        player.playMeeting("m", at: 100)
        try await until("the first stretch plays") { player.phase == .playing }
        XCTAssertEqual(player.top?.kind, .rolling)
        XCTAssertEqual(engine.cuts.first?.target, .range(from: 100, to: 160))
        XCTAssertEqual(engine.cuts.first?.padSec, 0, "the stretches meet end to start")
        sounds[0].finish()
        try await until("the next stretch is cut") { self.engine.cuts.count == 2 }
        XCTAssertEqual(engine.cuts[1].target, .range(from: 160, to: 220))
    }

    func testTheViewSettingPlaysAnOutsideTimeAsTheWholeMeeting() async throws {
        defaults.set("meeting", forKey: MeetingsPreferences.Playback.view.key)
        engine.audio = .init(path: engine.folder.appendingPathComponent("a.ogg").path, tracks: 1, channels: 1, durationSec: 600)
        let player = makePlayer()
        player.playTime(42, in: "m")
        try await until("it plays") { player.phase == .playing }
        XCTAssertEqual(player.top?.kind, .file)
        XCTAssertTrue(engine.cuts.isEmpty)
    }

    // MARK: A recording the system player cannot seek in (2026-11-10: every whole-meeting play started at 00:00)

    func testTheCodingsThePlayerSeeksInAreTheMeasuredOnes() {
        XCTAssertTrue(AVMomentSound.seeksExactly(coding: kAudioFormatLinearPCM))
        XCTAssertTrue(AVMomentSound.seeksExactly(coding: kAudioFormatMPEG4AAC))
        XCTAssertTrue(AVMomentSound.seeksExactly(coding: kAudioFormatMPEGLayer3))
        XCTAssertTrue(AVMomentSound.seeksExactly(coding: kAudioFormatFLAC))
        XCTAssertFalse(AVMomentSound.seeksExactly(coding: kAudioFormatOpus), "an Ogg Opus recording opens, reports the asked time and plays its start")
        XCTAssertFalse(AVMomentSound.seeksExactly(coding: nil), "a file nobody could read takes the cut stretches")
    }

    func testARecordingThePlayerCannotSeekInPlaysAsStretchesFromTheTime() async throws {
        engine.audio = .init(path: engine.folder.appendingPathComponent("upload.ogg").path, tracks: 1, channels: 2, durationSec: 8758)
        recordingSeeks = false
        let player = makePlayer()
        player.playMeeting("m", at: 2926)
        try await until("the stretch plays") { player.phase == .playing }
        XCTAssertEqual(player.top?.kind, .rolling, "one track, but a seek in it would play the file's start")
        XCTAssertEqual(engine.cuts.first?.target, .range(from: 2926, to: 2986))
        XCTAssertEqual(player.top?.label, "The meeting from 48:46")
        XCTAssertEqual(sounds.last?.url.pathExtension, "wav", "what plays is the cut stretch, not the recording")
    }

    func testAClickOnAPausedStretchPutsTheSoundThereAndStaysPaused() async throws {
        engine.audio = .init(path: engine.folder.appendingPathComponent("upload.ogg").path, tracks: 1, channels: 2, durationSec: 8758)
        recordingSeeks = false
        let player = makePlayer()
        player.playMeeting("m", at: 100)
        try await until("the stretch plays") { player.phase == .playing }
        player.pause()
        player.playTime(3000, in: "m", from: .outside)
        try await until("the clicked stretch is loaded") { player.phase == .paused && player.top?.startSec == 3000 }
        XCTAssertEqual(player.position, 3000, "the clock and the playhead show the clicked second")
        XCTAssertEqual(playingCount, 0, "the reader clicks, then plays")
        XCTAssertEqual(player.stack.count, 1)
        player.togglePause()
        XCTAssertEqual(player.phase, .playing)
        XCTAssertEqual(sounds.last?.currentTime, 0, "it plays the clicked stretch from its start")
    }

    func testTheNextStretchAndAClickKeepTheZoomedRange() async throws {
        engine.audio = .init(path: engine.folder.appendingPathComponent("upload.ogg").path, tracks: 1, channels: 2, durationSec: 8758)
        recordingSeeks = false
        let player = makePlayer()
        player.playMeeting("m", at: 100)
        try await until("the stretch plays") { player.phase == .playing }
        player.timeline.showView(100...400, layer: player.top?.id)
        sounds.last?.finish()
        try await until("the next stretch plays") { player.top?.startSec == 160 && player.phase == .playing }
        XCTAssertEqual(player.timeline.trail(of: player.top?.id), [100...400], "the next stretch is the same play")
        player.playTime(300, in: "m", from: .outside)
        try await until("the clicked stretch plays") { player.top?.startSec == 300 && player.phase == .playing }
        XCTAssertEqual(player.timeline.trail(of: player.top?.id), [100...400], "a click in the range does not zoom out")
    }

    func testTheStretchAfterTheOneThatPlaysIsCutAhead() async throws {
        engine.audio = .init(path: engine.folder.appendingPathComponent("upload.ogg").path, tracks: 1, channels: 2, durationSec: 8758)
        recordingSeeks = false
        let player = makePlayer()
        player.playMeeting("m", at: 100)
        try await until("the next stretch is cut while the first plays") { self.engine.cuts.count == 2 }
        XCTAssertEqual(engine.cuts.map(\.target), [.range(from: 100, to: 160), .range(from: 160, to: 220)])
        XCTAssertEqual(player.top?.startSec, 100, "the first one still plays")
        sounds.last?.finish()
        try await until("the next stretch plays") { player.top?.startSec == 160 && player.phase == .playing }
        XCTAssertEqual(engine.cuts.filter { $0.target == .range(from: 160, to: 220) }.count, 1, "its clip was at hand: no second cut, no gap")
    }

    // MARK: "Show" on a stretch too long for a clip

    func testShowMovesAWholeMeetingPlayAndNamesItsLevelAnew() async throws {
        engine.audio = .init(path: engine.folder.appendingPathComponent("a.m4a").path, tracks: 1, channels: 1, durationSec: 9000)
        let player = makePlayer()
        player.showMeeting("m", from: 1038)
        try await until("it plays") { player.phase == .playing }
        XCTAssertEqual(player.top?.label, "The meeting from 17:18")
        player.pause()
        player.showMeeting("m", from: 2926)
        XCTAssertEqual(player.stack.count, 1, "the same play moves there; no level is added")
        XCTAssertEqual(player.top?.label, "The meeting from 48:46", "the breadcrumb says where the sound is")
        XCTAssertEqual(sounds[0].currentTime, 2926)
        XCTAssertEqual(player.phase, .playing, "Show plays from the stretch's start, also from a pause")
    }

    func testShowOnStretchesTakesTheStretchsPlace() async throws {
        engine.audio = .init(path: engine.folder.appendingPathComponent("upload.ogg").path, tracks: 1, channels: 2, durationSec: 8758)
        recordingSeeks = false
        let player = makePlayer()
        player.showMeeting("m", from: 1038)
        try await until("it plays") { player.phase == .playing }
        player.showMeeting("m", from: 2926)
        try await until("the new stretch plays") { player.phase == .playing && player.top?.startSec == 2926 }
        XCTAssertEqual(player.stack.count, 1, "one level for the meeting, wherever its sound is")
        XCTAssertEqual(player.top?.label, "The meeting from 48:46")
    }

    func testShowOverAClipIsANewLevel() async throws {
        engine.audio = .init(path: engine.folder.appendingPathComponent("a.m4a").path, tracks: 1, channels: 1, durationSec: 9000)
        let player = makePlayer()
        player.play(.item("i1"), in: "m", from: .row)
        try await until("the row plays") { player.phase == .playing }
        player.showMeeting("m", from: 2926)
        try await until("the meeting plays") { player.phase == .playing && player.top?.kind == .file }
        XCTAssertEqual(player.stack.count, 2, "the row waits under the meeting")
    }

    func testASeekInTheRecordingNamesItsLevelAnew() async throws {
        engine.audio = .init(path: engine.folder.appendingPathComponent("a.m4a").path, tracks: 1, channels: 1, durationSec: 9000)
        let player = makePlayer()
        player.playMeeting("m", at: 60)
        try await until("it plays") { player.phase == .playing }
        player.playTime(6600, in: "m", from: .outside)
        XCTAssertEqual(player.top?.label, "The meeting from 1:50:00")
    }

    // MARK: Speed

    func testTheSpeedSettingAppliesToTheSound() async throws {
        defaults.set(1.5, forKey: MeetingsPreferences.Playback.speed.key)
        let player = makePlayer()
        player.play(.item("i1"), in: "m", from: .row)
        try await until("it plays") { player.phase == .playing }
        XCTAssertEqual(sounds[0].rate, 1.5)
    }
}

// MARK: Review round 2 (PR 759)

extension MeetingsPlayerTests {
    func testAWholeMeetingFileThatEndsNeitherRepeatsNorOffersMore() async throws {
        engine.audio = .init(path: engine.folder.appendingPathComponent("upload.ogg").path, tracks: 1, channels: 2, durationSec: 3600)
        defaults.set("once", forKey: MeetingsPreferences.Playback.repeatClip.key)
        defaults.set("continue", forKey: MeetingsPreferences.Playback.afterClip.key)
        let player = makePlayer()
        player.playMeeting("m", at: 3590)
        try await until("it plays") { player.phase == .playing }
        XCTAssertEqual(player.top?.kind, .file)
        sounds[0].finish()
        XCTAssertEqual(player.phase, .ended(offerMore: false), "the recording's end is the end: no repeat, no more past it")
        try await Task.sleep(for: .milliseconds(50))
        XCTAssertTrue(engine.cuts.isEmpty, "nothing past the recording is cut")
        XCTAssertEqual(player.phase, .ended(offerMore: false))
    }

    func testPoppingBackToAMomentWhoseCutWasCancelledCutsItAgain() async throws {
        engine.holdCuts = true
        let player = makePlayer()
        player.play(.item("i1"), in: "m", from: .row)
        try await until("the first cut waits") { self.engine.cuts.count == 1 }
        player.play(.stretch(atSec: 40, speaker: "Dana Example"), in: "m", from: .speakerChip)
        try await until("the pushed cut waits") { self.engine.cuts.count == 2 }
        player.pop()
        try await until("the first Moment is cut again") { self.engine.cuts.count == 3 }
        engine.release()
        try await until("the first Moment plays") { player.phase == .playing }
        XCTAssertEqual(player.top?.target, .item("i1"))
    }

    func testAnEvidencePreviewPausesTheMeetingsPlayback() async throws {
        let player = makePlayer()
        player.play(.item("i1"), in: "m", from: .row)
        try await until("it plays") { player.phase == .playing }
        NotificationCenter.default.post(name: MomentPlayer.previewWillPlay, object: nil)
        XCTAssertEqual(player.phase, .paused, "the evidence's own recording never plays over the meeting")
        XCTAssertEqual(playingCount, 0)
    }
}
