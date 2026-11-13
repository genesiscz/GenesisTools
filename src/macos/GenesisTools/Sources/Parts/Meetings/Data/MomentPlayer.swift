import AudioToolbox
import AVFoundation
import Foundation
import Observation

/// Where a click that plays comes from. Each source pushes onto the context stack or replaces part of it, by one table
/// (`MomentPlayer.placement`, G-STACK-1).
enum MomentSource: String, CaseIterable {
    /// A row's MomentButton.
    case row
    /// The next row, played by itself after an answer (R19).
    case autoplay
    /// A pin on the timeline (R3).
    case pin
    /// A time named in a question's text (R17, R38: "This answers 12:10–12:30").
    case questionTime
    /// A routed timestamp link enters the existing player's context stack.
    case link
    /// A transcript line (R42).
    case transcript
    /// A speaker's chip or one of its hint ranges (R20, R21).
    case speakerChip
    /// "Clip 5s" on a transcript selection (R43).
    case selection
    /// "Play 30 s more" at a clip's end, and the next stretch of a whole-meeting play.
    case more
    /// A click on the timeline outside the loaded clip (G-PLAY-1).
    case outside
}

/// How a new Moment joins the context stack.
enum MomentPlacement: Equatable {
    /// The stack holds only the new Moment.
    case replaceAll
    /// The new Moment takes the top's place; the Moments below stay.
    case replaceTop
    /// The new Moment plays on top; the one below pauses and plays again when it ends (R38).
    case push
}

/// One sound the player plays: an `AVAudioPlayer` on a cut clip or the meeting's file in the app, a fake in tests.
@MainActor
protocol MomentSound: AnyObject {
    /// Seconds from the sound's start.
    var currentTime: TimeInterval { get set }
    var duration: TimeInterval { get }
    var rate: Float { get set }
    var isPlaying: Bool { get }
    /// Called once when the sound plays to its end (not on `pause` or `stop`).
    var onEnd: (@MainActor () -> Void)? { get set }
    /// Whether a seek lands where it is asked. The system player opens an Ogg Opus recording, reports the asked time and
    /// plays the file's start (measured 2026-11-10 on a 2 h 26 min recording: the same level sequence after a seek to
    /// 0, 2926 and 5376 s, while WAV, AAC, MP3 and FLAC copies each played their own stretch). A whole meeting in such a
    /// format plays as cut stretches instead of the file.
    var seeksExactly: Bool { get }
    func play()
    func pause()
    func stop()
}

extension MomentSound {
    var seeksExactly: Bool { true }
}

typealias MomentSoundLoader = @MainActor (URL) throws -> MomentSound

/// An `AVAudioPlayer` as a `MomentSound`: it opens a WAV clip at once, seeks without a new process, and pauses for real.
@MainActor
final class AVMomentSound: NSObject, MomentSound, AVAudioPlayerDelegate {
    private let player: AVAudioPlayer
    var onEnd: (@MainActor () -> Void)?
    let seeksExactly: Bool

    /// The codings the system player seeks in exactly: the four that were measured. Any other one (Opus, Vorbis, a
    /// coding nobody measured) takes the cut stretches, which seek in every format.
    static let seekableCodings: Set<AudioFormatID> = [kAudioFormatLinearPCM, kAudioFormatMPEG4AAC, kAudioFormatMPEGLayer3, kAudioFormatFLAC]

    static func seeksExactly(coding: AudioFormatID?) -> Bool {
        coding.map(seekableCodings.contains) ?? false
    }

    /// The file's own coding ("opus", "aac ", "lpcm"), read from the file: the player's `format` is what it decodes to.
    static func coding(of url: URL) -> AudioFormatID? {
        var file: AudioFileID?
        guard AudioFileOpenURL(url as CFURL, .readPermission, 0, &file) == noErr, let file else { return nil }
        defer { AudioFileClose(file) }
        var description = AudioStreamBasicDescription()
        var size = UInt32(MemoryLayout<AudioStreamBasicDescription>.size)
        guard AudioFileGetProperty(file, kAudioFilePropertyDataFormat, &size, &description) == noErr else { return nil }
        return description.mFormatID
    }

    /// `muted`: the sound plays at volume 0 (a `--snapshot --play` picture of a playing Moment makes no sound).
    init(url: URL, muted: Bool = false) throws {
        player = try AVAudioPlayer(contentsOf: url)
        seeksExactly = Self.seeksExactly(coding: Self.coding(of: url))
        super.init()
        if muted { player.volume = 0 }
        player.enableRate = true
        player.delegate = self
        player.prepareToPlay()
    }

