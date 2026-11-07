import Foundation

/// One edit of one recording: what to keep (clips), where to zoom, the audio and the export settings. It is saved as
/// `edit.json` beside the recording (or beside a plain movie as `<name>.edit.json`), and the TypeScript side reads and
/// writes the same shape (src/utils/recording-editor/project.ts), so an agent and this window edit one document.
/// Every time is in microseconds of the SOURCE movie, so a cut never moves a zoom.
struct EditProject: Codable, Equatable {
    static let currentVersion = 1

    var version = EditProject.currentVersion
    var source: Source
    /// The kept parts of the source, in playback order. A cut is the space between two clips.
    var clips: [Clip]
    var zooms: [Zoom] = []
    var audio = AudioSettings()
    var export = ExportSettings()
    /// Clicks drawn from the cursor track; nil is off. Optional, so a file from before it decodes.
    var clicks: Clicks?
    /// The movie on a background with padding, rounded corners and a shadow; nil is the plain movie.
    var frame: Frame?
    /// The drawn cursor, for a movie recorded without the system cursor; nil is `Cursor()` (shown, smoothed).
    var cursor: Cursor?
    /// The spoken lines drawn over the picture, from the movie's cached transcript; nil is off.
    var captions: Captions?
    /// The ⌘/⌃ shortcuts the recording kept, drawn as they were pressed; nil is off.
    var keys: Keys?
    /// Parts of the source picture hidden for a time; nil is none. Optional, so an older file decodes.
    var redactions: [Redaction]?
    /// Lines of text over the picture for a time (titles, step names); nil is none.
    var texts: [TextNote]?
    /// Arrows, boxes and circles over the source picture for a time; nil is none.
    var shapes: [Shape]?
    /// Corrections to the cached transcript; nil is none.
    var transcript: TranscriptSettings?
    /// How the picture moves through a zoom; nil is `Motion()`.
    var motion: Motion?
    /// The timeline's effect lanes in order; nil is `EffectLanes.defaults` (src/utils/recording-editor/lanes.ts).
    var lanes: [EffectLane]?
    /// The camera recorded beside the screen, drawn as a bubble; nil is none (Render/CameraLayer.swift).
    var camera: Camera?
    /// Moments marked while editing (the range popover's Add Marker), in source order; nil is none. The recording's
    /// own markers stay in recording.json. Written by the `marker` op (src/utils/recording-editor/project.ts).
    var markers: [Marker]?
    /// Round 4 fx-render: transitions at the joins of two clips (Render/RenderFx.swift); nil is a hard cut everywhere.
    var transitions: Transitions?
    /// Round 4 fx-render: magnifier lenses over source ranges; nil is none.
    var lens: Lens?
    /// Round 4 fx-render: the 3D tilt of the framed picture; nil is flat.
    var tilt: Tilt?
    // fx B (round 4): private data, smooth cursor, typing and waiting speed-ups (private-data.ts, cursor-smooth.ts and
    // waits.ts in src/utils/recording-editor). Optional, so an older file decodes; nil is off.
    /// The private hits a `hidePrivate` op already hid.
    var privacy: Privacy?
    /// The smooth cursor; nil keeps `cursor.smoothing` and `cursor.hideAfterMs`.
    var cursorSmooth: CursorSmooth?
    /// The "⏩ 6x" badge over sped-up parts; nil is no badge.
    var autoSpeed: AutoSpeed?
    /// Raised by every save, so a reader knows the file changed and who changed it last.
    var revision = 0
    var updatedBy: String?
    // R4 6 animated captions
    /// How the captions animate (karaoke colours each word as it is said); nil shows each line at once.
    var captionsStyle: CaptionsStyle?
    // R4 10 progress bar and chapter strip
    /// A bar along the bottom showing the share played, divided at the markers; nil is none.
    var progress: ProgressBar?
    // R4 9 intro and end cards
    /// A title card before the movie and an end card after it, played by the export only; nil is none.
    var cards: Cards?
    // R5 5 redaction edges
    /// How the hiding parts close small holes (Render/RedactionEdges.swift); nil is `RedactionJoins()`.
    var redactionJoins: RedactionJoins?

    struct RedactionJoins: Codable, Equatable {
        /// A hiding part that ends this close before a cut is drawn up to the cut, one that starts this close after a
        /// cut is drawn from it, and two hiding parts with a gap this short meet; 0 leaves every part as placed.
        var snapMs = 250
    }

    struct Cards: Codable, Equatable {
        var intro: IntroCard?
        var end: EndCard?
    }

