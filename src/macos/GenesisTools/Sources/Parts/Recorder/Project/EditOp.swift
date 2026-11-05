import Foundation

/// One typed change to an edit, the `EditOp` union of src/utils/recording-editor/project.ts (`editOpSchema`), as the
/// window sends it to the recorder service (`edit.apply`, `gesture.preview`). The TypeScript side owns every rule; this
/// side only names the change. Times are SOURCE seconds, except the `range` op's, which are OUTPUT seconds.
///
/// Written by hand (zod emits no discriminator a generator could use); `EditOpTests` checks that the tags equal the
/// zod tags and decodes the ops TypeScript wrote into `edit-ops.golden.json`.
enum EditOp: Equatable {
    case split(Split)
    case cut(Cut)
    case keep(Keep)
    case speed(Speed)
    case zoom(Zoom)
    case unzoom(Unzoom)
    case redact(Redact)
    case spotlight(Spotlight)
    case unredact(Unredact)
    case text(Text)
    case untext(Untext)
    case marker(Marker)
    case unmarker(Unmarker)
    case retime(Retime)
    case shape(Shape)
    case unshape(Unshape)
    case fixLine(FixLine)
    case unfixLine(UnfixLine)
    case autoZoom(AutoZoom)
    case annotateClicks(AnnotateClicks)
    case volume(Volume)
    case mute(Mute)
    case audio(Audio)
    case music(Music)
    case exportSettings(ExportSettings)
    case reset(Reset)
    case clicks(Clicks)
    case keys(Keys)
    case captions(Captions)
    case motion(Motion)
    case cursor(Cursor)
    case frame(Frame)
    case camera(Camera)
    case cameraHide(CameraHide)
    case cameraShow(CameraShow)
    case removeIdle(RemoveIdle)
    case cutWords(CutWords)
    case cutFillers(CutFillers)
    case denoise(Denoise)
    case normalize(Normalize)
    case lanes(Lanes)
    case addLane(AddLane)
    case removeLane(RemoveLane)
    case moveLane(MoveLane)
    case moveToLane(MoveToLane)
    case range(RangeAction)
    case setZoom(SetZoom)
    case setRedaction(SetRedaction)
    case setText(SetText)
    case setShape(SetShape)
    case trim(Trim)
    case deleteClip(DeleteClip)
    case clipSpeed(ClipSpeed)
    case duplicate(Duplicate)
    case removeClickCircles(RemoveClickCircles)
    case renameLane(RenameLane)

    /// Every payload type, so the decoder finds one by its tag and the tag test lists them.
    static let payloads: [any EditOpPayload.Type] = [
        Split.self, Cut.self, Keep.self, Speed.self, Zoom.self, Unzoom.self, Redact.self, Spotlight.self, Unredact.self,
        Text.self, Untext.self, Marker.self, Unmarker.self, Retime.self, Shape.self, Unshape.self, FixLine.self,
        UnfixLine.self, AutoZoom.self, AnnotateClicks.self, Volume.self, Mute.self, Audio.self, Music.self,
        ExportSettings.self, Reset.self, Clicks.self, Keys.self, Captions.self, Motion.self, Cursor.self, Frame.self,
        Camera.self, CameraHide.self, CameraShow.self, RemoveIdle.self, CutWords.self, CutFillers.self, Denoise.self,
        Normalize.self, Lanes.self, AddLane.self, RemoveLane.self, MoveLane.self, MoveToLane.self, RangeAction.self,
        SetZoom.self, SetRedaction.self, SetText.self, SetShape.self, Trim.self, DeleteClip.self, ClipSpeed.self,
        Duplicate.self, RemoveClickCircles.self, RenameLane.self,
    ]

    static var tags: [String] { payloads.map { $0.tag } }

