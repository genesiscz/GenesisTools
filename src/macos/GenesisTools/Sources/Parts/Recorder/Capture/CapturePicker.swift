import AppKit
import SwiftUI

/// The capture picker (⌘7 by default, from any app): what to record (a window, an app, a display or an area) and the
/// recording's options in one panel. A choice starts `tools recorder start` through `RecorderMenu.startRecording`,
/// the one start path, after the countdown when it is on.
@MainActor
final class CapturePicker {
    static let shared = CapturePicker()

    let model = CapturePickerModel()
    private let panel = RecordingPickerPanel()
    private var load: RecordingTargetPicker.Load = .loading
    private var targets: RecordingTargets?
    private var initial: RecordingTarget?
    private var filter: (tab: RecordingPickerTab, query: String)?
    private var anchor = CGPoint.zero
    private var countdown: CaptureCountdown?
    private var area: AreaSelection?

    var isVisible: Bool { panel.isVisible }

    /// Opens the picker under the pointer, on the front window of the app the person was in.
    func show() {
        if panel.isVisible {
            panel.window.makeKeyAndOrderFront(nil)
            return
        }
        model.reload()
        anchor = NSEvent.mouseLocation
        let front = NSWorkspace.shared.frontmostApplication.flatMap { app in
            app.processIdentifier == ProcessInfo.processInfo.processIdentifier ? nil : app.processIdentifier
        }
        load = targets.map { .loaded($0) } ?? .loading
        initial = targets?.defaultTarget(preferredPid: front)
        filter = nil
        present()
        CameraBubble.shared.optionChanged(model.options.camera)
        HubPerf.log("recorder: capture picker opened")
        Task { await refresh(preferredPid: front) }
    }

    func dismiss() {
        panel.dismiss()
    }

    private func present() {
        let view = RecordingTargetPicker(
            load: load, title: "Record", initial: initial,
            onChoose: { [weak self] target in self?.choose(.target(target)) },
            onCancel: { [weak self] in self?.cancel() },
            onRetry: { [weak self] in
                guard let self else { return }
                load = .loading
                present()
                Task { await self.refresh(preferredPid: nil) }
            },
            restoring: filter,
            onFilterChange: { [weak self] tab, query in self?.filter = (tab, query) },
            accessory: AnyView(CaptureOptionsView(model: model, onArea: { [weak self] in self?.selectArea() })),
            footerHint: "↑ ↓ choose · Return records · ⌘4 an area · Esc cancels · ⌘1 ⌘2 ⌘3 tabs")
            .onKeyPress(phases: .down) { [weak self] press in
                guard press.modifiers == .command, press.characters == "4" else { return .ignored }
                self?.selectArea()
                return .handled
            }
        panel.present(view, near: anchor) { [weak self] in self?.cancel() }
    }

    private func refresh(preferredPid: Int32?) async {
        let previous = load
        do {
            let result = try await ToolsBridge(binaryPath: ToolsBridge.defaultBinaryPath())
                .run(subcommand: "control", args: ["capture", "targets", "--json"], timeoutSeconds: 120)
            guard result.exitCode == 0 else { throw ToolsBridgeError.refused(String(result.stderr.suffix(600))) }
            let loaded = try JSONDecoder().decode(RecordingTargets.self, from: Data(result.stdout.utf8))
                .excluding(pids: [ProcessInfo.processInfo.processIdentifier])
            targets = loaded
            load = .loaded(loaded)
            if initial == nil { initial = loaded.defaultTarget(preferredPid: preferredPid) }
        } catch {
            HubPerf.log("recorder: capture targets failed: \(error.localizedDescription)")
            load = .failed("Could not list what to record: \(error.localizedDescription)")
        }
        guard panel.isVisible, load != previous else { return }
        present()
    }

    private func cancel() {
        panel.dismiss()
        CameraBubble.shared.pickerClosed(started: false)
    }

    private func selectArea() {
        panel.dismiss()
        let selection = AreaSelection()
        area = selection
        selection.begin { [weak self] rect in
            guard let self else { return }
            area = nil
            if let rect {
                choose(.area(rect))
            } else {
                CameraBubble.shared.pickerClosed(started: false)
            }
        }
    }

