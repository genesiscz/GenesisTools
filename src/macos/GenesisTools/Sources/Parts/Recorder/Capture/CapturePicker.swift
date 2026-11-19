import AppKit
import Combine
import SwiftUI

/// What the capture picker does when another app or window takes the keyboard. Settings → Recorder → Recording.
enum CapturePickerFocusLoss: String, CaseIterable, Identifiable {
    /// It stays until its close control, Escape, a choice or the menu bar's start: agents' apps took the focus and
    /// closed it under the person (2026-11-09).
    case stayOpen
    /// It closes as a cancel, the way it did before.
    case close

    static let key = "recorder.picker.focusLoss"

    var id: String { rawValue }

    var closesPicker: Bool { self == .close }

    static func load(_ defaults: UserDefaults = .standard) -> CapturePickerFocusLoss {
        defaults.string(forKey: key).flatMap(Self.init(rawValue:)) ?? .stayOpen
    }
}

/// The full recorder's host for the shared bar. The picker is a child panel that can close independently.
@MainActor
final class CapturePicker {
    static var shared = CapturePicker()
    private let engine: ToolsRecorderEngine
    private let defaults: UserDefaults
    private let listTargets: () async throws -> RecordingTargets
    private(set) var bar: RecordingBarModel?
    private(set) var controls: RecordingBarPanel?
    private let picker = RecordingPickerPanel()
    private var overlays: RecordingPickerOverlays?
    private var load: RecordingTargetPicker.Load = .loading
    private var filter: (tab: RecordingPickerTab, query: String)?
    private var read: Task<Void, Never>?
    private var observers = Set<AnyCancellable>()
    private var focus = true
    private var onHide: (() -> Void)?
    private let preview: (Bool) -> Void
    /// Whether this setup may start the camera preview by itself (see `show`).
    private var previewsCamera = true

    init(engine: ToolsRecorderEngine? = nil, defaults: UserDefaults = .standard,
         preview: ((Bool) -> Void)? = nil, listTargets: (() async throws -> RecordingTargets)? = nil) {
        self.engine = engine ?? ToolsRecorderEngine()
        self.defaults = defaults
        self.preview = preview ?? { CameraBubble.shared.optionChanged($0) }
        self.listTargets = listTargets ?? {
            let result = try await ToolsBridge(binaryPath: ToolsBridge.defaultBinaryPath())
                .run(subcommand: "control", args: ["capture", "targets", "--json"], timeoutSeconds: 120)
            guard result.exitCode == 0 else { throw ToolsBridgeError.refused(String(result.stderr.suffix(600))) }
            return try JSONDecoder().decode(RecordingTargets.self, from: Data(result.stdout.utf8))
                .excluding(pids: [ProcessInfo.processInfo.processIdentifier])
        }
    }

    var isVisible: Bool { controls?.window.isVisible == true }

    /// The menu, window.show and the picker shortcut all open setup. Record is the only start action in this flow.
    /// A launch or forwarded window intent passes `previewCamera: false`: it can open setup before a person touches
    /// it, so the camera starts only when a later show comes from a person.
    func show(focus: Bool = true, preset: CaptureOptions? = nil, previewCamera: Bool = true) {
        self.focus = focus
        if isVisible {
            if previewCamera, !previewsCamera {
                previewsCamera = true
                if let bar, bar.phase == .setup { preview(bar.setup.camera.enabled) }
            }
        } else {
            previewsCamera = previewCamera
        }
        if let bar, bar.phase != .setup, !isFinished {
            controls?.show(focus: focus)
            return
        }
        if controls == nil || preset != nil || isFinished { configure(setup: draft(preset: preset)) }
        controls?.show(focus: false)
        openPicker(nil)
    }

    /// The explicit Start shortcut keeps its direct route through the very same model and adapter.
    func choose(_ choice: CaptureChoice, options: CaptureOptions = .load()) {
        guard bar == nil || bar?.phase == .setup || isFinished else { controls?.show(); return }
        var setup = draft(preset: options)
        switch choice {
        case let .target(target): setup.target = target
        case .followPointer: setup.target = .followDisplay
        case let .area(rect):
            let screens = NSScreen.screens.map(\.frame)
            guard let primary = screens.first else { return }
            let cocoa = CaptureChoice.coreGraphicsRect(cocoa: rect, primaryHeight: primary.maxY)
            let ids = CaptureChoice.screenIDs
            guard let index = screens.firstIndex(where: { $0.contains(cocoa) }),
                  ids.indices.contains(index), let id = ids[index] else { return }
            setup.target = .area(rect: cocoa.offsetBy(dx: -screens[index].minX, dy: -screens[index].minY),
                                 display: index, displayID: id)
        }
        configure(setup: setup)
        controls?.show()
        bar?.record()
    }