    struct IntroCard: Codable, Equatable {
        var title: String
        var subtitle: String?
        /// A picture file, absolute.
        var logo: String?
        var date: String?
        var seconds = 3.0
    }

    struct EndCard: Codable, Equatable {
        var text: String
        var link: String?
        /// A QR code of `link` under it.
        var qr = false
        var seconds = 3.0
    }

    /// `height` is a share of the canvas's short side; each chapter's name shows for `chapterMs` when it starts.
    struct ProgressBar: Codable, Equatable {
        var show = true
        var color = "#FFFFFF"
        var height = 0.008
        var chapters = true
        var chapterMs = 2000
    }

    // R4 6 animated captions and texts
    enum CaptionKind: String, Codable, CaseIterable {
        case line, karaoke
    }

    struct CaptionsStyle: Codable, Equatable {
        var kind: CaptionKind = .karaoke
        /// #RRGGBB of the words said so far.
        var color = "#FFD60A"
    }

    enum TextAnimation: String, Codable, CaseIterable {
        case fade, typewriter, slideUp
    }

    /// How a text comes in over `ms`; nil on a text is the 0.2 s fade.
    struct TextAnimate: Codable, Equatable {
        var kind: TextAnimation
        var ms = 600
    }

    /// A moment marked while editing, at SOURCE microseconds; `id` is what the `unmarker` op takes.
    struct Marker: Codable, Equatable, Identifiable {
        var id: String
        var atUs: Int64
        var label: String
    }

    struct Source: Codable, Equatable {
        /// The movie, absolute.
        var video: String
        /// The cursor track (`cursor.jsonl`) when the recorder wrote one.
        var cursor: String?
        /// The library recording id, when the movie belongs to one.
        var recording: String?
        var durationUs: Int64
        var width: Int
        var height: Int
    }

    struct Clip: Codable, Equatable, Identifiable {
        var id: String
        var fromUs: Int64
        var toUs: Int64
        /// 0.25 to 16; 2 plays the clip in half its time.
        var speed: Double = 1

        var sourceDurationUs: Int64 { max(0, toUs - fromUs) }
        /// A speed the decoder would refuse (0, negative, or not finite) plays at 1 rather than trapping on Int64(inf).
        var outputDurationUs: Int64 {
            guard speed.isFinite, speed > 0 else { return sourceDurationUs }
            return Int64((Double(sourceDurationUs) / speed).rounded())
        }
    }

    enum ZoomMode: String, Codable, CaseIterable {
        case manual
        /// The focus follows the recorded cursor (the manual focus when the recording has no cursor track).
        case follow
    }

    struct Zoom: Codable, Equatable, Identifiable {
        var id: String
        var startUs: Int64
        var endUs: Int64
        /// 1.0 to 4.0: 1.5 shows two thirds of the width.
        var scale: Double = 1.5
        var mode: ZoomMode = .manual
        /// The centre of the zoomed view, 0...1 from the top left of the frame.
        var focusX = 0.5
        var focusY = 0.5
        /// How long the zoom takes to reach its scale, and to leave it.
        var easeInMs = 450
        var easeOutMs = 450
        /// The effect lane it sits on (EffectLanes.swift); nil is the first lane that holds its kind.
        var lane: String?
    }

    struct AudioSettings: Codable, Equatable {
        var include = true
        /// 0 to 2 (200 %).
        var volume = 1.0
        /// Muted source audio tracks by index (0 is the first audio track of the movie).
        var mutedTracks: [Int] = []
        /// A sound file under the movie; nil is none. Optional, so an older file decodes.
        var music: Music?
        /// Noise reduction on export, applied by the TypeScript export (src/utils/recording-editor/denoise.ts); kept
        /// here so a save from the editor does not drop it. nil is none.
        var denoise: Denoise?
        // R4 voiceover clips
        /// Extra sound files played from source times, in source order; nil is none.
        var voiceovers: [Voiceover]?
        // R4 8 music ducking
        /// How far the music drops under speech; nil keeps `Music.duck` (src/utils/recording-editor/voiceovers.ts).
        var ducking: Ducking?
    }

    // R4 voiceover clips
    /// A sound file (a narration) that plays from SOURCE time `atUs` at its own speed for `durationUs`, measured
    /// when it was added; `id` is what the `unvoiceover` op takes.
    struct Voiceover: Codable, Equatable, Identifiable {
        var id: String
        var atUs: Int64
        var file: String
        var durationUs: Int64
        /// 0 to 2.
        var volume = 1.0
        var label: String?
    }

