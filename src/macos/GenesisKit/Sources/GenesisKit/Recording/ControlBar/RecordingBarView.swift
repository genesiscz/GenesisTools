import AppKit
import SwiftUI

/// The picker, movie destination and recorder commands supplied by the host. The picker completes its selection
/// with RecordingBarModel.endTargetSelection, including on cancel. A nil picker kind opens its usual tab.
@MainActor
public struct RecordingBarActions {
    public var chooseTarget: (RecordingTargetKind?) -> Void
    public var useTitle: String
    public var useMovie: (URL) async throws -> Void
    public var hide: () -> Void
    public var addMarker: (() async throws -> Void)?
    /// A draft owned by the host, consumed by its start command. Editing it does not write defaults.
    public var changeThreshold: Binding<Double>? {
        get { threshold?.value }
        set { threshold = newValue.map(Threshold.init) }
    }
    fileprivate final class Threshold {
        let value: Binding<Double>
        var opening: Double
        init(_ value: Binding<Double>) { self.value = value; opening = value.wrappedValue }
    }
    fileprivate var threshold: Threshold?
    /// Set by a host whose unselected target records the display in use.
    public var followsDisplayInUse = false
    /// The display reported by a recorder that follows activity. It can differ from the pointer's screen.
    public var followedDisplay: Binding<RecordingDisplay?>?

    public init(chooseTarget: @escaping (RecordingTargetKind?) -> Void, useTitle: String = "Open in editor",
                useMovie: @escaping (URL) async throws -> Void, hide: @escaping () -> Void = {}) {
        self.chooseTarget = chooseTarget
        self.useTitle = useTitle
        self.useMovie = useMovie
        self.hide = hide
    }

    func closeSetupIfNeeded(_ model: RecordingBarModel) {
        guard model.phase == .setup else { return }
        model.cancelSetup()
        if let threshold { threshold.value.wrappedValue = threshold.opening }
    }
}

@MainActor
public struct RecordingBarView: View {
    static let width: CGFloat = 520
    @ObservedObject private var model: RecordingBarModel
    private let actions: RecordingBarActions
    private let defaults: UserDefaults
    private let onPlace: (RecordingPanelPlacement) -> Void
    private let onDrag: () -> Void
    @Binding private var draftThreshold: Double
    @State private var placement: RecordingPanelPlacement
    @State private var saved: RecordingSetup
    @State private var inputNames: [String: String] = [:]
    @State private var outputName: String?
    @State private var detail: String?
    @State private var waitingTake: String?
    @State private var confirmation: Confirmation?
    @State private var marking = false
    @State private var usingMovie = false
    @State private var help: String?
    @State private var liveMenu: LiveMenu?

    private enum Confirmation: Equatable { case discard, restart }

    /// An AppKit menu gets its own window after capture starts. Keep live choices within the excluded bar.
    private struct LiveMenu {
        let title: String
        let options: [String]
        let selected: Int?
        let choose: (Int) -> Void
        let returnToCompact: Bool
    }

    public init(model: RecordingBarModel, actions: RecordingBarActions, defaults: UserDefaults = .standard,
                placement: RecordingPanelPlacement = .nearTarget,
                onPlace: @escaping (RecordingPanelPlacement) -> Void = { _ in }, onDrag: @escaping () -> Void = {}) {
        self.model = model
        self.actions = actions
        self.defaults = defaults
        self.onPlace = onPlace
        self.onDrag = onDrag
        _draftThreshold = actions.changeThreshold ?? .constant(0.5)
        _placement = State(initialValue: placement)
        _saved = State(initialValue: RecordingSetup.load(defaults))
    }

    private var setup: RecordingSetup { model.setup }
    private var caps: RecordingCapabilities { model.capabilities }
    private var configuring: Bool { model.phase == .setup }
    private var live: Bool {
        switch model.phase { case .recording, .paused: true; default: false }
    }
    private var startingTake: String? {
        if case let .starting(take) = model.phase { return take }
        return nil
    }
    private var recording: Bool {
        if case .recording = model.phase { return true }
        return false
    }
    private var follows: Bool { actions.followsDisplayInUse && setup.target == nil }
    private var useInlineMenus: Bool {
        switch model.phase {
        case .setup, .done, .failed: false
        case .countdown, .starting, .recording, .paused, .finishing: true
        }
    }