    var currentTime: TimeInterval {
        get { player.currentTime }
        set { player.currentTime = max(0, min(newValue, player.duration)) }
    }

    var duration: TimeInterval { player.duration }
    var volume: Float { player.volume }
    var rate: Float {
        get { player.rate }
        set { player.rate = newValue }
    }

    var isPlaying: Bool { player.isPlaying }

    func play() { player.play() }
    func pause() { player.pause() }
    func stop() {
        onEnd = nil
        player.stop()
    }

    /// AVAudioPlayer tells its delegate on the main thread.
    nonisolated func audioPlayerDidFinishPlaying(_ player: AVAudioPlayer, successfully flag: Bool) {
        DispatchQueue.main.async { [weak self] in
            MainActor.assumeIsolated { self?.onEnd?() }
        }
    }
}

/// One Moment on the context stack.
struct MomentLayer: Identifiable, Equatable {
    enum Kind: Equatable {
        /// A cut clip of the Moment engine (a row, a time, a range, a selection, a speaker's turn).
        case moment
        /// The meeting's own recording, one track (whole-meeting mode, decision 16): a seek is instant.
        case file
        /// Whole-meeting mode on a recording the window cannot open itself: 60 s Moments, one after the other.
        case rolling
    }

    let id: UUID
    let meeting: String
    let target: MomentTarget
    let source: MomentSource
    var kind: Kind
    /// The Moment the engine answered; nil while it is cut and for a file play.
    var moment: Moment?
    /// The meeting seconds at the sound's start and end.
    var startSec: Double
    var endSec: Double
    /// Where the tone ends on the meeting clock: a rewind never goes back into it (G-STACK-3).
    var toneEndSec: Double?
    /// Where a layer under the top stopped: it plays from here, less the rewind, when it is the top again.
    var pausedAt: Double?
    /// A deliberate seek while paused takes precedence over the automatic resume rewind.
    var hasPausedSeek = false
    /// What the bar names: the Moment's label ("i1", "00:09", "05:09–05:31"), or the meeting from a time.
    var label: String

    init(meeting: String, target: MomentTarget, source: MomentSource, kind: Kind, label: String) {
        id = UUID()
        self.meeting = meeting
        self.target = target
        self.source = source
        self.kind = kind
        startSec = target.startSec ?? 0
        endSec = startSec
        self.label = label
    }

    /// The asked spot on the meeting clock (the flag), when a Moment has one.
    var spotSec: Double? { moment?.spotSec }

    func contains(_ second: Double) -> Bool { second >= startSec && second <= endSec }
}

/// The Meetings window's player: every Moment plays through the Moment engine's cut clip (`moment.clip`), the same span,
/// pad and tone as `tools meetings listen` (R7). It pauses for real, plays again with a short rewind that never replays
/// the tone, seeks inside the loaded clip, and keeps a context stack: a pushed Moment pauses the one below and gives it
/// back when it ends, and two sounds never play at once (R18 read as R38). Whole-meeting mode plays the recording
/// itself when it has one track, else 60 s Moments (decision 16).
@Observable
@MainActor
final class MomentPlayer {
    enum Phase: Equatable {
        case idle
        /// The top's clip is being cut (the bar says so after 200 ms and offers Cancel after 5 s).
        case cutting(since: Date)
        case playing
        case paused
        /// The top played to its end and nothing follows; `offerMore` shows "Play 30 s more".
        case ended(offerMore: Bool)
        case failed(MeetingsCLI.Failure)
    }

    /// What the player asks the Moment engine. The live one goes through the Meetings service, and through the command
    /// when no service answers.
    struct Engine {
        var cut: @MainActor (MeetingsAPI.MomentParams) async throws -> MomentClip
        var plan: @MainActor (MeetingsAPI.MomentParams) async throws -> MeetingsAPI.MomentPlan.Result
        var audio: @MainActor (String) async throws -> MeetingsAPI.MeetingAudio.Result
    }

    /// The context stack, the bottom first; the last one is the one that plays or waits.
    private(set) var stack: [MomentLayer] = []
    private(set) var phase: Phase = .idle
    /// The meeting second the top is at, about ten times a second while it plays (R42, R25). Only small views read it:
    /// each read redraws the reader on every tick.
    private(set) var position: Double?
    /// Why a Moment cannot play: per meeting for a state (no-audio, recording, no-ffmpeg), per target otherwise.
    private(set) var cannot: [String: MomentCannot] = [:]

