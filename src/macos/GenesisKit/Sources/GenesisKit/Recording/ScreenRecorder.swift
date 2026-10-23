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
    /// The recording has started (the picker closed and the controls are up): a host can step aside here.
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

/// The whole screen recording flow for one host: the target picker, the Screen Recording grant, the session in
/// `tools control capture session`, the floating controls, switching target (the recording pauses while the picker is
/// open, so the movie never shows it) and the end. One recording runs at a time across every recorder in the process;
/// `begin` while another runs brings that one's controls forward.
@MainActor
public final class ScreenRecorder: ObservableObject {
    /// True from the picker's first appearance until the recording ended.
    @Published public private(set) var isActive = false

    public let settings: RecordingSettings
    private let bridge: ToolsBridge
    private let permissionGate: @MainActor (PermissionNeed) async -> Bool
    private let loadTargets: @MainActor () async throws -> RecordingTargets
    private var host: ScreenRecordingHost?
    private var controller: RecordingSessionController?
    private var controllerWatch: AnyCancellable?
    private var settingsWatch: AnyCancellable?
    private var controls: RecordingControlsPanel?
    private var controlsModel: RecordingControlsModel?
    private let picker = RecordingPickerPanel()
    private var targets: RecordingTargets?
    private var pickerLoad: RecordingTargetPicker.Load = .loading
    private var pickerInitial: RecordingTarget?
    private var pickerTitle = "Choose what to record"
    private var pickerChoose: ((RecordingTarget) -> Void)?
    private var pickerCancel: (() -> Void)?
    private var pickerAnchor = CGPoint.zero

    private static weak var running: ScreenRecorder?

    public init(bridge: ToolsBridge, settings: RecordingSettings? = nil,
                permissionGate: (@MainActor (PermissionNeed) async -> Bool)? = nil) {
        self.bridge = bridge
        self.settings = settings ?? .shared
        self.permissionGate = permissionGate ?? { await PermissionCenter.shared.ensure($0) }
        loadTargets = {
            let result = try await bridge.run(subcommand: "control", args: ["capture", "targets", "--json"],
                                              timeoutSeconds: 20)
            guard result.exitCode == 0 else {
                throw ToolsBridgeError.refused(String(result.stderr.suffix(600)))
            }
            return try JSONDecoder().decode(RecordingTargets.self, from: Data(result.stdout.utf8))
        }
    }

    /// Opens the picker near `anchor` (a Cocoa screen point; the pointer when nil), starting on the front window of
    /// `preferredPid` (the app the person was in), then records what they choose.
    public func begin(host: ScreenRecordingHost, anchor: CGPoint? = nil, preferredPid: Int32? = nil) {
        if let running = Self.running, running.isActive {
            running.controls?.show()
            if running !== self { host.onError("A screen recording is already running. Use its controls to end it.") }
            return
        }
        Self.running = self
        self.host = host
        isActive = true
        let preferred = preferredPid ?? NSWorkspace.shared.frontmostApplication.flatMap { app in
            app.processIdentifier == ProcessInfo.processInfo.processIdentifier ? nil : app.processIdentifier
        }
        openPicker(title: "Choose what to record", anchor: anchor ?? NSEvent.mouseLocation, preferredPid: preferred,
                   choose: { [weak self] target in self?.start(target) },
                   cancel: { [weak self] in self?.finish() })
    }

    /// Stops and hands the movie to the host, as the controls' use button does.
    public func stopAndUse() { controller?.stop() }

    public func discard() { controller?.discard() }

    /// Brings the controls of a running recording forward.
    public func showControls() { controls?.show() }

    // MARK: Picker

    private func openPicker(title: String, anchor: CGPoint, preferredPid: Int32?,
                            choose: @escaping (RecordingTarget) -> Void, cancel: @escaping () -> Void) {
        pickerTitle = title
        pickerAnchor = anchor
        pickerChoose = choose
        pickerCancel = cancel
        pickerLoad = targets.map { .loaded($0) } ?? .loading
        pickerInitial = controller?.target ?? targets?.defaultTarget(preferredPid: preferredPid)
        presentPicker()
        Task { [weak self] in await self?.refreshTargets(preferredPid: preferredPid) }
    }

    private func refreshTargets(preferredPid: Int32?) async {
        do {
            let own = ProcessInfo.processInfo.processIdentifier
            let loaded = try await loadTargets().excluding(pids: [own])
            targets = loaded
            pickerLoad = .loaded(loaded)
            if controller?.target == nil { pickerInitial = loaded.defaultTarget(preferredPid: preferredPid) }
        } catch {
            PerfLog.mark("recording.targets failed \(error.localizedDescription)")
            pickerLoad = .failed("Could not list what to record: \(error.localizedDescription)")
        }
        guard picker.isVisible else { return }
        presentPicker()
    }

    private func presentPicker() {
        let view = RecordingTargetPicker(
            load: pickerLoad, title: pickerTitle, initial: pickerInitial,
            onChoose: { [weak self] target in
                guard let self else { return }
                self.picker.dismiss()
                self.pickerChoose?(target)
            },
            onCancel: { [weak self] in
                guard let self else { return }
                self.picker.dismiss()
                self.pickerCancel?()
            },
            onRetry: { [weak self] in
                guard let self else { return }
                self.pickerLoad = .loading
                self.presentPicker()
                Task { await self.refreshTargets(preferredPid: nil) }
            })
        picker.present(view, near: pickerAnchor) { [weak self] in self?.pickerCancel?() }
    }

