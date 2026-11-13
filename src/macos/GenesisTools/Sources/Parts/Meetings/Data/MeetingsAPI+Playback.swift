import Foundation

// MARK: - Moments and the timeline's reads: the Swift mirror of their Meetings service methods
// (src/meetings/lib/service/api.ts, src/meetings/lib/moment-schema.ts). The protocol fixture holds a real request and
// reply of each, and MeetingsServiceTests decodes them with these types.

/// A point in a transcript line: the line's start (its address), its index as a hint, and how far into its text.
struct LinePoint: Codable, Equatable, Hashable {
    var atSec: Double
    var line: Int?
    /// 0 (the line's start) to 1 (its end).
    var fraction: Double?

    init(atSec: Double, line: Int? = nil, fraction: Double? = nil) {
        self.atSec = atSec
        self.line = line
        self.fraction = fraction
    }
}

/// What a Moment is of (`momentTargetSchema`): an item (an id or `Q12`), a time, a range, words selected in the
/// transcript, or one speaker's turn around a time.
enum MomentTarget: Codable, Equatable, Hashable {
    case item(String)
    case time(Double)
    case range(from: Double, to: Double)
    case selection(from: LinePoint, to: LinePoint)
    case stretch(atSec: Double, speaker: String?)

    private enum CodingKeys: String, CodingKey { case kind, id, atSec, fromSec, toSec, from, to, speaker }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        switch try container.decode(String.self, forKey: .kind) {
        case "item": self = .item(try container.decode(String.self, forKey: .id))
        case "time": self = .time(try container.decode(Double.self, forKey: .atSec))
        case "range": self = .range(from: try container.decode(Double.self, forKey: .fromSec),
                                    to: try container.decode(Double.self, forKey: .toSec))
        case "selection": self = .selection(from: try container.decode(LinePoint.self, forKey: .from),
                                            to: try container.decode(LinePoint.self, forKey: .to))
        case "stretch": self = .stretch(atSec: try container.decode(Double.self, forKey: .atSec),
                                        speaker: try container.decodeIfPresent(String.self, forKey: .speaker))
        case let other:
            throw DecodingError.dataCorruptedError(forKey: .kind, in: container, debugDescription: "unknown Moment target \(other)")
        }
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case .item(let id):
            try container.encode("item", forKey: .kind)
            try container.encode(id, forKey: .id)
        case .time(let atSec):
            try container.encode("time", forKey: .kind)
            try container.encode(atSec, forKey: .atSec)
        case .range(let from, let to):
            try container.encode("range", forKey: .kind)
            try container.encode(from, forKey: .fromSec)
            try container.encode(to, forKey: .toSec)
        case .selection(let from, let to):
            try container.encode("selection", forKey: .kind)
            try container.encode(from, forKey: .from)
            try container.encode(to, forKey: .to)
        case .stretch(let atSec, let speaker):
            try container.encode("stretch", forKey: .kind)
            try container.encode(atSec, forKey: .atSec)
            try container.encodeIfPresent(speaker, forKey: .speaker)
        }
    }

    /// The second the target starts at on the transcript clock, when the target names one by itself.
    var startSec: Double? {
        switch self {
        case .item: return nil
        case .time(let atSec), .stretch(let atSec, _): return atSec
        case .range(let from, _): return from
        case .selection(let from, _): return from.atSec
        }
    }
}

/// A tone's sound as a Moment or `tone.preview` answers it: its pitch, length and volume. A sound file answers hz 0 and
/// the file's length; a setting the window writes is `MeetingsAPI.ToneSoundSetting`.
struct ToneSound: Codable, Equatable, Hashable {
    var hz: Double
    var sec: Double
    var volume: Double
}

/// One frame of a Moment's spot, with the OCR hit that named it first (Vision's normalized box).
struct MomentFrame: Decodable, Equatable, Hashable {
    struct Hit: Decodable, Equatable, Hashable {
        struct Box: Decodable, Equatable, Hashable { let x: Double; let y: Double; let width: Double; let height: Double }
        let text: String
        let box: Box
    }

    let file: String
    let path: String
    let at: String
    let meetingSec: Double
    let displayId: Int?
    let hit: Hit?
}

/// A Moment as the engine answers it: the span asked for (`fromSec` to `toSec`), the audio it plays with the pad
/// (`startSec` to `endSec`), the asked spot (`spotSec`), the tone's time, and the frames at the spot.
struct Moment: Decodable, Equatable, Hashable {
    struct Tone: Decodable, Equatable, Hashable { let atSec: Double; let sound: ToneSound }

    let meeting: String
    let target: MomentTarget
    let label: String
    let fromSec: Double
    let toSec: Double
    let padSec: Double
    /// The pad after the heard stretch, present only when it differs from `padSec` (config version 5). `endSec`
    /// already holds it, so the views draw the end from `endSec`.
    var padAfterSec: Double? = nil
    let startSec: Double
    let endSec: Double
    let spotSec: Double
    let tone: Tone?
    let delaySec: Double
    let repeatGapSec: Double?
    let screen: [MomentFrame]?

    var lengthSec: Double { max(0, endSec - startSec) }
}

/// A Moment cut into the clip cache, with the WAV's path.
struct MomentClip: Decodable, Equatable, Hashable {
    let moment: Moment
    let path: String

    private enum CodingKeys: String, CodingKey { case path }

    init(moment: Moment, path: String) {
        self.moment = moment
        self.path = path
    }

    init(from decoder: Decoder) throws {
        moment = try Moment(from: decoder)
        path = try decoder.container(keyedBy: CodingKeys.self).decode(String.self, forKey: .path)
    }
}