    /// A disabled live control keeps its engine's reason. Phase changes never turn a disabled button into
    /// an edit of preferences behind the running take.
    private func reason(_ key: String, live supported: Bool, fallback: String = "Choose this before recording.") -> String? {
        if configuring { return nil }
        if live { return supported ? nil : caps.reasonUnavailable[key] ?? fallback }
        return "Available when setting up a recording."
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: 5) {
            HStack(spacing: 3) {
                RecordingGrip().frame(width: 24, height: 28)
                    .overlay(RecordingWindowDragArea(dragged: onDrag))
                target
                soundControls
                fpsMenu
                HStack(spacing: 3) { phaseArea }.frame(width: 146, alignment: .trailing)
                icon("ellipsis", "More recording options", "expand", value: model.expanded ? "Expanded" : "Collapsed") {
                    model.expanded.toggle()
                }
                icon("xmark", configuring ? "Close setup" : "Hide controls", "hide", action: close)
            }
            Text(help ?? sourceSummary).font(.caption).foregroundStyle(.secondary)
                .frame(maxWidth: .infinity, alignment: .leading)
                .accessibilityHidden(help != nil)
            phaseDetails
            if let audioReason {
                HStack {
                    InfoStrip(audioReason, tone: .warning)
                    if caps.targets.contains(.area) {
                        word("Select an Area", "area", reason: reason("target", live: caps.liveTargetSwitch)) { pick(.area) }
                    }
                }
            }
            if follows {
                HStack {
                    if let display = actions.followedDisplay?.wrappedValue { Text(display.name) }
                    word("Lock to This Display", "lockDisplay", reason: reason("target", live: caps.liveTargetSwitch)) {
                        if let display = actions.followedDisplay?.wrappedValue { model.apply(.target(display.target)); return }
                        let screens = NSScreen.screens
                        guard let index = screens.firstIndex(where: { $0.frame.contains(NSEvent.mouseLocation) }) else { return }
                        model.apply(.target(.display(index: index, name: screens[index].localizedName)))
                    }
                }
            }
            if let notice = model.notice {
                VStack(alignment: .leading, spacing: 2) {
                    InfoStrip(notice.message, tone: .warning).accessibilityIdentifier("recording.bar.notice")
                    if let take = notice.take, notice.actions.contains(.retryStop) {
                        HStack {
                            word("Retry Stop", "retryStop") { model.retryStop(take: take) }
                            word("Show Controls", "showControls") {
                                if model.notice?.take == take { model.expanded = true }
                            }
                        }
                    }
                }
            }
            if let detail {
                HStack {
                    InfoStrip(detail)
                    word("Dismiss", "dismissDetail") { self.detail = nil }
                }
            }
            if model.expanded {
                Divider()
                if let liveMenu { menuRow(liveMenu) }
                videoOptions
                deviceOptions
            }
        }
        .font(.system(size: 12))
        .padding(.horizontal, 8).padding(.vertical, 6)
        .frame(width: Self.width, alignment: .leading)
        .nativeGlassSurface(radius: 12)
        .environment(\.colorScheme, .dark)
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Recording controls")
        .onPreferenceChange(RecordingBarHelp.self) { help = $0 }
        .onChange(of: model.expanded) { _, expanded in if !expanded { liveMenu = nil } }
        .onAppear { model.refreshAudioDevices() }
        .onChange(of: model.audioInputs, initial: true) { _, devices in
            inputNames = Dictionary(devices.map { ($0.id, $0.name) }, uniquingKeysWith: { first, _ in first })
        }
        .onChange(of: model.audioOutputs, initial: true) { _, devices in outputName = devices.first(where: \.isDefault)?.name }
        .task(id: startingTake) {
            waitingTake = nil
            guard let take = startingTake else { return }
            let seconds = defaults.object(forKey: "recorder.bar.startWaitSeconds") as? Double ?? 5
            do { try await Task.sleep(for: .seconds(max(0, seconds))) } catch { return }
            if startingTake == take { waitingTake = take }
        }
        .onChange(of: model.phase) { old, new in
            confirmation = nil
            detail = nil
            liveMenu = nil
            switch new {
            case .recording:
                if case .paused = old { GenAnnounce.post("Recording resumed") } else { GenAnnounce.post("Recording started") }
            case .paused: GenAnnounce.post("Recording paused")
            case .done: GenAnnounce.post("Recording saved")
            case let .failed(message): GenAnnounce.post(message)
            default: break
            }
        }
    }

    private var target: some View {
        let title = setup.target?.title ?? (follows ? "Follow Display in Use" : "Choose target")
        return Button { pick(nil) } label: {
            HStack(spacing: 4) {
                Image(systemName: setup.target?.symbol ?? "display")
                VStack(alignment: .leading, spacing: 0) {
                    Text(title).lineLimit(1).truncationMode(.middle)
                    if audioReason != nil { Text("No audio").font(.caption).foregroundStyle(.secondary) }
                }
            }.frame(minWidth: 28, maxWidth: .infinity, minHeight: 26, alignment: .leading)
        }
        .buttonStyle(.genHoverRow())
        .barControl("target", label: "Choose what to record", value: title,
                    reason: reason("target", live: caps.liveTargetSwitch), scope: live ? "This take" : nil)
    }

    private func pick(_ kind: RecordingTargetKind?) {
        model.beginTargetSelection()
        actions.chooseTarget(kind)
    }

    private var audioReason: String? {
        switch setup.target {
        case .window, .app: caps.reasonUnavailable["microphone"] ?? caps.reasonUnavailable["systemAudio"]
        default: nil
        }
    }

    private func soundState(_ enabled: Bool, _ muted: Bool) -> String {
        enabled ? (muted ? "Muted" : "On") : "Off"
    }

    private var sourceSummary: String {
        let scope = configuring ? "Next recording" : "This take"
        if audioReason != nil { return "\(scope) · No audio track" }
        let mic = soundState(setup.microphone.enabled, setup.microphone.muted).lowercased()
        let system = soundState(setup.systemAudio.enabled, setup.systemAudio.muted).lowercased()
        return "\(scope) · Microphone \(mic) · System audio \(system)"
    }

    @ViewBuilder private var soundControls: some View {
        let mic = setup.microphone
        let system = setup.systemAudio
        let micReason = reason("microphone", live: caps.liveMicrophoneMute && mic.enabled,
                               fallback: "Enable the microphone before recording.")
        let systemReason = reason("systemAudio", live: caps.liveSystemAudioMute && system.enabled,
                                  fallback: "Enable system audio before recording.")
        icon(mic.enabled ? (mic.muted ? "mic.slash.fill" : "mic.fill") : "mic", "Microphone", "microphone",
             value: soundState(mic.enabled, mic.muted), reason: micReason, scope: scope(micReason)) {
            var next = mic
            if live { next.muted.toggle() } else {
                next.enabled.toggle()
                next.muted = false
            }
            model.apply(.microphone(next))
        }
        if useInlineMenus {
            icon("chevron.down", "Choose microphone", "micMenu", reason: deviceReason, scope: scope(deviceReason)) {
                let inputs = model.audioInputs
                let ids = [nil as String?] + inputs.map { Optional($0.id) }
                showMenu("Microphone", options: ["System default"] + inputs.map(\.name),
                         selected: ids.firstIndex(of: setup.microphone.deviceID)) { selectInput(ids[$0]) }
            }
        } else {
            Menu { inputChoices } label: {
                Image(systemName: "chevron.down").font(.caption).frame(width: 24, height: 26)
            }
            .menuStyle(.borderlessButton).menuIndicator(.hidden).fixedSize()
            .barControl("micMenu", label: "Choose microphone", reason: deviceReason, scope: scope(deviceReason))
        }
        icon(system.enabled ? (system.muted ? "speaker.slash.fill" : "speaker.wave.2.fill") : "speaker.slash",
             "System audio", "systemAudio", value: soundState(system.enabled, system.muted),
             reason: systemReason, scope: scope(systemReason)) {
            var next = system
            if live { next.muted.toggle() } else {
                next.enabled.toggle()
                next.muted = false
            }
            model.apply(.systemAudio(next))
        }
        let cameraReason = reason("camera", live: caps.liveCamera)
        icon(setup.camera.enabled ? "video.fill" : "video.slash", "Camera", "camera",
             value: setup.camera.enabled ? "On" : "Off", reason: cameraReason, scope: scope(cameraReason)) {
            var next = setup.camera
            next.enabled.toggle()
            model.apply(.camera(next))
        }
    }

    private var fpsMenu: some View {
        let why = reason("frameRate", live: caps.liveFrameRate)
        return choice("Frame rate", "frameRate", value: setup.frameRate, values: [15, 24, 30, 60],
                      title: { "\($0) fps" }, reason: why, scope: scope(why), compact: true) {
            model.apply(.frameRate($0, still: setup.stillFrameRate))
        }
    }

    @ViewBuilder private var phaseArea: some View {
        switch model.phase {
        case .setup:
            word("Record", "record", prominent: true, reason: setup.target == nil && !follows ? "Choose a recording target first." : nil,
                 action: model.record)
        case let .countdown(seconds):
            Text("\(seconds) s").monospacedDigit().barStatus("recording.bar.countdown")
            word("Cancel", "cancel", action: model.discard)
        case let .starting(take):
            Text(waitingTake == take ? "Still waiting" : "Starting…").barStatus("recording.bar.starting")
            word("Cancel", "cancel", action: model.discard)
        case .recording:
            clock(paused: false)
            icon("pause.fill", "Pause", "pause", action: model.pause)
            stop
        case let .paused(_, byUser):
            clock(paused: true)
            icon("play.fill", "Resume", "resume", reason: byUser ? nil : "Finish choosing a target to resume.", action: model.resume)
            stop
        case .finishing:
            Text("Saving…").barStatus("recording.bar.finishing")
        case let .done(url):
            word(actions.useTitle, "use", prominent: true,
                 reason: url == nil ? "The recorder returned no movie." : usingMovie ? "Opening the movie…" : nil) {
                guard let url, !usingMovie else { return }
                usingMovie = true
                Task { @MainActor in
                    defer { usingMovie = false }
                    do { try await actions.useMovie(url) }
                    catch { if model.phase == .done(url) { detail = error.localizedDescription } }
                }
            }
        case .failed:
            Label("Failed", systemImage: "exclamationmark.triangle").foregroundStyle(.orange)
        }
    }

    private var stop: some View { icon("stop.fill", "Stop", "stop", action: model.stop) }

    private func clock(paused: Bool) -> some View {
        let time = RecordingClock.format(model.elapsedMs)
        return HStack(spacing: 4) {
            Image(systemName: paused ? "pause.circle" : "record.circle.fill").foregroundStyle(paused ? Color.secondary : .red)
            Text(time).monospacedDigit()
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(paused ? "Paused" : "Recording").accessibilityValue(time)
        .barStatus("recording.bar.clock")
    }

    @ViewBuilder private var phaseDetails: some View {
        switch model.phase {
        case let .done(url):
            HStack {
                word("Show in Finder", "finder", reason: url == nil ? "The recorder returned no movie." : nil) {
                    if let url { NSWorkspace.shared.activateFileViewerSelecting([url]) }
                }
                newRecording
            }
        case let .failed(message):
            HStack {
                InfoStrip(message, tone: .error).accessibilityElement(children: .combine)
                    .barStatus("recording.bar.failed", label: message)
                newRecording
            }
        default: EmptyView()
        }
    }

    private var newRecording: some View { word("New recording", "newRecording", action: model.newRecording) }

    private var videoOptions: some View {
        HStack(spacing: 7) {
            let qualityReason = reason("quality", live: false)
            choice("Quality", "quality", value: setup.quality, values: RecordingQuality.allCases,
                   title: { $0.rawValue.capitalized }, reason: qualityReason, scope: scope(qualityReason)) { model.apply(.quality($0)) }
            let rateReason = reason("frameRate", live: caps.liveFrameRate)
            choice("While still", "stillFrameRate", value: setup.stillFrameRate, values: [0, 0.5, 1, 2, 5],
                   title: { $0 == 0 ? "Same" : "\($0.formatted()) fps" }, reason: rateReason, scope: scope(rateReason)) {
                model.apply(.frameRate(setup.frameRate, still: $0))
            }
            let thresholdReason = setup.stillFrameRate == 0 || setup.stillFrameRate == Double(setup.frameRate)
                ? "The active and still frame rates are the same."
                : (actions.changeThreshold == nil ? "This recorder has no change threshold." : reason("threshold", live: false))
            choice("Change needed", "threshold", value: draftThreshold,
                   values: [0.5, 1, 2.5, 5], title: { "\($0.formatted())%" },
                   reason: thresholdReason, scope: scope(thresholdReason)) { draftThreshold = $0 }
            let countdownReason = reason("countdown", live: false)
            choice("Countdown", "countdownSeconds", value: setup.countdownSeconds ?? 0, values: Array(0...10),
                   title: { $0 == 0 ? "Off" : "\($0) s" }, reason: countdownReason, scope: scope(countdownReason)) {
                model.setup.countdownSeconds = $0 == 0 ? nil : $0
            }
            let cursorReason = reason("drawsCursor", live: false)
            choice("Cursor", "drawsCursor", value: setup.drawsCursor, values: [true, false], title: { $0 ? "On" : "Off" },
                   reason: cursorReason, scope: scope(cursorReason)) { model.apply(.drawsCursor($0)) }
            Spacer(minLength: 0)
            choice("Placement", "placement", value: placement, values: RecordingPanelPlacement.allCases,
                   title: { $0.title }, scope: nil) {
                placement = $0
                onPlace($0)
            }
        }
    }

    private var deviceReason: String? { reason("microphoneDevice", live: caps.liveMicrophoneDevice && setup.microphone.enabled) }

    @ViewBuilder private var inputChoices: some View {
        Button("System default") { selectInput(nil) }
        ForEach(model.audioInputs) { input in
            Button { selectInput(input.id) } label: {
                if input.id == setup.microphone.deviceID { Label(input.name, systemImage: "checkmark") }
                else { Text(input.name) }
            }
        }
        if configuring && setup.microphone.enabled {
            Divider()
            Button(setup.microphone.muted ? "Unmute microphone" : "Start muted") {
                var next = setup.microphone
                next.muted.toggle()
                model.apply(.microphone(next))
            }
        }
    }

    private func selectInput(_ id: String?) {
        var next = setup.microphone
        next.deviceID = id
        model.apply(.microphone(next))
    }

    private var deviceOptions: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 8) {
                let cameraReason = !setup.camera.enabled ? "Turn on the camera first." : reason("camera", live: caps.liveCamera)
                choice("Camera size", "cameraSize", value: setup.camera.size, values: [140, 200, 260],
                       title: { "\($0) pt" }, reason: cameraReason, scope: scope(cameraReason)) {
                    var next = setup.camera
                    next.size = $0
                    model.apply(.camera(next))
                }
                choice("Shape", "cameraShape", value: setup.camera.shape, values: ["circle", "rounded", "square"],
                       title: { $0.capitalized }, reason: cameraReason, scope: scope(cameraReason)) {
                    var next = setup.camera
                    next.shape = $0
                    model.apply(.camera(next))
                }
                VStack(alignment: .leading) {
                    Text("System output").font(.caption).foregroundStyle(.secondary)
                    Text(outputName ?? "System default").lineLimit(1).truncationMode(.middle)
                }.accessibilityElement(children: .combine)
                Spacer(minLength: 0)
                let displaysReason = reason("displays", live: caps.liveDisplaysAddRemove)
                    ?? (caps.targets.contains(.displays) ? nil : "This recorder captures one display at a time.")
                word("Displays…", "displays", reason: displaysReason) { pick(.displays) }
            }
            HStack(spacing: 6) {
                Text("Microphone").font(.caption).foregroundStyle(.secondary)
                ScrollView(.horizontal) {
                    HStack(spacing: 4) {
                        inputButton(nil, title: "System default")
                        ForEach(model.audioInputs) { input in inputButton(input.id, title: input.name) }
                    }
                }.frame(height: 26)
                if configuring { saveDefaults }
                if live { takeOptions }
            }
        }
    }

    private func inputButton(_ id: String?, title: String) -> some View {
        Button { selectInput(id) } label: {
            Label(title, systemImage: (setup.microphone.deviceID == id) ? "checkmark.circle.fill" : "circle")
                .lineLimit(1).frame(minWidth: 24, minHeight: 24)
        }
        .buttonStyle(.genHoverRow()).fixedSize()
        .barControl("input.\(id ?? "default")", label: title, value: setup.microphone.deviceID == id ? "Selected" : "",
                    reason: deviceReason, scope: scope(deviceReason))
    }

    private var saveDefaults: some View {
        VStack(alignment: .leading, spacing: 1) {
            word("Save as Defaults", "saveDefaults") {
                model.saveAsDefaults()
                saved = setup
                if let threshold = actions.threshold {
                    defaults.set(draftThreshold, forKey: "recorder.capture.threshold")
                    threshold.opening = draftThreshold
                }
                detail = "Saved recording defaults."
            }
            if let changes = changedSources { Text(changes).font(.caption).foregroundStyle(.secondary) }
        }
    }

    private var changedSources: String? {
        var changes: [String] = []
        if setup.microphone != saved.microphone {
            let mic = setup.microphone
            let device = mic.deviceID.flatMap { inputNames[$0] } ?? mic.deviceID ?? "system default"
            changes.append("Microphone \(soundState(mic.enabled, mic.muted).lowercased()), \(device)")
        }
        if setup.systemAudio != saved.systemAudio {
            changes.append("System audio \(soundState(setup.systemAudio.enabled, setup.systemAudio.muted).lowercased())")
        }
        if setup.camera != saved.camera {
            changes.append("Camera \(setup.camera.enabled ? "on" : "off"), \(setup.camera.size) pt \(setup.camera.shape)")
        }
        return changes.isEmpty ? nil : changes.joined(separator: " · ")
    }

    @ViewBuilder private var takeOptions: some View {
        if let confirmation {
            Text(confirmation == .discard ? "Discard this take?" : "Replace this take?")
            word("Keep", "keep") { self.confirmation = nil }
            word(confirmation == .discard ? "Discard" : "Restart", "confirm") { run(confirmation) }
        } else {
            let phase = model.phase
            word("Add marker", "marker", reason: !recording ? "Resume recording to add a marker."
                 : actions.addMarker == nil ? "This recorder does not support markers." : marking ? "Adding marker…" : nil) {
                guard let add = actions.addMarker, !marking else { return }
                marking = true
                Task { @MainActor in
                    defer { marking = false }
                    do {
                        try await add()
                        if model.phase == phase { detail = "Marker added." }
                    } catch {
                        if model.phase == phase { detail = error.localizedDescription }
                    }
                }
            }
            word("Restart", "restart") { confirm(.restart) }
            word("Discard", "discard") { confirm(.discard) }
        }
    }

    private func confirm(_ action: Confirmation) {
        if defaults.object(forKey: RecordingSettings.Key.confirmsDiscard) as? Bool ?? true { confirmation = action }
        else { run(action) }
    }

    private func run(_ action: Confirmation) {
        confirmation = nil
        if action == .discard { model.discard() } else { model.restart() }
    }

    private func close() {
        actions.closeSetupIfNeeded(model)
        actions.hide()
    }

    private func scope(_ reason: String?) -> String? { live ? (reason == nil ? "This take" : "Next recording") : nil }

    private func icon(_ symbol: String, _ label: String, _ id: String, value: String = "", reason: String? = nil,
                      scope: String? = nil, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: symbol).frame(width: 24, height: 26).contentShape(Rectangle())
        }
        .buttonStyle(.genHover(padding: EdgeInsets()))
        .barControl(id, label: label, value: value, reason: reason, scope: scope)
    }

    private func word(_ label: String, _ id: String, prominent: Bool = false, reason: String? = nil,
                      action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Text(label).fontWeight(prominent ? .semibold : .regular).lineLimit(1)
                .padding(.horizontal, 5).frame(minWidth: 24, minHeight: 26)
                .background(prominent ? Color.accentColor.opacity(0.25) : .clear, in: RoundedRectangle(cornerRadius: 5))
        }
        .fixedSize().buttonStyle(.genHoverRow())
        .barControl(id, label: label, reason: reason)
    }

    private func showMenu(_ title: String, options: [String], selected: Int?, choose: @escaping (Int) -> Void) {
        let returnToCompact = liveMenu?.returnToCompact ?? !model.expanded
        liveMenu = LiveMenu(title: title, options: options, selected: selected, choose: choose, returnToCompact: returnToCompact)
        model.expanded = true
    }

    private func closeMenu(_ menu: LiveMenu) {
        liveMenu = nil
        if menu.returnToCompact { model.expanded = false }
    }

    private func menuRow(_ menu: LiveMenu) -> some View {
        HStack {
            Text(menu.title)
            ScrollView(.horizontal) {
                HStack(spacing: 5) {
                    ForEach(menu.options.indices, id: \.self) { index in
                        Button {
                            closeMenu(menu)
                            menu.choose(index)
                        } label: {
                            Label(menu.options[index], systemImage: index == menu.selected ? "checkmark.circle.fill" : "circle")
                                .frame(minWidth: 24, minHeight: 24)
                        }.buttonStyle(.genHoverRow()).fixedSize()
                    }
                }
            }.frame(height: 26)
            word("Close", "closeMenu") { closeMenu(menu) }
        }
    }

    @ViewBuilder private func choice<Value: Hashable>(_ label: String, _ id: String, value: Value, values: [Value],
                                         title: @escaping (Value) -> String, reason: String? = nil, scope: String?,
                                         compact: Bool = false, select: @escaping (Value) -> Void) -> some View {
        let face = VStack(alignment: .leading, spacing: 1) {
            if !compact { Text(label).font(.caption).foregroundStyle(.secondary) }
            HStack(spacing: 3) {
                Text(title(value)).lineLimit(1)
                Image(systemName: "chevron.down").font(.caption2)
            }
            if !compact, let scope { Text(scope).font(.caption).foregroundStyle(.secondary) }
        }.frame(minWidth: 24, minHeight: 26)
        Group {
            if useInlineMenus {
                Button {
                    showMenu(label, options: values.map(title), selected: values.firstIndex(of: value)) { select(values[$0]) }
                } label: { face }
                .buttonStyle(.genHoverRow())
            } else {
                Menu {
                    ForEach(values, id: \.self) { option in
                        Button { select(option) } label: {
                            if value == option { Label(title(option), systemImage: "checkmark") }
                            else { Text(title(option)) }
                        }
                    }
                } label: { face }
                .menuStyle(.borderlessButton).menuIndicator(.hidden)
            }
        }
        .fixedSize()
        .barControl(id, label: label, value: title(value), reason: reason, scope: scope)
    }
}

