import AVFoundation
import AppKit
import SwiftUI

// GenesisTools --recorder [--edit <movie | recording folder | edit.json>] [--background]
//   The recorder part: a menu bar item (record, recent recordings, open an edit), the live recordings' item and
//   floating controls, and the editor windows. One per login session: a later launch hands its request to the
//   running one and exits.
// GenesisTools --recorder --export <edit.json | movie> [--out <file>] [--json]
//   Renders an edit headlessly with the editor's own renderer, prints the result, exits.
// GenesisTools --recorder --edit <path> --snapshot <png> [--width <pt>] [--height <pt>] [--at <seconds>] [--tab zoom|clip|audio|export] [--select-zoom <n>|--select-clip <n>]
//   Draws the editor off screen into a PNG and exits (verification without a screen).

private let recorderInstance = SingleInstance(
    name: "recorder",
    lockFile: NativePreview.hubFile("recorder.lock"),
    notificationPrefix: NativePreview.namespace + ".recorder",
    retryHint: "quit the recorder from its menu bar item, then try again.",
    log: { HubPerf.log($0) }
)

struct RecorderRequest {
    var edit: String?
    var export: String?
    var out: String?
    var json = false
    /// `--no-focus`: the editor opens behind the front window and the app is not activated (tests, agents).
    var focus = true
    var snapshot: String?
    var width: CGFloat = 1440
    var height: CGFloat = 920
    var atSeconds: Double?
    var tab: InspectorTab?
    var selectZoom: Int?
    var selectClip: Int?
    /// `--library`: the recordings library window (with `--snapshot`, a picture of it).
    var library = false
    /// `--still <edit> --at <s> --out <png>`: one frame of the edit, printed as JSON.
    var still: String?

    static func parse(_ args: [String]) -> RecorderRequest {
        var request = RecorderRequest()
        var index = 0
        func value() -> String? {
            guard index + 1 < args.count else { return nil }
            index += 1
            return args[index]
        }
        while index < args.count {
            switch args[index] {
            case "--edit": request.edit = value().map(absolute)
            case "--export": request.export = value().map(absolute)
            case "--out": request.out = value().map(absolute)
            case "--json": request.json = true
            case "--no-focus", "--no-activate": request.focus = false
            case "--snapshot": request.snapshot = value().map(absolute)
            case "--width": request.width = value().flatMap(Double.init).map { CGFloat($0) } ?? request.width
            case "--height": request.height = value().flatMap(Double.init).map { CGFloat($0) } ?? request.height
            case "--at": request.atSeconds = value().flatMap(Double.init)
            case "--tab": request.tab = value().flatMap(InspectorTab.init(rawValue:))
            case "--select-zoom": request.selectZoom = value().flatMap(Int.init)
            case "--select-clip": request.selectClip = value().flatMap(Int.init)
            case "--library": request.library = true
            case "--still": request.still = value().map(absolute)
            default: break
            }
            index += 1
        }
        return request
    }

    private static func absolute(_ path: String) -> String {
        URL(fileURLWithPath: (path as NSString).expandingTildeInPath).standardizedFileURL.path
    }
}

package func runRecorder(_ args: [String]) -> Never {
    let request = RecorderRequest.parse(args)
    if let export = request.export {
        runHeadlessExport(source: export, out: request.out, json: request.json)
    }
    if let still = request.still {
        runHeadlessStill(source: still, atSeconds: request.atSeconds ?? 0, out: request.out)
    }
    if let snapshot = request.snapshot {
        runSnapshot(request, to: snapshot)
    }
    HubPerf.log("recorder: launch edit=\(request.edit ?? "-")")
    if !recorderInstance.claim() {
        exit(recorderInstance.forward(args) ? 0 : 1)
    }
    MainActor.assumeIsolated {
        let app = NSApplication.shared
        app.setActivationPolicy(.accessory)
        HangWatch.start()
        recorderInstance.serve { forwarded in
            let next = RecorderRequest.parse(forwarded)
            MainActor.assumeIsolated {
                if let edit = next.edit { EditorWindows.shared.open(path: edit, focus: next.focus) }
                if next.library { LibraryWindow.shared.show(focus: next.focus) }
            }
        }
        RecorderMenu.shared.install()
        // The live recordings' item and floating controls; the hub defers to this face while it runs.
        LiveRecordingsStatusItem.shared.start(preferred: true)
        if let edit = request.edit { EditorWindows.shared.open(path: edit, focus: request.focus) }
        if request.library { LibraryWindow.shared.show(focus: request.focus) }
        app.run()
    }
    exit(0)
}