    var payload: any EditOpPayload {
        switch self {
        case let .split(op): op
        case let .cut(op): op
        case let .keep(op): op
        case let .speed(op): op
        case let .zoom(op): op
        case let .unzoom(op): op
        case let .redact(op): op
        case let .spotlight(op): op
        case let .unredact(op): op
        case let .text(op): op
        case let .untext(op): op
        case let .marker(op): op
        case let .unmarker(op): op
        case let .retime(op): op
        case let .shape(op): op
        case let .unshape(op): op
        case let .fixLine(op): op
        case let .unfixLine(op): op
        case let .autoZoom(op): op
        case let .annotateClicks(op): op
        case let .volume(op): op
        case let .mute(op): op
        case let .audio(op): op
        case let .music(op): op
        case let .exportSettings(op): op
        case let .reset(op): op
        case let .clicks(op): op
        case let .keys(op): op
        case let .captions(op): op
        case let .motion(op): op
        case let .cursor(op): op
        case let .frame(op): op
        case let .camera(op): op
        case let .cameraHide(op): op
        case let .cameraShow(op): op
        case let .removeIdle(op): op
        case let .cutWords(op): op
        case let .cutFillers(op): op
        case let .denoise(op): op
        case let .normalize(op): op
        case let .lanes(op): op
        case let .addLane(op): op
        case let .removeLane(op): op
        case let .moveLane(op): op
        case let .moveToLane(op): op
        case let .range(op): op
        case let .setZoom(op): op
        case let .setRedaction(op): op
        case let .setText(op): op
        case let .setShape(op): op
        case let .trim(op): op
        case let .deleteClip(op): op
        case let .clipSpeed(op): op
        case let .duplicate(op): op
        case let .removeClickCircles(op): op
        case let .renameLane(op): op
        }
    }

    var tag: String { type(of: payload).tag }

    /// The op as a JSON object, for a `[String: Any]` RPC call.
    var object: [String: Any] {
        guard let data = try? JSONEncoder().encode(self),
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return ["op": tag] }
        return object
    }

    static func objects(_ ops: [EditOp]) -> [[String: Any]] { ops.map(\.object) }

    /// The ops as one JSON array, as `tools recorder apply` takes them.
    static func json(_ ops: [EditOp]) -> String {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        guard let data = try? encoder.encode(ops) else { return "[]" }
        return String(decoding: data, as: UTF8.self)
    }
}

/// One op's fields; `tag` is its `op` value.
protocol EditOpPayload: Codable, Equatable {
    static var tag: String { get }
    var op: EditOp { get }
}

extension EditOp: Codable {
    private enum TagKey: String, CodingKey { case op }

    init(from decoder: Decoder) throws {
        let tag = try decoder.container(keyedBy: TagKey.self).decode(String.self, forKey: .op)
        guard let type = Self.payloads.first(where: { $0.tag == tag }) else {
            throw DecodingError.dataCorrupted(.init(codingPath: decoder.codingPath, debugDescription: "no edit op \"\(tag)\""))
        }
        self = try type.init(from: decoder).op
    }

    func encode(to encoder: Encoder) throws {
        var tagged = encoder.container(keyedBy: TagKey.self)
        try tagged.encode(tag, forKey: .op)
        try payload.encode(to: encoder)
    }
}

extension EditOp {
    struct Point: Codable, Equatable {
        var x: Double
        var y: Double
    }

    struct Rect: Codable, Equatable {
        var x: Double
        var y: Double
        var width: Double
        var height: Double

        init(x: Double, y: Double, width: Double, height: Double) {
            self.x = x
            self.y = y
            self.width = width
            self.height = height
        }

        init(_ rect: CGRect) {
            self.init(x: rect.minX, y: rect.minY, width: rect.width, height: rect.height)
        }
    }

    struct Split: EditOpPayload {
        static let tag = "split"
        var at: Double
        var op: EditOp { .split(self) }
    }

    /// The source between the two times goes.
    struct Cut: EditOpPayload {
        static let tag = "cut"
        var from: Double
        var to: Double
        var op: EditOp { .cut(self) }
    }

    struct Keep: EditOpPayload {
        static let tag = "keep"
        var from: Double
        var to: Double
        var op: EditOp { .keep(self) }
    }

    struct Speed: EditOpPayload {
        static let tag = "speed"
        var from: Double
        var to: Double
        var factor: Double
        var op: EditOp { .speed(self) }
    }