private extension View {
    func barStatus(_ identifier: String, label: String? = nil) -> some View {
        accessibilityIdentifier(identifier).modifier(RecordingBarProbe(identifier, label: label))
    }

    func barControl(_ id: String, label: String, value: String = "", reason: String? = nil, scope: String? = nil) -> some View {
        let identifier = "recording.bar.\(id)"
        let hint = scope.map { timing in reason.map { "\(timing). \($0)" } ?? timing } ?? reason ?? ""
        let tip = label + (value.isEmpty ? "" : " · \(value)") + (hint.isEmpty ? "" : " · \(hint)")
        return modifier(RecordingBarProbe(identifier, label: label, hint: hint))
            .disabled(reason != nil)
            .modifier(RecordingBarHover(text: tip))
            .accessibilityLabel(Text(label))
            .accessibilityValue(Text(value))
            .accessibilityHint(Text(hint))
            .accessibilityIdentifier(identifier)
    }
}

/// The test host requests just the controls it needs from its own window.
private struct RecordingBarProbeIDs: EnvironmentKey {
    static let defaultValue: Set<String> = []
}

extension EnvironmentValues {
    var recordingBarProbeIDs: Set<String> {
        get { self[RecordingBarProbeIDs.self] }
        set { self[RecordingBarProbeIDs.self] = newValue }
    }
}