// MARK: - Windows

@MainActor
final class EditorWindows: NSObject, NSWindowDelegate {
    static let shared = EditorWindows()
    private var open: [ObjectIdentifier: (NSWindow, EditorModel, Any?)] = [:]

    func open(path: String, focus wanted: Bool = true) {
        if let existing = open.values.first(where: { $0.1.store.url.deletingLastPathComponent().path == URL(fileURLWithPath: path).deletingLastPathComponent().path || $0.1.project.source.video == path }) {
            if wanted { focus(existing.0) }
            return
        }
        Task {
            do {
                let span = HubPerf.begin("recorder.editor.open", path)
                let (store, project) = try await ProjectStore.open(path: path)
                span.end()
                show(EditorModel(project: project, store: store), focus: wanted)
            } catch {
                HubPerf.log("recorder.editor: \(path) did not open: \(error.localizedDescription)")
                let alert = NSAlert()
                alert.messageText = "The recording did not open"
                alert.informativeText = error.localizedDescription
                NSApp.activate(ignoringOtherApps: true)
                alert.runModal()
            }
        }
    }

    private func show(_ model: EditorModel, focus wanted: Bool) {
        let window = Self.makeWindow(model: model, size: NSSize(width: 1440, height: 920))
        window.delegate = self
        let monitor = EditorKeys.install(model: model, window: window)
        open[ObjectIdentifier(window)] = (window, model, monitor)
        if wanted {
            NSApp.setActivationPolicy(.regular)
            focus(window)
        } else {
            window.orderBack(nil)
        }
        HubPerf.log("recorder.editor: opened \(model.title) (\(Plural.count(model.project.clips.count, "clip")), \(Plural.count(model.project.zooms.count, "zoom")))")
    }

    private func focus(_ window: NSWindow) {
        NSApp.activate(ignoringOtherApps: true)
        window.makeKeyAndOrderFront(nil)
    }

    static func makeWindow(model: EditorModel, size: NSSize) -> NSWindow {
        let window = NSWindow(contentRect: NSRect(origin: .zero, size: size),
                              styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
        window.title = model.title
        window.minSize = NSSize(width: 980, height: 640)
        window.appearance = NSAppearance(named: .darkAqua)
        window.backgroundColor = NSColor(white: 0.105, alpha: 1)
        window.isReleasedWhenClosed = false
        window.contentView = NSHostingView(rootView: EditorView(model: model))
        let accessory = NSTitlebarAccessoryViewController()
        accessory.layoutAttribute = .trailing
        accessory.view = NSHostingView(rootView: TitlebarExport(model: model))
        accessory.view.frame.size = NSSize(width: 190, height: 28)
        window.addTitlebarAccessoryViewController(accessory)
        window.setFrameAutosaveName("GenesisToolsRecorderEditor")
        window.center()
        return window
    }

    func windowWillClose(_ notification: Notification) {
        guard let window = notification.object as? NSWindow, let entry = open[ObjectIdentifier(window)] else { return }
        entry.1.close()
        if let monitor = entry.2 { NSEvent.removeMonitor(monitor) }
        open[ObjectIdentifier(window)] = nil
        if open.isEmpty { NSApp.setActivationPolicy(.accessory) }
    }
}

/// The title bar's right side: "Edited" while a change is unsaved, and the Export button.
private struct TitlebarExport: View {
    @Bindable var model: EditorModel