    /// Starts a recording of `choice` with the saved options: the countdown first when it is on.
    func choose(_ choice: CaptureChoice) {
        panel.dismiss()
        let options = CaptureOptions.load()
        let screen = Self.screen(for: choice)
        Task {
            let need = PermissionNeed(.screenRecording, reason: "The recorder records the screen you choose.",
                                      grantWorksInNewProcess: true)
            guard await PermissionCenter.shared.ensure(need) else {
                CameraBubble.shared.pickerClosed(started: false)
                return
            }
            guard options.countdown else {
                start(choice, options: options)
                return
            }
            let countdown = CaptureCountdown(seconds: options.countdownSeconds, screen: screen)
            self.countdown = countdown
            countdown.run { [weak self] finished in
                guard let self else { return }
                self.countdown = nil
                if finished {
                    start(choice, options: options)
                } else {
                    HubPerf.log("recorder: countdown cancelled")
                    CameraBubble.shared.pickerClosed(started: false)
                }
            }
        }
    }

    private func start(_ choice: CaptureChoice, options: CaptureOptions) {
        let exclude = options.camera ? CameraBubble.shared.windowIDs : []
        CameraBubble.shared.pickerClosed(started: options.camera)
        RecorderMenu.shared.startRecording(arguments: options.startArguments(choice, excludeWindowIds: exclude))
    }

    /// `--picker --snapshot`: the panel over made-up targets, drawn off screen into a PNG (verification without a
    /// screen; nothing starts and no setting changes).
    static func snapshot(to path: String, shortcutsOpen: Bool) async throws {
        let targets = RecordingTargets(
            windows: [
                RecordingWindow(id: 101, pid: 501, app: "Editor", title: "notes.md",
                                bounds: .init(x: 0, y: 0, width: 1200, height: 800)),
                RecordingWindow(id: 102, pid: 501, app: "Editor", title: "plan.md",
                                bounds: .init(x: 40, y: 40, width: 900, height: 700)),
                RecordingWindow(id: 201, pid: 502, app: "Browser", title: "Example page",
                                bounds: .init(x: 0, y: 0, width: 1440, height: 900)),
            ],
            apps: [RecordingApp(pid: 501, name: "Editor", windowCount: 2), RecordingApp(pid: 502, name: "Browser", windowCount: 1)],
            displays: [RecordingDisplay(index: 0, name: "Built-in Display", isPrimary: true, width: 1512, height: 982)],
            frontmostPid: 501)
        let model = CapturePickerModel(persist: false)
        model.shortcutsOpen = shortcutsOpen
        let view = RecordingTargetPicker(
            load: .loaded(targets), title: "Record", initial: targets.defaultTarget(preferredPid: 501),
            onChoose: { _ in }, onCancel: {},
            accessory: AnyView(CaptureOptionsView(model: model, onArea: {})),
            footerHint: "↑ ↓ choose · Return records · ⌘4 an area · Esc cancels · ⌘1 ⌘2 ⌘3 tabs")
        let hosting = NSHostingView(rootView: view.fixedSize())
        hosting.layoutSubtreeIfNeeded()
        let size = hosting.fittingSize
        let window = NSWindow(contentRect: CGRect(origin: .zero, size: size), styleMask: [.borderless],
                              backing: .buffered, defer: false)
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

    /// The screen the countdown shows on: the chosen display, the area's, the window's, else the pointer's.
    private static func screen(for choice: CaptureChoice) -> NSScreen? {
        let screens = NSScreen.screens
        switch choice {
        case let .target(.display(index, _)):
            return screens.indices.contains(index) ? screens[index] : NSScreen.main
        case let .area(rect):
            let primaryHeight = screens.first?.frame.height ?? 0
            let center = CGPoint(x: rect.midX, y: primaryHeight - rect.midY)
            return screens.first { $0.frame.contains(center) } ?? NSScreen.main
        default:
            return screens.first { $0.frame.contains(NSEvent.mouseLocation) } ?? NSScreen.main
        }
    }
}

/// The options the panel shows and edits, saved at each change.
@MainActor
final class CapturePickerModel: ObservableObject {
    /// False for a snapshot: the panel's changes stay in memory.
    private let persist: Bool