    /// What the dock's timeline shows and draws (F9); the keys reach it through the player.
    @ObservationIgnored let timeline: TimelineDockModel
    @ObservationIgnored private let engine: Engine
    @ObservationIgnored private let load: MomentSoundLoader
    @ObservationIgnored private let defaults: UserDefaults
    @ObservationIgnored private var sounds: [UUID: MomentSound] = [:]
    @ObservationIgnored private var cutTask: Task<Void, Never>?
    @ObservationIgnored private var cutKey: String?
    @ObservationIgnored private var inFlight: [String: Task<MomentClip, Error>] = [:]
    @ObservationIgnored private var clips: [(key: String, clip: MomentClip)] = []
    @ObservationIgnored private var clipEpoch = 0

    func invalidateClipCache() {
        clipEpoch += 1
        clips = []
    }

    private func cacheKey(_ params: MeetingsAPI.MomentParams) -> String {
        "\(clipEpoch):\(Self.key(params))"
    }
    @ObservationIgnored private var ticker: Task<Void, Never>?
    @ObservationIgnored private var repeated: Set<UUID> = []

    /// A whole-meeting stretch when the recording plays as Moments.
    static let rollingSec: Double = 60
    /// How many cut clips the player keeps at hand (the engine keeps them on disk too).
    static let keptClips = 12

    init(engine: Engine = .live, load: @escaping MomentSoundLoader = { try AVMomentSound(url: $0) },
         defaults: UserDefaults = .standard, timeline: TimelineDockModel? = nil) {
        self.timeline = timeline ?? TimelineDockModel(defaults: defaults)
        self.engine = engine
        self.load = load
        self.defaults = defaults
        previewHold = PreviewHold { [weak self] in self?.pause() }
    }

    /// Posted by a sheet that plays a recording of its own (the channel evidence's Raw mic, Isolated call, Cleaned
    /// estimate): every Moment player pauses, so two recordings never play at once. The reader resumes it.
    static let previewWillPlay = Notification.Name("meetings.preview.willPlay")
    @ObservationIgnored private var previewHold: PreviewHold?

    /// The observer of `previewWillPlay`, removed with the player.
    private final class PreviewHold {
        private let token: NSObjectProtocol

        init(pause: @escaping @MainActor () -> Void) {
            token = NotificationCenter.default.addObserver(forName: MomentPlayer.previewWillPlay, object: nil, queue: .main) { _ in
                MainActor.assumeIsolated { pause() }
            }
        }

        deinit { NotificationCenter.default.removeObserver(token) }
    }

    var top: MomentLayer? { stack.last }
    /// The meeting that plays, so the bar names it while the reader looks at another one (R18).
    var meeting: String? { top?.meeting }
    var isActive: Bool { phase != .idle }
    /// The top's cut failed: a click on its control is a retry.
    var isFailed: Bool { if case .failed = phase { return true } else { return false } }

    // MARK: The table

    /// Push or replace, per click source (G-STACK-1). A row, the next row and a pin start over; a time in a question
    /// pushes (or replaces, `meetings.playback.stack.clickInQuestion`); a speaker chip and Clip 5s push; a transcript
    /// line outside the clip, "Play more" and a click outside the clip take the top's place.
    static func placement(for source: MomentSource,
                          clickInQuestion: MeetingsPreferences.Playback.ClickInQuestion) -> MomentPlacement {
        switch source {
        case .row, .autoplay, .pin: return .replaceAll
        case .questionTime: return clickInQuestion == .push ? .push : .replaceTop
        case .speakerChip, .selection, .link: return .push
        case .transcript, .more, .outside: return .replaceTop
        }
    }

    /// Where a paused Moment plays again: `rewindSec` earlier, but never back into its tone once the tone has played
    /// (G-STACK-3). As an offset into the sound.
    static func resumeOffset(pausedAt: Double, startSec: Double, rewindSec: Double, toneEndSec: Double?) -> Double {
        var at = pausedAt - rewindSec
        if let toneEndSec, pausedAt >= toneEndSec { at = max(at, toneEndSec) }
        return max(0, at - startSec)
    }

    /// What the bar shows while a clip is cut: nothing for the first 200 ms (most cuts are done by then, G-PLAY-11),
    /// then "Cutting the clip", and Cancel from 5 s.
    static func cuttingShows(elapsed: TimeInterval) -> (words: Bool, cancel: Bool) {
        (elapsed >= 0.2, elapsed >= 5)
    }

    // MARK: Playing

    /// Plays the Moment of `target`, placed on the stack as its source says. A row's button that names the Moment that
    /// plays pauses or plays it again instead (R14: a second click no longer starts over); on a failed cut it cuts again.
    func play(_ target: MomentTarget, in meeting: String, from source: MomentSource, lengthSec: Double? = nil) {
        if source == .row, let top, top.meeting == meeting, top.target == target, top.kind == .moment, !isFailed {
            togglePause()
            return
        }
        play(MeetingsAPI.MomentParams(meeting: meeting, target: target,
                                     tone: source == .outside ? false : nil, lengthSec: lengthSec), from: source)
    }

