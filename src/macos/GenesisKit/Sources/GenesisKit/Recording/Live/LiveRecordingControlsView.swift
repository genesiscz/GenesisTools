import AppKit
import SwiftUI

/// The floating controls of one live recording: the grip, the state dot, the time since it started and its frames,
/// its title, Pause or Resume, Stop, and a button that hides the controls. The look of `RecordingControlsView`.
struct LiveRecordingControlsView: View {
    let recording: LiveRecording
    let send: (LiveRecordingCommand) -> Void
    let hide: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 8) {
                status
                Text(recording.title)
                    .font(.system(size: 12, weight: .medium))
                    .lineLimit(1).truncationMode(.middle)
                    .frame(maxWidth: 200, alignment: .leading)
                    .foregroundStyle(.secondary)
                    .accessibilityIdentifier("live-recording.title")
                controls
            }
            if let error = recording.lastError {
                HStack(alignment: .top, spacing: 6) {
                    Image(systemName: "exclamationmark.triangle.fill").font(.system(size: 10)).foregroundStyle(.orange)
                    Text(error).font(.system(size: 11)).foregroundStyle(SessionPalette.secondary)
                        .lineLimit(3).fixedSize(horizontal: false, vertical: true)
                        .textSelection(.enabled)
                        .frame(maxWidth: 420, alignment: .leading)
                }
                .padding(.leading, 6)
                .accessibilityElement(children: .combine)
                .accessibilityIdentifier("live-recording.error")
            }
        }
        .padding(.leading, 6)
        .padding(.trailing, 8)
        .padding(.vertical, 6)
        .frame(minHeight: 44)
        .modifier(NativeGlassShapeSurface(shape: RoundedRectangle(cornerRadius: 14, style: .continuous)))
        .environment(\.colorScheme, .dark)
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Recording controls for \(recording.title)")
    }

    private var status: some View {
        HStack(spacing: 7) {
            RecordingGrip()
            indicator
            VStack(alignment: .leading, spacing: 0) {
                // The one view that ticks: nothing above it renders again each second.
                TimelineView(.periodic(from: .now, by: 1)) { context in
                    Text(verbatim: RecordingClock.format(recording.elapsedMs(now: context.date)))
                        .font(.system(size: 13, weight: .semibold).monospacedDigit())
                        .foregroundStyle(recording.isPaused ? .secondary : .primary)
                }
                Text(caption)
                    .font(.system(size: 11, weight: .medium))
                    .foregroundStyle(recording.isPaused || recording.warning != nil ? .orange : SessionPalette.secondary)
                    .lineLimit(1)
            }
            .frame(minWidth: 64, alignment: .leading)
        }
        .padding(.leading, 4)
        .padding(.trailing, 2)
        .frame(maxHeight: .infinity)
        .contentShape(Rectangle())
        .allowsHitTesting(false)
        .background(RecordingWindowDragArea(dragged: {}))
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("live-recording.status")
    }

    @ViewBuilder private var indicator: some View {
        if recording.isPaused {
            Image(systemName: "pause.circle.fill").font(.system(size: 12)).foregroundStyle(.orange)
        } else if recording.isStopping {
            ProgressView().controlSize(.mini).frame(width: 12, height: 12)
        } else {
            Circle().fill(Color.red).frame(width: 9, height: 9)
                .shadow(color: .red.opacity(0.7), radius: 3)
        }
    }

    private var caption: String {
        let frames = Plural.count(recording.frames, "frame")
        if recording.isStopping { return "Stopping" }
        if recording.isPaused { return "Paused · \(frames)" }
        if recording.warning != nil { return "\(frames) · warning" }

        return frames
    }

    private var controls: some View {
        HStack(spacing: 6) {
            if recording.isPaused {
                IconButton(systemName: "play.fill", tooltip: "Resume", size: 13) { send(.resume) }
                    .disabled(!recording.allows(.resume))
                    .accessibilityIdentifier("live-recording.resume")
            } else {
                IconButton(systemName: "pause.fill", tooltip: "Pause", size: 13) { send(.pause) }
                    .disabled(!recording.allows(.pause))
                    .accessibilityIdentifier("live-recording.pause")
            }
            Button { send(.stop) } label: {
                HStack(spacing: 5) {
                    Image(systemName: "stop.fill").font(.system(size: 10, weight: .bold))
                    Text("Stop").font(.system(size: 12, weight: .semibold)).lineLimit(1)
                }
                .foregroundStyle(.white)
                .padding(.horizontal, 10)
                .padding(.vertical, 6)
                .background(Color.red.opacity(recording.allows(.stop) ? 0.88 : 0.4), in: Capsule())
                .contentShape(Capsule())
            }
            .buttonStyle(.genHoverPlain(brighten: 0.12))
            .disabled(!recording.allows(.stop))
            .fixedSize()
            .instantTooltip("Stop the recording")
            .accessibilityLabel("Stop")
            .accessibilityIdentifier("live-recording.stop")
            IconButton(systemName: "xmark", tooltip: "Hide these controls (the recording goes on)", size: 10, action: hide)
                .accessibilityIdentifier("live-recording.hide")
        }
    }
}

@MainActor
final class LiveRecordingPanelModel: ObservableObject {
    @Published var recording: LiveRecording

    init(recording: LiveRecording) {
        self.recording = recording
    }
}

private struct LiveRecordingControlsHost: View {
    @ObservedObject var model: LiveRecordingPanelModel
    let send: (LiveRecordingCommand) -> Void
    let hide: () -> Void

    var body: some View {
        LiveRecordingControlsView(recording: model.recording, send: send, hide: hide)
    }
}

/// One always-on-top, non-activating panel bound to one live recording, in `RecordingControlsPanel`.
@MainActor
final class LiveRecordingPanel {
    let id: String
    private let panel = RecordingControlsPanel()
    private let model: LiveRecordingPanelModel

    /// `stack` is the number of controls already open: each next one goes under the one before.
    init(recording: LiveRecording, stack: Int, send: @escaping (LiveRecordingCommand) -> Void,
         hide: @escaping () -> Void) {
        id = recording.id
        model = LiveRecordingPanelModel(recording: recording)
        panel.window.title = "Recording controls: \(recording.title)"
        panel.window.identifier = NSUserInterfaceItemIdentifier("live-recording.controls")
        panel.setContent(LiveRecordingControlsHost(model: model, send: send, hide: hide))
        // Measured here: the panel's own hosting view reports no size before its first layout, which put a corner
        // placement half off the screen.
        let size = NSHostingView(rootView: LiveRecordingControlsView(recording: recording, send: { _ in }, hide: {})
            .fixedSize()).fittingSize
        var frame = RecordingPanelLayout.frame(size: size, placement: .topRight, targetCG: nil, displayIndex: nil,
                                               screens: RecordingPanelLayout.liveScreens)
        frame.origin.y -= CGFloat(stack) * (size.height + 8)
        panel.window.setFrame(frame, display: true)
    }

    func update(_ recording: LiveRecording) {
        if recording != model.recording { model.recording = recording }
    }

    func show() { panel.show() }

    func close() { panel.close() }
}