/// Why a Moment cannot play: a target refusal (unknown-item, no-time, bad-range, unknown-line, no-speech,
/// past-the-end, too-long: then no Moment) or a state of this Mac or meeting (no-audio, recording, no-ffmpeg: the
/// Moment stays). A disabled play control shows `message` (G-STATE-1).
struct MomentCannot: Decodable, Equatable, Hashable {
    let code: String
    let message: String

    /// The states that keep a Moment: it exists, it cannot play here and now.
    static let stateCodes: Set<String> = ["no-audio", "recording", "no-ffmpeg"]
    var isState: Bool { Self.stateCodes.contains(code) }
}

/// A refusal's `data` for `unplayable`: the moment.plan code that says why.
struct UnplayableData: Decodable, Equatable {
    let code: String
    let reason: String?
}

extension MeetingsAPI {
    /// The members `moment.plan` and `moment.clip` share.
    struct MomentParams: Codable, Equatable {
        var meeting: String
        var target: MomentTarget
        /// Seconds of audio before the target, and after it unless `padAfterSec` is given; the settings' when nil.
        var padSec: Double?
        /// Seconds of audio after the target.
        var padAfterSec: Double?
        /// This tone for the call instead of the saved one; it sounds even while the saved tone is off.
        var toneSound: MeetingsAPI.ToneSoundSetting?
        /// False skips the screen frames at the spot.
        var screen: Bool?
        /// At most this long from the span's start ("Clip 5s": 5); the pad stays.
        var lengthSec: Double?

        init(meeting: String, target: MomentTarget, padSec: Double? = nil, padAfterSec: Double? = nil,
             toneSound: MeetingsAPI.ToneSoundSetting? = nil, screen: Bool? = nil, lengthSec: Double? = nil) {
            self.meeting = meeting
            self.target = target
            self.padSec = padSec
            self.padAfterSec = padAfterSec
            self.toneSound = toneSound
            self.screen = screen
            self.lengthSec = lengthSec
        }
    }

    /// `moment.plan`: the Moment of a target and why it cannot play; cuts nothing.
    enum MomentPlan: MeetingsServiceMethod {
        static let name = "moment.plan"
        typealias Params = MomentParams

        struct Result: Decodable, Equatable {
            let moment: Moment?
            let cannot: MomentCannot?
        }
    }

    /// `moment.clip`: the Moment cut to a WAV in the clip cache. A newer `moment.clip` on the same connection cancels
    /// the older cut (answered 1013).
    enum MomentClipCut: MeetingsServiceMethod {
        static let name = "moment.clip"
        typealias Params = MomentParams
        typealias Result = MomentClip
    }

    /// `tone.preview`: the tone alone as a WAV, for a sound picker's Play button.
    enum TonePreview: MeetingsServiceMethod {
        static let name = "tone.preview"

        /// A sine, a named preset or a sound file; the saved `playback.listen.tone.sound` when nil.
        struct Params: Codable, Equatable { var sound: MeetingsAPI.ToneSoundSetting? }

        struct Result: Decodable, Equatable {
            let path: String
            let sound: ToneSound
        }
    }

    /// `meeting.audio`: the recording on this Mac (ffprobe). One track plays as the file (an instant seek).
    enum MeetingAudio: MeetingsServiceMethod {
        static let name = "meeting.audio"

        struct Params: Codable, Equatable { var meeting: String }

        struct Result: Decodable, Equatable {
            let path: String
            let tracks: Int
            let channels: Int
            let durationSec: Double
        }
    }

    /// `meeting.speakers`: talk time per label with its spans, and the hints with their ranges.
    enum MeetingSpeakers: MeetingsServiceMethod {
        static let name = "meeting.speakers"

        struct Params: Codable, Equatable {
            var meeting: String
            var gapSec: Double?
            var attendance: String?
        }

        struct Span: Decodable, Equatable, Hashable { let fromSec: Double; let toSec: Double; let turns: Int }

        struct Speaker: Decodable, Equatable, Hashable, Identifiable {
            let label: String
            let speakerId: Int?
            let origin: String
            let turns: Int
            let lines: Int
            let words: Int
            let spokenSec: Double
            let firstSec: Double?
            let lastSec: Double?
            let spans: [Span]
            var id: String { label }
        }

        struct Result: Decodable, Equatable {
            let meeting: String
            let gapSec: Double
            /// False when no line has a time: the lanes show nothing, only counts.
            let timed: Bool
            let speakers: [Speaker]
            let hints: [SpeakerHint]
        }
    }

    /// `meeting.screen`: the screen frames by time (`recorded` false: no pane).
    enum MeetingScreen: MeetingsServiceMethod {
        static let name = "meeting.screen"

        struct Params: Codable, Equatable {
            var meeting: String
            var fromSec: Double?
            var toSec: Double?
            var display: Int?
        }

        struct Frame: Decodable, Equatable, Hashable {
            let file: String
            let path: String
            let meetingSec: Double
            let displayId: Int?
            let width: Double
            let height: Double
            let lineCount: Int
        }

        struct Result: Decodable, Equatable {
            let meeting: String
            let recorded: Bool
            let displays: [ScreenTimeline.Display]
            let frames: [Frame]
        }
    }

    /// `meeting.waveform`: peaks for the whole-conversation strip and the zoomed timeline.
    enum MeetingWaveform: MeetingsServiceMethod {
        static let name = "meeting.waveform"

        struct Params: Codable, Equatable {
            var meeting: String
            var fromSec: Double?
            var toSec: Double?
            var buckets: Int
        }

        struct Cannot: Decodable, Equatable { let code: String; let message: String }

        struct Result: Decodable, Equatable {
            let meeting: String
            let fromSec: Double
            let toSec: Double
            /// 0 to 1 of the recording's loudest 100 ms; empty when `cannot`.
            let peaks: [Double]
            let cannot: Cannot?
        }
    }
}