    func play(_ params: MeetingsAPI.MomentParams, from source: MomentSource) {
        let layer = MomentLayer(meeting: params.meeting, target: params.target, source: source, kind: .moment,
                                label: Self.provisionalLabel(params.target))
        place(layer, Self.placement(for: source, clickInQuestion: MeetingsPreferences.Playback.clickInQuestion.value(defaults)))
        cut(layer.id, params)
    }

    /// A transcript time (a line, the timeline): inside the loaded clip it seeks there; outside it, the Moment at that
    /// time takes the top's place, or the whole meeting plays from there in Meeting view (`meetings.playback.view`).
    func playTime(_ second: Double, in meeting: String, from source: MomentSource = .transcript) {
        if let top, top.meeting == meeting, top.contains(second), sounds[top.id] != nil {
            // The recording itself: its level says where the sound was put, as a new stretch's level does.
            if top.kind == .file { update(top.id) { $0.label = Self.meetingLabel(second) } }
            seek(to: second)
            return
        }
        if MeetingsPreferences.Playback.view.value(defaults) == .meeting || top?.kind == .file || top?.kind == .rolling {
            // A click on a paused whole-meeting play puts the sound there and stays paused, as a seek inside a loaded
            // sound does: the reader clicks, then plays.
            let holds = phase == .paused && top?.meeting == meeting && top?.kind == .rolling
            playMeeting(meeting, at: second, from: source, paused: holds)
        } else {
            play(.time(second), in: meeting, from: source == .row ? .outside : source)
        }
    }

    /// Plays the whole meeting from `second`: the recording itself when it has one track, this Mac opens it and the
    /// player seeks in its coding (an instant seek, R3, R4), else 60 s Moments one after the other (decision 16).
    /// `paused`: the sound is put at `second` and waits.
    func playMeeting(_ meeting: String, at second: Double, from source: MomentSource = .pin, paused: Bool = false) {
        var layer = MomentLayer(meeting: meeting, target: .time(second), source: source, kind: .file,
                                label: Self.meetingLabel(second))
        layer.startSec = second
        let before = top
        place(layer, Self.placement(for: source, clickInQuestion: MeetingsPreferences.Playback.clickInQuestion.value(defaults)))
        // A whole-meeting level that takes another one's place keeps the range the reader zoomed to.
        if let before, before.meeting == meeting, before.kind != .moment, !stack.contains(where: { $0.id == before.id }) {
            timeline.moveView(from: before.id, to: layer.id)
        }
        let id = layer.id
        phase = .cutting(since: Date())
        cutTask?.cancel()
        cutTask = Task { [weak self] in
            guard let self else { return }
            let audio = try? await self.engine.audio(meeting)
            guard !Task.isCancelled, self.top?.id == id else { return }
            if let audio, audio.tracks == 1, let sound = try? self.load(URL(fileURLWithPath: audio.path)), sound.seeksExactly {
                self.update(id) {
                    $0.startSec = 0
                    $0.endSec = audio.durationSec
                }
                self.start(sound, for: id, at: second, paused: paused)
            } else {
                self.update(id) { $0.kind = .rolling }
                self.cut(id, Self.rollingParams(meeting, from: second), paused: paused)
            }
        }
    }

    /// "Show" on a stretch too long for a clip (G-SPK-3): the whole meeting plays from `second`. A whole-meeting play
    /// of the same meeting moves there and its level is named anew, so the breadcrumb says where the sound is; over
    /// any other top it is a new level.
    func showMeeting(_ meeting: String, from second: Double, source: MomentSource = .speakerChip) {
        guard let top, top.meeting == meeting, top.kind != .moment else {
            playMeeting(meeting, at: second, from: source)
            return
        }
        if top.kind == .file, let sound = sounds[top.id], top.contains(second) {
            update(top.id) { $0.label = Self.meetingLabel(second) }
            seek(to: second)
            if phase != .playing { run(sound, for: top.id) }
            GenAnnounce.post("Playing \(Self.meetingLabel(second))")
            return
        }
        playMeeting(meeting, at: second, from: .outside)
    }

    /// Cuts the clip of `target` now, so its play is instant (the next row's, G-PLAY-11). Only while no cut runs: the
    /// service cancels an older cut on the same connection for a newer one, so a pre-cut never starts over a play's.
    func precut(_ target: MomentTarget, in meeting: String) {
        guard inFlight.isEmpty else { return }
        let params = MeetingsAPI.MomentParams(meeting: meeting, target: target)
        guard cachedClip(cacheKey(params)) == nil else { return }
        Task { [weak self] in _ = try? await self?.clip(params) }
    }

