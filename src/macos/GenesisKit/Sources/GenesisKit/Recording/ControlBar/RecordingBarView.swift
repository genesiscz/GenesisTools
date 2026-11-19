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

/// Which way the options drawer opens: away from the screen edge the bar sits near, so the first row never moves.
public enum RecordingBarGrowth: Equatable, Sendable { case down, up }

/// The window's side of the drawer's motion. The view says when a change starts and ends; the panel resizes its
/// window once per change: at the start of an opening (so the drawer has room) and at the end of a closing (so the
/// drawer closes inside the window). A bar without a panel (a still) keeps the defaults.
@MainActor
final class RecordingBarMotion: ObservableObject {
    @Published var growth: RecordingBarGrowth = .down
    /// The way the drawer should open from where the window is now.
    var decideGrowth: () -> RecordingBarGrowth = { .down }
    /// Makes the window `height` tall now, the first row where it is.
    var reserve: (CGFloat) -> Void = { _ in }
    /// The drawer finished closing: the window takes the content's size.
    var settle: () -> Void = {}
    /// A picture of the motion: the drawer revealed this far (0 to 1), still. Nil in use.
    @Published var stillFraction: CGFloat?
    /// True from the start of a drawer change until its animation ends; the window never shrinks meanwhile.
    private(set) var moving = false

    func begin() { moving = true }

    func end() {
        moving = false
        settle()
    }
}

/// Sizes shared by every cell of the bar, so the cells line up in every phase.
enum RecordingBarMetrics {
    static let cell: CGFloat = 32
    static let radius: CGFloat = 8
    static let targetWidth: CGFloat = 160
    static let corner: CGFloat = 15
}

/// How the recording bar looks: its surface and the style of its controls. The layout is the same in both. A setting
/// (Settings → Recorder → Recording bar), stored under `recorder.bar.look` and read when the bar opens.
public enum RecordingBarLook: String, CaseIterable, Identifiable, Sendable {
    /// Near-black like CleanShot X's recording bar, with the kit's aurora controls. The default since 2026-11-19.
    case dark
    /// The look before 2026-11-19: the system glass surface and the app's own control look.
    case glass

    public static let key = "recorder.bar.look"

    public var id: String { rawValue }

    public var title: String {
        switch self {
        case .dark: return "Dark"
        case .glass: return "Glass"
        }
    }

    public var detail: String {
        switch self {
        case .dark: return "Near-black, like the CleanShot X recording bar."
        case .glass: return "The system glass of the earlier bar."
        }
    }

    public static func load(_ defaults: UserDefaults) -> RecordingBarLook {
        defaults.string(forKey: key).flatMap(Self.init(rawValue:)) ?? .dark
    }
}

/// The bar's backdrop for each look. Only the backdrop and the kit look of the controls change.
private struct RecordingBarSurface: ViewModifier {
    let look: RecordingBarLook

    @ViewBuilder func body(content: Content) -> some View {
        switch look {
        case .dark:
            let shape = RoundedRectangle(cornerRadius: RecordingBarMetrics.corner, style: .continuous)
            content
                .background {
                    shape.fill(Color(white: 0.085).opacity(0.94))
                        .overlay(shape.strokeBorder(Color.white.opacity(0.11), lineWidth: 1))
                }
                .clipShape(shape)
                .kitLook(.aurora)
        case .glass:
            content
                .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
                .nativeGlassSurface(radius: 12)
        }
    }
}

@MainActor
public struct RecordingBarView: View {
    static let width: CGFloat = 704
    @ObservedObject private var model: RecordingBarModel
    @StateObject private var motion: RecordingBarMotion
    private let actions: RecordingBarActions
    private let defaults: UserDefaults
    private let barLook: RecordingBarLook
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
    /// The drawer is in the view tree (it stays while it closes).
    @State private var drawerMounted = false
    /// The drawer is revealed; the only value its motion animates.
    @State private var drawerOpen = false
    @State private var drawerHeight: CGFloat = 0
    @State private var headHeight: CGFloat = 0
    /// Each drawer change gets a number, so a late completion of an interrupted change does nothing.
    @State private var drawerChange = 0
    @State private var pendingOpen = false
    @GenReduceMotion private var reduceMotion

    private enum Confirmation: Equatable { case discard, restart }

    public init(model: RecordingBarModel, actions: RecordingBarActions, defaults: UserDefaults = .standard,
                placement: RecordingPanelPlacement = .nearTarget, look: RecordingBarLook = .dark,
                onPlace: @escaping (RecordingPanelPlacement) -> Void = { _ in }, onDrag: @escaping () -> Void = {}) {
        self.init(model: model, actions: actions, defaults: defaults, placement: placement, look: look,
                  motion: RecordingBarMotion(), onPlace: onPlace, onDrag: onDrag)
    }

