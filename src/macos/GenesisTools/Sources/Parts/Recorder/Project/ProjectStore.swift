import AVFoundation
import Foundation

/// Finds, reads, writes and watches the `edit.json` of what the editor opens. A path may be a movie, a recording
/// folder (its `screen.mp4`), or an edit file. A write is atomic and raises `revision`; a change on disk that this
/// window did not make (an agent's `clip.project()` edit) reaches `onExternalChange`.
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
        let target = URL(fileURLWithPath: (path as NSString).expandingTildeInPath).standardizedFileURL
        var isFolder: ObjCBool = false
        guard FileManager.default.fileExists(atPath: target.path, isDirectory: &isFolder) else { throw OpenError.missing(target.path) }
        if target.pathExtension == "json" {
            let store = ProjectStore(url: target)
            let project = try EditProject.decode(Data(contentsOf: target), at: target)
            store.lastWritten = project.revision
            return (store, project)
        }
        let video: URL
        if isFolder.boolValue {
            guard let movie = ["screen.mp4", "screen.mov", "proxy.mp4"].map({ target.appendingPathComponent($0) })
                .first(where: { FileManager.default.fileExists(atPath: $0.path) }) else {
                throw OpenError.noMovie(target.path)
            }
            video = movie
        } else {
            video = target
        }
        let projectURL = EditProject.projectURL(forVideo: video)
        let store = ProjectStore(url: projectURL)
        if let data = try? Data(contentsOf: projectURL) {
            let project = try EditProject.decode(data, at: projectURL)
            store.lastWritten = project.revision
            return (store, project)
        }
        let project = try await newProject(video: video)
        return (store, project)
    }

    static func newProject(video: URL) async throws -> EditProject {
        let asset = AVURLAsset(url: video)
        let duration = try await asset.load(.duration)
        guard let track = try await asset.loadTracks(withMediaType: .video).first else {
            throw EditRenderer.RenderError.noVideoTrack(video.path)
        }
        let size = try await track.load(.naturalSize)
        let folder = video.deletingLastPathComponent()
        let cursor = folder.appendingPathComponent("cursor.jsonl")
        let isRecording = FileManager.default.fileExists(atPath: folder.appendingPathComponent("recording.json").path)
        return EditProject.whole(
            video: video.path,
            durationUs: Int64((duration.seconds * 1_000_000).rounded()),
            width: Int(size.width), height: Int(size.height),
            cursor: FileManager.default.fileExists(atPath: cursor.path) ? cursor.path : nil,
            recording: isRecording ? folder.lastPathComponent : nil
        )
    }

    func save(_ project: EditProject) throws -> EditProject {
        var saved = project
        saved.revision = max(project.revision, lastWritten) + 1
        saved.updatedBy = "editor"
        try saved.encoded().write(to: url, options: .atomic)
        lastWritten = saved.revision
        // An atomic write replaces the file, so the old watch is on a file that is gone.
        watch()
        return saved
    }

    /// Watches the edit file; an atomic replace ends the watch, so each event starts a new one.
    func watch() {
        source?.cancel()
        let descriptor = Darwin.open(url.path, O_EVTONLY)
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
