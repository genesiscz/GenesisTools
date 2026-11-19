import AppKit
import Combine
import SwiftUI

/// What a host does with a recording. The recorder itself is generic: the widget pastes the movie into a session's
/// draft, the Capture shelf stages it, any other host does what it likes.
public struct ScreenRecordingHost {
    /// The name of "stop and keep" in the controls: "Stop and paste", "Stop and save".
    public var useTitle: String
    public var useSymbol: String
    /// Says why the recording asks for Screen Recording, in the permission dialog.
    public var permissionReason: String
    /// Gets the finished movie. The file is the host's from here on; a throw is reported through `onError`.
    public var onUse: (URL) async throws -> Void
    public var onDiscard: () -> Void
    /// A recording that could not start or failed, or a use that threw.
    public var onError: (String) -> Void
    /// Capture is starting. The host can step aside before the first movie frame.
    public var onStart: () -> Void

    public init(useTitle: String, useSymbol: String = "stop.fill", permissionReason: String,
                onUse: @escaping (URL) async throws -> Void, onDiscard: @escaping () -> Void = {},
                onError: @escaping (String) -> Void, onStart: @escaping () -> Void = {}) {
        self.useTitle = useTitle
        self.useSymbol = useSymbol
        self.permissionReason = permissionReason
        self.onUse = onUse
        self.onDiscard = onDiscard
        self.onError = onError
        self.onStart = onStart
    }
}

/// Refresh the existing picker in place, including while an area selector has hidden its window.
@MainActor
private final class WidgetTargetInventory: ObservableObject {
    @Published var load: RecordingTargetPicker.Load = .loading
    var initial: RecordingTarget?
}

@MainActor
private struct WidgetPickerContent: View {
    @ObservedObject var inventory: WidgetTargetInventory
    let content: (RecordingTargetPicker.Load, RecordingTarget?) -> RecordingTargetPicker

    var body: some View { content(inventory.load, inventory.initial) }
}

/// A widget recording belongs to its opening host until that host has received the finished movie.
@MainActor
public final class ScreenRecorder: ObservableObject {
    static let entryTitle = "Record the screen…"
    static let entryDetail = "Choose what to record, then press Record (up to 10 min)"
    @Published public private(set) var isActive = false
    @Published private(set) var phase: RecordingBarPhase?
    public let settings: RecordingSettings

    private let makeController: @MainActor () -> RecordingSessionController
    private let defaults: UserDefaults
    private let forSnapshot: Bool
    private let permissionGate: @MainActor (PermissionNeed) async -> Bool
    private let loadTargets: @MainActor () async throws -> RecordingTargets
    private static weak var running: ScreenRecorder?

    private var host: ScreenRecordingHost?
    private var bar: RecordingBarModel?
    private var controls: RecordingBarPanel?
    private lazy var picker: RecordingPickerPanel = {
        let panel = RecordingPickerPanel()
        if forSnapshot {
            panel.window.alphaValue = 0
            panel.window.ignoresMouseEvents = true
        }
        return panel
    }()
    private var overlays: RecordingPickerOverlays?
    private var outline: RecordingTargetOutline?
    private var outlinedTarget: RecordingTarget?
    private var targets: RecordingTargets?
    private let inventory = WidgetTargetInventory()
    private var preferredPid: Int32?
    private var widgetRate: Int?
    private var usesCustomSettings = false
    private var started = false
    private var delivering = false
    private var opening: Task<Void, Never>?
    private var reading: Task<Void, Never>?
    private var waitingForPause: Task<Void, Never>?
    private var observers = Set<AnyCancellable>()

    public convenience init(bridge: ToolsBridge, settings: RecordingSettings? = nil,
                            permissionGate: (@MainActor (PermissionNeed) async -> Bool)? = nil) {
        self.init(settings: settings ?? .shared, defaults: .standard,
                  permissionGate: permissionGate ?? { await PermissionCenter.shared.ensure($0) },
                  makeController: { RecordingSessionController(bridge: bridge) }, loadTargets: {
            // Long enough for the one compile after an update (about 30 s, more on a busy Mac); the compile goes on
            // without this call if it is cut, and the recording then reuses its binary.
            let result = try await bridge.run(subcommand: "control", args: ["capture", "targets", "--json"],
                                              timeoutSeconds: 120)
            guard result.exitCode == 0 else {
                throw ToolsBridgeError.refused(String(result.stderr.suffix(600)))
            }
            return try JSONDecoder().decode(RecordingTargets.self, from: Data(result.stdout.utf8))
        })
        usesCustomSettings = settings.map { $0 !== RecordingSettings.shared } ?? false
    }

