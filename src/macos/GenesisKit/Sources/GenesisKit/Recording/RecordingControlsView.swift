import AppKit
import SwiftUI

/// What the recording controls show. A value, so a host (or a test) can draw any moment of a recording.
public struct RecordingControlsState: Equatable {
    public var phase: RecordingPhase
    public var elapsedMs: Double
    public var limitMs: Double
    public var target: RecordingTarget?
    /// `user`, `limit` or `recorder` while paused.
    public var pauseReason: String?
    public var notice: String?
    /// Why the start takes long: the recorder compiles after an update, or no first frame came yet.
    public var preparing: String?
    /// The host's name for stopping and keeping the movie: "Stop and paste", "Stop and save".
    public var useTitle: String
    public var useSymbol: String
    /// Discard and Restart ask once inside the controls first (`RecordingSettings.confirmsDiscard`).
    public var confirmsDiscard: Bool

    public init(phase: RecordingPhase, elapsedMs: Double = 0, limitMs: Double = 600_000, target: RecordingTarget? = nil,
                pauseReason: String? = nil, notice: String? = nil, preparing: String? = nil, useTitle: String,
                useSymbol: String = "stop.fill", confirmsDiscard: Bool = true) {
        self.phase = phase
        self.elapsedMs = elapsedMs
        self.limitMs = limitMs
        self.target = target
        self.pauseReason = pauseReason
        self.notice = notice
        self.preparing = preparing
        self.useTitle = useTitle
        self.useSymbol = useSymbol
        self.confirmsDiscard = confirmsDiscard
    }
}

/// What the recording controls do. Each closure is one of Martin's actions: pause or resume, switch what is recorded,
/// restart, stop and use the movie, stop and discard it.
public struct RecordingControlsActions {
    public var pause: () -> Void
    public var resume: () -> Void
    public var switchTarget: () -> Void
    public var restart: () -> Void
    public var use: () -> Void
    public var discard: () -> Void
    public var dismissNotice: () -> Void
    /// The person dragged the controls somewhere else.
    public var moved: () -> Void

    public init(pause: @escaping () -> Void, resume: @escaping () -> Void, switchTarget: @escaping () -> Void,
                restart: @escaping () -> Void, use: @escaping () -> Void, discard: @escaping () -> Void,
                dismissNotice: @escaping () -> Void = {}, moved: @escaping () -> Void = {}) {
        self.pause = pause
        self.resume = resume
        self.switchTarget = switchTarget
        self.restart = restart
        self.use = use
        self.discard = discard
        self.dismissNotice = dismissNotice
        self.moved = moved
    }
}

/// A recording's elapsed time as `m:ss`, or `h:mm:ss` from an hour on.
public enum RecordingClock {
    public static func format(_ milliseconds: Double) -> String {
        let total = max(0, Int(milliseconds / 1000))
        let hours = total / 3600
        let minutes = (total % 3600) / 60
        let seconds = total % 60
        return hours > 0
            ? String(format: "%d:%02d:%02d", hours, minutes, seconds)
            : String(format: "%d:%02d", minutes, seconds)
    }
}

/// The controls' state as something to observe, so a host sets the view up once and only the values change (its
/// own state, such as an open discard question, survives the clock's ticks).
@MainActor
final class RecordingControlsModel: ObservableObject {
    @Published var state: RecordingControlsState

    init(state: RecordingControlsState) {
        self.state = state
    }
}

struct RecordingControlsHost: View {
    @ObservedObject var model: RecordingControlsModel
    let actions: RecordingControlsActions

    var body: some View {
        RecordingControlsView(state: model.state, actions: actions)
    }
}

/// The icon of a running app by pid, looked up once per pid: the controls redraw every second while recording.
@MainActor
enum RecordingAppIcon {
    private static var cache: [Int32: NSImage] = [:]

    static func image(pid: Int32?) -> NSImage? {
        guard let pid, pid > 0 else { return nil }
        if let cached = cache[pid] { return cached }
        guard let icon = NSRunningApplication(processIdentifier: pid)?.icon else { return nil }
        cache[pid] = icon
        return icon
    }
}

