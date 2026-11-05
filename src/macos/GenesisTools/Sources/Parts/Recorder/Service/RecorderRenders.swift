import AppKit
import AVFoundation
import SwiftUI

/// The renders the recorder face answers, once for both callers: the headless `--still`, `--sheet`, `--export` and
/// `--snapshot` runs print what these return, and the recorder host answers `render.*` with the same fields. A still
/// and a sheet build and decode the movie off the main actor (`EditRenderer.render` and the image generator are
/// nonisolated); the main actor only opens the project (`ProjectStore` is main-actor), draws the sheet's labels
/// (AppKit string drawing) and runs the exporter's 0.25 s progress timer. A snapshot draws a window, so it is
/// main-actor work throughout; its awaits still give the main thread back between steps.
enum RecorderRenders {
    /// `--still`: one frame of the edit as it exports. `full` renders at the export's size (a poster).
    static func still(source: String, atSeconds: Double, out: String?, full: Bool) async throws -> [String: Any] {
        let project = try await openProject(source)
        let zoom = ZoomState(project: project, cursor: CursorTrack.load(project.source.cursor))
        let at = Int64((atSeconds * 1_000_000).rounded())
        let image = try await stillFrame(project: project, atOutput: at, zoom: zoom, maxHeight: full ? project.export.maxHeight : 1080)
        let url = URL(fileURLWithPath: out ?? NSTemporaryDirectory() + "recorder-still-\(UUID().uuidString.prefix(8)).png")
        try writePNG(image, to: url, what: "the frame")
        return ["ok": true, "path": url.path, "width": image.width, "height": image.height, "atSeconds": atSeconds]
    }

    /// `--sheet`: those frames of the edit on one picture, each with its output time.
    static func sheet(source: String, times: [Double], out: String?) async throws -> [String: Any] {
        guard !times.isEmpty else {
            throw NSError(domain: "recorder", code: 64, userInfo: [NSLocalizedDescriptionKey: "--sheet needs --times with at least one time"])
        }
        let project = try await openProject(source)
        let zoom = ZoomState(project: project, cursor: CursorTrack.load(project.source.cursor))
        let frames = try await stillFrames(project: project, atOutput: times.map { Int64(($0 * 1_000_000).rounded()) }, zoom: zoom)
        let sheet = await MainActor.run { ContactSheet.draw(frames: zip(times, frames).map { ($0, $1) }) }
        let url = URL(fileURLWithPath: out ?? NSTemporaryDirectory() + "recorder-sheet-\(UUID().uuidString.prefix(8)).png")
        try writePNG(sheet, to: url, what: "the sheet")
        return ["ok": true, "path": url.path, "width": sheet.width, "height": sheet.height, "times": times]
    }

    /// `--export`: the movie, written by the editor's exporter. `onProgress` runs on the main actor every 0.25 s;
    /// `isCancelled` true stops the export, removes its partial file and throws a CancellationError.
    @MainActor
    static func export(source: String, out: String?, isCancelled: @escaping () -> Bool = { false },
                       onProgress: @escaping (Double) -> Void) async throws -> EditExporter.Result {
        var (_, project) = try await ProjectStore.open(path: source)
        if let out { project.export.output = out }
        return try await EditExporter.export(project: project, to: EditExporter.outputURL(for: project),
                                             isCancelled: isCancelled, onProgress: onProgress)
    }

    /// The fields `--export --json` prints.
    static func exportAnswer(_ result: EditExporter.Result) -> [String: Any] {
        ["ok": true, "path": result.url.path, "bytes": result.bytes, "seconds": (result.seconds * 100).rounded() / 100]
    }