    init(settings: RecordingSettings, defaults: UserDefaults, forSnapshot: Bool = false,
         permissionGate: @escaping @MainActor (PermissionNeed) async -> Bool,
         makeController: @escaping @MainActor () -> RecordingSessionController,
         loadTargets: @escaping @MainActor () async throws -> RecordingTargets) {
        self.settings = settings
        self.defaults = defaults
        self.forSnapshot = forSnapshot
        self.permissionGate = permissionGate
        self.makeController = makeController
        self.loadTargets = loadTargets
    }

    public func begin(host: ScreenRecordingHost, anchor: CGPoint? = nil, preferredPid: Int32? = nil) {
        if let running = Self.running, running.isActive {
            running.showControls()
            if running !== self { host.onError("A screen recording is already open. Use its controls to end it.") }
            return
        }
        Self.running = self
        self.host = host
        self.preferredPid = preferredPid ?? NSWorkspace.shared.frontmostApplication.flatMap {
            $0.processIdentifier == ProcessInfo.processInfo.processIdentifier ? nil : $0.processIdentifier
        }
        phase = .setup
        isActive = true
        let need = PermissionNeed(.screenRecording, reason: host.permissionReason, grantWorksInNewProcess: true)
        opening = Task { [weak self, permissionGate] in
            let granted = await permissionGate(need)
            guard let self, !Task.isCancelled else { return }
            opening = nil
            guard granted else { finish(); return }
            presentSetup(host: host, anchor: anchor)
        }
    }

    private func presentSetup(host: ScreenRecordingHost, anchor: CGPoint?) {
        var setup = RecordingSetup.load(defaults)
        let storedRate = usesCustomSettings ? settings.frameRate : defaults.integer(forKey: RecordingSettings.Key.frameRate)
        widgetRate = RecordingSettings.frameRates.contains(storedRate) ? storedRate : settings.frameRate
        if let widgetRate {
            if setup.stillFrameRate == Double(setup.frameRate) { setup.stillFrameRate = 0 }
            setup.frameRate = widgetRate
        }
        let engine = WidgetSessionEngine(makeController: makeController, showsBorder: { [settings] in settings.showsBorder })
        let bar = RecordingBarModel(engine: engine, setup: setup, defaults: defaults,
                                    countdownTick: { try? await Task.sleep(for: .seconds(1)) })
        self.bar = bar
        let overlays = RecordingPickerOverlays()
        let outline = RecordingTargetOutline()
        self.overlays = overlays
        self.outline = outline
        bar.excludeWindowIDs = overlays.windowIDs + outline.windowIDs + [picker.window.windowNumber]
        let actions = RecordingBarActions(chooseTarget: { [weak self] kind in self?.requestPicker(kind) },
                                          useTitle: host.useTitle, useMovie: { [weak self] url in self?.use(url) },
                                          hide: { [weak self] in self?.didHide() })
        let controls = RecordingBarPanel(model: bar, actions: actions, defaults: defaults) { [weak self] target in
            guard let rects = self?.rects(target), let first = rects.first else { return nil }
            return rects.dropFirst().reduce(first) { $0.union($1) }
        }
        self.controls = controls
        if forSnapshot {
            controls.window.alphaValue = 0
            controls.window.ignoresMouseEvents = true
        }
        for window in [controls.window as NSWindow, picker.window as NSWindow] {
            NotificationCenter.default.publisher(for: NSWindow.didResizeNotification, object: window)
                .sink { [weak self] _ in self?.positionPicker() }.store(in: &observers)
        }
        bar.$phase.removeDuplicates().dropFirst().sink { [weak self] phase in
            self?.didChange(phase)
        }.store(in: &observers)
        settings.$showsBorder.removeDuplicates().dropFirst().sink { [weak self] enabled in
            self?.updateOutline(enabled: enabled)
        }.store(in: &observers)
        controls.show()
        if let anchor, let screen = NSScreen.screens.first(where: { $0.frame.contains(anchor) }) {
            let frame = RecordingPanelLayout.picker(size: controls.window.frame.size, anchor: anchor, visible: screen.visibleFrame)
            controls.window.setFrameOrigin(frame.origin)
        }
        openPicker(nil)
    }

    public func stopAndUse() {
        switch phase {
        case .recording, .paused: bar?.stop()
        default: break
        }
    }

