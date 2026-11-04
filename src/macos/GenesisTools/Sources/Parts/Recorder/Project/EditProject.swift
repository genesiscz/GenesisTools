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
    /// Raised by every save, so a reader knows the file changed and who changed it last.
    var revision = 0
    var updatedBy: String?

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
        var outputDurationUs: Int64 { Int64((Double(sourceDurationUs) / speed).rounded()) }
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
    }

    enum SubtitleFormat: String, Codable, CaseIterable {
        case srt, vtt
    }

    enum ExportFormat: String, Codable, CaseIterable {
        case mp4, gif, webm
    }
}

extension EditProject {
    /// A project that keeps the whole movie, as a new edit starts.
    static func whole(video: String, durationUs: Int64, width: Int, height: Int, cursor: String?, recording: String?) -> EditProject {
        EditProject(
            source: Source(video: video, cursor: cursor, recording: recording, durationUs: durationUs, width: width, height: height),
            clips: [Clip(id: newID("c"), fromUs: 0, toUs: durationUs)]
        )
    }

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

    enum ProjectError: LocalizedError {
        case notAnObject
        case newerVersion(Int)

        var errorDescription: String? {
            switch self {
            case .notAnObject: "the edit file is not a JSON object"
            case let .newerVersion(version): "the edit file has version \(version); this build reads up to \(EditProject.currentVersion)"
            }
        }
    }
}