    init(persist: Bool = true) {
        self.persist = persist
    }

    @Published var options = CaptureOptions.load() {
        didSet {
            guard persist, options != oldValue else { return }
            options.save()
            if options.camera != oldValue.camera { CameraBubble.shared.optionChanged(options.camera) }
        }
    }

    @Published var bindings: [RecorderShortcutAction: RecorderShortcutBinding] = CapturePickerModel.loadBindings()
    @Published var shortcutsOpen = false
    @Published var alwaysHeld = RecorderShortcuts.alwaysHeld {
        didSet {
            UserDefaults.standard.set(alwaysHeld, forKey: RecorderShortcuts.alwaysHeldKey)
            RecorderShortcuts.shared.apply()
        }
    }

    func reload() {
        options = CaptureOptions.load()
        bindings = Self.loadBindings()
    }

    func binding(_ action: RecorderShortcutAction) -> RecorderShortcutBinding {
        bindings[action] ?? RecorderShortcutBinding(chord: action.defaultChord)
    }

    func set(_ action: RecorderShortcutAction, _ binding: RecorderShortcutBinding) {
        bindings[action] = binding
        binding.save(action)
        RecorderShortcuts.shared.apply()
    }

    private static func loadBindings() -> [RecorderShortcutAction: RecorderShortcutBinding] {
        Dictionary(uniqueKeysWithValues: RecorderShortcutAction.allCases.map { ($0, RecorderShortcutBinding.load($0)) })
    }
}

/// The options under the picker's list: countdown, frame rates, change threshold, audio, cursor, the shortcuts
/// overlay, the camera bubble, the area button, and the global shortcuts behind a disclosure.
struct CaptureOptionsView: View {
    @ObservedObject var model: CapturePickerModel
    let onArea: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 7) {
            Button(action: onArea) {
                HStack(spacing: 8) {
                    Image(systemName: "rectangle.dashed").frame(width: 18)
                    Text("Select an area…").font(.system(size: 12, weight: .medium))
                    Spacer(minLength: 0)
                    Text(verbatim: "⌘4").font(.system(size: 11)).foregroundStyle(SessionPalette.secondary)
                }
                .padding(.horizontal, 8).padding(.vertical, 5)
                .contentShape(Rectangle())
            }
            .buttonStyle(.genHoverRow())
            .instantTooltip("Drag a rectangle on any display; the recording keeps only that area")
            .accessibilityIdentifier("recorder.capture.area")

            Text("Options").kicker()
            row("Countdown", detail: "Seconds to switch to what is recorded after a choice") {
                HStack(spacing: 6) {
                    if model.options.countdown {
                        Stepper(value: $model.options.countdownSeconds, in: 1...10) {
                            Text(verbatim: "\(model.options.countdownSeconds) s").font(.system(size: 11)).monospacedDigit()
                        }
                        .controlSize(.mini)
                        .accessibilityIdentifier("recorder.capture.countdownSeconds")
                    }
                    toggle($model.options.countdown, "recorder.capture.countdown")
                }
            }
            row("Frame rate", detail: "Frames per second while something moves") {
                menu($model.options.fps, CaptureOptions.frameRates, "recorder.capture.fps") { "\($0) fps" }
            }
            row("While still", detail: "Frames per second while nothing moves; Same keeps one rate") {
                menu($model.options.idleFps, CaptureOptions.idleRates, "recorder.capture.idleFps") {
                    $0 == 0 ? "Same" : "\($0 == $0.rounded() ? String(Int($0)) : String($0)) fps"
                }
            }
            row("Change needed", detail: "How much of the picture must change to leave the still rate") {
                menu($model.options.threshold, CaptureOptions.thresholds, "recorder.capture.threshold") {
                    "\($0 == $0.rounded() ? String(Int($0)) : String($0)) %"
                }
            }
            row("System audio", detail: "What the Mac plays, as its own track") {
                toggle($model.options.systemAudio, "recorder.capture.audio.system")
            }
            row("Microphone", detail: "Your voice, as its own track") {
                toggle($model.options.microphone, "recorder.capture.audio.mic")
            }
            row("Draw the cursor", detail: "The editor draws it smoothed and at any size; off keeps the system cursor") {
                toggle($model.options.drawCursor, "recorder.capture.drawCursor")
            }
            row("Shortcuts overlay", detail: "Keeps ⌘ and ⌃ shortcuts for the editor's overlay; plain typing never") {
                toggle($model.options.shortcutsOverlay, "recorder.capture.shortcuts")
            }
            row("Camera bubble", detail: "Records the camera beside the screen; drag the bubble to place it") {
                toggle($model.options.camera, "recorder.capture.camera")
            }

            GenDisclosure(isExpanded: $model.shortcutsOpen, identifier: "recorder.capture.shortcutsDisclosure",
                          accessibilityTitle: "Shortcuts") {
                VStack(alignment: .leading, spacing: 6) {
                    ForEach(RecorderShortcutAction.allCases) { action in
                        shortcutRow(action)
                    }
                    row("Hold stop, pause and mark keys", detail: "Off: those keys reach other apps while nothing records") {
                        toggle($model.alwaysHeld, "recorder.capture.alwaysHeld")
                    }
                }
                .padding(.top, 4)
            } label: {
                Text("Shortcuts").font(.system(size: 12, weight: .medium))
            }
        }
    }

    private func row<Control: View>(_ title: String, detail: String, @ViewBuilder control: () -> Control) -> some View {
        HStack(spacing: 8) {
            Text(title).font(.system(size: 12))
                .instantTooltip(detail)
            Spacer(minLength: 8)
            control()
        }
        .frame(minHeight: 22)
        .accessibilityElement(children: .contain)
        .accessibilityLabel(title)
        .accessibilityHint(detail)
    }

    private func toggle(_ value: Binding<Bool>, _ identifier: String) -> some View {
        Toggle("", isOn: value).labelsHidden().toggleStyle(.switch).controlSize(.mini)
            .accessibilityIdentifier(identifier)
    }

    private func menu<Value: Hashable>(_ value: Binding<Value>, _ values: [Value], _ identifier: String,
                                       title: @escaping (Value) -> String) -> some View {
        Picker("", selection: value) {
            ForEach(values, id: \.self) { item in
                Text(title(item)).tag(item)
            }
        }
        .labelsHidden().pickerStyle(.menu).controlSize(.small).fixedSize()
        .accessibilityIdentifier(identifier)
    }

    private func shortcutRow(_ action: RecorderShortcutAction) -> some View {
        let binding = model.binding(action)
        return HStack(alignment: .top, spacing: 8) {
            Toggle("", isOn: Binding(get: { binding.enabled }, set: { on in
                model.set(action, RecorderShortcutBinding(chord: binding.chord, enabled: on))
            }))
            .labelsHidden().toggleStyle(.checkbox).controlSize(.small)
            .accessibilityIdentifier("recorder.shortcut.\(action.rawValue).enabled")
            Text(action.title).font(.system(size: 12))
                .foregroundStyle(binding.enabled ? .primary : SessionPalette.secondary)
                .instantTooltip(action.detail)
            Spacer(minLength: 8)
            HotkeyRecorder(
                chord: Binding(get: { binding.chord }, set: { chord in
                    model.set(action, RecorderShortcutBinding(chord: chord, enabled: true))
                }),
                defaultChord: action.defaultChord, identifier: "recorder.shortcut.\(action.rawValue)",
                onListening: { listening in RecorderShortcuts.shared.setListening(listening ? action : nil) })
                .controlSize(.small)
        }
    }
}