    struct Zoom: EditOpPayload {
        static let tag = "zoom"
        var from: Double
        var to: Double
        var scale: Double?
        var focus: Point?
        var follow: Bool?
        var lane: String?
        var op: EditOp { .zoom(self) }
    }

    struct Unzoom: EditOpPayload {
        static let tag = "unzoom"
        var id: String
        var op: EditOp { .unzoom(self) }
    }

    struct Redact: EditOpPayload {
        static let tag = "redact"
        var from: Double
        var to: Double
        var rect: Rect
        var style: EditProject.RedactionStyle?
        var label: String?
        var follow: Bool?
        var dim: Double?
        var cutout: EditProject.SpotlightCutout?
        var lane: String?
        var op: EditOp { .redact(self) }
    }

    struct Spotlight: EditOpPayload {
        static let tag = "spotlight"
        var from: Double
        var to: Double
        var rect: Rect
        var label: String?
        var follow: Bool?
        var dim: Double?
        var cutout: EditProject.SpotlightCutout?
        var lane: String?
        var op: EditOp { .spotlight(self) }
    }

    struct Unredact: EditOpPayload {
        static let tag = "unredact"
        var id: String
        var op: EditOp { .unredact(self) }
    }

    struct Text: EditOpPayload {
        static let tag = "text"
        var from: Double
        var to: Double
        var text: String
        var x: Double?
        var y: Double?
        var size: Double?
        var style: EditProject.TextStyle?
        var lane: String?
        var op: EditOp { .text(self) }
    }

    struct Untext: EditOpPayload {
        static let tag = "untext"
        var id: String
        var op: EditOp { .untext(self) }
    }

    struct Marker: EditOpPayload {
        static let tag = "marker"
        var at: Double
        var label: String?
        var op: EditOp { .marker(self) }
    }

    struct Unmarker: EditOpPayload {
        static let tag = "unmarker"
        var id: String
        var op: EditOp { .unmarker(self) }
    }

    /// Moves or trims an item by id: `at` moves its start, `from` and `to` set its edges, `by` shifts it (seconds).
    struct Retime: EditOpPayload {
        static let tag = "retime"
        var id: String
        var at: Double?
        var from: Double?
        var to: Double?
        var by: Double?
        var op: EditOp { .retime(self) }
    }

    struct Shape: EditOpPayload {
        static let tag = "shape"
        var from: Double
        var to: Double
        var kind: EditProject.ShapeKind
        /// Without start and end the service places it: round `at`, else round the pointer at `from`.
        var start: Point?
        var end: Point?
        var at: Point?
        var color: String?
        var width: Double?
        var appear: EditProject.ShapeAppear?
        var lane: String?
        var op: EditOp { .shape(self) }
    }

    struct Unshape: EditOpPayload {
        static let tag = "unshape"
        var id: String
        var op: EditOp { .unshape(self) }
    }

    struct FixLine: EditOpPayload {
        static let tag = "fixLine"
        var from: Double
        var text: String
        var op: EditOp { .fixLine(self) }
    }

    struct UnfixLine: EditOpPayload {
        static let tag = "unfixLine"
        var from: Double
        var op: EditOp { .unfixLine(self) }
    }

    struct AutoZoom: EditOpPayload {
        static let tag = "autoZoom"
        var scale: Double?
        var op: EditOp { .autoZoom(self) }
    }

    struct AnnotateClicks: EditOpPayload {
        static let tag = "annotateClicks"
        var from: Double?
        var to: Double?
        var kind: EditProject.ShapeKind?
        var seconds: Double?
        var color: String?
        var appear: EditProject.ShapeAppear?
        var op: EditOp { .annotateClicks(self) }
    }

    struct Volume: EditOpPayload {
        static let tag = "volume"
        var volume: Double
        var op: EditOp { .volume(self) }
    }

    struct Mute: EditOpPayload {
        static let tag = "mute"
        var track: Int
        var muted: Bool?
        var op: EditOp { .mute(self) }
    }

    struct Audio: EditOpPayload {
        static let tag = "audio"
        var include: Bool
        var op: EditOp { .audio(self) }
    }