    // R4 8 music ducking
    /// The music drops `db` under the transcript's lines and the voiceovers (each switchable), over `fadeMs`.
    struct Ducking: Codable, Equatable {
        var db = 12.0
        var fadeMs = 300
        var transcript = true
        var voiceovers = true
    }

    /// The export's noise reduction: `afftdn` turns the noise down by `reductionDb` on the chosen audio tracks.
    struct Denoise: Codable, Equatable {
        var method = "afftdn"
        var reductionDb = 12.0
        /// nil cleans every audio track.
        var tracks: [Int]?
        /// A strength per track ("1": 20) where it differs from `reductionDb`.
        var trackReductionDb: [String: Double]?

        func strength(ofTrack track: Int) -> Double { trackReductionDb?[String(track)] ?? reductionDb }

        func cleans(track: Int) -> Bool { tracks?.contains(track) ?? true }
    }

    /// Music looped under the movie, fading in and out, and quieter (`duck`) while a transcript line plays.
    struct Music: Codable, Equatable {
        var file: String
        /// 0 to 1.
        var volume = 0.25
        /// How much quieter under speech: 0.6 drops it to 40 %.
        var duck = 0.6
        var fadeMs = 1500
        /// Where in the file it starts; nil is its beginning.
        var startMs: Int?
        /// false plays the file once; nil loops it to the movie's length.
        var loop: Bool?
    }

    struct Clicks: Codable, Equatable {
        var highlight = true
        /// #RRGGBB.
        var color = "#FFD60A"
        /// The disc's largest radius, as a fraction of the picture's height.
        var radius = 0.03
        var durationMs = 450
        /// A soft tick at each click in the sound; nil is off.
        var sound: Bool?
    }

    struct Cursor: Codable, Equatable {
        var show = true
        /// 0.5 to 3 times the recorded size.
        var size = 1.0
        /// 0 (the raw path) to 1 (the path averaged over ±120 ms).
        var smoothing = 0.5
        /// Fades the cursor out after it stood still this long; nil or 0 keeps it. Optional, so an older file decodes.
        var hideAfterMs: Int?
    }

    struct Motion: Codable, Equatable {
        /// 0 keeps each frame of a pan or a zoom sharp; 1 smears it over the whole frame's move (a 360° shutter).
        var blur = 0.5
    }

    enum CaptionPosition: String, Codable, CaseIterable {
        case bottom, top
    }

    struct Captions: Codable, Equatable {
        var show = true
        /// The text height, as a fraction of the output's short side.
        var size = 0.038
        var position: CaptionPosition = .bottom
    }

    enum RedactionStyle: String, Codable, CaseIterable {
        case blur, pixelate, black, spotlight
    }

    /// A spotlight's lit shape; nil is rounded.
    enum SpotlightCutout: String, Codable, CaseIterable {
        case rounded, rect, circle
    }

    /// A rectangle of the SOURCE picture (0...1 from its top left) hidden from `startUs` to `endUs`; it moves with a
    /// zoom, because it is drawn before it.
    struct Redaction: Codable, Equatable, Identifiable {
        var id: String
        var startUs: Int64
        var endUs: Int64
        var x: Double
        var y: Double
        var width: Double
        var height: Double
        var style: RedactionStyle = .blur
        /// What it hides ("API token"), for the lists; absent shows the style.
        var label: String?
        /// Moves with the drawn cursor, centred on it, keeping its size; nil is still.
        var follow: Bool?
        /// A spotlight's dim around it (0.2...0.95 black); nil is `Looks.spotlightDim`.
        var dim: Double?
        var cutout: SpotlightCutout?
        /// The effect lane it sits on (EffectLanes.swift); nil is the first lane that holds its kind.
        var lane: String?
        // fx B (round 4)
        /// Keyframes of the rectangle (a part that follows its text through a scroll); nil keeps x, y, width, height.
        var track: [TrackKey]?
        /// Areas the part leaves visible (a toast over the text); nil is none.
        var exclude: [Box]?
        // R5 5 redaction edges
        /// A spotlight's dim fades in and out over this many ms (capped at a third of its length); 0 is a hard cut,
        /// nil is 200. The hiding styles never fade: they cover fully from their first frame to their last.
        var fadeMs: Int?
        /// A pixelate block's side in source pixels (2 to 256); nil is 1.8 % of the picture's height, at least 8.
        var cell: Double?
    }