// MARK: - Area

/// Drag a rectangle on any display: one clear panel per screen with a crosshair; Escape or a click without a drag
/// cancels. The result is in CoreGraphics global points, as `--region` takes it.
@MainActor
final class AreaSelection {
    private var panels: [NSPanel] = []
    private var monitor: Any?
    private var done: ((CGRect?) -> Void)?

    func begin(_ done: @escaping (CGRect?) -> Void) {
        self.done = done
        let primaryHeight = NSScreen.screens.first?.frame.height ?? 0
        panels = NSScreen.screens.map { screen in
            let panel = AreaSelectionWindow(contentRect: screen.frame, styleMask: [.borderless, .nonactivatingPanel],
                                            backing: .buffered, defer: false)
            panel.title = "Select an area"
            panel.level = .screenSaver
            panel.isOpaque = false
            panel.backgroundColor = .clear
            panel.hasShadow = false
            panel.hidesOnDeactivate = false
            panel.isReleasedWhenClosed = false
            panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .ignoresCycle]
            panel.sharingType = .none
            let view = AreaSelectionView(frame: CGRect(origin: .zero, size: screen.frame.size))
            view.onFinish = { [weak self] local in
                guard let self else { return }
                let rect = local.map { CGRect(x: $0.minX + screen.frame.minX, y: $0.minY + screen.frame.minY,
                                              width: $0.width, height: $0.height) }
                finish(rect.map { CaptureChoice.coreGraphicsRect(cocoa: $0, primaryHeight: primaryHeight) })
            }
            panel.contentView = view
            panel.setFrame(screen.frame, display: false)
            panel.orderFrontRegardless()
            return panel
        }
        let pointer = NSEvent.mouseLocation
        (panels.first { $0.frame.contains(pointer) } ?? panels.first)?.makeKey()
        monitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [weak self] event in
            guard event.keyCode == 53 else { return event }
            self?.finish(nil)
            return nil
        }
        NSCursor.crosshair.push()
    }

    private func finish(_ rect: CGRect?) {
        guard let done else { return }
        self.done = nil
        NSCursor.pop()
        if let monitor { NSEvent.removeMonitor(monitor) }
        monitor = nil
        panels.forEach { $0.orderOut(nil); $0.close() }
        panels = []
        HubPerf.log("recorder: area \(rect.map { "\(Int($0.minX)),\(Int($0.minY)) \(Int($0.width))x\(Int($0.height))" } ?? "cancelled")")
        done(rect)
    }
}