    func pause() {
        guard phase == .playing, let top, let sound = sounds[top.id] else { return }
        sound.pause()
        update(top.id) { $0.pausedAt = top.startSec + sound.currentTime }
        phase = .paused
        stopTicker()
        GenAnnounce.post("Paused")
    }

    /// Resumes at an explicit paused seek, or with the configured rewind; an ended top plays from its start.
    func resume() {
        guard let top, let sound = sounds[top.id] else { return }
        switch phase {
        case .paused:
            let paused = top.pausedAt ?? (top.startSec + sound.currentTime)
            sound.currentTime = resumeOffset(for: top, pausedAt: paused)
            run(sound, for: top.id)
            GenAnnounce.post("Playing")
        case .ended:
            playAgain()
        default:
            break
        }
    }

    private func resumeOffset(for layer: MomentLayer, pausedAt: Double) -> Double {
        let keepSelected = layer.hasPausedSeek && MeetingsPreferences.Playback.resumeAfterSeek.value(defaults) == .selectedTime
        let rewind = keepSelected ? 0 : MeetingsPreferences.Playback.rewindSec.value(defaults)
        return Self.resumeOffset(pausedAt: pausedAt, startSec: layer.startSec, rewindSec: rewind, toneEndSec: layer.toneEndSec)
    }

    func togglePause() {
        switch phase {
        case .playing: pause()
        case .paused, .ended: resume()
        default: break
        }
    }

    /// The top from its start, with its tone.
    func playAgain() {
        guard let top, let sound = sounds[top.id] else { return }
        sound.currentTime = 0
        run(sound, for: top.id)
        GenAnnounce.post("Playing \(top.label) again")
    }

    /// A meeting second inside the top's sound: it plays from there (a paused one stays paused).
    func seek(to second: Double) {
        guard let top, let sound = sounds[top.id], top.contains(second) else { return }
        sound.currentTime = second - top.startSec
        let paused = phase == .paused
        update(top.id) { $0.pausedAt = second; $0.hasPausedSeek = paused }
        position = second
        if case .ended = phase { run(sound, for: top.id) }
    }

    /// To the asked spot's tone, 0.3 s before it (the flag, G-PLAY-3); to the spot when the Moment has no tone.
    func seekToSpot() {
        guard let top, let moment = top.moment else { return }
        seek(to: max(top.startSec, (moment.tone?.atSec ?? moment.spotSec) - 0.3))
    }

    /// Left and Right, and the dock's 5 s buttons: inside the loaded clip a seek, outside it the Moment at that time takes
    /// the top's place (G-PLAY-1). Never before the meeting's start.
    func skip(by delta: Double) {
        guard let top else { return }
        let now = position ?? top.pausedAt ?? top.startSec
        playTime(max(0, now + delta), in: top.meeting, from: .outside)
    }

    /// "Play 30 s more" after a clip's end: the next stretch takes the top's place.
    func playMore() {
        guard let top else { return }
        let more = MeetingsPreferences.Playback.moreSec.value(defaults)
        play(.range(from: top.endSec, to: top.endSec + more), in: top.meeting, from: .more)
    }

    /// The top leaves; the Moment under it plays again from where it stopped (Esc, a pushed Moment's end).
    func pop() {
        guard stack.count > 1, let top else {
            stop()
            return
        }
        abortCut()
        drop(top.id)
        stack.removeLast()
        guard let below = stack.last else { return }
        GenAnnounce.post("Back to \(below.label)")
        if let sound = sounds[below.id] {
            let paused = below.pausedAt ?? below.startSec
            sound.currentTime = resumeOffset(for: below, pausedAt: paused)
            run(sound, for: below.id)
        } else {
            cut(below.id, MeetingsAPI.MomentParams(meeting: below.meeting, target: below.target))
        }
    }

    /// The breadcrumb's click on a Moment below the top: every Moment above it leaves in one step, and it plays again
    /// from where it stopped (announced as one "Back to …").
    func pop(to index: Int) {
        guard index >= 0, index < stack.count - 1 else { return }
        while stack.count > index + 2, let top {
            drop(top.id)
            stack.removeLast()
        }
        pop()
    }

    /// Ends every Moment and empties the stack.
    func stop() {
        cancelCut()
        for id in stack.map(\.id) { drop(id) }
        let wasActive = phase != .idle
        stack = []
        phase = .idle
        position = nil
        if wasActive { GenAnnounce.post("Stopped") }
    }