    init(model: RecordingBarModel, actions: RecordingBarActions, defaults: UserDefaults, placement: RecordingPanelPlacement,
         look: RecordingBarLook, motion: RecordingBarMotion, onPlace: @escaping (RecordingPanelPlacement) -> Void,
         onDrag: @escaping () -> Void) {
        self.model = model
        _motion = StateObject(wrappedValue: motion)
        self.actions = actions
        self.defaults = defaults
        barLook = look
        self.onPlace = onPlace
        self.onDrag = onDrag
        _draftThreshold = actions.changeThreshold ?? .constant(0.5)
        _placement = State(initialValue: placement)
        _saved = State(initialValue: RecordingSetup.load(defaults))
        // A bar that opens expanded (a setting, a picture) shows its drawer from the first frame.
        _drawerMounted = State(initialValue: model.expanded)
        _drawerOpen = State(initialValue: model.expanded)
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
    private var follows: Bool { setup.target == .followDisplay || (actions.followsDisplayInUse && setup.target == nil) }
    /// The display a following take records now: the engine's report while live, else the host's guess.
    private var followedNow: RecordingDisplay? { model.liveDisplay ?? actions.followedDisplay?.wrappedValue }
    /// While a take may be filmed, a menu would open a window of its own on the recorded screen. The bar's own
    /// drawer stays inside its excluded window, so the options open there instead.
    private var optionsInBar: Bool {
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
        let growth = motion.growth
        VStack(alignment: .leading, spacing: 0) {
            if growth == .up { drawer }
            head.onGeometryChange(for: CGFloat.self, of: { $0.size.height }) { headHeight = $0 }
            if growth == .down { drawer }
        }
        .frame(width: Self.width, alignment: .leading)
        .modifier(RecordingBarSurface(look: barLook))
        .environment(\.colorScheme, .dark)
        .font(.system(size: 12))
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Recording controls")
        .onPreferenceChange(RecordingBarHelp.self) { help = $0 }
        .onChange(of: model.expanded) { _, expanded in setDrawer(open: expanded) }
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

    // MARK: The first rows

    private var head: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 4) {
                RecordingGrip().frame(width: 14, height: RecordingBarMetrics.cell)
                    .overlay(RecordingWindowDragArea(dragged: onDrag))
                cell("xmark", configuring ? "Close setup" : "Hide controls", "hide", action: close)
                separator
                target
                separator
                soundControls
                separator
                fpsCell
                optionsCell
                Spacer(minLength: 8)
                phaseArea
            }
            .frame(height: RecordingBarMetrics.cell)
            statusLine
            notes
        }
        .padding(.horizontal, 8).padding(.top, 7).padding(.bottom, 8)
    }

    private var separator: some View {
        Rectangle().fill(Color.white.opacity(0.12)).frame(width: 1, height: 18).padding(.horizontal, 2)
            .accessibilityHidden(true)
    }

    private var statusLine: some View {
        HStack(spacing: 8) {
            Text(help ?? statusSummary).font(.system(size: 11)).foregroundStyle(.white.opacity(0.62))
                .lineLimit(1).truncationMode(.tail)
                .frame(maxWidth: .infinity, alignment: .leading)
                .accessibilityHidden(help != nil)
            if follows { lockToDisplay }
        }
        .frame(height: 16)
        .padding(.leading, 4)
    }

    @ViewBuilder private var lockToDisplay: some View {
        let captured = followedNow
        let lockReason = live && captured == nil ? "Waiting for the recorder to report its display." : nil
        Button {
            if let captured { model.apply(.target(captured.target)); return }
            guard configuring else { return }
            let screens = NSScreen.screens
            guard let index = screens.firstIndex(where: { $0.frame.contains(NSEvent.mouseLocation) }) else { return }
            model.apply(.target(.display(index: index, name: screens[index].localizedName)))
        } label: {
            HStack(spacing: 4) {
                KitButtonGlyph("lock")
                Text("Lock to this display")
            }
        }
        .buttonStyle(KitButtonStyle(kind: .plain, size: .small))
        .fixedSize()
        .barControl("lockDisplay", label: "Lock to this display", reason: lockReason ?? reason("target", live: caps.liveTargetSwitch))
    }

    /// Facts the cells do not show: what is recorded in full, and when a change applies.
    private var statusSummary: String {
        let scope = configuring ? "Next recording" : "This take"
        let what: String
        if follows {
            what = followedNow.map { live ? "Recording \($0.name)" : "\($0.name), the display in use" }
                ?? "Starts on the display in use"
        } else if let target = setup.target {
            what = target.title
        } else {
            what = "Choose what to record"
        }
        let mic = setup.microphone.enabled ? (setup.microphone.muted ? "microphone muted" : "microphone") : nil
        let system = setup.systemAudio.enabled ? (setup.systemAudio.muted ? "system audio muted" : "system audio") : nil
        let sound = [mic, system].compactMap { $0 }.joined(separator: " and ")
        return "\(scope) · \(what) · " + (sound.isEmpty ? "No sound" : sound.prefix(1).uppercased() + sound.dropFirst())
    }

    @ViewBuilder private var notes: some View {
        if let notice = model.notice {
            VStack(alignment: .leading, spacing: 4) {
                InfoStrip(notice.message, tone: .warning).accessibilityIdentifier("recording.bar.notice")
                if let take = notice.take, notice.actions.contains(.retryStop) {
                    HStack(spacing: 6) {
                        word("Retry stop", "retryStop") { model.retryStop(take: take) }
                        word("Show controls", "showControls") {
                            if model.notice?.take == take { model.expanded = true }
                        }
                    }
                }
            }
        }
        if let detail {
            HStack(spacing: 8) {
                InfoStrip(detail)
                word("Dismiss", "dismissDetail") { self.detail = nil }
            }
        }
        phaseDetails
    }

    // MARK: Row one

    private var target: some View {
        let title = setup.target?.title ?? (follows ? RecordingTarget.followDisplay.title : "Choose target")
        return Button { pick(nil) } label: {
            HStack(spacing: 6) {
                Image(systemName: setup.target?.symbol ?? "display").font(.system(size: 13, weight: .medium))
                    .foregroundStyle(.white.opacity(0.75))
                Text(title).lineLimit(1).truncationMode(.tail)
                    .frame(maxWidth: .infinity, alignment: .leading)
                Image(systemName: "chevron.down").font(.system(size: 9, weight: .bold)).foregroundStyle(.white.opacity(0.5))
            }
            .padding(.horizontal, 9)
        }
        .buttonStyle(RecordingBarCellStyle(kind: .soft, width: RecordingBarMetrics.targetWidth))
        .barControl("target", label: "Choose what to record", value: title,
                    reason: reason("target", live: caps.liveTargetSwitch), scope: live ? "This take" : nil)
    }

    private func pick(_ kind: RecordingTargetKind?) {
        model.beginTargetSelection { actions.chooseTarget(kind) }
    }

    private func soundState(_ enabled: Bool, _ muted: Bool) -> String {
        enabled ? (muted ? "Muted" : "On") : "Off"
    }

    @ViewBuilder private var soundControls: some View {
        let mic = setup.microphone
        let system = setup.systemAudio
        let micReason = reason("microphone", live: caps.liveMicrophoneMute && mic.enabled,
                               fallback: "Turn the microphone on before recording.")
        let systemReason = reason("systemAudio", live: caps.liveSystemAudioMute && system.enabled,
                                  fallback: "Turn system audio on before recording.")
        HStack(spacing: 0) {
            sourceCell(on: mic.enabled, muted: mic.muted, symbol: mic.enabled ? (mic.muted ? "mic.slash.fill" : "mic.fill") : "mic.slash",
                       label: "Microphone", id: "microphone", reason: micReason) {
                var next = mic
                if live { next.muted.toggle() } else {
                    next.enabled.toggle()
                    next.muted = false
                }
                model.apply(.microphone(next))
            }
            micMenu
        }
        sourceCell(on: system.enabled, muted: system.muted,
                   symbol: system.enabled ? (system.muted ? "speaker.slash.fill" : "speaker.wave.2.fill") : "speaker.slash",
                   label: "System audio", id: "systemAudio", reason: systemReason) {
            var next = system
            if live { next.muted.toggle() } else {
                next.enabled.toggle()
                next.muted = false
            }
            model.apply(.systemAudio(next))
        }
        let cameraReason = reason("camera", live: caps.liveCamera)
        sourceCell(on: setup.camera.enabled, muted: false, symbol: setup.camera.enabled ? "video.fill" : "video.slash",
                   label: "Camera", id: "camera", reason: cameraReason) {
            var next = setup.camera
            next.enabled.toggle()
            model.apply(.camera(next))
        }
    }

    /// A source the take records: its glyph, and a check mark under it while it is on. Muted shows the slashed glyph
    /// in the warning colour and no check; off shows the slashed glyph dimmed.
    private func sourceCell(on: Bool, muted: Bool, symbol: String, label: String, id: String, reason: String?,
                            action: @escaping () -> Void) -> some View {
        let checked = on && !muted
        return Button(action: action) {
            VStack(spacing: 1) {
                Image(systemName: symbol).font(.system(size: 13, weight: .medium))
                    .foregroundStyle(muted ? KitHue.care.ink : (on ? Color.white : Color.white.opacity(0.5)))
                    .frame(height: 15)
                Image(systemName: "checkmark").font(.system(size: 7, weight: .heavy))
                    .foregroundStyle(.white.opacity(0.9)).opacity(checked ? 1 : 0)
            }
        }
        .buttonStyle(RecordingBarCellStyle(kind: on ? .soft : .plain, width: RecordingBarMetrics.cell))
        .barControl(id, label: label, value: soundState(on, muted), reason: reason, scope: scope(reason))
    }

    @ViewBuilder private var micMenu: some View {
        let chevron = Image(systemName: "chevron.down").font(.system(size: 8, weight: .bold))
            .foregroundStyle(.white.opacity(deviceReason == nil ? 0.6 : 0.3))
        if optionsInBar {
            Button { openDrawer() } label: { chevron }
                .buttonStyle(RecordingBarCellStyle(kind: .plain, width: 16))
                .barControl("micMenu", label: "Choose microphone", reason: deviceReason, scope: scope(deviceReason))
        } else {
            MenuButton(style: RecordingBarCellStyle(kind: .plain, width: 16), items: { microphoneItems }) { chevron }
                .barControl("micMenu", label: "Choose microphone", reason: deviceReason, scope: scope(deviceReason))
        }
    }

    private var microphoneItems: [MenuButtonItem] {
        var items: [MenuButtonItem] = [.action("System default", checked: setup.microphone.deviceID == nil) { selectInput(nil) }]
        items += model.audioInputs.map { input in
            .action(input.name, checked: input.id == setup.microphone.deviceID) { selectInput(input.id) }
        }
        if configuring {
            items.append(.divider)
            items.append(.action("Start muted", checked: setup.microphone.muted, enabled: setup.microphone.enabled) {
                var next = setup.microphone
                next.muted.toggle()
                model.apply(.microphone(next))
            })
            items.append(.action(setup.microphone.enabled ? "Don’t record the microphone" : "Record the microphone") {
                var next = setup.microphone
                next.enabled.toggle()
                next.muted = false
                model.apply(.microphone(next))
            })
        }
        return items
    }

    @ViewBuilder private var fpsCell: some View {
        let why = reason("frameRate", live: caps.liveFrameRate)
        let label = HStack(spacing: 4) {
            Text("\(setup.frameRate) fps").monospacedDigit()
            Image(systemName: "chevron.down").font(.system(size: 8, weight: .bold)).foregroundStyle(.white.opacity(0.5))
        }
        if optionsInBar {
            Button { openDrawer() } label: { label }
                .buttonStyle(RecordingBarCellStyle(kind: .plain, width: 64))
                .barControl("frameRate", label: "Frame rate", value: "\(setup.frameRate) fps", reason: why, scope: scope(why))
        } else {
            MenuButton(style: RecordingBarCellStyle(kind: .plain, width: 64), items: {
                [15, 24, 30, 60].map { rate in
                    .action("\(rate) fps", checked: rate == setup.frameRate) { model.changeFrameRate(active: rate) }
                }
            }) { label }
            .barControl("frameRate", label: "Frame rate", value: "\(setup.frameRate) fps", reason: why, scope: scope(why))
        }
    }

    /// "Options": a menu while nothing records, the bar's own drawer while a take may be filmed.
    @ViewBuilder private var optionsCell: some View {
        let label = HStack(spacing: 3) {
            Image(systemName: "slider.horizontal.3").font(.system(size: 12, weight: .medium))
            Image(systemName: "chevron.down").font(.system(size: 8, weight: .bold)).foregroundStyle(.white.opacity(0.5))
                .rotationEffect(.degrees(model.expanded ? 180 : 0))
        }
        let value = model.expanded ? "Expanded" : "Collapsed"
        if optionsInBar || model.expanded {
            Button { model.expanded.toggle() } label: { label }
                .buttonStyle(RecordingBarCellStyle(kind: model.expanded ? .soft : .plain, width: 40))
                .barControl("expand", label: "More recording options", value: value)
        } else {
            MenuButton(style: RecordingBarCellStyle(kind: .plain, width: 40), items: { optionItems }) { label }
                .barControl("expand", label: "More recording options", value: value)
        }
    }

    // MARK: The phase area

    @ViewBuilder private var phaseArea: some View {
        HStack(spacing: 4) {
            if let confirmation {
                Text(confirmation == .discard ? "Discard this take?" : "Start this take again?")
                    .foregroundStyle(.white.opacity(0.85)).lineLimit(1).fixedSize()
                word("Keep", "keep") { self.confirmation = nil }
                Button(confirmation == .discard ? "Discard" : "Restart") { run(confirmation) }
                    .buttonStyle(KitButtonStyle(kind: .primary, hue: .danger, size: .small)).fixedSize()
                    // Red in both bar looks: the classic kit look draws every filled button blue.
                    .kitLook(.aurora)
                    .barControl("confirm", label: confirmation == .discard ? "Discard" : "Restart")
            } else {
                phaseControls
            }
        }
    }

    @ViewBuilder private var phaseControls: some View {
        switch model.phase {
        case .setup:
            Button(action: model.record) {
                HStack(spacing: 6) {
                    RecordDot()
                    Text("Record")
                }
            }
            .buttonStyle(KitButtonStyle(kind: .primary, hue: .danger, size: .large, minWidth: 104))
            // Red in both bar looks: the record affordance is a fix, not a look choice.
            .kitLook(.aurora)
            .fixedSize()
            .barControl("record", label: "Record", reason: setup.target == nil && !follows ? "Choose a recording target first." : nil)
        case let .countdown(seconds):
            HStack(spacing: 6) {
                Text("\(seconds)").font(.system(size: 13, weight: .semibold, design: .rounded)).monospacedDigit()
                    .frame(width: 22, height: 22)
                    .overlay(Circle().strokeBorder(KitHue.danger.ink, lineWidth: 1.5))
                Text("Get ready").foregroundStyle(.white.opacity(0.7))
            }
            .accessibilityElement(children: .ignore).accessibilityLabel("Recording starts in \(seconds) s")
            .barStatus("recording.bar.countdown")
            word("Cancel", "cancel", action: model.discard)
        case let .starting(take):
            HStack(spacing: 6) {
                SpinningArc(color: .white.opacity(0.7), lineWidth: 1.6).frame(width: 12, height: 12)
                Text(waitingTake == take ? "Still waiting" : "Starting…").foregroundStyle(.white.opacity(0.75))
            }
            .barStatus("recording.bar.starting")
            word("Cancel", "cancel", action: model.discard)
        case .recording:
            stopRing(paused: false)
            hairline
            cell("pause.fill", "Pause", "pause", action: model.pause)
            takeCells
        case let .paused(_, byUser):
            stopRing(paused: true)
            hairline
            cell("play.fill", "Resume", "resume", kind: .tinted, hue: .play,
                 reason: byUser ? nil : "Finish choosing a target to resume.", action: model.resume)
            takeCells
        case .finishing:
            HStack(spacing: 6) {
                SpinningArc(color: .white.opacity(0.7), lineWidth: 1.6).frame(width: 12, height: 12)
                Text("Saving…").foregroundStyle(.white.opacity(0.75))
            }
            .barStatus("recording.bar.finishing")
        case let .done(url):
            Button {
                guard let url, !usingMovie else { return }
                usingMovie = true
                Task { @MainActor in
                    defer { usingMovie = false }
                    do { try await actions.useMovie(url) }
                    catch { if model.phase == .done(url) { detail = error.localizedDescription } }
                }
            } label: { Text(actions.useTitle) }
            .buttonStyle(KitButtonStyle(kind: .primary, hue: .play, size: .large, minWidth: 104))
            .fixedSize()
            .barControl("use", label: actions.useTitle,
                        reason: url == nil ? "The recorder returned no movie." : usingMovie ? "Opening the movie…" : nil)
        case .failed:
            Label("Failed", systemImage: "exclamationmark.triangle.fill").foregroundStyle(KitHue.danger.ink)
                .labelStyle(.titleAndIcon)
        }
    }

    /// Restart and discard sit beside pause, as in the running bars of other recorders; both ask once in the bar.
    @ViewBuilder private var takeCells: some View {
        let restartReason = caps.liveRestart ? restartPendingReason
            : (caps.reasonUnavailable["restart"] ?? "This recorder does not offer Restart.")
        hairline
        cell("arrow.counterclockwise", "Restart", "restart", reason: restartReason) { confirm(.restart) }
        hairline
        cell("trash", "Discard", "discard", reason: restartPendingReason) { confirm(.discard) }
    }

    /// Stop, Restart and Discard wait while a Restart runs: the take they would act on is being replaced.
    private var restartPendingReason: String? { model.isRestartPending ? "Restart is in progress." : nil }

    /// The thin line between the running controls (CleanShot's running bar).
    private var hairline: some View {
        Rectangle().fill(Color.white.opacity(0.1)).frame(width: 1, height: RecordingBarMetrics.cell).accessibilityHidden(true)
    }

    /// The stop control: a red ring around a square, and the take's time beside it. A click stops the take.
    private func stopRing(paused: Bool) -> some View {
        let time = RecordingClock.format(model.elapsedMs)
        return Button(action: model.stop) {
            HStack(spacing: 6) {
                ZStack {
                    Circle().strokeBorder(KitHue.danger.ink, lineWidth: 1.8)
                    RoundedRectangle(cornerRadius: 1.5).fill(KitHue.danger.ink).frame(width: 7, height: 7)
                }
                .frame(width: 18, height: 18)
                Text(time).font(.system(size: 13, weight: .semibold)).monospacedDigit()
                    .foregroundStyle(paused ? KitHue.care.ink : KitHue.danger.ink)
            }
            .padding(.horizontal, 8)
        }
        .buttonStyle(RecordingBarCellStyle(kind: .plain, width: nil))
        .fixedSize()
        .barControl("stop", label: "Stop", value: (paused ? "Paused, " : "Recording, ") + time, reason: restartPendingReason)
        // A button style keeps its label's preferences, and a probe replaces the ones inside it: the clock's probe
        // rides beside the button's.
        .overlay { Color.clear.allowsHitTesting(false).barStatus("recording.bar.clock", label: paused ? "Paused" : "Recording") }
    }

    @ViewBuilder private var phaseDetails: some View {
        switch model.phase {
        case let .done(url):
            HStack(spacing: 6) {
                word("Show in Finder", "finder", reason: url == nil ? "The recorder returned no movie." : nil) {
                    if let url { PathOpener.reveal(url.path) }
                }
                newRecording
            }
        case let .failed(message):
            HStack(spacing: 8) {
                InfoStrip(message, tone: .error).accessibilityElement(children: .combine)
                    .barStatus("recording.bar.failed", label: message)
                newRecording
            }
        default: EmptyView()
        }
    }

    private var newRecording: some View { word("New recording", "newRecording", action: model.newRecording) }

    // MARK: Options: one list, drawn as a menu or as the drawer

    private var deviceReason: String? { reason("microphoneDevice", live: caps.liveMicrophoneDevice && setup.microphone.enabled) }

    private var stillReason: String? { reason("frameRate", live: caps.liveFrameRate) }

    private var thresholdReason: String? {
        setup.stillFrameRate == 0 || setup.stillFrameRate == Double(setup.frameRate)
            ? "The active and still frame rates are the same."
            : (actions.changeThreshold == nil ? "This recorder has no change threshold." : reason("threshold", live: false))
    }

    private var cameraOptionReason: String? {
        !setup.camera.enabled ? "Turn on the camera first." : reason("camera", live: caps.liveCamera)
    }

    private var displaysReason: String? {
        reason("displays", live: caps.liveDisplaysAddRemove)
            ?? (caps.targets.contains(.displays) ? nil : "This recorder captures one display at a time.")
    }

    private var recordsFrames: Bool { setup.target?.kind == .displays }
    /// A frames recording keeps an explicit still rate; "Same" is only a movie's.
    private var stillRates: [Double] { RecordingSetup.stillFrameRates.filter { !recordsFrames || $0 > 0 } }
    /// High and Max scale a frames recording; a movie records at its target's native size.
    private var qualities: [RecordingQuality] { recordsFrames ? RecordingQuality.allCases : [.standard] }
    private var qualityReason: String? {
        recordsFrames ? nil : (caps.reasonUnavailable["quality"] ?? "Movies record at the target’s native size.")
    }
    private static let thresholds: [Double] = [0.5, 1, 2.5, 5]
    private static func stillTitle(_ rate: Double) -> String { rate == 0 ? "Same" : "\(number(rate)) fps" }
    /// "0.5", "2.5": one English form, not the system region's ("0,5" on a Czech Mac).
    private static func number(_ value: Double) -> String { String(format: "%g", value) }

    private func choiceItems<Value: Hashable>(_ values: [Value], current: Value, title: (Value) -> String, reason: String?,
                                              select: @escaping (Value) -> Void) -> [MenuButtonItem] {
        var items: [MenuButtonItem] = reason.map { [.note($0)] } ?? []
        items += values.map { value in .action(title(value), checked: value == current, enabled: reason == nil) { select(value) } }
        return items
    }

    /// The setup menu: the macOS screenshot toolbar's "Options" menu, with this recorder's choices.
    private var optionItems: [MenuButtonItem] {
        var items: [MenuButtonItem] = [
            .submenu("Quality", choiceItems(qualities, current: setup.quality, title: { $0.rawValue.capitalized },
                                            reason: qualityReason) { model.apply(.quality($0)) }),
            .submenu("While still", choiceItems(stillRates, current: setup.stillFrameRate, title: Self.stillTitle,
                                                reason: stillReason) { model.changeFrameRate(still: $0) }),
            .submenu("Change needed", choiceItems(Self.thresholds, current: draftThreshold, title: { "\(Self.number($0))%" },
                                                  reason: thresholdReason) { draftThreshold = $0 }),
            .submenu("Countdown", choiceItems(Array(0...10), current: setup.countdownSeconds ?? 0,
                                              title: { $0 == 0 ? "Off" : "\($0) s" }, reason: nil) {
                model.setup.countdownSeconds = $0 == 0 ? nil : $0
            }),
            .action("Show the pointer", checked: setup.drawsCursor) { model.apply(.drawsCursor(!setup.drawsCursor)) },
            .divider,
            .submenu("Camera size", choiceItems([140, 200, 260], current: setup.camera.size, title: { "\($0) pt" },
                                                reason: cameraOptionReason) { size in
                var next = setup.camera
                next.size = size
                model.apply(.camera(next))
            }),
            .submenu("Camera shape", choiceItems(["circle", "rounded", "square"], current: setup.camera.shape,
                                                 title: { $0.capitalized }, reason: cameraOptionReason) { shape in
                var next = setup.camera
                next.shape = shape
                model.apply(.camera(next))
            }),
            .divider,
            .submenu("Microphone", microphoneItems),
            .note("System output: \(outputName ?? "System default")"),
            .divider,
            .submenu("Bar placement", choiceItems(RecordingPanelPlacement.allCases, current: placement, title: { $0.title },
                                                  reason: nil) { place($0) }),
            .action("Record several displays…", enabled: displaysReason == nil) { pick(.displays) },
        ]
        if configuring {
            items.append(.divider)
            items.append(.action("Save as defaults", enabled: changedSources != nil || setup != saved) { saveDefaults() })
            if let changes = changedSources { items.append(.note(changes)) }
        }
        return items
    }

    private func place(_ newValue: RecordingPanelPlacement) {
        placement = newValue
        onPlace(newValue)
    }

    private func selectInput(_ id: String?) {
        var next = setup.microphone
        next.deviceID = id
        model.apply(.microphone(next))
    }

    private func saveDefaults() {
        model.saveAsDefaults()
        saved = setup
        if let threshold = actions.threshold {
            defaults.set(draftThreshold, forKey: "recorder.capture.threshold")
            threshold.opening = draftThreshold
        }
        detail = "Saved recording defaults."
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

    // MARK: The drawer

    private func openDrawer() {
        if !model.expanded { model.expanded = true }
    }

    /// Opens or closes the drawer in one motion. Opening: the drawer is laid out at its full height first, the window
    /// grows once, then the clip reveals it. Closing: the clip closes over it, then the drawer leaves and the window
    /// shrinks once. Under Reduce Motion both are instant.
    private func setDrawer(open: Bool) {
        drawerChange += 1
        let change = drawerChange
        if open {
            if !drawerMounted { motion.growth = motion.decideGrowth() }
            motion.begin()
            if drawerMounted && drawerHeight > 0 {
                reveal(change)
            } else {
                pendingOpen = true
                drawerMounted = true
            }
        } else {
            pendingOpen = false
            motion.begin()
            let finish = {
                guard change == drawerChange else { return }
                drawerMounted = false
                motion.end()
            }
            if let animation = GenMotion.animation(expanding: false, reduceMotion: reduceMotion) {
                withAnimation(animation, completionCriteria: .logicallyComplete) { drawerOpen = false } completion: { finish() }
            } else {
                drawerOpen = false
                finish()
            }
        }
    }

    private func reveal(_ change: Int) {
        motion.reserve(headHeight + drawerHeight)
        let finish = {
            guard change == drawerChange else { return }
            motion.end()
        }
        if let animation = GenMotion.animation(expanding: true, reduceMotion: reduceMotion) {
            withAnimation(animation, completionCriteria: .logicallyComplete) { drawerOpen = true } completion: { finish() }
        } else {
            drawerOpen = true
            finish()
        }
    }

    @ViewBuilder private var drawer: some View {
        if drawerMounted {
            let growth = motion.growth
            drawerContent
                .fixedSize(horizontal: false, vertical: true)
                .onGeometryChange(for: CGFloat.self, of: { $0.size.height }) { height in
                    drawerHeight = height
                    if pendingOpen, height > 0 {
                        pendingOpen = false
                        // Not inside the layout that measured it: the window resize lays the content out again.
                        let change = drawerChange
                        DispatchQueue.main.async { reveal(change) }
                    }
                }
                .frame(height: motion.stillFraction.map { $0 * drawerHeight } ?? (drawerOpen ? drawerHeight : 0),
                       alignment: growth == .down ? .top : .bottom)
                .clipped()
                .opacity(motion.stillFraction.map { min(1, $0 * 1.6) } ?? (drawerOpen ? 1 : 0))
                .accessibilityHidden(!drawerOpen)
        }
    }

    private var drawerContent: some View {
        VStack(alignment: .leading, spacing: 9) {
            if motion.growth == .down { Rectangle().fill(Color.white.opacity(0.1)).frame(height: 1).padding(.bottom, 1) }
            if configuring || !live { setupRows } else { liveRows }
            if live {
                Text("Quality, countdown, the pointer and the camera apply when you set up the next recording.")
                    .font(.system(size: 11)).foregroundStyle(.white.opacity(0.5))
                    .padding(.leading, 12 + Self.labelWidth + 10)
            }
            if motion.growth == .up { Rectangle().fill(Color.white.opacity(0.1)).frame(height: 1).padding(.top, 1) }
        }
        .padding(motion.growth == .down ? .bottom : .top, 10)
        .frame(width: Self.width, alignment: .leading)
    }

    /// The drawer's two columns: a label of one width, then its control, so every label and control lines up.
    private static let labelWidth: CGFloat = 92
    private static let pairWidth: CGFloat = 334

    private func pair(_ label: String, wide: Bool = false, @ViewBuilder _ control: () -> some View) -> some View {
        HStack(spacing: 10) {
            Text(label).font(.system(size: 11, weight: .medium)).foregroundStyle(.white.opacity(0.6))
                .lineLimit(1).frame(width: Self.labelWidth, alignment: .trailing)
            control()
        }
        .frame(width: wide ? nil : Self.pairWidth, alignment: .leading)
    }

    private func row(@ViewBuilder _ content: () -> some View) -> some View {
        HStack(spacing: 8) { content() }.padding(.leading, 12)
    }

    @ViewBuilder private var setupRows: some View {
        row {
            pair("Quality") {
                segmented("Quality", "quality", values: qualities, current: setup.quality,
                          title: { $0.rawValue.capitalized }, reason: qualityReason) { model.apply(.quality($0)) }
            }
            pair("Pointer") {
                segmented("Pointer", "drawsCursor", values: [true, false], current: setup.drawsCursor,
                          title: { $0 ? "Shown" : "Hidden" }, reason: nil) { model.apply(.drawsCursor($0)) }
            }
        }
        row {
            pair("While still") { stillChoice }
            pair("Change needed") {
                segmented("Change needed", "threshold", values: Self.thresholds, current: draftThreshold,
                          title: { "\(Self.number($0))%" }, reason: thresholdReason) { draftThreshold = $0 }
            }
        }
        row {
            if setup.camera.enabled {
                pair("Camera") {
                    segmented("Camera size", "cameraSize", values: [140, 200, 260], current: setup.camera.size,
                              title: { "\($0) pt" }, reason: cameraOptionReason) { size in
                        var next = setup.camera
                        next.size = size
                        model.apply(.camera(next))
                    }
                }
                pair("Shape") {
                    segmented("Shape", "cameraShape", values: ["circle", "rounded", "square"], current: setup.camera.shape,
                              title: { $0.capitalized }, reason: cameraOptionReason) { shape in
                        var next = setup.camera
                        next.shape = shape
                        model.apply(.camera(next))
                    }
                }
            } else {
                pair("Camera") {
                    Text("Off. Turn it on in the bar to set its size and shape.")
                        .font(.system(size: 11)).foregroundStyle(.white.opacity(0.55)).fixedSize()
                }
            }
        }
        row {
            pair("Countdown") {
                KitNumberField("Countdown", value: Binding(get: { setup.countdownSeconds ?? 0 },
                                                           set: { model.setup.countdownSeconds = $0 == 0 ? nil : $0 }),
                               in: 0...10, suffix: .text("s"), size: .small, identifier: "recording.bar.countdownSeconds")
                    .fixedSize()
            }
        }
        row {
            pair("Microphone", wide: true) { microphoneRow }
        }
        row {
            pair("Bar placement", wide: true) { placementChoice }
        }
        row {
            Color.clear.frame(width: Self.labelWidth, height: 1)
            word("Record several displays…", "displays", reason: displaysReason) { pick(.displays) }
            if configuring {
                word("Save as defaults", "saveDefaults") { saveDefaults() }
                if let changes = changedSources {
                    Text(changes).font(.system(size: 11)).foregroundStyle(.white.opacity(0.55)).lineLimit(1)
                }
            }
        }
    }

    private var stillChoice: some View {
        segmented("While still", "stillFrameRate", values: stillRates, current: setup.stillFrameRate,
                  title: { $0 == 0 ? "Same" : Self.number($0) }, reason: stillReason) {
            model.changeFrameRate(still: $0)
        }
    }

    @ViewBuilder private var liveRows: some View {
        row {
            pair("Frame rate") {
                segmented("Frame rate", "liveFrameRate", values: [15, 24, 30, 60], current: setup.frameRate,
                          title: { "\($0) fps" }, reason: reason("frameRate", live: caps.liveFrameRate)) { (rate: Int) in
                    model.changeFrameRate(active: rate)
                }
            }
            pair("While still") { stillChoice }
        }
        row {
            pair("Microphone", wide: true) { microphoneRow }
        }
        row {
            pair("Bar placement", wide: true) { placementChoice }
        }
        row {
            pair("This take", wide: true) {
                HStack(spacing: 6) {
                    word("Add marker", "marker", reason: !recording ? "Resume recording to add a marker."
                         : actions.addMarker == nil ? "This recorder does not support markers." : marking ? "Adding marker…" : nil) {
                        addMarker()
                    }
                    word("Record several displays…", "displays", reason: displaysReason) { pick(.displays) }
                }
            }
        }
    }

    private func addMarker() {
        guard let add = actions.addMarker, !marking else { return }
        let phase = model.phase
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

    private var placementChoice: some View {
        segmented("Bar placement", "placement", values: RecordingPanelPlacement.allCases, current: placement,
                  title: { $0.shortTitle }, reason: nil, scope: false) { place($0) }
    }

    private var microphoneRow: some View {
        HStack(spacing: 4) {
            inputButton(nil, title: "System default")
            ForEach(model.audioInputs) { input in inputButton(input.id, title: input.name) }
            Spacer(minLength: 0)
        }
    }

    private func inputButton(_ id: String?, title: String) -> some View {
        let selected = setup.microphone.deviceID == id
        return Button { selectInput(id) } label: {
            HStack(spacing: 5) {
                KitButtonGlyph(selected ? "checkmark" : "mic")
                Text(title).lineLimit(1)
            }
        }
        .buttonStyle(KitButtonStyle(kind: selected ? .tinted : .ghost, hue: selected ? .play : .neutral, size: .small))
        .fixedSize()
        .barControl("input.\(id ?? "default")", label: title, value: selected ? "Selected" : "",
                    reason: deviceReason, scope: scope(deviceReason))
    }

    private func segmented<Value: Hashable>(_ label: String, _ id: String, values: [Value], current: Value,
                                            title: @escaping (Value) -> String, reason: String?, scope showsScope: Bool = true,
                                            select: @escaping (Value) -> Void) -> some View {
        let items = values.indices.map { GenSegmentedTabs<Int>.Item($0, title(values[$0])) }
        let selection = Binding<Int>(get: { values.firstIndex(of: current) ?? -1 },
                                     set: { if values.indices.contains($0) { select(values[$0]) } })
        return GenSegmentedTabs(label, items: items, selection: selection, minSegmentWidth: 30, size: .small)
            .fixedSize()
            .opacity(reason == nil ? 1 : 0.5)
            .accessibilityElement(children: .contain)
            .barControl(id, label: label, value: title(current), reason: reason, scope: showsScope ? scope(reason) : nil)
    }

    // MARK: Small parts

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

    /// A glyph in a cell of the bar's size.
    private func cell(_ symbol: String, _ label: String, _ id: String, value: String = "", kind: KitButtonKind = .plain,
                      hue: KitHue = .neutral, reason: String? = nil, scope: String? = nil,
                      action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: symbol).font(.system(size: 12, weight: .semibold))
                .foregroundStyle(hue == .neutral ? Color.white.opacity(0.85) : hue.ink)
        }
        .buttonStyle(RecordingBarCellStyle(kind: kind, hue: hue, width: RecordingBarMetrics.cell))
        .barControl(id, label: label, value: value, reason: reason, scope: scope)
    }

    /// A text action of the bar's notes and drawer.
    private func word(_ label: String, _ id: String, reason: String? = nil, action: @escaping () -> Void) -> some View {
        Button(action: action) { Text(label) }
            .buttonStyle(KitButtonStyle(kind: .ghost, size: .small))
            .fixedSize()
            .barControl(id, label: label, reason: reason)
    }
}