    struct Music: EditOpPayload {
        static let tag = "music"
        var file: String?
        var volume: Double?
        var duck: Double?
        var fadeMs: Int?
        var startMs: Int?
        var loop: Bool?
        var enabled: Bool?
        var op: EditOp { .music(self) }
    }

    struct ExportSettings: EditOpPayload {
        static let tag = "exportSettings"
        var codec: EditProject.Codec?
        var maxHeight: Int?
        var output: String?
        var format: EditProject.ExportFormat?
        /// "srt", "vtt" or "none".
        var subtitles: String?
        var chapters: Bool?
        var op: EditOp { .exportSettings(self) }
    }

    struct Reset: EditOpPayload {
        static let tag = "reset"
        var op: EditOp { .reset(self) }
    }

    struct Clicks: EditOpPayload {
        static let tag = "clicks"
        var highlight: Bool?
        var color: String?
        var radius: Double?
        var durationMs: Int?
        var sound: Bool?
        var op: EditOp { .clicks(self) }
    }

    struct Keys: EditOpPayload {
        static let tag = "keys"
        var show: Bool?
        var size: Double?
        var position: EditProject.CaptionPosition?
        var durationMs: Int?
        var op: EditOp { .keys(self) }
    }

    struct Captions: EditOpPayload {
        static let tag = "captions"
        var show: Bool?
        var size: Double?
        var position: EditProject.CaptionPosition?
        var op: EditOp { .captions(self) }
    }

    struct Motion: EditOpPayload {
        static let tag = "motion"
        var blur: Double?
        var op: EditOp { .motion(self) }
    }

    struct Cursor: EditOpPayload {
        static let tag = "cursor"
        var show: Bool?
        var size: Double?
        var smoothing: Double?
        var hideAfterMs: Int?
        var op: EditOp { .cursor(self) }
    }

    struct Frame: EditOpPayload {
        static let tag = "frame"
        var enabled: Bool?
        var aspect: EditProject.CanvasAspect?
        var fit: EditProject.CanvasFit?
        var background: Background?
        var padding: Double?
        var cornerRadius: Double?
        var shadow: Bool?
        var op: EditOp { .frame(self) }

        struct Background: Codable, Equatable {
            var kind: EditProject.BackgroundKind?
            var colors: [String]?
            var image: String?
            var blur: Double?
        }
    }

    struct Camera: EditOpPayload {
        static let tag = "camera"
        var file: String?
        var show: Bool?
        var corner: EditProject.CameraCorner?
        var x: Double?
        var y: Double?
        var size: Double?
        var shape: EditProject.CameraShape?
        var mirror: Bool?
        var offsetMs: Int?
        var enabled: Bool?
        var op: EditOp { .camera(self) }
    }

    struct CameraHide: EditOpPayload {
        static let tag = "cameraHide"
        var from: Double
        var to: Double
        var lane: String?
        var op: EditOp { .cameraHide(self) }
    }

    /// Shows the camera over a range again, or deletes one hidden part by `id`.
    struct CameraShow: EditOpPayload {
        static let tag = "cameraShow"
        var from: Double?
        var to: Double?
        var id: String?
        var op: EditOp { .cameraShow(self) }
    }

    struct RemoveIdle: EditOpPayload {
        static let tag = "removeIdle"
        var minSeconds: Double?
        var keepSeconds: Double?
        var speed: Double?
        var op: EditOp { .removeIdle(self) }
    }

    struct CutWords: EditOpPayload {
        static let tag = "cutWords"
        var at: Double
        var words: String
        var occurrence: Int?
        var padMs: Int?
        var op: EditOp { .cutWords(self) }
    }

    struct CutFillers: EditOpPayload {
        static let tag = "cutFillers"
        var language: String?
        /// "sounds" or "all".
        var level: String?
        var words: [String]?
        var padMs: Int?
        var op: EditOp { .cutFillers(self) }
    }