/// The small floating controls of a running recording: the recorded time with a red dot, what is recorded (a click
/// switches it), pause or resume, restart, the host's "stop and use" action and stop and discard. The leading part
/// (grip, dot and time) moves the window. Generic: the host names the use action and decides what it does.
public struct RecordingControlsView: View {
    private let state: RecordingControlsState
    private let actions: RecordingControlsActions
    @State private var confirming: Confirmation?
    @GenReduceMotion private var reduceMotion

    private enum Confirmation: Equatable { case discard, restart }

    public init(state: RecordingControlsState, actions: RecordingControlsActions) {
        self.state = state
        self.actions = actions
    }

    private var busy: Bool { state.phase == .finishing || !state.phase.isActive }
    private var paused: Bool { state.phase == .paused }
    /// Under a minute left before the length limit, the clock says so.
    private var remainingMs: Double? {
        let left = state.limitMs - state.elapsedMs
        return state.phase == .recording && left < 60_000 ? max(0, left) : nil
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 8) {
                status
                if let confirming {
                    confirmation(confirming)
                        .transition(.opacity)
                } else {
                    targetChip
                    controls
                        .transition(.opacity)
                }
            }
            if state.phase == .starting, let preparing = state.preparing {
                preparingRow(preparing)
            }
            if let notice = state.notice {
                noticeRow(notice)
            }
        }
        .padding(.leading, 6)
        .padding(.trailing, 8)
        .padding(.vertical, 6)
        .frame(minHeight: 44)
        .modifier(NativeGlassShapeSurface(shape: RoundedRectangle(cornerRadius: 14, style: .continuous)))
        .environment(\.colorScheme, .dark)
        .animation(reduceMotion ? nil : .easeOut(duration: 0.16), value: confirming)
        .onChange(of: state.phase) { old, phase in
            if !phase.isActive || phase == .finishing { confirming = nil }
            announce(from: old, to: phase)
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Recording controls")
    }

    /// Phases change by themselves (the recorder starts late, the limit pauses), so VoiceOver is told.
    private func announce(from old: RecordingPhase, to phase: RecordingPhase) {
        switch phase {
        case .recording:
            GenAnnounce.post(old == .paused ? "Recording resumed" : "Recording started")
        case .paused:
            GenAnnounce.post(state.pauseReason == "limit" ? "Recording paused, the length limit is reached" : "Recording paused")
        case .finishing:
            GenAnnounce.post("Recording stopped, saving")
        default:
            break
        }
    }

    // MARK: Status (the drag area)

    private var status: some View {
        HStack(spacing: 7) {
            RecordingGrip()
            indicator
            VStack(alignment: .leading, spacing: 0) {
                Text(verbatim: RecordingClock.format(state.elapsedMs))
                    .font(.system(size: 13, weight: .semibold).monospacedDigit())
                    .foregroundStyle(paused ? .secondary : .primary)
                if let caption = statusCaption {
                    Text(caption).font(.system(size: 11, weight: .medium))
                        .foregroundStyle(captionColor)
                        .lineLimit(1)
                }
            }
            .frame(minWidth: 48, alignment: .leading)
        }
        .padding(.leading, 4)
        .padding(.trailing, 2)
        .frame(maxHeight: .infinity)
        .contentShape(Rectangle())
        .allowsHitTesting(false)
        .background(RecordingWindowDragArea(dragged: actions.moved))
        .accessibilityElement(children: .combine)
        .accessibilityLabel(accessibilityStatus)
        .frameProbe("recording.status")
    }

    @ViewBuilder private var indicator: some View {
        switch state.phase {
        case .starting, .finishing:
            ProgressView().controlSize(.mini).frame(width: 12, height: 12)
        case .paused:
            Image(systemName: "pause.circle.fill").font(.system(size: 12)).foregroundStyle(.orange)
        case .recording:
            Circle().fill(Color.red).frame(width: 9, height: 9)
                .shadow(color: .red.opacity(0.7), radius: 3)
        default:
            Circle().fill(Color.secondary).frame(width: 9, height: 9)
        }
    }

    private var statusCaption: String? {
        switch state.phase {
        case .starting: return "Starting"
        case .finishing: return "Saving"
        case .paused:
            return state.pauseReason == "limit" ? "Limit reached" : "Paused"
        case .recording:
            return remainingMs.map { "\(RecordingClock.format($0)) left" }
        default:
            return nil
        }
    }

    private var captionColor: Color {
        state.phase == .paused || remainingMs != nil ? .orange : RecordingInk.readable
    }

    private var accessibilityStatus: String {
        let time = RecordingClock.format(state.elapsedMs)
        switch state.phase {
        case .starting: return state.preparing.map { "Starting the recording. \($0)" } ?? "Starting the recording"
        case .recording: return "Recording, \(time)"
        case .paused: return "Paused at \(time)"
        case .finishing: return "Saving the recording"
        default: return "Recording ended"
        }
    }

    // MARK: Target

    private var targetChip: some View {
        Button(action: actions.switchTarget) {
            HStack(spacing: 6) {
                if let icon = RecordingAppIcon.image(pid: state.target?.pid) {
                    Image(nsImage: icon).resizable().interpolation(.high).frame(width: 16, height: 16)
                } else {
                    Image(systemName: state.target?.symbol ?? "rectangle.dashed").font(.system(size: 11))
                        .frame(width: 16, height: 16)
                }
                Text(state.target?.title ?? "Choose what to record")
                    .font(.system(size: 12, weight: .medium))
                    .lineLimit(1).truncationMode(.middle)
                    .frame(maxWidth: 180, alignment: .leading)
                Image(systemName: "chevron.down").font(.system(size: 8, weight: .bold)).foregroundStyle(.secondary)
            }
            .padding(.horizontal, 8)
            .padding(.vertical, 5)
            .background(.white.opacity(0.07), in: RoundedRectangle(cornerRadius: 8, style: .continuous))
            .contentShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
        }
        .buttonStyle(.genHoverPlain())
        .disabled(busy)
        .instantTooltip("Record something else")
        .accessibilityLabel("Recording \(state.target?.title ?? "nothing"). Switch what is recorded")
        .accessibilityIdentifier("recording.switch")
        .frameProbe("recording.switch")
    }

    // MARK: Controls

    private var controls: some View {
        HStack(spacing: 6) {
            Group {
                if paused {
                    IconButton(systemName: "play.fill", tooltip: state.pauseReason == "limit" ? "The length limit is reached" : "Resume",
                               size: 13, action: actions.resume)
                        .disabled(state.pauseReason == "limit")
                        .accessibilityIdentifier("recording.resume")
                        .frameProbe("recording.resume")
                } else {
                    IconButton(systemName: "pause.fill", tooltip: "Pause", size: 13, action: actions.pause)
                        .disabled(busy)
                        .accessibilityIdentifier("recording.pause")
                        .frameProbe("recording.pause")
                }
            }
            IconButton(systemName: "arrow.counterclockwise", tooltip: "Restart: discard what was recorded and start again",
                       size: 13) {
                ask(.restart, then: actions.restart)
            }
            .disabled(busy)
            .accessibilityIdentifier("recording.restart")
            .frameProbe("recording.restart")
            Rectangle().fill(.white.opacity(0.14)).frame(width: 1, height: 20).padding(.horizontal, 2)
            Button(action: actions.use) {
                HStack(spacing: 5) {
                    Image(systemName: state.useSymbol).font(.system(size: 10, weight: .bold))
                    Text(state.useTitle).font(.system(size: 12, weight: .semibold)).lineLimit(1)
                }
                .foregroundStyle(.white)
                .padding(.horizontal, 10)
                .padding(.vertical, 6)
                .background(Color.red.opacity(busy ? 0.4 : 0.88), in: Capsule())
                .contentShape(Capsule())
            }
            .buttonStyle(.genHoverPlain(brighten: 0.12))
            .disabled(busy)
            .fixedSize()
            .accessibilityLabel(state.useTitle)
            .accessibilityIdentifier("recording.use")
            .frameProbe("recording.use")
            IconButton(systemName: "trash", tooltip: "Discard the recording", size: 13) {
                ask(.discard, then: actions.discard)
            }
            .disabled(busy)
            .accessibilityIdentifier("recording.discard")
            .frameProbe("recording.discard")
        }
        // While the movie is saved nothing can be pressed, and it shows.
        .opacity(busy ? 0.45 : 1)
    }

    private func ask(_ confirmation: Confirmation, then action: @escaping () -> Void) {
        // Nothing recorded yet means nothing to lose.
        if state.confirmsDiscard && state.elapsedMs >= 1000 {
            confirming = confirmation
        } else {
            action()
        }
    }

    private func confirmation(_ kind: Confirmation) -> some View {
        HStack(spacing: 8) {
            Text(kind == .discard
                 ? "Discard \(RecordingClock.format(state.elapsedMs)) of recording?"
                 : "Restart and discard \(RecordingClock.format(state.elapsedMs))?")
                .font(.system(size: 12, weight: .medium))
                .lineLimit(1)
                .fixedSize()
            Button {
                confirming = nil
                kind == .discard ? actions.discard() : actions.restart()
            } label: {
                Text(kind == .discard ? "Discard" : "Restart")
                    .font(.system(size: 12, weight: .semibold)).foregroundStyle(.white)
                    .padding(.horizontal, 10).padding(.vertical, 5)
                    .background(Color.red.opacity(0.88), in: Capsule())
                    .contentShape(Capsule())
            }
            .buttonStyle(.genHoverPlain(brighten: 0.12))
            .fixedSize()
            .accessibilityIdentifier("recording.confirm")
            .frameProbe("recording.confirm")
            Button {
                confirming = nil
            } label: {
                Text("Keep").font(.system(size: 12, weight: .medium))
                    .padding(.horizontal, 10).padding(.vertical, 5)
                    .background(.white.opacity(0.1), in: Capsule())
                    .contentShape(Capsule())
            }
            .buttonStyle(.genHoverPlain())
            .fixedSize()
            .accessibilityIdentifier("recording.keep")
            .frameProbe("recording.keep")
        }
    }

    private func preparingRow(_ text: String) -> some View {
        HStack(alignment: .top, spacing: 6) {
            Image(systemName: "hourglass").font(.system(size: 10)).foregroundStyle(.secondary)
            Text(text).font(.system(size: 11)).foregroundStyle(RecordingInk.readable)
                .lineLimit(3).fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: 420, alignment: .leading)
            Spacer(minLength: 0)
        }
        .padding(.leading, 6)
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("recording.preparing")
    }

    private func noticeRow(_ notice: String) -> some View {
        HStack(alignment: .top, spacing: 6) {
            Image(systemName: "exclamationmark.triangle.fill").font(.system(size: 10)).foregroundStyle(.orange)
            Text(notice).font(.system(size: 11)).foregroundStyle(RecordingInk.readable)
                .lineLimit(3).fixedSize(horizontal: false, vertical: true)
                .textSelection(.enabled)
                .frame(maxWidth: 420, alignment: .leading)
            Spacer(minLength: 0)
            IconButton(systemName: "xmark", tooltip: "Dismiss", size: 9, action: actions.dismissNotice)
        }
        .padding(.leading, 6)
    }
}

/// Six dots: the grip that says the controls can be dragged.
private struct RecordingGrip: View {
    var body: some View {
        Grid(horizontalSpacing: 2.5, verticalSpacing: 2.5) {
            ForEach(0..<3, id: \.self) { _ in
                GridRow {
                    Circle().frame(width: 2.5, height: 2.5)
                    Circle().frame(width: 2.5, height: 2.5)
                }
            }
        }
        .foregroundStyle(.white.opacity(0.35))
        .accessibilityHidden(true)
    }
}
