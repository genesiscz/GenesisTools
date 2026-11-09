import AppKit
import Foundation

/// How a recorder failure reaches the person when no editor window can show it (a quick action from the menu bar, a
/// recording that did not open or start), and how Rename asks for a title. Settings → Recorder → Menu bar.
enum RecorderFailureStyle: String, CaseIterable, Identifiable {
    /// A note under the recorder's menu bar item that never takes the keyboard or brings a window forward, and stays
    /// until it is closed. Rename asks in a small panel that takes the typing without bringing the recorder forward.
    case notice
    /// A modal alert that brings the recorder and its windows to the front and waits for an answer.
    case alert

    static let key = "recorder.failures.style"

    var id: String { rawValue }

    static func load(_ defaults: UserDefaults = .standard) -> RecorderFailureStyle {
        defaults.string(forKey: key).flatMap(Self.init(rawValue:)) ?? .notice
    }
}

/// When the camera bubble's live preview shows on screen. Settings → Recorder → Camera.
/// The preview shows while it records only when the movie leaves it out: its window id reached the recorder's
/// `--exclude-window-ids` before the first frame (ScreenCaptureKit ignores the panel's sharing type, so a preview the
/// movie did not leave out is baked into it). The picker, the Start shortcut and the recorder service's `camera.start`
/// leave it out; a recording the face found by its own watch, with no service, does not.
enum CameraPreviewPolicy: String, CaseIterable, Identifiable {
    /// Every recording that records the camera, also one the CLI, an agent or the recorder service started.
    case everyCameraRecording = "every"
    /// Only a recording the capture picker or the Start shortcut started (the behaviour before this setting).
    case pickerRecordings = "picker"
    /// Never: the camera records without a preview, and the editor places the bubble.
    case never

    static let key = "recorder.camera.preview"

    var id: String { rawValue }

    static func load(_ defaults: UserDefaults = .standard) -> CameraPreviewPolicy {
        defaults.string(forKey: key).flatMap(Self.init(rawValue:)) ?? .everyCameraRecording
    }

    /// The picker shows the preview while it is open, so the bubble can be placed before the start.
    var showsWhilePicking: Bool { self != .never }

    /// Whether a recording that records the camera shows the preview while it runs. `previewLeftOut`: the preview's
    /// window is in the movie's `--exclude-window-ids`; without it the preview never shows, or the movie would hold it.
    func showsPreview(startedByPicker: Bool, previewLeftOut: Bool) -> Bool {
        guard previewLeftOut else { return false }
        return switch self {
        case .everyCameraRecording: true
        case .pickerRecordings: startedByPicker
        case .never: false
        }
    }
}

/// What a recorder shortcut does when it has nothing to act on: stop, pause or mark while no recording runs.
/// Settings → Recorder → Shortcuts.
enum IdleShortcutFeedback: String, CaseIterable, Identifiable {
    /// No sound: a short note by the pointer says that no recording runs, and fades. It takes no focus.
    case note
    case beep
    case nothing

    static let key = "recorder.shortcuts.idleFeedback"

    var id: String { rawValue }

    static func load(_ defaults: UserDefaults = .standard) -> IdleShortcutFeedback {
        defaults.string(forKey: key).flatMap(Self.init(rawValue:)) ?? .note
    }
}

/// The settings window runs in its own process (`--features`), the recorder in another (`--recorder`). Both read the
/// same defaults, so most choices apply at their next use; what the recorder face holds (the shortcuts' keys, the
/// picker's options, the camera bubble) follows one distributed notice the settings page posts after a change.
enum RecorderPreferencesSync {
    static var changed: Notification.Name { Notification.Name(NativePreview.namespace + ".recorder.preferencesChanged") }
    /// The settings page records a new chord for an action (`action` in the user info) or stopped (no `action`): the
    /// recorder lets go of that action's key meanwhile, so the press reaches the page.
    static var listening: Notification.Name { Notification.Name(NativePreview.namespace + ".recorder.shortcutListening") }

    static func postChanged() {
        DistributedNotificationCenter.default().postNotificationName(
            changed, object: NativePreview.namespace, userInfo: nil, deliverImmediately: true)
    }

    static func postListening(_ action: RecorderShortcutAction?) {
        DistributedNotificationCenter.default().postNotificationName(
            listening, object: NativePreview.namespace, userInfo: action.map { ["action": $0.rawValue] },
            deliverImmediately: true)
    }

    /// The action a `listening` notice names; nil when it names none (the page stopped listening).
    static func listeningAction(_ userInfo: [AnyHashable: Any]?) -> RecorderShortcutAction? {
        (userInfo?["action"] as? String).flatMap(RecorderShortcutAction.init(rawValue:))
    }

    @MainActor private static var observers: [NSObjectProtocol] = []

    /// The recorder face: re-reads what it holds when the settings page changed something.
    @MainActor
    static func observe() {
        guard observers.isEmpty else { return }
        let center = DistributedNotificationCenter.default()
        observers.append(center.addObserver(forName: changed, object: NativePreview.namespace, queue: .main) { _ in
            MainActor.assumeIsolated {
                HubPerf.log("recorder: settings changed in another process; reading them again")
                RecorderShortcuts.shared.apply()
                CapturePicker.shared.preferencesChanged()
                CameraBubble.shared.appearanceChanged()
                CameraBubble.shared.previewPolicyChanged()
            }
        })
        observers.append(center.addObserver(forName: listening, object: NativePreview.namespace, queue: .main) { note in
            let action = listeningAction(note.userInfo)
            MainActor.assumeIsolated { RecorderShortcuts.shared.setListening(action) }
        })
    }
}