    public func discard() {
        if phase == .setup { finish() }
        else { bar?.discard() }
    }

    public func showControls() {
        if case .done = phase { return } // The host is copying the file.
        controls?.show()
        if picker.isVisible, !forSnapshot { picker.window.makeKeyAndOrderFront(nil) }
    }

    /// The widget driver uses the same selection callback as a picker row.
    @discardableResult
    public func choose(_ pick: (RecordingTargets) -> RecordingTarget?) -> Bool {
        guard picker.isVisible, case let .loaded(targets) = inventory.load, let target = pick(targets),
              bar?.capabilities.targets.contains(target.kind) == true else { return false }
        chose(target)
        return true
    }

    public var stateDescription: String {
        let name: String
        switch phase {
        case nil: name = "idle"
        case .setup: name = "setup"
        case .countdown: name = "countdown"
        case .starting: name = "starting"
        case .recording: name = "recording"
        case .paused: name = "paused"
        case .finishing: name = "finishing"
        case .done: name = "done"
        case .failed: name = "failed"
        }
        return "phase=\(name) picker=\(picker.isVisible) target=\(bar?.setup.target?.title ?? "-") preparing=\(bar?.notice?.message ?? "-") "
            + "outline=\(outlinedTarget?.title ?? "-") elapsedMs=\(Int(bar?.elapsedMs ?? 0))"
    }

    // MARK: Picker

    private func requestPicker(_ kind: RecordingTargetKind?) {
        guard let bar, waitingForPause == nil else { return }
        if picker.window.parent != nil {
            if kind == .area && picker.isVisible { selectArea() }
            else { showControls() }
            return
        }
        switch bar.phase {
        case .setup, .paused: openPicker(kind)
        case let .recording(take):
            // RecordingBarView already requested the picker pause. A pipe write alone does not stop capture.
            let command = bar.pendingCommand
            waitingForPause = Task { [weak self, weak bar] in
                await command?.value
                guard let self, !Task.isCancelled else { return }
                waitingForPause = nil
                if case let .paused(current, _) = bar?.phase, current == take { openPicker(kind) }
            }
        default: break
        }
    }

    private func openPicker(_ kind: RecordingTargetKind?) {
        presentPicker(kind)
        refreshTargets()
        if kind == .area { selectArea() }
    }

    private func selectArea() {
        guard let overlays else { return }
        AreaSelector.begin(overlays: overlays, parent: picker.window) { [weak self] target in
            if let target { self?.chose(target) }
        }
    }

    private func refreshTargets() {
        reading?.cancel()
        reading = Task { [weak self, loadTargets] in
            let next: RecordingTargetPicker.Load
            do { next = .loaded(try await loadTargets().excluding(pids: [ProcessInfo.processInfo.processIdentifier])) }
            catch { next = .failed("Could not list what to record: \(error.localizedDescription)") }
            guard let self, !Task.isCancelled else { return }
            reading = nil
            if case let .loaded(loaded) = next {
                targets = loaded
                inventory.initial = loaded.defaultTarget(preferredPid: preferredPid)
            }
            if next != inventory.load { inventory.load = next }
        }
    }

    private func presentPicker(_ kind: RecordingTargetKind?) {
        guard let bar, let controls, let overlays, let host else { return }
        let configuring = bar.phase == .setup
        let accessory = configuring ? AnyView(VStack(alignment: .leading, spacing: 3) {
            Label("Silent video · \(host.useTitle) when finished", systemImage: host.useSymbol)
            if let widgetRate { Text("Widget frame rate override · \(widgetRate) fps") }
        }.font(.caption).foregroundStyle(.secondary)) : nil
        let view = WidgetPickerContent(inventory: inventory) { [weak self] load, initial in
            RecordingTargetPicker(load: load, title: configuring ? "Choose what to record" : "Switch to",
                                  initial: bar.setup.target ?? initial, onChoose: { [weak self] in self?.chose($0) },
                                  onCancel: { [weak self] in self?.cancelPicker() },
                                  onRetry: { [weak self] in self?.refreshTargets() }, restoring: kind == .area ? (.area, "") : nil,
                                  accessory: accessory, footerHint: "↑ ↓ to browse · Return chooses · Esc cancels · \(RecordingPickerKey.tabLabels) tabs",
                                  capabilities: bar.capabilities, overlays: overlays)
        }
        picker.closesOnFocusLoss = defaults.string(forKey: "recorder.picker.focusLoss") == "close"
        let frame = controls.window.frame
        picker.present(view, near: CGPoint(x: frame.midX, y: frame.minY), focus: !forSnapshot) { [weak self] in self?.cancelPicker() }
        if picker.window.parent !== controls.window { controls.window.addChildWindow(picker.window, ordered: .above) }
        positionPicker()
    }

