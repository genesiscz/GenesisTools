import AppKit
import Combine
import GenesisKit
import SwiftUI

/// Inputs to a still of the real controls. No capture, desktop enumeration or permission prompt.
@MainActor
struct RecorderBarSnapshot {
    enum Host: String, CaseIterable { case recorder, widget }
    enum State: String, CaseIterable {
        case setup, expanded = "setup-expanded", picker, pickerDisplays = "picker-displays", area, recording, paused, done

        var live: Bool { self == .recording || self == .paused || self == .done }
    }

    let host: Host
    let state: State
    let legacyPicker: Bool
    let expanded: Bool
    static let display = RecordingDisplay(index: 0, name: "Studio Display", isPrimary: true, width: 1920, height: 1080)
    static let document = RecordingWindow(id: 102, pid: -201, app: "Editor", title: "Storyboard",
                                          bounds: .init(x: 14, y: 14, width: 356, height: 208))
    static let targets = RecordingTargets(windows: [
        RecordingWindow(id: 101, pid: -201, app: "Editor", title: "Notes", bounds: .init(x: 0, y: 0, width: 580, height: 420)),
        document,
    ], apps: [.init(pid: -201, name: "Editor", windowCount: 2)],
       displays: [display, RecordingDisplay(index: 1, name: "Side Display", isPrimary: false, width: 2560, height: 1440)])

    init(request: RecorderRequest, shortcutsOpen: Bool) throws {
        guard let state = State(rawValue: request.barState ?? "picker"),
              let host = Host(rawValue: request.barHost ?? "recorder") else {
            throw RecordingEngineError.unsupported("Choose --bar-host recorder|widget and --bar-state setup|setup-expanded|picker|picker-displays|area|recording|paused|done.")
        }
        guard request.width.isFinite, request.height.isFinite, request.width > 0, request.height > 0 else {
            throw RecordingEngineError.unsupported("Snapshot width and height must be positive.")
        }
        self.host = host
        self.state = state
        legacyPicker = request.barState == nil
        expanded = state == .expanded || (legacyPicker && shortcutsOpen)
    }

    func makeModel() async -> RecordingBarModel {
        let engine = SnapshotMovie(host: host, state: state)
        let target = legacyPicker ? Self.targets.defaultTarget() : host == .widget ? Self.display.target : .followDisplay
        let setup = RecordingSetup(target: target, microphone: .init(enabled: host == .recorder),
                                   systemAudio: .init(enabled: host == .recorder), countdownSeconds: nil)
        let model = RecordingBarModel(engine: engine, setup: setup)
        model.expanded = expanded
        if state.live {
            model.record()
            // Subscribe on the main actor before the fake's start task runs. A picture is ready on the
            // requested event, even when the snapshot process is busy.
            for await _ in model.$phase.filter({ $0 == engine.finalPhase }).values { break }
        }
        return model
    }

    var actions: RecordingBarActions {
        var actions = RecordingBarActions(chooseTarget: { _ in },
                                          useTitle: host == .widget ? "Stop and paste" : "Open in editor", useMovie: { _ in })
        if host == .recorder {
            actions.followsDisplayInUse = true
            actions.followedDisplay = .constant(state.live ? Self.display : nil)
            actions.changeThreshold = .constant(0.5)
            actions.addMarker = {}
        }
        return actions
    }

    func view() async -> some View {
        let model = await makeModel()
        let defaults = UserDefaults(suiteName: "recorder.snapshot.\(UUID().uuidString)")!
        // The bar on top, what it opens under it: the picker beside the window it outlines, or the area drag.
        return VStack(spacing: 8) {
            RecordingBarView(model: model, actions: actions, defaults: defaults, look: RecordingBarLook.load(defaults))
            HStack(alignment: .top, spacing: 12) {
                if state == .picker || state == .pickerDisplays {
                    // Highlight the same row a hover selects, independently of the target set in the bar.
                    let initial = state == .pickerDisplays ? RecordingTarget.followDisplay
                        : legacyPicker ? model.setup.target : Self.document.target
                    RecordingTargetPicker(load: .loaded(Self.targets), initial: initial,
                                          onChoose: { _ in }, onCancel: {}, capabilities: model.capabilities,
                                          overlays: RecordingPickerOverlays(screens: []))
                    if !legacyPicker { SnapshotDocument(area: false) }
                }
                if state == .area { SnapshotDocument(area: true) }
            }
        }.defaultAppStorage(defaults).allowsHitTesting(false)
    }