    private var isFinished: Bool {
        switch bar?.phase { case .done, .failed: true; default: false }
    }

    private func draft(preset: CaptureOptions?) -> RecordingSetup {
        var setup = RecordingSetup.load(defaults)
        // This recorder's start with no target follows the display in use: name it, so the bar says what Record does.
        if setup.target == nil { setup.target = .followDisplay }
        if let preset {
            setup.microphone.enabled = preset.microphone
            setup.systemAudio.enabled = preset.systemAudio
        }
        return setup
    }

    private func configure(setup: RecordingSetup) {
        detachPicker()
        controls?.window.orderOut(nil)
        observers.removeAll()
        let bar = self.bar ?? RecordingBarModel(engine: engine, setup: setup)
        bar.resetSetup(setup)
        self.bar = bar
        let options = CaptureOptions.load(defaults)
        engine.threshold = options.threshold
        engine.shortcuts = options.shortcutsOverlay
        let overlays = RecordingPickerOverlays()
        self.overlays = overlays
        bar.excludeWindowIDs = overlays.windowIDs + [picker.window.windowNumber]
        var actions = RecordingBarActions(chooseTarget: { [weak self] kind in self?.openPicker(kind) },
                                         useMovie: { folder in
            if FileManager.default.fileExists(atPath: folder.appendingPathComponent("screen.mp4").path) {
                EditorWindows.shared.open(path: folder.path)
            } else {
                try ToolsRunner.detached(["recorder", "edit", folder.path]) { status, output in
                    RecorderNotice.failure("Could not open the recording (exit \(status)).", output: output)
                }
            }
        }, hide: { [weak self] in self?.didHide() })
        actions.followsDisplayInUse = true
        actions.followedDisplay = Binding(get: { [weak engine] in engine?.followedDisplay }, set: { _ in })
        actions.changeThreshold = Binding(get: { [weak engine] in engine?.threshold ?? 0.5 },
                                         set: { [weak engine] in engine?.threshold = $0 })
        actions.addMarker = { [weak engine] in
            guard let engine else { return }
            try await engine.addMarker()
        }
        let controls = RecordingBarPanel(model: bar, actions: actions, defaults: defaults) { [weak self] target in
            self?.bounds(of: target)
        }
        self.controls = controls
        let menu = NSMenu()
        menu.addItem(ClosureMenuItem("Recorder Settings and Shortcuts…") {
            FeatureSettingsLaunch.open(pageID: RecorderSettingsPlugin.recordingPageID)
        })
        if onHide != nil {
            menu.addItem(ClosureMenuItem("Use Compact Controls for Recordings Started Elsewhere") { [weak self] in
                self?.defaults.set(false, forKey: LiveRecordingBarPresentation.foreignPreference)
                self?.dismiss()
            })
        }
        controls.window.contentView?.menu = menu
        for window in [controls.window as NSWindow, picker.window as NSWindow] {
            NotificationCenter.default.publisher(for: NSWindow.didResizeNotification, object: window)
                .sink { [weak self] _ in self?.attachPicker() }.store(in: &observers)
        }
        bar.$phase.removeDuplicates().dropFirst().sink { [weak self] phase in
            guard let self else { return }
            switch phase {
            case .countdown, .starting:
                detachPicker(keepingChoice: true)
            case .finishing, .failed, .done:
                detachPicker()
            case .setup:
                if controls.window.isVisible {
                    Task { @MainActor [weak self] in
                        if self?.bar?.phase == .setup { self?.openPicker(nil) }
                    }
                }
            default: break
            }
        }.store(in: &observers)
        if onHide == nil {
            bar.$setup.map(\.camera.enabled).removeDuplicates().sink { [weak self, weak bar, preview] enabled in
                if bar?.phase == .setup, self?.previewsCamera == true { preview(enabled) }
            }.store(in: &observers)
        }
    }

    private func bounds(of target: RecordingTarget) -> CGRect? {
        let screens = NSScreen.screens
        if target.kind == .area {
            return target.areaBounds(screens: screens.map(\.frame), displayIDs: CaptureChoice.screenIDs)
        }
        guard case let .loaded(targets) = load, let primary = screens.first else { return nil }
        let windows: [RecordingWindow]
        switch target {
        case let .window(ids, _, _, _): windows = targets.windows.filter { ids.contains($0.id) }
        case let .app(app, _): windows = targets.windows.filter { String($0.pid) == app || $0.app == app }
        default: return nil
        }
        return windows.reduce(nil as CGRect?) { union, window in
            let b = window.bounds
            let rect = CGRect(x: b.x, y: primary.frame.maxY - b.y - b.height, width: b.width, height: b.height)
            return union?.union(rect) ?? rect
        }
    }