    /// `--snapshot`: the editor (`edit`), the library or the capture picker drawn off screen into `path`. Answers how
    /// the window was captured. Every window the snapshot ordered in is closed after it, so a snapshot inside the
    /// running app leaves nothing behind.
    @MainActor
    static func snapshot(_ request: RecorderRequest, to path: String) async throws -> String {
        let before = Set(NSApp.windows.map(ObjectIdentifier.init))
        defer {
            for window in NSApp.windows where !before.contains(ObjectIdentifier(window)) && window.alphaValue == 0 && window.ignoresMouseEvents {
                window.orderOut(nil)
                window.close()
            }
        }
        if request.library { return try await snapshotLibrary(request, to: path) }
        if request.picker {
            try await CapturePicker.snapshot(to: path, shortcutsOpen: request.shortcuts)
            return "picker"
        }
        guard let edit = request.edit else { throw NSError(domain: "recorder", code: 64, userInfo: [NSLocalizedDescriptionKey: "--snapshot needs --edit <path> or --library"]) }
        let (store, project) = try await ProjectStore.open(path: edit)
        let model = EditorModel(project: project, store: store)
        defer { model.close() }
        if let tab = request.tab { model.tab = tab }
        if let n = request.selectZoom, project.zooms.indices.contains(n) { model.selection = .zoom(project.zooms[n].id); model.tab = .zoom }
        if let n = request.selectClip, project.clips.indices.contains(n) { model.selection = .clip(project.clips[n].id); model.tab = .clip }
        if let part = request.part {
            model.partInUs = Int64(part.from * 1_000_000)
            model.partOutUs = Int64(part.to * 1_000_000)
        }
        if let range = request.range {
            model.timelineRange = TimelineRange(fromUs: Int64(range.from * 1_000_000), toUs: Int64(range.to * 1_000_000))
        }
        if let n = request.comment, model.reviewComments.indices.contains(n) { model.openComment = model.reviewComments[n].id }
        let at = Int64(((request.atSeconds ?? 0) * 1_000_000).rounded())
        // The filmstrip and the waveform load in the background; give them up to 8 s.
        for _ in 0..<80 where model.filmstrip.tiles.isEmpty {
            try await Task.sleep(for: .milliseconds(100))
        }
        try await Task.sleep(for: .milliseconds(300))
        // The Export tab lists what `tools recorder check` finds; wait up to 4 s for its answer.
        if model.tab == .export {
            model.refreshIssues()
            for _ in 0..<40 where model.issuesRevision != model.project.revision {
                try await Task.sleep(for: .milliseconds(100))
            }
        }
        // After the player item landed, which resets the clock to its own start.
        model.seek(at)
        let still = try await stillFrame(project: project, atOutput: at, zoom: model.zoom)
        let window = EditorWindows.makeWindow(model: model, size: NSSize(width: request.width, height: request.height))
        window.contentView = NSHostingView(rootView: EditorView(model: model, stillPreview: still))
        window.orderInForSnapshot()
        try await Task.sleep(for: .milliseconds(500))
        guard let capture = await WindowSnapshot.capture(window),
              let png = capture.image.representation(using: .png, properties: [:]) else {
            throw NSError(domain: "recorder", code: 70, userInfo: [NSLocalizedDescriptionKey: "the window could not be drawn"])
        }
        try png.write(to: URL(fileURLWithPath: path))
        return "\(capture.method)"
    }

    @MainActor
    private static func snapshotLibrary(_ request: RecorderRequest, to path: String) async throws -> String {
        let model = LibraryModel()
        model.load()
        for _ in 0..<100 where !model.loaded {
            try await Task.sleep(for: .milliseconds(100))
        }
        if let filter = request.filter {
            model.filter = filter
            // The spoken search waits 300 ms after the last key, then runs `tools recorder search` (about 0.4 s).
            for _ in 0..<40 where model.spoken.isEmpty {
                try await Task.sleep(for: .milliseconds(100))
            }
        }
        let window = LibraryWindow.makeWindow(model: model, size: NSSize(width: request.width, height: request.height))
        window.orderInForSnapshot()
        try await Task.sleep(for: .milliseconds(600))
        guard let capture = await WindowSnapshot.capture(window),
              let png = capture.image.representation(using: .png, properties: [:]) else {
            throw NSError(domain: "recorder", code: 70, userInfo: [NSLocalizedDescriptionKey: "the window could not be drawn"])
        }
        try png.write(to: URL(fileURLWithPath: path))
        return "\(capture.method) (\(model.items.count) recordings)"
    }

    /// Only the project: the store is a main-actor object, and these renders need nothing else of it.
    @MainActor
    private static func openProject(_ source: String) async throws -> EditProject {
        try await ProjectStore.open(path: source).1
    }

    private static func writePNG(_ image: CGImage, to url: URL, what: String) throws {
        guard let png = NSBitmapImageRep(cgImage: image).representation(using: .png, properties: [:]) else {
            throw NSError(domain: "recorder", code: 70, userInfo: [NSLocalizedDescriptionKey: "\(what) could not be encoded"])
        }
        try png.write(to: url)
    }
}
