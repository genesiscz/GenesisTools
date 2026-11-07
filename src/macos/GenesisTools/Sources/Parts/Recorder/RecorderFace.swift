import AVFoundation
import AppKit
import SwiftUI

// GenesisTools --recorder [--edit <movie | recording folder | edit.json>] [--background]
//   The recorder part: a menu bar item (record, recent recordings, open an edit), the live recordings' item and
//   floating controls, and the editor windows. One per login session: a later launch hands its request to the
//   running one and exits.
// GenesisTools --recorder --export <edit.json | movie> [--out <file>] [--json]
//   Renders an edit headlessly with the editor's own renderer, prints the result, exits.
// GenesisTools --recorder --edit <path> --snapshot <png> [--width <pt>] [--height <pt>] [--at <seconds>] [--tab zoom|clip|hide|style|audio|export] [--select-zoom <n>|--select-clip <n>] [--part <from>-<to>] [--range <from>-<to>] [--comment <n>]
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
    /// `--select-marker 0`: the edit's first marker set while editing, selected (as a click on its flag does).
    var selectMarker: Int?
    /// `--part 1.5-4`: the export part's marks in output seconds, as I and O would set them.
    var part: (from: Double, to: Double)?
    /// `--range 1.5-4`: a range on the frames lane in output seconds, as a drag there selects it.
    var range: (from: Double, to: Double)?
    /// `--comment 0`: the first review comment's popover open over the timeline.
    var comment: Int?
    /// `--library`: the recordings library window (with `--snapshot`, a picture of it).
    var library = false
    /// `--filter <text>` with `--library --snapshot`: the search field's text, so a snapshot shows its hits.
    var filter: String?
    /// `--still <edit> --at <s> --out <png>`: one frame of the edit, printed as JSON.
    var still: String?
    /// `--sheet <edit> --times <s,s,…> --out <png>`: those frames of the edit on one picture, each with its time.
    var sheet: String?
    var times: [Double] = []
    /// `--full` with `--still`: the frame at the export's size (a poster), not the 1080 pixel preview.
    var full = false
    /// `--picker`: the capture picker (with `--snapshot`, a picture of it over made-up targets).
    var picker = false
    /// `--shortcuts` with `--picker --snapshot`: the Shortcuts section open.
    var shortcuts = false
    // R5 3 export size
    /// `--size 1280x720` (or `1280x`, `x720`) with `--export`: the picture's exact pixels.
    var exportSize: EditProject.OutputSize?

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
            case "--select-marker": request.selectMarker = value().flatMap(Int.init)
            case "--part":
                let ends = (value() ?? "").split(separator: "-").compactMap { Double($0) }
                if ends.count == 2 { request.part = (ends[0], ends[1]) }
            case "--range":
                let ends = (value() ?? "").split(separator: "-").compactMap { Double($0) }
                if ends.count == 2 { request.range = (ends[0], ends[1]) }
            case "--comment": request.comment = value().flatMap(Int.init)
            case "--library": request.library = true
            case "--filter": request.filter = value()
            case "--still": request.still = value().map(absolute)
            case "--sheet": request.sheet = value().map(absolute)
            case "--full": request.full = true
            case "--picker": request.picker = true
            case "--shortcuts": request.shortcuts = true
            case "--times": request.times = (value() ?? "").split(separator: ",").compactMap { Double($0) }
            // R5 3 export size: "1280x720", "1280x" or "x720".
            case "--size":
                let sides = (value() ?? "").split(separator: "x", omittingEmptySubsequences: false).map { Int($0) }
                if sides.count == 2 { request.exportSize = EditProject.OutputSize(width: sides[0], height: sides[1]) }
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
        runHeadlessExport(source: export, out: request.out, size: request.exportSize, json: request.json)
    }
    if let still = request.still {
        runHeadlessStill(source: still, atSeconds: request.atSeconds ?? 0, out: request.out, full: request.full)
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
                if next.picker { CapturePicker.shared.show() }
            }
        }
        RecorderMenu.shared.install()
        RecorderShortcutActions.install()
        // The live recordings' item and floating controls; the hub defers to this face while it runs.
        LiveRecordingsStatusItem.shared.start(preferred: true)
        RecorderServiceHost.startForFace()
        if let edit = request.edit { EditorWindows.shared.open(path: edit, focus: request.focus, atSeconds: request.atSeconds, tab: request.tab) }
        if request.library { LibraryWindow.shared.show(focus: request.focus) }
        if request.picker { CapturePicker.shared.show() }
        app.run()
    }
    exit(0)
}

