import AppKit
import Foundation

/// What each global shortcut does, and the watch on live recordings that holds the live-only keys while one runs and
/// feeds the camera bubble's recorder.
@MainActor
enum RecorderShortcutActions {
    private static let watcher = LiveRecordingsWatcher()

    static func install() {
        RecorderShortcuts.shared.onAction = { perform($0) }
        RecorderShortcuts.shared.install()
        RecorderPreferencesSync.observe()
        watcher.onRefresh = { recordings in
            RecorderShortcuts.shared.setRecording(recordings.contains { !$0.isStopping })
            CameraBubble.shared.liveRecordingsChanged(recordings)
        }
        watcher.start()
    }

    static func perform(_ action: RecorderShortcutAction) {
        HubPerf.log("recorder: shortcut \(action.rawValue)")
        switch action {
        case .picker:
            CapturePicker.shared.show()
        case .start:
            CapturePicker.shared.choose(.followPointer)
        case .stop:
            send("stop", for: action, params: ["wait": false])
        case .pause:
            guard let newest = newest(), let command = newest.toggleCommand else {
                nothingRunning(action)
                return
            }
            send(command.rawValue, for: action)
        case .mark:
            send("marker.add", for: action, params: ["label": "Mark"])
        }
    }

    /// The newest recording that takes commands (the one `tools recorder stop` without an id means).
    private static func newest() -> LiveRecording? {
        watcher.recordings.filter { $0.canControl && !$0.isStopping && $0.socket != nil }.max { $0.startedAt < $1.startedAt }
    }

    private static func send(_ method: String, for action: RecorderShortcutAction, params: [String: Any]? = nil) {
        guard let recording = newest(), let socket = recording.socket else {
            HubPerf.log("recorder: shortcut \(method) with no recording running")
            nothingRunning(action)
            return
        }
        let client = LiveRecordingRPCClient(path: socket)
        do {
            try client.connect()
        } catch {
            HubPerf.log("recorder: \(method) could not reach \(recording.id): \(error.localizedDescription)")
            return
        }
        client.call(method, params: params, timeout: 5) { result in
            if case let .failure(error) = result {
                HubPerf.log("recorder: \(method) on \(recording.id) failed: \(error.localizedDescription)")
            }
            client.close()
        }
    }

    /// Stop, pause or mark with no recording running: a short note, a beep or nothing (Settings → Recorder).
    private static func nothingRunning(_ action: RecorderShortcutAction) {
        RecorderNotice.nothingToActOn(nothingToActOnTitle(action), detail: "No recording is running")
    }

    static func nothingToActOnTitle(_ action: RecorderShortcutAction) -> String {
        switch action {
        case .stop: "Nothing to stop"
        case .pause: "Nothing to pause"
        case .mark: "Nothing to mark"
        case .picker, .start: "Nothing to do"
        }
    }
}