    /// fx B (round 4): a rectangle as fractions of the picture from its top left.
    struct Box: Codable, Equatable {
        var x: Double
        var y: Double
        var width: Double
        var height: Double
    }

    /// fx B (round 4): one keyframe of a tracked hidden part, at SOURCE microseconds.
    struct TrackKey: Codable, Equatable {
        var atUs: Int64
        var x: Double
        var y: Double
        var width: Double
        var height: Double
    }

    /// The fixed words of a transcript line by its start in source milliseconds; an empty text hides the line.
    struct TranscriptSettings: Codable, Equatable {
        var fixes: [String: String] = [:]

        static func key(_ line: CaptionTrack.Line) -> String { String(Int((Double(line.fromUs) / 1000).rounded())) }

        /// The line as it should read, or nil when its fix hides it.
        func apply(_ line: CaptionTrack.Line) -> CaptionTrack.Line? {
            guard let fix = fixes[Self.key(line)] else { return line }
            guard !fix.isEmpty else { return nil }
            var fixed = line
            fixed.text = fix
            return fixed
        }
    }

    enum TextStyle: String, Codable, CaseIterable {
        case plate, plain
    }

    /// A line of text in the CANVAS (it stays put through a zoom) from `startUs` to `endUs` of the source; `x`/`y`
    /// is its centre, 0...1 from the top left, and `size` its height as a fraction of the short side.
    struct TextNote: Codable, Equatable, Identifiable {
        var id: String
        var startUs: Int64
        var endUs: Int64
        var text: String
        var x = 0.5
        var y = 0.12
        var size = 0.055
        var style: TextStyle = .plate
        /// The effect lane it sits on (EffectLanes.swift); nil is the first lane that holds its kind.
        var lane: String?
        // R4 6 animated texts
        var animate: TextAnimate?
    }

    enum ShapeKind: String, Codable, CaseIterable {
        case arrow, box, circle
    }

    /// How a shape comes in: draws itself on (nil means this), fades in, or is there at once.
    enum ShapeAppear: String, Codable, CaseIterable {
        case draw, fade, none
    }

    /// An arrow from (x1, y1) to its head at (x2, y2), or a box or circle between those corners, over the SOURCE
    /// picture (0...1 from its top left), so it moves with a zoom. `width` is the line as a fraction of the short side.
    struct Shape: Codable, Equatable, Identifiable {
        var id: String
        var startUs: Int64
        var endUs: Int64
        var kind: ShapeKind
        var x1: Double
        var y1: Double
        var x2: Double
        var y2: Double
        /// #RRGGBB.
        var color = "#FF3B30"
        var width = 0.006
        var appear: ShapeAppear?
        /// The effect lane it sits on (EffectLanes.swift); nil is the first lane that holds its kind.
        var lane: String?
    }

    struct Keys: Codable, Equatable {
        var show = true
        /// The text height, as a fraction of the output's short side.
        var size = 0.05
        var position: CaptionPosition = .bottom
        /// How long a shortcut stays after its press.
        var durationMs = 1200
    }

    enum BackgroundKind: String, Codable, CaseIterable {
        case none, color, gradient, image
    }

    struct Background: Codable, Equatable {
        var kind: BackgroundKind = .gradient
        /// One color for `color`, two (top left to bottom right) for `gradient`.
        var colors = ["#4F46E5", "#DB2777"]
        /// `image`: the picture, absolute, scaled to cover the canvas.
        var image: String?
        /// `image`: 0 (sharp) to 1 (very soft).
        var blur: Double?
    }

    /// The shape of the exported picture around the movie. The canvas's short side is the movie's height, so a
    /// 1080p export is 1920 × 1080 at 16:9, 1080 × 1080 at 1:1 and 1080 × 1920 at 9:16.
    enum CanvasAspect: String, Codable, CaseIterable {
        case source
        case wide = "16:9"
        case standard = "4:3"
        case square = "1:1"
        case portrait = "9:16"

        /// Width over height; nil keeps the movie's own.
        var ratio: CGFloat? {
            switch self {
            case .source: nil
            case .wide: 16.0 / 9
            case .standard: 4.0 / 3
            case .square: 1
            case .portrait: 9.0 / 16
            }
        }
    }

    enum CanvasFit: String, Codable, CaseIterable {
        /// The whole movie, with the background around it.
        case contain
        /// The canvas filled: the movie cropped to its shape, the crop following the cursor (the centre without a
        /// cursor track).
        case cover
    }