    private func openPicker(_ kind: RecordingTargetKind?) {
        guard bar != nil else { return }
        if kind == .area { filter = (.area, filter?.query ?? "") }
        present()
        if kind == .area, let overlays {
            AreaSelector.begin(overlays: overlays, parent: picker.window) { [weak self] target in
                guard let self, let target else { return }
                bar?.endTargetSelection(target)
                detachPicker()
                if defaults.bool(forKey: "recorder.picker.choiceStarts"), bar?.phase == .setup { bar?.record() }
            }
        }
        if read == nil { refresh() }
    }

    private func refresh() {
        read?.cancel()
        read = Task { [weak self] in
            guard let self else { return }
            let next: RecordingTargetPicker.Load
            do { next = .loaded(try await listTargets()) }
            catch { next = .failed("Could not list what to record: \(error.localizedDescription)") }
            guard !Task.isCancelled else { return }
            let changed = next != load
            load = next
            read = nil
            if changed, picker.isVisible { present() }
        }
    }

    private func present() {
        guard let bar, let overlays, let controls else { return }
        picker.closesOnFocusLoss = CapturePickerFocusLoss.load(defaults).closesPicker
        let chosen = { [weak self] in self?.detachPicker(keepingChoice: true) }
        let cancel = { [weak self] in self?.cancelPicker() }
        let retry = { [weak self] in self?.refresh() }
        let filtered: (RecordingPickerTab, String) -> Void = { [weak self] tab, query in self?.filter = (tab, query) }
        let view: RecordingTargetPicker
        if bar.phase == .setup {
            view = RecordingTargetPicker(load: load, bar: bar, overlays: overlays,
                                         onChoose: { chosen() }, onCancel: { cancel() }, onRetry: { retry() },
                                         restoring: filter, onFilterChange: filtered)
        } else {
            // Send one switch, preserving whether the pause was made by the user or by this picker.
            view = RecordingTargetPicker(load: load, initial: bar.setup.target, onChoose: { target in
                bar.endTargetSelection(target)
                chosen()
            }, onCancel: { cancel() }, onRetry: { retry() }, restoring: filter, onFilterChange: filtered,
            capabilities: bar.capabilities, overlays: overlays)
        }
        let frame = controls.window.frame
        picker.present(view, near: CGPoint(x: frame.midX, y: frame.minY), focus: focus) { cancel() }
        if picker.window.parent !== controls.window { controls.window.addChildWindow(picker.window, ordered: .above) }
        attachPicker()
    }

    private func attachPicker() {
        guard let parent = picker.window.parent, picker.isVisible, let visible = parent.screen?.visibleFrame else { return }
        let size = picker.window.frame.size
        let bottom = visible.minY + size.height + 4
        if parent.frame.minY < bottom {
            parent.setFrameOrigin(CGPoint(x: parent.frame.minX, y: min(visible.maxY - parent.frame.height, bottom)))
        }
        let frame = parent.frame
        picker.window.setFrameOrigin(CGPoint(x: max(visible.minX, min(frame.midX - size.width / 2, visible.maxX - size.width)),
                                             y: max(visible.minY, frame.minY - size.height - 4)))
    }

    private func detachPicker(keepingChoice: Bool = false) {
        picker.window.parent?.removeChildWindow(picker.window)
        picker.dismiss()
        picker.window.contentView = nil
        overlays?.dismiss(keepingChoice: keepingChoice)
        read?.cancel()
        read = nil
    }

    private func cancelPicker() {
        bar?.endTargetSelection(nil)
        detachPicker()
    }

    private func didHide() {
        cancelPicker()
        if bar?.phase == .setup || isFinished {
            if onHide == nil { preview(false) }
            observers.removeAll()
            controls = nil
            overlays = nil
            filter = nil
            load = .loading
        }
        onHide?()
    }

    func dismiss() { controls?.hide() }

    func preferencesChanged() {
        picker.closesOnFocusLoss = CapturePickerFocusLoss.load(defaults).closesPicker
    }