    /// An invented window in a fixed local coordinate system. Its frame and title match the hovered picker row.
    private struct SnapshotDocument: View {
        let area: Bool
        var body: some View {
            let document = RecorderBarSnapshot.document
            let bounds = document.bounds
            let size = CGSize(width: bounds.width + 2 * bounds.x, height: bounds.height + 2 * bounds.y)
            let rect = CGRect(x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height)
            return ZStack {
                VStack(alignment: .leading, spacing: 0) {
                    Label(document.title, systemImage: "doc.text").font(.headline).padding(10)
                    Divider()
                    Text("Opening shot\n\nCut to the wide view.\nHold for the final frame.")
                        .font(.body).padding(14)
                    Spacer()
                }
                .frame(width: rect.width, height: rect.height, alignment: .leading)
                .background(.background, in: RoundedRectangle(cornerRadius: 8))
                SnapshotOverlay(view: area
                    ? AreaSelector.still(size: size, selection: rect.insetBy(dx: 48, dy: 46))
                    : TargetPulse.still(size: size, rect: rect))
                    .frameProbe(area ? "recorder.snapshot.drag" : "recorder.snapshot.pulse")
            }.frame(width: size.width, height: size.height)
        }
    }

    private struct SnapshotOverlay: NSViewRepresentable {
        let view: NSView
        func makeNSView(context: Context) -> NSView { view }
        func updateNSView(_ nsView: NSView, context: Context) {}
    }
}

/// Only the fixture publishes into this stream. The host capability tables are shared with production.
@MainActor
private final class SnapshotMovie: RecordingEngineAdapter {
    let nextTakeID = "fixture-take"
    let capabilities: RecordingCapabilities
    let events: AsyncStream<RecordingEngineEvent>
    private let output: AsyncStream<RecordingEngineEvent>.Continuation
    private let state: RecorderBarSnapshot.State
    private let movie = URL(fileURLWithPath: "/fixture/Storyboard.mp4")

    init(host: RecorderBarSnapshot.Host, state: RecorderBarSnapshot.State) {
        self.state = state
        (events, output) = AsyncStream.makeStream(of: RecordingEngineEvent.self)
        let methods: Set<String>? = state.live ? ["pause", "resume", "stop", "target.switch", "settings.set", "marker.add"] : nil
        capabilities = host == .widget ? WidgetSessionEngine.movieCapabilities :
            ToolsRecorderEngine.capabilities(methods: methods, recordedSources: [.mic, .system])
    }

    var finalPhase: RecordingBarPhase {
        switch state {
        case .done: .done(movie)
        case .paused: .paused(take: nextTakeID, byUser: true)
        default: .recording(take: nextTakeID)
        }
    }

    func start(_ setup: RecordingSetup, excludeWindowIDs: [Int]) async throws {
        func emit(_ value: RecordingEngineEvent.Value) { output.yield(.init(take: nextTakeID, value: value)) }
        emit(.elapsed(milliseconds: 83_000))
        emit(.firstFrame)
        if setup.target == .followDisplay { emit(.liveDisplay(RecorderBarSnapshot.display)) }
        if state == .paused { emit(.paused) }
        if state == .done { emit(.stopped(movie)) }
    }

    func pause() async throws {}
    func resume() async throws {}
    func stop() async throws -> URL? { movie }
    func discard() async throws {}
    func restart() async throws {}
    func apply(_ change: RecordingSetupChange) async throws {}
    func audioDevices() async throws -> (inputs: [RecordingAudioDevice], outputs: [RecordingAudioDevice]) {
        ([.init(id: "fixture-mic", name: "Studio microphone", isDefault: true)],
         [.init(id: "fixture-output", name: "Speakers", isDefault: true)])
    }
}