    /// Stops the cut that runs (Cancel): the Moment being cut leaves, and the stack keeps what played before it, paused.
    func cancelCut() {
        abortCut()
        guard case .cutting = phase else { return }
        if let top, sounds[top.id] == nil {
            stack.removeLast()
            phase = stack.last.flatMap { sounds[$0.id] } != nil ? .paused : .idle
        }
    }

    /// Hides a failure; the stack goes when nothing below waits.
    func dismissFailure() {
        guard case .failed = phase else { return }
        if let top, sounds[top.id] == nil { stack.removeLast() }
        phase = stack.isEmpty ? .idle : .paused
    }

    /// Whether `target` of `meeting` is the Moment that plays now (its button shows Pause).
    func isPlaying(_ target: MomentTarget, in meeting: String) -> Bool {
        phase == .playing && top?.meeting == meeting && top?.target == target
    }

    /// Whether `target` of `meeting` is the top, playing, paused, cut or ended.
    func isTop(_ target: MomentTarget, in meeting: String) -> Bool {
        top?.meeting == meeting && top?.target == target
    }

    // MARK: Why a Moment cannot play (G-STATE-1)

    /// Why `target` of `meeting` cannot play, when the player knows: the meeting's state (no audio on this Mac, still
    /// recording, no ffmpeg), or the target's own refusal. A play control is disabled with these words.
    func reason(_ target: MomentTarget, in meeting: String) -> MomentCannot? {
        cannot[meeting] ?? cannot[Self.key(MeetingsAPI.MomentParams(meeting: meeting, target: target, screen: false))]
    }

    /// Asks the engine once whether a Moment of `meeting` can play (the rows ask it for their first target when they
    /// load), so every play control knows a state reason before a click.
    func checkPlayable(_ target: MomentTarget, in meeting: String) {
        let params = MeetingsAPI.MomentParams(meeting: meeting, target: target, screen: false)
        Task { [weak self] in await self?.learn(params) }
    }

    private func learn(_ params: MeetingsAPI.MomentParams) async {
        guard let plan = try? await engine.plan(params) else { return }
        if let reason = plan.cannot {
            if reason.isState { cannot[params.meeting] = reason } else { cannot[Self.key(params)] = reason }
        } else if cannot[params.meeting] != nil {
            cannot[params.meeting] = nil
        }
    }

    // MARK: The stack

    /// Stops the cut task and its moment.clip; the layers stay (a layer under a push is cut again when it is the top).
    private func abortCut() {
        cutTask?.cancel()
        cutTask = nil
        // The cancelled cut leaves the table now: a cut of the same Moment right after (push B, pop back to A) starts
        // a new one instead of awaiting this one's CancellationError and staying in `.cutting`.
        if let cutKey, let running = inFlight[cutKey] {
            running.cancel()
            inFlight[cutKey] = nil
        }
        cutKey = nil
    }

    private func place(_ layer: MomentLayer, _ placement: MomentPlacement) {
        abortCut()
        switch placement {
        case .replaceAll:
            for id in stack.map(\.id) { drop(id) }
            stack = [layer]
        case .replaceTop:
            if let top { drop(top.id); stack.removeLast() }
            stack.append(layer)
        case .push:
            if let top, let sound = sounds[top.id] {
                if sound.isPlaying { sound.pause() }
                update(top.id) { $0.pausedAt = top.startSec + sound.currentTime }
            }
            stack.append(layer)
            let depth = MeetingsPreferences.Playback.stackDepth.value(defaults)
            while stack.count > depth + 1 {
                drop(stack[0].id)
                stack.removeFirst()
            }
        }
        stopTicker()
    }

    private func cut(_ id: UUID, _ params: MeetingsAPI.MomentParams, paused: Bool = false) {
        phase = .cutting(since: Date())
        cutTask?.cancel()
        cutTask = Task { [weak self] in
            guard let self, !Task.isCancelled else { return }
            let key = self.cacheKey(params)
            self.cutKey = key
            do {
                let clip = try await self.clip(params)
                guard !Task.isCancelled, self.top?.id == id else { return }
                if self.cutKey == key { self.cutKey = nil }
                let sound = try self.load(URL(fileURLWithPath: clip.path))
                self.update(id) {
                    $0.moment = clip.moment
                    $0.startSec = clip.moment.startSec
                    $0.endSec = clip.moment.endSec
                    $0.toneEndSec = clip.moment.tone.map { $0.atSec + $0.sound.sec }
                    if $0.kind == .moment { $0.label = clip.moment.label }
                    else { $0.label = Self.meetingLabel(clip.moment.fromSec) }
                }
                let layer = self.stack.first { $0.id == id }
                // A stretch of the whole meeting starts after its tone: the stretches play on as one recording.
                let at = layer?.kind == .rolling ? max(clip.moment.startSec, layer?.toneEndSec ?? 0) : clip.moment.startSec
                self.start(sound, for: id, at: at, paused: paused)
                if layer?.kind == .rolling { self.precutStretch(params.meeting, from: clip.moment.endSec) }
            } catch is CancellationError {
                return
            } catch {
                guard !Task.isCancelled, self.top?.id == id else { return }
                if self.cutKey == key { self.cutKey = nil }
                self.phase = .failed(asFailure(error))
                await self.learn(params)
            }
        }
    }