struct RecordingBarProbe: ViewModifier {
    struct State: Equatable {
        let isEnabled: Bool
        let label: String?
        let hint: String
    }

    /// A preference contains only mounted controls. FrameProbe retains a control's last geometry after it disappears.
    enum Controls: PreferenceKey {
        static var defaultValue: [String: State] { [:] }
        static func reduce(value: inout [String: State], nextValue: () -> [String: State]) {
            value.merge(nextValue(), uniquingKeysWith: { _, next in next })
        }
    }

    @Environment(\.recordingBarProbeIDs) private var requested
    @Environment(\.isEnabled) private var isEnabled
    private let id: String
    private let label: String?
    private let hint: String

    init(_ id: String, label: String?, hint: String = "") {
        self.id = id
        self.label = label
        self.hint = hint
    }

    func body(content: Content) -> some View {
        if FrameProbe.enabled, requested.contains(id) {
            content.frameProbe(id)
                .preference(key: Controls.self, value: [id: State(isEnabled: isEnabled, label: label, hint: hint)])
        } else {
            content
        }
    }
}

/// The tooltip occupies the bar's source-summary line. A separate tooltip window would enter a display recording.
private enum RecordingBarHelp: PreferenceKey {
    static var defaultValue: String? { nil }
    static func reduce(value: inout String?, nextValue: () -> String?) {
        if let next = nextValue() { value = next }
    }
}

private struct RecordingBarHover: ViewModifier {
    let text: String
    @State private var hovered = false
    func body(content: Content) -> some View {
        content.onHover { hovered = $0 }.preference(key: RecordingBarHelp.self, value: hovered ? text : nil)
    }
}