/// Takes the keyboard (Escape) without activating the app.
final class AreaSelectionWindow: NSPanel {
    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { false }
}

/// Dims the screen a little, draws the dragged rectangle clear with its size, and reports it on mouse-up.
final class AreaSelectionView: NSView {
    var onFinish: ((CGRect?) -> Void)?
    private var start: CGPoint?
    private var current: CGPoint?
    /// A rectangle smaller than this on either side is a click, not an area.
    static let minimumSide: CGFloat = 16

    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }

    override func resetCursorRects() { addCursorRect(bounds, cursor: .crosshair) }

    private var selection: CGRect? {
        guard let start, let current else { return nil }
        return CGRect(x: min(start.x, current.x), y: min(start.y, current.y),
                      width: abs(current.x - start.x), height: abs(current.y - start.y)).integral
    }

    override func mouseDown(with event: NSEvent) {
        start = convert(event.locationInWindow, from: nil)
        current = start
        needsDisplay = true
    }

    override func mouseDragged(with event: NSEvent) {
        current = convert(event.locationInWindow, from: nil)
        needsDisplay = true
    }

    override func mouseUp(with event: NSEvent) {
        current = convert(event.locationInWindow, from: nil)
        let rect = selection
        start = nil
        current = nil
        needsDisplay = true
        guard let rect, rect.width >= Self.minimumSide, rect.height >= Self.minimumSide else {
            onFinish?(nil)
            return
        }
        onFinish?(rect)
    }

    override func draw(_ dirtyRect: NSRect) {
        NSColor.black.withAlphaComponent(0.25).setFill()
        bounds.fill()
        guard let rect = selection else {
            hint("Drag to choose the area to record · Esc cancels", at: CGPoint(x: bounds.midX, y: bounds.midY))
            return
        }
        NSGraphicsContext.current?.compositingOperation = .clear
        rect.fill()
        NSGraphicsContext.current?.compositingOperation = .sourceOver
        NSColor.systemRed.withAlphaComponent(0.9).setStroke()
        let path = NSBezierPath(rect: rect.insetBy(dx: -1, dy: -1))
        path.lineWidth = 2
        path.setLineDash([8, 5], count: 2, phase: 0)
        path.stroke()
        hint("\(Int(rect.width)) × \(Int(rect.height))", at: CGPoint(x: rect.midX, y: max(rect.minY - 18, 14)))
    }

    private func hint(_ text: String, at center: CGPoint) {
        let attributes: [NSAttributedString.Key: Any] = [
            .font: NSFont.systemFont(ofSize: 13, weight: .medium), .foregroundColor: NSColor.white,
        ]
        let size = (text as NSString).size(withAttributes: attributes)
        let box = CGRect(x: center.x - size.width / 2 - 10, y: center.y - size.height / 2 - 5,
                         width: size.width + 20, height: size.height + 10)
        NSColor.black.withAlphaComponent(0.7).setFill()
        NSBezierPath(roundedRect: box, xRadius: 8, yRadius: 8).fill()
        (text as NSString).draw(at: CGPoint(x: box.minX + 10, y: box.minY + 5), withAttributes: attributes)
    }
}