    /// Cuts the stretch after the one that plays, so a whole meeting plays on without a pause each minute (a cut takes
    /// about 130 ms). Past the meeting's end the engine refuses, which is the end.
    private func precutStretch(_ meeting: String, from second: Double) {
        let params = Self.rollingParams(meeting, from: second)
        let key = cacheKey(params)
        guard cachedClip(key) == nil, inFlight[key] == nil else { return }
        Task { [weak self] in _ = try? await self?.clip(params) }
    }

    /// A clip from the kept ones, the cut that runs for the same Moment, or a new cut.
    private func clip(_ params: MeetingsAPI.MomentParams) async throws -> MomentClip {
        let key = cacheKey(params)
        if let kept = cachedClip(key) { return kept }
        if let running = inFlight[key], !running.isCancelled { return try await running.value }
        let task = Task { @MainActor in try await engine.cut(params) }
        inFlight[key] = task
        // Only this cut's own entry: an older cut that ends later must not drop the cut that replaced it.
        defer { if inFlight[key] == task { inFlight[key] = nil } }
        let clip = try await task.value
        clips.removeAll { $0.key == key }
        clips.append((key, clip))
        if clips.count > Self.keptClips { clips.removeFirst(clips.count - Self.keptClips) }
        return clip
    }

    private func cachedClip(_ key: String) -> MomentClip? {
        guard let kept = clips.first(where: { $0.key == key })?.clip else { return nil }
        // The engine's cache drops the oldest clips past its size cap.
        return FileManager.default.fileExists(atPath: kept.path) ? kept : nil
    }

    /// Plays `sound` for the top from the meeting second `at`; every other sound is paused, so two never play at once.
    private func start(_ sound: MomentSound, for id: UUID, at second: Double, paused: Bool = false) {
        guard let layer = stack.first(where: { $0.id == id }) else { return }
        sounds[id] = sound
        sound.onEnd = { [weak self] in self?.ended(id) }
        sound.currentTime = max(0, second - layer.startSec)
        if paused {
            let held = max(second, layer.startSec)
            update(id) { $0.pausedAt = held; $0.hasPausedSeek = true }
            position = held
            phase = .paused
            return
        }
        run(sound, for: id)
        GenAnnounce.post("Playing \(layer.label)")
    }

    private func run(_ sound: MomentSound, for id: UUID) {
        update(id) { $0.hasPausedSeek = false }
        for (other, playing) in sounds where other != id && playing.isPlaying { playing.pause() }
        sound.rate = Float(MeetingsPreferences.Playback.speed.value(defaults))
        sound.play()
        phase = .playing
        startTicker(id)
    }

    /// The top played to its end: a pushed Moment gives the one below back (`stack.onTopEnd`), a whole-meeting stretch
    /// goes on, a repeat plays once more, and otherwise the clip end does what `afterClip` says.
    private func ended(_ id: UUID) {
        guard let top, top.id == id else { return }
        stopTicker()
        position = top.endSec
        if stack.count > 1, MeetingsPreferences.Playback.onTopEnd.value(defaults) == .return {
            pop()
            return
        }
        if top.kind == .rolling {
            var next = MomentLayer(meeting: top.meeting, target: .time(top.endSec), source: .more, kind: .rolling,
                                   label: top.label)
            next.startSec = top.endSec
            drop(top.id)
            stack[stack.count - 1] = next
            // The next stretch is the same play: the range the reader zoomed to stays.
            timeline.moveView(from: top.id, to: next.id)
            cut(next.id, Self.rollingParams(top.meeting, from: top.endSec))
            return
        }
        // A whole-meeting file played to the recording's end: no repeat, and nothing past the end to offer or cut.
        if top.kind == .file {
            phase = .ended(offerMore: false)
            return
        }
        if MeetingsPreferences.Playback.repeatClip.value(defaults) == .once, !repeated.contains(id), let sound = sounds[id] {
            repeated.insert(id)
            let gap = top.moment?.repeatGapSec ?? 1
            phase = .paused
            Task { [weak self] in
                try? await Task.sleep(for: .seconds(gap))
                guard let self, self.top?.id == id, self.phase == .paused else { return }
                sound.currentTime = 0
                self.run(sound, for: id)
            }
            return
        }
        switch MeetingsPreferences.Playback.afterClip.value(defaults) {
        case .stop: phase = .ended(offerMore: false)
        case .offerMore: phase = .ended(offerMore: true)
        case .continue: playMore()
        }
    }

