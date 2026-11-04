import AVFoundation
import AppKit
import SwiftUI

// GenesisTools --recorder [--edit <movie | recording folder | edit.json>] [--background]
//   The recorder part: a menu bar item (record, recent recordings, open an edit), the live recordings' item and
//   floating controls, and the editor windows. One per login session: a later launch hands its request to the
//   running one and exits.
// GenesisTools --recorder --export <edit.json | movie> [--out <file>] [--json]
//   Renders an edit headlessly with the editor's own renderer, prints the result, exits.
// GenesisTools --recorder --edit <path> --snapshot <png> [--width <pt>] [--height <pt>] [--at <seconds>] [--tab zoom|clip|hide|style|audio|export] [--select-zoom <n>|--select-clip <n>] [--part <from>-<to>]
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
    /// `--part 1.5-4`: the export part's marks in output seconds, as I and O would set them.
    var part: (from: Double, to: Double)?
    /// `--library`: the recordings library window (with `--snapshot`, a picture of it).
    var library = false
    /// `--still <edit> --at <s> --out <png>`: one frame of the edit, printed as JSON.
    var still: String?
    /// `--sheet <edit> --times <s,s,…> --out <png>`: those frames of the edit on one picture, each with its time.
    var sheet: String?
    var times: [Double] = []

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
            case "--part":
                let ends = (value() ?? "").split(separator: "-").compactMap { Double($0) }
                if ends.count == 2 { request.part = (ends[0], ends[1]) }
            case "--library": request.library = true
            case "--still": request.still = value().map(absolute)
            case "--sheet": request.sheet = value().map(absolute)
            case "--times": request.times = (value() ?? "").split(separator: ",").compactMap { Double($0) }
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
    if let sheet = request.sheet {
        runHeadlessSheet(source: sheet, times: request.times, out: request.out)
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
                if let edit = next.edit { EditorWindows.shared.open(path: edit, focus: next.focus, atSeconds: next.atSeconds, tab: next.tab) }
                if next.library { LibraryWindow.shared.show(focus: next.focus) }
            }
        }
        RecorderMenu.shared.install()
        // The live recordings' item and floating controls; the hub defers to this face while it runs.
        LiveRecordingsStatusItem.shared.start(preferred: true)
        if let edit = request.edit { EditorWindows.shared.open(path: edit, focus: request.focus, atSeconds: request.atSeconds, tab: request.tab) }
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
    /// Where a window that is still opening goes once its model exists.
    private var pendingPlacement: [String: (EditorModel) -> Void] = [:]

    /// Opens (or brings back) the editor of `path`; `atSeconds` (output time) and `tab` place it, so an agent can show
    /// a moment (`movie.show({ at, tab })`, `tools recorder edit --at --tab`).
    func open(path: String, focus wanted: Bool = true, atSeconds: Double? = nil, tab: InspectorTab? = nil) {
        let place = { (model: EditorModel) in
            if let tab { model.tab = tab }
            if let atSeconds { model.seek(Int64((atSeconds * 1_000_000).rounded())) }
        }
        if let existing = open.values.first(where: { $0.1.store.url.deletingLastPathComponent().path == URL(fileURLWithPath: path).deletingLastPathComponent().path || $0.1.project.source.video == path }) {
            place(existing.1)
            if wanted { focus(existing.0) }
            return
        }
        pendingPlacement[path] = place
        Task {
            do {
                let span = HubPerf.begin("recorder.editor.open", path)
                let (store, project) = try await ProjectStore.open(path: path)
                span.end()
                let model = EditorModel(project: project, store: store)
                show(model, focus: wanted)
                // The player item lands in the background; seek after it, as the snapshot face does.
                if let place = pendingPlacement.removeValue(forKey: path) {
                    try? await Task.sleep(for: .milliseconds(400))
                    place(model)
                }
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

    /// The model of the editor in front (the key window, else the main one), for the menu bar's commands.
    func frontModel() -> EditorModel? {
        for window in [NSApp.keyWindow, NSApp.mainWindow].compactMap({ $0 }) {
            if let entry = open[ObjectIdentifier(window)] { return entry.1 }
        }
        return nil
    }

    private func show(_ model: EditorModel, focus wanted: Bool) {
        EditorMenu.install()
        let window = Self.makeWindow(model: model, size: NSSize(width: 1440, height: 920))
        Self.rememberFrame(window)
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
        window.representedURL = URL(fileURLWithPath: model.project.source.video)
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
        window.center()
        return window
    }

    /// The live window keeps the size the user left it at; a snapshot keeps the size it asked for.
    static func rememberFrame(_ window: NSWindow) {
        window.setFrameAutosaveName("GenesisToolsRecorderEditor")
    }

    func windowWillClose(_ notification: Notification) {
        guard let window = notification.object as? NSWindow, let entry = open[ObjectIdentifier(window)] else { return }
        entry.1.close()
        if let monitor = entry.2 { NSEvent.removeMonitor(monitor) }
        open[ObjectIdentifier(window)] = nil
        if open.isEmpty { NSApp.setActivationPolicy(.accessory) }
    }
}

/// The title bar's right side: "Edited" while a change is unsaved, and the Export button, which opens a summary of
/// what the export writes (format, size, part, file) with the one Export action, so nothing starts unchecked.
private struct TitlebarExport: View {
    @Bindable var model: EditorModel
    @State private var summary = false

    var body: some View {
        HStack(spacing: 10) {
            if let progress = model.exportProgress {
                ProgressView(value: progress).frame(width: 80)
            } else {
                Button("Export") { summary = true }
                    .buttonStyle(.genPrimary())
                    .instantTooltip("Export (⌘E)")
                    .accessibilityIdentifier("recorder.titlebar.export")
                    .popover(isPresented: $summary, arrowEdge: .bottom) {
                        ExportSummary(model: model) { summary = false }
                    }
            }
        }
        .padding(.trailing, 10)
        .frame(height: 28)
        .background(DocumentEditedMark(edited: model.edited))
    }
}

private struct ExportSummary: View {
    @Bindable var model: EditorModel
    let close: () -> Void

    var body: some View {
        let settings = model.project.export
        let format = settings.format ?? .mp4
        let source = CGSize(width: model.project.source.width, height: model.project.source.height)
        let size = EditRenderer.outputSizes(source: source, maxHeight: settings.maxHeight, aspect: model.project.frame?.aspect,
                                            h264Fps: settings.codec == .h264 ? 60 : nil).canvas
        let part = model.exportPart
        VStack(alignment: .leading, spacing: 8) {
            Text("Export").font(.system(size: 14, weight: .semibold))
            row("Format", format == .mp4 ? "MP4 · \(settings.codec == .h264 ? "H.264" : "HEVC")" : format.rawValue.uppercased())
            if format != .gif { row("Size", "\(Int(size.width)) × \(Int(size.height))") }
            row("Part", part.map { "\(formatClock($0.fromUs, tenths: true)) – \(formatClock($0.toUs, tenths: true))" }
                ?? "Everything (\(formatClock(model.durationUs, tenths: true)))")
            row("File", EditExporter.outputURL(for: model.project, format: format).lastPathComponent)
            HStack {
                Button("Settings…") { model.tab = .export; close() }
                    .buttonStyle(.genHoverPlain())
                Spacer()
                Button("Export") {
                    close()
                    model.tab = .export
                    model.export()
                }
                .buttonStyle(.genPrimary())
                .keyboardShortcut(.defaultAction)
                .accessibilityIdentifier("recorder.summary.export")
            }
            .padding(.top, 4)
        }
        .padding(14)
        .frame(width: 300)
    }

    private func row(_ title: String, _ value: String) -> some View {
        HStack {
            Text(title).foregroundStyle(.secondary)
            Spacer()
            Text(verbatim: value).monospacedDigit()
        }
        .font(.system(size: 12.5))
    }
}

/// Marks the window as edited while a change is unsaved: the close button gets its dot, as in every Mac document.
private struct DocumentEditedMark: NSViewRepresentable {
    let edited: Bool

    func makeNSView(context: Context) -> NSView { NSView() }

    func updateNSView(_ view: NSView, context: Context) {
        DispatchQueue.main.async { view.window?.isDocumentEdited = edited }
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
            case ("[", false): model.trimToPlayhead(.start)
            case ("]", false): model.trimToPlayhead(.end)
            case ("z", false): model.addZoom()
            case ("z", true): shift ? model.redo() : model.undo()
            case ("s", true): model.saveNow()
            case ("e", true): model.tab = .export; model.export()
            case ("j", false), ("k", false), ("l", false):
                model.shuttle(Character(event.charactersIgnoringModifiers?.lowercased() ?? "k"))
            case ("d", true): model.duplicateSelection()
            case ("i", false): model.markIn()
            case ("o", false): model.markOut()
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

/// Frames of the edit as it exports, on one picture in rows of three, each labelled with its output time: one look
/// at a whole edit for an agent. The movie is built once and every frame comes from the same generator.
private func runHeadlessSheet(source: String, times: [Double], out: String?) -> Never {
    MainActor.assumeIsolated {
        _ = NSApplication.shared
        NSApp.setActivationPolicy(.prohibited)
        Task {
            do {
                guard !times.isEmpty else {
                    throw NSError(domain: "recorder", code: 64, userInfo: [NSLocalizedDescriptionKey: "--sheet needs --times with at least one time"])
                }
                let (_, project) = try await ProjectStore.open(path: source)
                let zoom = ZoomState(project: project, cursor: CursorTrack.load(project.source.cursor))
                let frames = try await stillFrames(project: project, atOutput: times.map { Int64(($0 * 1_000_000).rounded()) }, zoom: zoom)
                let sheet = ContactSheet.draw(frames: zip(times, frames).map { ($0, $1) })
                let url = URL(fileURLWithPath: out ?? NSTemporaryDirectory() + "recorder-sheet-\(UUID().uuidString.prefix(8)).png")
                guard let png = NSBitmapImageRep(cgImage: sheet).representation(using: .png, properties: [:]) else {
                    throw NSError(domain: "recorder", code: 70, userInfo: [NSLocalizedDescriptionKey: "the sheet could not be encoded"])
                }
                try png.write(to: url)
                FileHandle.standardOutput.write(Data(jsonLine(["ok": true, "path": url.path, "width": sheet.width, "height": sheet.height,
                                                               "times": times]).utf8))
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

/// A grid of frames, each with its output time on a dark plate in its corner.
enum ContactSheet {
    static let columns = 3
    /// Each tile's width; the height follows the movie's shape.
    static let tileWidth = 640
    static let gap = 8

    static func draw(frames: [(seconds: Double, image: CGImage)]) -> CGImage {
        let first = frames[0].image
        let tileHeight = max(1, Int((Double(tileWidth) * Double(first.height) / Double(max(1, first.width))).rounded()))
        let columns = min(columns, frames.count)
        let rows = (frames.count + columns - 1) / columns
        let width = columns * tileWidth + (columns + 1) * gap
        let height = rows * tileHeight + (rows + 1) * gap
        let context = CGContext(data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0,
                                space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
        context.setFillColor(CGColor(red: 0.08, green: 0.08, blue: 0.09, alpha: 1))
        context.fill(CGRect(x: 0, y: 0, width: width, height: height))
        context.interpolationQuality = .high
        let previous = NSGraphicsContext.current
        NSGraphicsContext.current = NSGraphicsContext(cgContext: context, flipped: false)
        defer { NSGraphicsContext.current = previous }
        for (index, frame) in frames.enumerated() {
            let column = index % columns
            let row = index / columns
            // Core Graphics counts y from the bottom; the first row is the top one.
            let rect = CGRect(x: gap + column * (tileWidth + gap), y: height - (row + 1) * (tileHeight + gap),
                              width: tileWidth, height: tileHeight)
            context.draw(frame.image, in: rect)
            let label = NSAttributedString(string: formatClock(Int64((frame.seconds * 1_000_000).rounded()), tenths: true), attributes: [
                .font: NSFont.monospacedDigitSystemFont(ofSize: 15, weight: .semibold),
                .foregroundColor: NSColor.white,
            ])
            let size = label.size()
            let plate = CGRect(x: rect.minX + 8, y: rect.minY + 8, width: size.width + 14, height: size.height + 6)
            context.setFillColor(CGColor(red: 0, green: 0, blue: 0, alpha: 0.7))
            context.addPath(CGPath(roundedRect: plate, cornerWidth: 5, cornerHeight: 5, transform: nil))
            context.fillPath()
            label.draw(at: CGPoint(x: plate.minX + 7, y: plate.minY + 3))
        }
        return context.makeImage()!
    }
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
                if let part = request.part {
                    model.partInUs = Int64(part.from * 1_000_000)
                    model.partOutUs = Int64(part.to * 1_000_000)
                }
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

/// Several frames of the edit as the export draws them, from one build of the movie.
@MainActor
func stillFrames(project: EditProject, atOutput times: [Int64], zoom: ZoomState) async throws -> [CGImage] {
    let asset = AVURLAsset(url: URL(fileURLWithPath: project.source.video))
    let rendered = try await EditRenderer.render(project: project, asset: asset, zoom: zoom, maxHeight: 1080)
    let generator = AVAssetImageGenerator(asset: rendered.composition)
    generator.videoComposition = rendered.videoComposition
    generator.requestedTimeToleranceBefore = .zero
    generator.requestedTimeToleranceAfter = .zero
    var images: [CGImage] = []
    for outUs in times {
        images.append(try await generator.image(at: EditRenderer.us(min(max(0, outUs), max(0, project.outputDurationUs - 20_000)))).image)
    }
    return images
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