/// The white disc of a record button: the sign every recorder uses for "start".
private struct RecordDot: View {
    var body: some View {
        Circle().fill(Color.white).frame(width: 9, height: 9)
            .overlay(Circle().strokeBorder(Color.white.opacity(0.45), lineWidth: 2).padding(-3))
            .padding(3)
            .accessibilityHidden(true)
    }
}

/// A cell of the bar: the look's quiet surface (`soft` for a source that is on, `plain` otherwise), one height for
/// every cell, a hover and a pressed fill inside the cell's own frame, never over its neighbours.
struct RecordingBarCellStyle: ButtonStyle {
    var kind: KitButtonKind = .plain
    var hue: KitHue = .neutral
    /// Nil: as wide as the label.
    var width: CGFloat?

    func makeBody(configuration: Configuration) -> some View {
        RecordingBarCellBody(configuration: configuration, style: self)
    }
}

private struct RecordingBarCellBody: View {
    let configuration: ButtonStyleConfiguration
    let style: RecordingBarCellStyle
    @State private var hovering = false
    @Environment(\.isEnabled) private var isEnabled
    @Environment(\.kitLook) private var look
    @Environment(\.kitForcedInteraction) private var forced
    @GenReduceMotion private var reduceMotion

    private var state: KitInteraction {
        guard isEnabled else { return .rest }
        if configuration.isPressed || forced == .pressed { return .pressed }
        return hovering || forced == .hover ? .hover : .rest
    }