    var body: some View {
        HStack(spacing: 10) {
            if model.edited {
                Text("Edited").font(.system(size: 12)).foregroundStyle(.secondary)
            }
            if let progress = model.exportProgress {
                ProgressView(value: progress).frame(width: 80)
            } else {
                Button("Export") {
                    model.tab = .export
                    model.export()
                }
                .buttonStyle(.genPrimary())
                .accessibilityIdentifier("recorder.titlebar.export")
            }
        }
        .padding(.trailing, 10)
        .frame(height: 28)
    }
}

/// The editor's keys, for the key window only and never while a text field edits.
enum EditorKeys {
    @MainActor
    static func install(model: EditorModel, window: NSWindow) -> Any? {
        NSEvent.addLocalMonitorForEvents(matching: .keyDown) { event in
            guard event.window === window, !(window.firstResponder is NSText) else { return event }
            let command = event.modifierFlags.contains(.command)
            let shift = event.modifierFlags.contains(.shift)
            switch (event.charactersIgnoringModifiers?.lowercased() ?? "", command) {
            case (" ", false): model.togglePlay()
            case ("s", false): model.splitAtPlayhead()
            case ("z", false): model.addZoom()
            case ("z", true): shift ? model.redo() : model.undo()
            case ("s", true): model.saveNow()
            case ("e", true): model.tab = .export; model.export()
            default:
                switch event.keyCode {
                case 51, 117: model.deleteSelection()
                case 123: model.step(frames: shift ? -60 : -1)
                case 124: model.step(frames: shift ? 60 : 1)
                case 115: model.seek(0)
                case 119: model.seek(model.durationUs)
                case 53: model.selection = .none
                default: return event
                }
            }
            return nil
        }
    }
}

// MARK: - Headless export and snapshot

/// One JSON object and a newline; a path or a message with quotes in it stays valid JSON.
private func jsonLine(_ object: [String: Any]) -> String {
    guard let data = try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys, .withoutEscapingSlashes]),
          let text = String(data: data, encoding: .utf8) else { return "{\"ok\":false,\"error\":\"unencodable answer\"}\n" }
    return text + "\n"
}

/// `--still <edit> --at <seconds> --out <png>`: one frame of the edited movie as it exports (zoom, clicks, frame
/// style), for an agent to look at without a window.
private func runHeadlessStill(source: String, atSeconds: Double, out: String?) -> Never {
    MainActor.assumeIsolated {
        _ = NSApplication.shared
        NSApp.setActivationPolicy(.prohibited)
        Task {
            do {
                let (_, project) = try await ProjectStore.open(path: source)
                let zoom = ZoomState(project: project, cursor: CursorTrack.load(project.source.cursor))
                let at = Int64((atSeconds * 1_000_000).rounded())
                let image = try await stillFrame(project: project, atOutput: at, zoom: zoom)
                let url = URL(fileURLWithPath: out ?? NSTemporaryDirectory() + "recorder-still-\(UUID().uuidString.prefix(8)).png")
                let rep = NSBitmapImageRep(cgImage: image)
                guard let png = rep.representation(using: .png, properties: [:]) else {
                    throw NSError(domain: "recorder", code: 70, userInfo: [NSLocalizedDescriptionKey: "the frame could not be encoded"])
                }
                try png.write(to: url)
                FileHandle.standardOutput.write(Data(jsonLine(["ok": true, "path": url.path, "width": image.width, "height": image.height,
                                                               "atSeconds": atSeconds]).utf8))
                exit(0)
            } catch {
                FileHandle.standardOutput.write(Data(jsonLine(["ok": false, "error": error.localizedDescription]).utf8))
                exit(1)
            }
        }
        NSApp.run()
    }
    exit(0)
}