    private func positionPicker() {
        guard let parent = picker.window.parent, picker.isVisible, let visible = parent.screen?.visibleFrame else { return }
        let size = picker.window.frame.size
        let bottom = visible.minY + size.height + 4
        if parent.frame.minY < bottom {
            parent.setFrameOrigin(CGPoint(x: parent.frame.minX, y: min(visible.maxY - parent.frame.height, bottom)))
        }
        let x = min(parent.frame.midX - size.width / 2, visible.maxX - size.width)
        picker.window.setFrameOrigin(CGPoint(x: max(visible.minX, x), y: max(visible.minY, parent.frame.minY - size.height - 4)))
    }

    private func chose(_ target: RecordingTarget) {
        guard picker.window.parent != nil else { return }
        detachPicker(keepChoicePulse: true)
        bar?.endTargetSelection(target)
    }

    private func cancelPicker() {
        let wasPicking = picker.window.parent != nil || waitingForPause != nil
        detachPicker()
        if wasPicking { bar?.endTargetSelection(nil) }
    }

    private func detachPicker(keepChoicePulse: Bool = false) {
        waitingForPause?.cancel()
        waitingForPause = nil
        reading?.cancel()
        reading = nil
        picker.window.parent?.removeChildWindow(picker.window)
        picker.dismiss()
        picker.window.contentView = nil
        overlays?.dismiss(keepingChoice: keepChoicePulse)
    }

    // MARK: Take and host

    private func didChange(_ next: RecordingBarPhase) {
        let previous = phase
        phase = next
        updateOutline(enabled: settings.showsBorder)
        switch next {
        case .countdown, .starting, .finishing:
            if picker.window.parent != nil || waitingForPause != nil { detachPicker() }
            if case .starting = next, !started {
                started = true
                host?.onStart()
            }
        case .setup:
            if case .countdown = previous { break }
            let onDiscard = host?.onDiscard
            finish()
            onDiscard?()
        case let .done(url):
            if let url { use(url) } else { fail("The recorder stopped without returning a movie.") }
        case let .failed(message): fail(message)
        default: break
        }
    }

    private func rects(_ target: RecordingTarget) -> [CGRect] {
        RecordingPickerGeometry.rects(target, windows: targets?.windows ?? [], screens: NSScreen.screens.map(\.frame),
                                      displayIDs: RecordingTarget.connectedDisplayIDs)
    }

    private func updateOutline(enabled: Bool) {
        let wanted: RecordingTarget?
        if case .starting = phase, enabled { wanted = bar?.setup.target } else { wanted = nil }
        guard wanted != outlinedTarget else { return }
        outlinedTarget = wanted
        if let wanted { outline?.show(rects(wanted)) } else { outline?.hide() }
    }

    private func didHide() {
        if phase == .setup { finish() } else { cancelPicker() }
    }

    private func use(_ url: URL) {
        guard let host, phase == .done(url), !delivering else { return }
        delivering = true
        detachPicker()
        controls?.window.orderOut(nil)
        Task { [weak self] in
            do { try await host.onUse(url) }
            catch { host.onError("The recording is saved at \(url.path), but it could not be used: \(error.localizedDescription)") }
            self?.finish()
        }
    }

    private func fail(_ message: String) {
        let host = self.host
        finish()
        guard let host else { return }
        if WidgetCaptureError.isScreenRecordingDenied(message: message) {
            let need = PermissionNeed(.screenRecording, reason: host.permissionReason, grantWorksInNewProcess: true)
            Task { [permissionGate] in if await permissionGate(need) { host.onError(message) } }
        } else {
            host.onError(message)
        }
    }

    private func finish() {
        opening?.cancel()
        opening = nil
        observers.removeAll()
        detachPicker()
        controls?.window.close()
        controls = nil
        outline?.close()
        outline = nil
        overlays = nil
        outlinedTarget = nil
        bar = nil
        host = nil
        targets = nil
        inventory.initial = nil
        inventory.load = .loading
        started = false
        delivering = false
        phase = nil
        isActive = false
        if Self.running === self { Self.running = nil }
    }
}