// MARK: - Countdown

/// The seconds before a recording starts, large in the middle of the recorded screen. Escape cancels. The panel is
/// gone before the recorder starts, so it is never in the movie.
@MainActor
final class CaptureCountdown {
    private let seconds: Int
    private let panel: AreaSelectionWindow
    private let model = CountdownModel()
    private var monitor: Any?
    private var timer: Timer?
    private var done: ((Bool) -> Void)?

    init(seconds: Int, screen: NSScreen?) {
        self.seconds = max(1, seconds)
        let frame = screen?.frame ?? NSScreen.main?.frame ?? CGRect(x: 0, y: 0, width: 800, height: 600)
        let size = CGSize(width: 220, height: 220)
        panel = AreaSelectionWindow(contentRect: CGRect(x: frame.midX - size.width / 2, y: frame.midY - size.height / 2,
                                                        width: size.width, height: size.height),
                                    styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
        panel.title = "Recording countdown"
        panel.level = .screenSaver
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = false
        panel.ignoresMouseEvents = true
        panel.isReleasedWhenClosed = false
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .ignoresCycle]
        panel.sharingType = .none
        panel.contentView = NSHostingView(rootView: CountdownView(model: model))
    }

    func run(_ done: @escaping (Bool) -> Void) {
        self.done = done
        model.remaining = seconds
        panel.orderFrontRegardless()
        panel.makeKey()
        monitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [weak self] event in
            guard event.keyCode == 53 else { return event }
            self?.finish(false)
            return nil
        }
        timer = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated {
                guard let self else { return }
                if self.model.remaining <= 1 {
                    self.finish(true)
                } else {
                    self.model.remaining -= 1
                }
            }
        }
    }

    private func finish(_ completed: Bool) {
        guard let done else { return }
        self.done = nil
        timer?.invalidate()
        timer = nil
        if let monitor { NSEvent.removeMonitor(monitor) }
        monitor = nil
        panel.orderOut(nil)
        panel.close()
        done(completed)
    }
}

@MainActor
final class CountdownModel: ObservableObject {
    @Published var remaining = 3
}

struct CountdownView: View {
    @ObservedObject var model: CountdownModel
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        VStack(spacing: 6) {
            Text(verbatim: "\(model.remaining)")
                .font(.system(size: 84, weight: .semibold, design: .rounded))
                .monospacedDigit()
                .contentTransition(reduceMotion ? .identity : .numericText(countsDown: true))
                .animation(reduceMotion ? nil : .easeOut(duration: 0.25), value: model.remaining)
            Text("Esc cancels").font(.system(size: 12)).foregroundStyle(.white.opacity(0.7))
        }
        .foregroundStyle(.white)
        .frame(width: 200, height: 200)
        .background(Circle().fill(.black.opacity(0.62)))
        .accessibilityElement(children: .combine)
        .accessibilityLabel("Recording starts in \(model.remaining) seconds")
    }
}