    struct Frame: Codable, Equatable {
        /// The canvas around the movie; nil is the movie's own shape. Optional, so an older file decodes.
        var aspect: CanvasAspect?
        /// How the movie fills a canvas of another shape; nil is `.contain`.
        var fit: CanvasFit?
        var background = Background()
        /// The margin on every side, as a fraction of the output height.
        var padding = 0.06
        /// As a fraction of the output height.
        var cornerRadius = 0.012
        var shadow = true
    }

    enum Codec: String, Codable, CaseIterable {
        case h264, hevc
    }

    struct ExportSettings: Codable, Equatable {
        var codec: Codec = .h264
        /// 0 keeps the source height; 2160, 1440, 1080, 720 cap it.
        var maxHeight = 0
        /// The file to write; empty is `<source name>-edited.mp4` beside the source.
        var output = ""
        /// nil is mp4 (files from before the field); gif and webm are made by `tools recorder export`.
        var format: ExportFormat?
        /// A subtitle file written beside every export from the cached transcript; nil is none.
        var subtitles: SubtitleFormat?
        /// The recording's markers as chapters inside an MP4; nil is on.
        var chapters: Bool?
        // R5 3 export size
        /// The exported picture's exact pixels (one side, the other following its shape, or both in its shape); nil
        /// follows `maxHeight`. It wins over `maxHeight` and over the H.264 frame-rate budget.
        var size: OutputSize?
    }

    // R5 3 export size
    struct OutputSize: Codable, Equatable {
        var width: Int?
        var height: Int?
    }

    enum SubtitleFormat: String, Codable, CaseIterable {
        case srt, vtt
    }

    enum ExportFormat: String, Codable, CaseIterable {
        case mp4, gif, webm

        /// The name as people write it ("WebM", beside "WebVTT"), not the file extension in capitals.
        var title: String {
            switch self {
            case .mp4: "MP4"
            case .gif: "GIF"
            case .webm: "WebM"
            }
        }
    }

    // MARK: Round 4 fx-render (src/utils/recording-editor/fx.ts)

    enum TransitionKind: String, Codable, CaseIterable {
        case none, crossfade, zoom, blur
    }

    /// One join's transition: `ms` is its whole length, centred on the join.
    struct Transition: Codable, Equatable {
        var kind: TransitionKind = .none
        var ms = 300
    }

    /// Every join takes `default` unless `joins` has its own, keyed by the id of the clip that starts there.
    struct Transitions: Codable, Equatable {
        var `default` = Transition()
        var joins: [String: Transition]?
    }

    /// A round loupe from `startUs` to `endUs` of the source: it follows the cursor, or stays at x/y (0...1 of the
    /// source picture). `radius` is a fraction of the picture's short side.
    struct LensItem: Codable, Equatable, Identifiable {
        var id: String
        var startUs: Int64
        var endUs: Int64
        var radius = 0.12
        var magnification = 2.0
        var follow = true
        var x = 0.5
        var y = 0.5
        /// #RRGGBB.
        var ring = "#FFFFFF"
    }

    struct Lens: Codable, Equatable {
        var items: [LensItem] = []
    }

    /// The framed picture tilts slightly in 3D (strength 0...1), drifts slowly, tilts in at the start and out at the end.
    struct Tilt: Codable, Equatable {
        var strength = 0.5
        var drift = true
        var tiltIn = true
        var tiltOut = true
        var inMs = 1200
        var outMs = 1200
    }
}

extension EditProject {
    /// A project that keeps the whole movie, as a new edit starts.
    static func whole(video: String, durationUs: Int64, width: Int, height: Int, cursor: String?, recording: String?) -> EditProject {
        EditProject(
            source: Source(video: video, cursor: cursor, recording: recording, durationUs: durationUs, width: width, height: height),
            clips: [Clip(id: wholeClipID, fromUs: 0, toUs: durationUs)]
        )
    }

    /// A new edit's one clip has the same id in every process (WHOLE_CLIP_ID in src/utils/recording-editor/project.ts),
    /// so an op this window sends for an edit not saved yet names the clip the recorder service made for it too.
    static let wholeClipID = "c00000000"

    static func newID(_ prefix: String) -> String {
        prefix + String(UUID().uuidString.prefix(8)).lowercased()
    }

    var outputDurationUs: Int64 { clips.reduce(0) { $0 + $1.outputDurationUs } }

    /// Where a project of this movie lives: `<folder>/edit.json` for a recording folder's movie, `<name>.edit.json`
    /// beside any other movie.
    static func projectURL(forVideo video: URL) -> URL {
        let folder = video.deletingLastPathComponent()
        if FileManager.default.fileExists(atPath: folder.appendingPathComponent("recording.json").path) {
            return folder.appendingPathComponent("edit.json")
        }
        return folder.appendingPathComponent(video.deletingPathExtension().lastPathComponent + ".edit.json")
    }