    private func drop(_ id: UUID) {
        sounds[id]?.stop()
        sounds[id] = nil
        repeated.remove(id)
    }

    private func update(_ id: UUID, _ change: (inout MomentLayer) -> Void) {
        guard let index = stack.firstIndex(where: { $0.id == id }) else { return }
        change(&stack[index])
    }

    private func startTicker(_ id: UUID) {
        ticker?.cancel()
        ticker = Task { [weak self] in
            while !Task.isCancelled {
                guard let self, let top = self.top, top.id == id, let sound = self.sounds[id] else { return }
                let now = top.startSec + sound.currentTime
                if self.position != now { self.position = now }
                try? await Task.sleep(for: .milliseconds(100))
            }
        }
    }

    private func stopTicker() {
        ticker?.cancel()
        ticker = nil
    }

    // MARK: Helpers

    /// What a whole-meeting level is called: where its sound was put.
    static func meetingLabel(_ second: Double) -> String { "The meeting from \(MeetingsFormat.clock(second))" }

    /// What the bar names before the engine's label arrives.
    static func provisionalLabel(_ target: MomentTarget) -> String {
        switch target {
        case .item(let id): return id
        case .time(let at): return MeetingsFormat.clock(at)
        case .range(let from, let to): return "\(MeetingsFormat.clock(from))–\(MeetingsFormat.clock(to))"
        case .selection(let from, _): return "The selection at \(MeetingsFormat.clock(from.atSec))"
        case .stretch(let at, let speaker): return "\(speaker ?? "The speaker") at \(MeetingsFormat.clock(at))"
        }
    }

    /// One stretch of a whole-meeting play: no pad, so the stretches meet end to start.
    static func rollingParams(_ meeting: String, from second: Double) -> MeetingsAPI.MomentParams {
        MeetingsAPI.MomentParams(meeting: meeting, target: .range(from: second, to: second + rollingSec), padSec: 0, tone: false, screen: false)
    }

    /// Every option that changes the clip or its metadata is part of its identity.
    static func key(_ params: MeetingsAPI.MomentParams) -> String {
        // Sorted keys: an encoder may write the same target's keys in another order, and the key must not change.
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        return (try? encoder.encode(params)).map { String(decoding: $0, as: UTF8.self) } ?? "?"
    }
}

extension MomentPlayer.Engine {
    /// The same Moment options reach the service and its command adapter.
    static let live = MomentPlayer.Engine(
        cut: { params in
            try await MeetingsRead.service(MeetingsAPI.MomentClipCut.self, params,
                                           orRun: command(params) + ["--clip"],
                                           timeoutSeconds: 120).run()
        },
        plan: { params in
            if let service = MeetingsService.shared {
                do {
                    return try await service.call(MeetingsAPI.MomentPlan.self, params)
                } catch is MeetingsService.Unavailable {}
            }
            let moment = try await MeetingsCLI.json(Moment.self, command(params) + ["--no-start"])
            return MeetingsAPI.MomentPlan.Result(moment: moment, cannot: nil)
        },
        audio: { meeting in
            guard let service = MeetingsService.shared else {
                throw MeetingsService.Unavailable(reason: "the recording's tracks are read by the Meetings service only")
            }
            return try await service.call(MeetingsAPI.MeetingAudio.self, .init(meeting: meeting))
        })

    static func command(_ params: MeetingsAPI.MomentParams) -> [String] {
        var args = ["play", params.meeting, "--target", targetJSON(params.target), "--json"]
        if let value = params.padSec { args += ["--pad-before", String(value)] }
        if let value = params.padAfterSec { args += ["--pad-after", String(value)] }
        if let value = params.lengthSec { args += ["--length", String(value)] }
        if params.tone == false { args += ["--no-tone"] }
        else if let sound = params.toneSound, let data = try? JSONEncoder().encode(sound) {
            args += ["--tone", String(decoding: data, as: UTF8.self)]
        }
        if params.screen == false { args += ["--no-screen"] }
        return args
    }

    static func targetJSON(_ target: MomentTarget) -> String {
        (try? JSONEncoder().encode(target)).map { String(decoding: $0, as: UTF8.self) } ?? "{}"
    }
}
