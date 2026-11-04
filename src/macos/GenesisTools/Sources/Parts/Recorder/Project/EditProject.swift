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
    }

    struct AudioSettings: Codable, Equatable {
        var include = true
        /// 0 to 2 (200 %).
        var volume = 1.0
        /// Muted source audio tracks by index (0 is the first audio track of the movie).
        var mutedTracks: [Int] = []
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

    static func decode(_ data: Data) throws -> EditProject {
        let object = try JSONSerialization.jsonObject(with: data)
        guard var root = object as? [String: Any] else { throw ProjectError.notAnObject }
        root = try migrate(root)
        return try JSONDecoder().decode(EditProject.self, from: JSONSerialization.data(withJSONObject: root))
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