private func runHeadlessExport(source: String, out: String?, json: Bool) -> Never {
    MainActor.assumeIsolated {
        _ = NSApplication.shared
        NSApp.setActivationPolicy(.prohibited)
        Task {
            do {
                var (_, project) = try await ProjectStore.open(path: source)
                if let out { project.export.output = out }
                let url = EditExporter.outputURL(for: project)
                var lastTenth = -1
                let result = try await EditExporter.export(project: project, to: url) { progress in
                    let tenth = Int(progress * 10)
                    if tenth != lastTenth, !json {
                        lastTenth = tenth
                        FileHandle.standardError.write(Data("export \(tenth * 10)%\n".utf8))
                    }
                }
                let line = json
                    ? jsonLine(["ok": true, "path": result.url.path, "bytes": result.bytes, "seconds": (result.seconds * 100).rounded() / 100])
                    : "\(result.url.path) (\(ByteFormat.file(result.bytes)), \(String(format: "%.1f", result.seconds)) s)\n"
                FileHandle.standardOutput.write(Data(line.utf8))
                exit(0)
            } catch {
                let message = error.localizedDescription
                FileHandle.standardOutput.write(Data((json ? jsonLine(["ok": false, "error": message]) : "error: \(message)\n").utf8))
                exit(1)
            }
        }
        NSApp.run()
    }
    exit(0)
}

@MainActor
private func snapshotLibrary(_ request: RecorderRequest, to path: String) async throws {
    let model = LibraryModel()
    model.load()
    for _ in 0..<100 where !model.loaded {
        try await Task.sleep(for: .milliseconds(100))
    }
    let window = LibraryWindow.makeWindow(model: model, size: NSSize(width: request.width, height: request.height))
    window.orderInForSnapshot()
    try await Task.sleep(for: .milliseconds(600))
    guard let capture = await WindowSnapshot.capture(window),
          let png = capture.image.representation(using: .png, properties: [:]) else {
        throw NSError(domain: "recorder", code: 70, userInfo: [NSLocalizedDescriptionKey: "the window could not be drawn"])
    }
    try png.write(to: URL(fileURLWithPath: path))
    FileHandle.standardError.write(Data("recorder snapshot: \(path) by \(capture.method) (\(model.items.count) recordings)\n".utf8))
}

private func runSnapshot(_ request: RecorderRequest, to path: String) -> Never {
    MainActor.assumeIsolated {
        _ = NSApplication.shared
        NSApp.setActivationPolicy(.prohibited)
        Task {
            do {
                if request.library {
                    try await snapshotLibrary(request, to: path)
                    exit(0)
                }
                guard let edit = request.edit else { throw NSError(domain: "recorder", code: 64, userInfo: [NSLocalizedDescriptionKey: "--snapshot needs --edit <path> or --library"]) }
                let (store, project) = try await ProjectStore.open(path: edit)
                let model = EditorModel(project: project, store: store)
                if let tab = request.tab { model.tab = tab }
                if let n = request.selectZoom, project.zooms.indices.contains(n) { model.selection = .zoom(project.zooms[n].id); model.tab = .zoom }
                if let n = request.selectClip, project.clips.indices.contains(n) { model.selection = .clip(project.clips[n].id); model.tab = .clip }
                let at = Int64(((request.atSeconds ?? 0) * 1_000_000).rounded())
                // The filmstrip and the waveform load in the background; give them up to 8 s.
                for _ in 0..<80 where model.filmstrip.tiles.isEmpty {
                    try await Task.sleep(for: .milliseconds(100))
                }
                try await Task.sleep(for: .milliseconds(300))
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
                model.close()
                FileHandle.standardError.write(Data("recorder snapshot: \(path) by \(capture.method)\n".utf8))
                exit(0)
            } catch {
                FileHandle.standardError.write(Data("recorder snapshot failed: \(error.localizedDescription)\n".utf8))
                exit(1)
            }
        }
        NSApp.run()
    }
    exit(0)
}

/// One frame of the edit as the export draws it, for the snapshot's preview.
@MainActor
func stillFrame(project: EditProject, atOutput outUs: Int64, zoom: ZoomState) async throws -> CGImage {
    let asset = AVURLAsset(url: URL(fileURLWithPath: project.source.video))
    let rendered = try await EditRenderer.render(project: project, asset: asset, zoom: zoom, maxHeight: 1080)
    let generator = AVAssetImageGenerator(asset: rendered.composition)
    generator.videoComposition = rendered.videoComposition
    generator.requestedTimeToleranceBefore = .zero
    generator.requestedTimeToleranceAfter = .zero
    return try await generator.image(at: EditRenderer.us(min(outUs, max(0, project.outputDurationUs - 20_000)))).image
}