// MARK: - Windows

@MainActor
final class EditorWindows: NSObject, NSWindowDelegate {
    static let shared = EditorWindows()
    private var open: [ObjectIdentifier: (NSWindow, EditorModel, Any?)] = [:]
    private var frontWindow: ObjectIdentifier?
    /// Where a window that is still opening goes once its model exists.
    private var pendingPlacement: [String: (EditorModel) -> Void] = [:]

    /// Opens (or brings back) the editor of `path`; `atSeconds` (output time) and `tab` place it, so an agent can show
    /// a moment (`movie.show({ at, tab })`, `tools recorder edit --at --tab`).
    /// `atSourceSeconds` is a moment of the recording itself (a search hit), placed where it plays in the edit.
    /// `opened` gets the window once it exists (or the reason it did not open), before any placement or alert.
    func open(path: String, focus wanted: Bool = true, atSeconds: Double? = nil, atSourceSeconds: Double? = nil, tab: InspectorTab? = nil,
              opened: ((Result<NSWindow, Error>) -> Void)? = nil) {
        let place = { (model: EditorModel) in
            if let tab { model.tab = tab }
            if let atSeconds { model.seek(Int64((atSeconds * 1_000_000).rounded())) }
            if let atSourceSeconds {
                let sourceUs = Int64((atSourceSeconds * 1_000_000).rounded())
                model.seek(TimelineMap.outputTime(ofSource: sourceUs, in: model.project) ?? 0)
            }
        }
        // The same matcher as `close`: the recording's folder, its edit file or its movie bring the open window back.
        if let existing = open.values.first(where: { Self.names($0.1, path) }) {
            place(existing.1)
            if wanted { focus(existing.0) }
            opened?(.success(existing.0))
            return
        }
        pendingPlacement[path] = place
        Task {
            do {
                let span = HubPerf.begin("recorder.editor.open", path)
                let (store, project) = try await ProjectStore.open(path: path)
                span.end()
                let model = EditorModel(project: project, store: store)
                // Not inside `opened?(…)`: with no `opened` (the library's Open in Editor) Swift skips the arguments,
                // so the window was never made.
                let window = show(model, focus: wanted)
                opened?(.success(window))
                // The player item lands in the background; seek after it, as the snapshot face does.
                if let place = pendingPlacement.removeValue(forKey: path) {
                    try? await Task.sleep(for: .milliseconds(400))
                    place(model)
                }
            } catch {
                HubPerf.log("recorder.editor: \(path) did not open: \(error.localizedDescription)")
                opened?(.failure(error))
                RecorderNotice.failure("The recording did not open: \(URL(fileURLWithPath: path).lastPathComponent).",
                                       more: error.localizedDescription)
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

    @discardableResult
    private func show(_ model: EditorModel, focus wanted: Bool) -> NSWindow {
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
        writeOpenState(front: wanted ? window : nil)
        return window
    }

    /// Closes the editor `path` names (`names`) or window number `window`, as its close button does, and answers the
    /// window's number; nil when no editor shows it. A window that must not close now (`closeRefusal`) is refused with
    /// `windowBusy`, never closed half-way: no alert, no dropped drag, no stopped export.
    func close(path: String?, window number: Int?) throws -> Int? {
        let entry = open.values.first { entry in
            if let number { return entry.0.windowNumber == number }
            return path.map { Self.names(entry.1, $0) } ?? false
        }
        guard let (window, model, _) = entry else { return nil }
        if let refusal = Self.closeRefusal(of: model) {
            throw LiveRecordingRPCClient.Failure.remote(code: RecorderServiceHost.Code.windowBusy, message: refusal)
        }
        let closed = window.windowNumber
        HubPerf.log("recorder.editor: closing \(model.title) for window.close")
        window.close()
        return closed
    }

    /// Why the editor of `model` must not close now, or nil: a drag whose last step is not saved yet, an export running.
    static func closeRefusal(of model: EditorModel) -> String? {
        if model.gesture != nil {
            return "the editor window of \(model.title) has a drag that is not saved yet; let it finish, then close it"
        }
        if model.canCancelExport {
            return "the editor window of \(model.title) is exporting the movie; closing it would stop the export"
        }
        return nil
    }

    /// Whether `path` names the editor of `model`: its recording folder, its edit file or its movie.
    static func names(_ model: EditorModel, _ path: String) -> Bool {
        let given = URL(fileURLWithPath: path).standardizedFileURL.path
        let edit = model.store.url.standardizedFileURL
        return given == edit.deletingLastPathComponent().path || given == edit.path
            || given == URL(fileURLWithPath: model.project.source.video).standardizedFileURL.path
    }

    /// `{ front?, open: [{ path, title, window }] }`: the editor's windows, `window` being each one's window number
    /// (what `window.open` answers). The recorder host's `window.list` and `window.changed` carry it as is.
    func openState() -> [String: Any] {
        func row(_ entry: (NSWindow, EditorModel, Any?)) -> [String: Any] {
            ["path": entry.1.store.url.deletingLastPathComponent().path, "title": entry.1.title, "window": entry.0.windowNumber]
        }
        var state: [String: Any] = ["open": open.values.map(row)]
        if let id = frontWindow, let entry = open[id] { state["front"] = row(entry) }
        return state
    }

    /// `recordings/editor-open.json`: which recordings the editor shows and which one is in front, so the CLI and the
    /// REPL can act on "the open one" (`tools recorder … open`, `tools recorder opened --wait`). Rewritten when a
    /// window opens, comes to the front or closes, and sent to the recorder service as `window.changed`; the file
    /// stays the answer while no service runs. `front` keeps the last window that was in front while it is open;
    /// `pid` lets a reader drop the file of a process that is gone (a crash, a rebuild's reap).
    private func writeOpenState(front window: NSWindow?) {
        if let window, open[ObjectIdentifier(window)] != nil { frontWindow = ObjectIdentifier(window) }
        if let id = frontWindow, open[id] == nil { frontWindow = nil }
        let shown = openState()
        RecorderServiceHost.shared?.notify("window.changed", params: shown)
        var state = shown
        state["version"] = 1
        state["pid"] = Int(ProcessInfo.processInfo.processIdentifier)
        state["updatedAt"] = Self.stamp.string(from: Date())
        let url = RecorderMenu.libraryFolder.deletingLastPathComponent().appendingPathComponent("editor-open.json")
        do {
            let data = try JSONSerialization.data(withJSONObject: state, options: [.prettyPrinted, .sortedKeys])
            try data.write(to: url, options: .atomic)
        } catch {
            HubPerf.log("recorder.editor: could not write \(url.path): \(error.localizedDescription)")
        }
    }

    private static let stamp: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }()

    func windowDidBecomeKey(_ notification: Notification) {
        guard let window = notification.object as? NSWindow, open[ObjectIdentifier(window)] != nil else { return }
        writeOpenState(front: window)
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

    /// Closing during an export asks first; Keep Exporting is the default, Stop and Close cancels it.
    func windowShouldClose(_ window: NSWindow) -> Bool {
        guard let model = open[ObjectIdentifier(window)]?.1, model.canCancelExport else { return true }
        let alert = NSAlert()
        alert.messageText = "Stop the export?"
        alert.informativeText = "The movie is still being exported. If you close the window now, the export stops and no file is written."
        alert.addButton(withTitle: "Keep Exporting")
        alert.addButton(withTitle: "Stop and Close")
        guard alert.runModal() == .alertSecondButtonReturn else { return false }
        model.cancelExport()
        return true
    }

    func windowWillClose(_ notification: Notification) {
        guard let window = notification.object as? NSWindow, let entry = open[ObjectIdentifier(window)] else { return }
        entry.1.close()
        if let monitor = entry.2 { NSEvent.removeMonitor(monitor) }
        open[ObjectIdentifier(window)] = nil
        writeOpenState(front: nil)
        if open.isEmpty { RecorderActivation.windowClosed(window) }
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
            row("Format", format == .mp4 ? "MP4 · \(settings.codec == .h264 ? "H.264" : "HEVC")" : format.title)
            if format != .gif { row("Size", "\(Int(size.width)) × \(Int(size.height))") }
            row("Part", part.map { formatClockRange($0.fromUs, $0.toUs) }
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

/// The editor's keys, for the key window only and never while a text field edits. A key runs the command the menu bar
/// lists for it (`EditorMenu`'s tables), so the key does what its menu item says; the monitor runs before the menu.
@MainActor
enum EditorKeys {
    /// Every command with a key, in the menu bar's order.
    static let keyed: [EditorCommand] = (EditorMenu.file + EditorMenu.edit + EditorMenu.timeline + EditorMenu.tabs).filter { !$0.key.isEmpty }

    /// The command a key press runs, or nil to let the key through. `key` is the event's characters without modifiers;
    /// with Single-Key Shortcuts off, a key with no modifier (S, Z, Space) runs nothing.
    static func command(key: String, modifiers: NSEvent.ModifierFlags, singleKeys: Bool) -> EditorCommand? {
        let pressed = modifiers.intersection([.command, .option, .shift, .control])
        // ⌫ types DEL and ⌦ a function key; the menu names both by backspace.
        let typed = key == "\u{7f}" || key == String(UnicodeScalar(NSDeleteFunctionKey)!) ? "\u{8}" : key.lowercased()
        guard let command = keyed.first(where: { $0.key == typed && $0.modifiers == pressed }) else { return nil }
        if !singleKeys, EditorMenuTarget.isSingleKey(command) { return nil }
        return command
    }

    static func install(model: EditorModel, window: NSWindow) -> Any? {
        NSEvent.addLocalMonitorForEvents(matching: .keyDown) { event in
            guard event.window === window, !(window.firstResponder is NSText),
                  let command = command(key: event.charactersIgnoringModifiers ?? "", modifiers: event.modifierFlags,
                                        singleKeys: EditorMenuTarget.singleKeysOn) else { return event }
            command.run(model)
            return nil
        }
    }
}

/// An error with what AVFoundation hides under "The operation could not be completed": the failure reason, the
/// domain and code, and each underlying error, so a log or an agent can tell a codec refusal from a missing file.
func explained(_ error: Error) -> String {
    var parts: [String] = []
    var next: NSError? = error as NSError
    while let current = next, parts.count < 4 {
        var line = current.localizedDescription
        if let reason = current.localizedFailureReason, !line.contains(reason) { line += " (\(reason))" }
        line += " [\(current.domain) \(current.code)]"
        parts.append(line)
        next = current.userInfo[NSUnderlyingErrorKey] as? NSError
    }
    return parts.joined(separator: "; because: ")
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
private func runHeadlessStill(source: String, atSeconds: Double, out: String?, full: Bool) -> Never {
    runHeadlessJSON { try await RecorderRenders.still(source: source, atSeconds: atSeconds, out: out, full: full) }
}

/// Frames of the edit as it exports, on one picture in rows of three, each labelled with its output time: one look
/// at a whole edit for an agent. The movie is built once and every frame comes from the same generator.
private func runHeadlessSheet(source: String, times: [Double], out: String?) -> Never {
    runHeadlessJSON { try await RecorderRenders.sheet(source: source, times: times, out: out) }
}

/// Runs one render with no window, prints its answer (or `{ ok: false, error }`) as one JSON line, and exits.
private func runHeadlessJSON(_ render: @escaping () async throws -> [String: Any]) -> Never {
    MainActor.assumeIsolated {
        _ = NSApplication.shared
        NSApp.setActivationPolicy(.prohibited)
        Task {
            do {
                FileHandle.standardOutput.write(Data(jsonLine(try await render()).utf8))
                exit(0)
            } catch {
                FileHandle.standardOutput.write(Data(jsonLine(["ok": false, "error": explained(error)]).utf8))
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
        // Core Text, not AppKit string drawing, so a sheet draws on any thread (the host renders it off the main one).
        let font = NSFont.monospacedDigitSystemFont(ofSize: 15, weight: .semibold) as CTFont
        for (index, frame) in frames.enumerated() {
            let column = index % columns
            let row = index / columns
            // Core Graphics counts y from the bottom; the first row is the top one.
            let rect = CGRect(x: gap + column * (tileWidth + gap), y: height - (row + 1) * (tileHeight + gap),
                              width: tileWidth, height: tileHeight)
            context.draw(frame.image, in: rect)
            let text = NSAttributedString(string: formatClock(Int64((frame.seconds * 1_000_000).rounded()), tenths: true), attributes: [
                NSAttributedString.Key(kCTFontAttributeName as String): font,
                NSAttributedString.Key(kCTForegroundColorAttributeName as String): CGColor(gray: 1, alpha: 1),
            ])
            let line = CTLineCreateWithAttributedString(text)
            var ascent: CGFloat = 0, descent: CGFloat = 0, leading: CGFloat = 0
            let width = CGFloat(CTLineGetTypographicBounds(line, &ascent, &descent, &leading))
            let plate = CGRect(x: rect.minX + 8, y: rect.minY + 8, width: width + 14, height: ascent + descent + leading + 6)
            context.setFillColor(CGColor(red: 0, green: 0, blue: 0, alpha: 0.7))
            context.addPath(CGPath(roundedRect: plate, cornerWidth: 5, cornerHeight: 5, transform: nil))
            context.fillPath()
            context.textPosition = CGPoint(x: plate.minX + 7, y: plate.minY + 3 + descent + leading)
            CTLineDraw(line, context)
        }
        return context.makeImage()!
    }
}

private func runHeadlessExport(source: String, out: String?, size: EditProject.OutputSize?, json: Bool) -> Never {
    MainActor.assumeIsolated {
        _ = NSApplication.shared
        NSApp.setActivationPolicy(.prohibited)
        Task {
            do {
                var lastTenth = -1
                let result = try await RecorderRenders.export(source: source, out: out, size: size) { progress in
                    let tenth = Int(progress * 10)
                    if tenth != lastTenth, !json {
                        lastTenth = tenth
                        FileHandle.standardError.write(Data("export \(tenth * 10)%\n".utf8))
                    }
                }
                let line = json
                    ? jsonLine(RecorderRenders.exportAnswer(result))
                    : "\(result.url.path) (\(ByteFormat.file(result.bytes)), \(String(format: "%.1f", result.seconds)) s)\n"
                FileHandle.standardOutput.write(Data(line.utf8))
                exit(0)
            } catch {
                let message = explained(error)
                HubPerf.log("recorder.export failed: \(message)")
                FileHandle.standardOutput.write(Data((json ? jsonLine(["ok": false, "error": message]) : "error: \(message)\n").utf8))
                exit(1)
            }
        }
        NSApp.run()
    }
    exit(0)
}

private func runSnapshot(_ request: RecorderRequest, to path: String) -> Never {
    MainActor.assumeIsolated {
        _ = NSApplication.shared
        NSApp.setActivationPolicy(.prohibited)
        Task {
            do {
                let method = try await RecorderRenders.snapshot(request, to: path)
                // The picker's own snapshot prints its line.
                if !request.picker { FileHandle.standardError.write(Data("recorder snapshot: \(path) by \(method)\n".utf8)) }
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

/// Several frames of the edit as the export draws them, from one build of the movie. Nonisolated: the build and the
/// decode run off the main actor (`RecorderRenders`).
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

/// One frame of the edit as the export draws it, for the snapshot's preview. Nonisolated, as `stillFrames`.
func stillFrame(project: EditProject, atOutput outUs: Int64, zoom: ZoomState, maxHeight: Int = 1080) async throws -> CGImage {
    let asset = AVURLAsset(url: URL(fileURLWithPath: project.source.video))
    let rendered = try await EditRenderer.render(project: project, asset: asset, zoom: zoom, maxHeight: maxHeight)
    let generator = AVAssetImageGenerator(asset: rendered.composition)
    generator.videoComposition = rendered.videoComposition
    generator.requestedTimeToleranceBefore = .zero
    generator.requestedTimeToleranceAfter = .zero
    return try await generator.image(at: EditRenderer.us(min(outUs, max(0, project.outputDurationUs - 20_000)))).image
}