    /// `at` is the edit file: a recording folder copied whole names the original folder in its source paths, so when
    /// the edit's own folder holds the same movie (same name and size) its paths are read from there, as the CLI does
    /// (`inItsFolder` in src/recorder/lib/edit.ts).
    static func decode(_ data: Data, at url: URL? = nil) throws -> EditProject {
        let object = try JSONSerialization.jsonObject(with: data)
        guard var root = object as? [String: Any] else { throw ProjectError.notAnObject }
        root = try migrate(root)
        let project = try JSONDecoder().decode(EditProject.self, from: JSONSerialization.data(withJSONObject: root))
        try project.validate()
        guard let url else { return project }
        return project.inItsFolder(url.deletingLastPathComponent())
    }

    func inItsFolder(_ folder: URL) -> EditProject {
        let video = URL(fileURLWithPath: source.video)
        guard video.deletingLastPathComponent().standardizedFileURL != folder.standardizedFileURL else { return self }
        let here = folder.appendingPathComponent(video.lastPathComponent)
        let size = { (path: String) in (try? FileManager.default.attributesOfItem(atPath: path)[.size] as? Int) ?? nil }
        guard let mine = size(here.path), let theirs = size(video.path), mine == theirs else { return self }
        var moved = self
        moved.source.video = here.path
        if let cursor = source.cursor {
            let local = folder.appendingPathComponent(URL(fileURLWithPath: cursor).lastPathComponent)
            if FileManager.default.fileExists(atPath: local.path) { moved.source.cursor = local.path }
        }
        return moved
    }

    /// The loader's migration table: one step per version. Version 1 is the first shape, so it only refuses a newer
    /// file instead of reading it wrongly.
    static func migrate(_ root: [String: Any]) throws -> [String: Any] {
        let version = root["version"] as? Int ?? 1
        guard version <= currentVersion else { throw ProjectError.newerVersion(version) }
        return root
    }

    func encoded() throws -> Data {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        return try encoder.encode(self)
    }

    /// The ranges `tools recorder apply` keeps (src/utils/recording-editor/project.ts, clipSchema). A file edited by
    /// hand or by another writer can hold anything; a clip speed of 0 made every duration Int64(infinity), which traps,
    /// and a negative one asked AVFoundation for a negative duration. Refused here with the clip named instead.
    func validate() throws {
        guard source.durationUs >= 0 else { throw ProjectError.badValue("source.durationUs is \(source.durationUs); it must be 0 or more") }
        for (index, clip) in clips.enumerated() {
            guard clip.speed.isFinite, (0.25...16).contains(clip.speed) else {
                throw ProjectError.badValue("clip \(index + 1) (\(clip.id)) has speed \(clip.speed); it must be 0.25 to 16")
            }
            guard clip.fromUs >= 0, clip.toUs >= 0 else {
                throw ProjectError.badValue("clip \(index + 1) (\(clip.id)) runs from \(clip.fromUs) to \(clip.toUs) µs; times must be 0 or more")
            }
        }
    }

    enum ProjectError: LocalizedError {
        case notAnObject
        case newerVersion(Int)
        case badValue(String)

        var errorDescription: String? {
            switch self {
            case .notAnObject: "the edit file is not a JSON object"
            case let .newerVersion(version): "the edit file has version \(version); this build reads up to \(EditProject.currentVersion)"
            case let .badValue(detail): "the edit file is not valid: \(detail)"
            }
        }
    }
}

// fx B (round 4)
extension EditProject {
    struct Privacy: Codable, Equatable {
        var applied: [String] = []
    }

    /// The drawn cursor glides along an average up to ±400 ms × `strength`, moves under `jitterPx` points are dropped,
    /// and it fades after `idleFadeSeconds` without a move (0 keeps it). Clicks stay exact.
    struct CursorSmooth: Codable, Equatable {
        var strength = 0.6
        var jitterPx = 3.0
        var idleFadeSeconds = 2.0
    }

    struct AutoSpeed: Codable, Equatable {
        var badge = true
        var position = SpeedBadgePosition.topRight
    }

    enum SpeedBadgePosition: String, Codable, CaseIterable {
        case topRight = "top-right", topLeft = "top-left", bottomRight = "bottom-right", bottomLeft = "bottom-left"
    }
}
