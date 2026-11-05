import AVFoundation
import Foundation

/// Finds, reads and watches the `edit.json` of what the editor opens. A path may be a movie, a recording folder (its
/// `screen.mp4`), or an edit file. The window never writes it: its changes are ops that the recorder service, or
/// `tools recorder apply` while no service answers, applies to the edit as it is on disk, so a writer the window has
/// not seen yet keeps its change (a whole-project save from a stale copy lost it). A change on disk that this window
/// did not make (an agent's `clip.project()` edit) reaches `onExternalChange`.
@MainActor
final class ProjectStore {
    let url: URL
    private(set) var lastWritten = -1
    private var source: DispatchSourceFileSystemObject?
    var onExternalChange: ((EditProject) -> Void)?

    init(url: URL) {
        self.url = url
    }

    enum OpenError: LocalizedError {
        case missing(String)
        case noMovie(String)

        var errorDescription: String? {
            switch self {
            case let .missing(path): "nothing at \(path)"
            case let .noMovie(path):
                "\(path) has no movie (screen.mp4). A frames-only recording opens after `tools recorder proxy \(path)` makes one."
            }
        }
    }

    /// The project for `path`, read from its edit file or made new (the whole movie) when there is none.
    static func open(path: String) async throws -> (ProjectStore, EditProject) {
        let loaded = try await load(path: path)
        let store = ProjectStore(url: loaded.url)
        if loaded.onDisk { store.lastWritten = loaded.project.revision }
        return (store, loaded.project)
    }

    /// The edit file for `path` and its project, read or made new, off the main actor: a render needs only these.
    nonisolated static func load(path: String) async throws -> (url: URL, project: EditProject, onDisk: Bool) {
        let target = URL(fileURLWithPath: (path as NSString).expandingTildeInPath).standardizedFileURL
        var isFolder: ObjCBool = false
        guard FileManager.default.fileExists(atPath: target.path, isDirectory: &isFolder) else { throw OpenError.missing(target.path) }
        if target.pathExtension == "json" {
            return (target, try EditProject.decode(Data(contentsOf: target), at: target), true)
        }
        let video: URL
        if isFolder.boolValue {
            guard let movie = RecordingMovie.own(in: target) else { throw OpenError.noMovie(target.path) }
            video = movie
        } else {
            video = target
        }
        let projectURL = EditProject.projectURL(forVideo: video)
        if let data = try? Data(contentsOf: projectURL) {
            return (projectURL, try EditProject.decode(data, at: projectURL), true)
        }
        return (projectURL, try await newProject(video: video), false)
    }

    nonisolated static func newProject(video: URL) async throws -> EditProject {
        let asset = AVURLAsset(url: video)
        let duration = try await asset.load(.duration)
        guard let track = try await asset.loadTracks(withMediaType: .video).first else {
            throw EditRenderer.RenderError.noVideoTrack(video.path)
        }
        let size = try await track.load(.naturalSize)
        let folder = video.deletingLastPathComponent()
        let cursor = folder.appendingPathComponent("cursor.jsonl")
        let isRecording = FileManager.default.fileExists(atPath: folder.appendingPathComponent("recording.json").path)
        var project = EditProject.whole(
            video: video.path,
            durationUs: Int64((duration.seconds * 1_000_000).rounded()),
            width: Int(size.width), height: Int(size.height),
            cursor: FileManager.default.fileExists(atPath: cursor.path) ? cursor.path : nil,
            recording: isRecording ? folder.lastPathComponent : nil
        )
        if let data = try? Data(contentsOf: folder.appendingPathComponent("camera.json")),
           let sidecar = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
           let file = sidecar["file"] as? String {
            var camera = EditProject.Camera(file: file)
            let formatter = ISO8601DateFormatter()
            formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
            if let started = sidecar["startedAt"] as? String, let screen = sidecar["screenStartedAt"] as? String,
               let a = formatter.date(from: started), let b = formatter.date(from: screen) {
                camera.offsetMs = max(-600_000, min(600_000, Int((a.timeIntervalSince(b) * 1000).rounded())))
            }
            if let placement = sidecar["placement"] as? [String: Any] {
                if let x = placement["x"] as? Double, let y = placement["y"] as? Double {
                    camera.corner = .custom
                    camera.x = x
                    camera.y = y
                }
                if let size = placement["size"] as? Double { camera.size = size }
                if let shape = placement["shape"] as? String, let value = EditProject.CameraShape(rawValue: shape) { camera.shape = value }
            }
            project.camera = camera
        }
        return project
    }

    /// A revision this window's own change wrote through `tools` (offline): its file event is not an outside edit.
    func noteWritten(_ revision: Int) {
        lastWritten = max(lastWritten, revision)
    }

    /// Watches the edit file; an atomic replace ends the watch, so each event starts a new one.
    func watch() {
        source?.cancel()
        let watched = FileManager.default.fileExists(atPath: url.path) ? url : url.deletingLastPathComponent()
        let descriptor = Darwin.open(watched.path, O_EVTONLY)
        guard descriptor >= 0 else { return }
        let source = DispatchSource.makeFileSystemObjectSource(fileDescriptor: descriptor, eventMask: [.write, .rename, .delete], queue: .main)
        source.setEventHandler { [weak self] in
            MainActor.assumeIsolated { self?.reloadIfChanged() }
        }
        source.setCancelHandler { close(descriptor) }
        source.resume()
        self.source = source
    }

    func stopWatching() {
        source?.cancel()
        source = nil
    }

    private func reloadIfChanged() {
        defer { watch() }
        guard let data = try? Data(contentsOf: url), let project = try? EditProject.decode(data, at: url) else { return }
        guard project.revision > lastWritten else { return }
        lastWritten = project.revision
        HubPerf.log("recorder.editor: \(url.lastPathComponent) changed on disk (revision \(project.revision) by \(project.updatedBy ?? "?"))")
        onExternalChange?(project)
    }
}