    /// `track` with `on` puts one track in or out; `track` with `reductionDb` is that track's strength. Both need
    /// `trackCount`, the movie's sound tracks, for the service's rules.
    struct Denoise: EditOpPayload {
        static let tag = "denoise"
        var enabled: Bool?
        var method: String?
        var reductionDb: Double?
        var tracks: [Int]?
        var trackReductionDb: [String: Double]?
        var track: Int?
        var on: Bool?
        var trackCount: Int?
        var op: EditOp { .denoise(self) }
    }

    struct Normalize: EditOpPayload {
        static let tag = "normalize"
        var targetLufs: Double?
        var op: EditOp { .normalize(self) }
    }

    struct Lanes: EditOpPayload {
        static let tag = "lanes"
        var lanes: [EffectLane]
        var op: EditOp { .lanes(self) }
    }

    struct AddLane: EditOpPayload {
        static let tag = "addLane"
        var kinds: [EffectKind]?
        var name: String?
        var id: String?
        var op: EditOp { .addLane(self) }
    }

    struct RemoveLane: EditOpPayload {
        static let tag = "removeLane"
        var id: String
        var op: EditOp { .removeLane(self) }
    }

    struct MoveLane: EditOpPayload {
        static let tag = "moveLane"
        var id: String
        var to: Int
        var op: EditOp { .moveLane(self) }
    }

    struct MoveToLane: EditOpPayload {
        static let tag = "moveToLane"
        var id: String
        var lane: String
        var op: EditOp { .moveToLane(self) }
    }

    /// The range popover's change over OUTPUT seconds: "cut", "speed", "zoom", "hide", "spotlight", "text", "marker".
    struct RangeAction: EditOpPayload {
        static let tag = "range"
        var from: Double
        var to: Double
        var action: String
        var factor: Double?
        var scale: Double?
        var text: String?
        var lane: String?
        var op: EditOp { .range(self) }
    }

    struct SetZoom: EditOpPayload {
        static let tag = "setZoom"
        var id: String
        var scale: Double?
        var mode: EditProject.ZoomMode?
        var focus: Point?
        var easeInMs: Int?
        var easeOutMs: Int?
        var op: EditOp { .setZoom(self) }
    }

    struct SetRedaction: EditOpPayload {
        static let tag = "setRedaction"
        var id: String
        var rect: Rect?
        var style: EditProject.RedactionStyle?
        /// "" takes the label away.
        var label: String?
        var follow: Bool?
        var dim: Double?
        var cutout: EditProject.SpotlightCutout?
        var op: EditOp { .setRedaction(self) }
    }

    struct SetText: EditOpPayload {
        static let tag = "setText"
        var id: String
        var text: String?
        var x: Double?
        var y: Double?
        var size: Double?
        var style: EditProject.TextStyle?
        var op: EditOp { .setText(self) }
    }

    struct SetShape: EditOpPayload {
        static let tag = "setShape"
        var id: String
        var kind: EditProject.ShapeKind?
        var start: Point?
        var end: Point?
        var color: String?
        var width: Double?
        var appear: EditProject.ShapeAppear?
        var op: EditOp { .setShape(self) }
    }

    /// A clip's edges in SOURCE seconds.
    struct Trim: EditOpPayload {
        static let tag = "trim"
        var clip: String
        var from: Double?
        var to: Double?
        var op: EditOp { .trim(self) }
    }

    struct DeleteClip: EditOpPayload {
        static let tag = "deleteClip"
        var clip: String
        var op: EditOp { .deleteClip(self) }
    }

    struct ClipSpeed: EditOpPayload {
        static let tag = "clipSpeed"
        var clip: String
        var factor: Double
        var op: EditOp { .clipSpeed(self) }
    }

    struct Duplicate: EditOpPayload {
        static let tag = "duplicate"
        var id: String
        var op: EditOp { .duplicate(self) }
    }

    struct RemoveClickCircles: EditOpPayload {
        static let tag = "removeClickCircles"
        var op: EditOp { .removeClickCircles(self) }
    }

    struct RenameLane: EditOpPayload {
        static let tag = "renameLane"
        var id: String
        var name: String
        var op: EditOp { .renameLane(self) }
    }
}