    // MARK: Session

    private func start(_ target: RecordingTarget) {
        guard let host else { return }
        Task { [weak self] in
            guard let self else { return }
            let need = PermissionNeed(.screenRecording, reason: host.permissionReason, grantWorksInNewProcess: true)
            guard await self.permissionGate(need) else {
                self.finish()
                return
            }
            self.record(target)
        }
    }

    private func record(_ target: RecordingTarget) {
        guard let host else { return }
        let controller = RecordingSessionController(bridge: bridge)
        let controls = RecordingControlsPanel()
        self.controller = controller
        self.controls = controls
        controller.onDone = { [weak self] url, _ in self?.use(url) }
        controller.onDiscarded = { [weak self] in
            self?.host?.onDiscard()
            self?.finish()
        }
        controller.onFailed = { [weak self] message, code in self?.failed(message, code: code) }
        controllerWatch = controller.objectWillChange.sink { [weak self] _ in
            DispatchQueue.main.async { self?.renderControls() }
        }
        settingsWatch = settings.objectWillChange.sink { [weak self] _ in
            DispatchQueue.main.async { self?.renderControls() }
        }
        renderControls()
        place(target)
        // The controls are on screen before the recorder lists windows, so it can leave them out by id.
        controls.show()
        do {
            try controller.start(target: target, excludeWindowIDs: [controls.windowID], frameRate: settings.frameRate,
                                 showsBorder: settings.showsBorder)
            host.onStart()
        } catch {
            failed("Could not start the recorder: \(error.localizedDescription)", code: nil)
        }
    }

    /// The view goes in once per recording; each tick only changes its state, so what the view holds itself (an open
    /// discard question) survives the clock.
    private func renderControls() {
        guard let controller, let controls, let host else { return }
        let state = RecordingControlsState(
            phase: controller.phase, elapsedMs: controller.elapsedMs, limitMs: controller.limitMs,
            target: controller.target, pauseReason: controller.pauseReason, notice: controller.notice,
            useTitle: host.useTitle, useSymbol: host.useSymbol, confirmsDiscard: settings.confirmsDiscard)
        if let controlsModel {
            if controlsModel.state != state { controlsModel.state = state }
            return
        }
        let model = RecordingControlsModel(state: state)
        controlsModel = model
        controls.setContent(RecordingControlsHost(model: model, actions: RecordingControlsActions(
            pause: { [weak controller] in controller?.pause() },
            resume: { [weak controller] in controller?.resume() },
            switchTarget: { [weak self] in self?.switchTarget() },
            restart: { [weak controller] in controller?.restart() },
            use: { [weak controller] in controller?.stop() },
            discard: { [weak controller] in controller?.discard() },
            dismissNotice: { [weak controller] in controller?.notice = nil },
            moved: { [weak controls] in controls?.noteMoved() })))
    }

    /// Pauses (so the picker never shows in the movie), lets the person choose, then switches or resumes.
    private func switchTarget() {
        guard let controller, let controls else { return }
        let wasRecording = controller.phase == .recording || controller.phase == .starting
        if wasRecording { controller.pause() }
        let frame = controls.window.frame
        openPicker(title: "Switch to", anchor: CGPoint(x: frame.midX, y: frame.minY), preferredPid: nil,
                   choose: { [weak self] target in
                       self?.controller?.switchTo(target)
                       self?.place(target)
                   },
                   cancel: { [weak self] in
                       if wasRecording { self?.controller?.resume() }
                   })
    }

    private func place(_ target: RecordingTarget) {
        guard let controls else { return }
        var bounds: CGRect?
        var display: Int?
        switch target {
        case let .window(ids, _, _, _):
            bounds = union(targets?.windows.filter { ids.contains($0.id) } ?? [])
        case let .app(app, _):
            bounds = union(targets?.windows.filter { String($0.pid) == app } ?? [])
        case let .display(index, _):
            display = index
        }
        controls.place(settings.placement, targetCG: bounds, displayIndex: display)
    }

    private func union(_ windows: [RecordingWindow]) -> CGRect? {
        windows.map { CGRect(x: $0.bounds.x, y: $0.bounds.y, width: $0.bounds.width, height: $0.bounds.height) }
            .reduce(nil) { partial, rect in partial.map { $0.union(rect) } ?? rect }
    }

    private func use(_ url: URL) {
        guard let host else { return finish() }
        Task { [weak self] in
            do {
                try await host.onUse(url)
            } catch {
                host.onError("The recording is saved at \(url.path), but it could not be used: \(error.localizedDescription)")
            }
            self?.finish()
        }
    }

    private func failed(_ message: String, code: String?) {
        let host = self.host
        finish()
        if code == WidgetCaptureError.screenRecordingDenied, let host {
            let need = PermissionNeed(.screenRecording, reason: host.permissionReason, grantWorksInNewProcess: true)
            Task { [permissionGate] in
                if await permissionGate(need) { host.onError(message) }
            }
            return
        }
        host?.onError(message)
    }

    private func finish() {
        picker.dismiss()
        controls?.close()
        controls = nil
        controlsModel = nil
        controllerWatch = nil
        settingsWatch = nil
        controller = nil
        host = nil
        isActive = false
        if Self.running === self { Self.running = nil }
    }
}