    /// Resolve a request from the watcher's Show Controls action, even if the original bar was hidden.
    static func presentation(for entry: LiveRecording, hide: @escaping () -> Void) -> LiveRecordingBarPresentation? {
        if shared.engine.liveID == entry.id {
            return LiveRecordingBarPresentation(show: { done in
                shared.controls?.show()
                done(shared.isVisible)
            }, update: { _ in }, close: {})
        }
        guard UserDefaults.standard.bool(forKey: LiveRecordingBarPresentation.foreignPreference),
              entry.canControl, entry.socket != nil, entry.controls.contains("settings.get") else { return nil }
        let engine = ToolsRecorderEngine(adopting: entry)
        let host = CapturePicker(engine: engine)
        host.onHide = hide
        var opening: Task<Void, Never>?
        var openingID: UUID?
        return LiveRecordingBarPresentation(show: { done in
            if let controls = host.controls { controls.show(); done(host.isVisible); return }
            guard opening == nil else { return }
            let id = UUID()
            openingID = id
            opening = Task {
                defer {
                    if openingID == id {
                        opening = nil
                        openingID = nil
                    }
                }
                do {
                    let setup = try await engine.adoptedSetup()
                    guard openingID == id, !Task.isCancelled else { return }
                    host.configure(setup: setup)
                    host.bar?.record() // The adapter attaches to the existing ID; no process is launched.
                    host.controls?.show()
                    done(host.isVisible)
                } catch {
                    guard openingID == id, !Task.isCancelled else { return }
                    RecorderNotice.failure("Could not open this recording's controls.", more: error.localizedDescription)
                    done(false)
                }
            }
        }, update: { engine.observe($0) }, close: {
            openingID = nil
            opening?.cancel()
            opening = nil
            host.detachPicker()
            host.controls?.window.orderOut(nil)
        })
    }

    /// What a start runs, and whether it leaves the camera preview out of the movie: one answer for both, from the
    /// preview's windows on screen at the start (`CameraBubble.windowIDs`). The preview may show while it records only
    /// when `previewLeftOut`. `panels` are other windows the movie leaves out (the countdown's).
    nonisolated static func startPlan(choice: CaptureChoice, options: CaptureOptions, previewWindowIDs: [Int],
                                      panels: [Int] = []) -> (arguments: [String], previewLeftOut: Bool) {
        let preview = options.camera ? previewWindowIDs.filter { $0 > 0 } : []
        let exclude = preview + panels.filter { $0 > 0 }
        return (options.startArguments(choice, excludeWindowIds: exclude), !preview.isEmpty)
    }

    static func snapshot(to path: String, shortcutsOpen: Bool, request: RecorderRequest = RecorderRequest()) async throws {
        let fixture = try RecorderBarSnapshot(request: request, shortcutsOpen: shortcutsOpen)
        let view = await fixture.view()
        let sized = request.hasSnapshotDimensions || request.barState != nil
        let hosting = NSHostingView(rootView: view.fixedSize()
            .frame(width: sized ? request.width : nil, height: sized ? request.height : nil)
            .preferredColorScheme(.dark))
        hosting.layoutSubtreeIfNeeded()
        let size = sized ? CGSize(width: request.width, height: request.height) : hosting.fittingSize
        let window = NSWindow(contentRect: CGRect(origin: .zero, size: size), styleMask: [.borderless],
                              backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.backgroundColor = NSColor(white: 0.16, alpha: 1)
        window.contentView = hosting
        window.orderInForSnapshot()
        try await Task.sleep(for: .milliseconds(600))
        guard let capture = await WindowSnapshot.capture(window),
              let png = capture.image.representation(using: .png, properties: [:]) else {
            throw NSError(domain: "recorder", code: 70, userInfo: [NSLocalizedDescriptionKey: "the picker could not be drawn"])
        }
        try png.write(to: URL(fileURLWithPath: path))
        FileHandle.standardError.write(Data("recorder snapshot: \(path) by \(capture.method) (\(Int(size.width))×\(Int(size.height)) pt)\n".utf8))
    }

}

enum CaptureCountdown {
    static func hasFirstFrame(_ recording: LiveRecording) -> Bool {
        recording.frames > 0 || recording.lastFrameAt != nil
    }

    static func firstFrameIn(_ recordings: [LiveRecording], since: Date) -> Bool {
        recordings.contains { $0.startedAt >= since.addingTimeInterval(-1) && hasFirstFrame($0) }
    }
}

@MainActor
final class CountdownModel: ObservableObject {
    @Published var remaining = 3
    /// The recorder runs: Escape no longer cancels.
    @Published var starting = false

    /// The last second is over: the number shows 0 until the movie's first frame ends the countdown.
    func lastSecondEnded() {
        remaining = 0
    }

    /// What VoiceOver reads: the seconds left, or that the recording is starting once the count reached 0.
    var spoken: String {
        remaining > 0 ? "Recording starts in \(Plural.count(remaining, "second"))" : "The recording is starting"
    }
}