    var body: some View {
        let state = state
        let surface = look.surface(style.kind.role, state, hue: style.hue)
        configuration.label
            .foregroundStyle(.white)
            .frame(width: style.width, height: RecordingBarMetrics.cell)
            .background(KitSurfaceBackground(surface, radius: RecordingBarMetrics.radius))
            .scaleEffect(reduceMotion ? 1 : (state == .pressed ? 0.96 : 1))
            .opacity(isEnabled ? 1 : 0.38)
            .contentShape(RoundedRectangle(cornerRadius: RecordingBarMetrics.radius, style: .continuous))
            .pointerCursor(isEnabled)
            .onHover { inside in
                let next = isEnabled && inside
                guard next != hovering else { return }
                withAnimation(reduceMotion ? nil : KitTheme.quick) { hovering = next }
            }
            .onChange(of: isEnabled) { _, enabled in if !enabled { hovering = false } }
            .onDisappear { hovering = false }
            .animation(reduceMotion ? nil : KitTheme.quick, value: configuration.isPressed)
    }
}

private extension RecordingPanelPlacement {
    /// The words of a segment in the bar's drawer.
    var shortTitle: String {
        switch self {
        case .nearTarget: "Near"
        case .topLeft: "Top left"
        case .topRight: "Top right"
        case .bottomLeft: "Bottom left"
        case .bottomRight: "Bottom right"
        }
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

/// The tooltip occupies the bar's status line. A separate tooltip window would enter a display recording.
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
