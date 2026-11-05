import AppKit
import Carbon.HIToolbox
import Foundation

/// The recorder's global shortcuts. Each action has a chord (rebindable) and can be turned off; the chords are kept in
/// the app's defaults as `recorder.shortcut.<action>` = "keyCode:modifiers" or "off".
enum RecorderShortcutAction: String, CaseIterable, Identifiable {
    case picker, start, stop, pause, mark

    var id: String { rawValue }

    var title: String {
        switch self {
        case .picker: return "Open the capture picker"
        case .start: return "Start recording"
        case .stop: return "Stop recording"
        case .pause: return "Pause or resume"
        case .mark: return "Mark this moment"
        }
    }

    var detail: String {
        switch self {
        case .picker: return "From any app: choose a display, a window, an app or an area, with the options."
        case .start: return "Records the display in use with the picker's options, without the picker."
        case .stop: return "Stops the newest recording and saves it."
        case .pause: return "Pauses the newest recording, or resumes it. Paused time stays out of the movie."
        case .mark: return "Adds a marker the editor and movie.markers() show."
        }
    }

    /// ⌘7 opens the picker (Martin's pick); the others sit beside it on ⌥⌘7 to ⌥⌘0, which no common app uses.
    var defaultChord: HotkeyChord {
        switch self {
        case .picker: return HotkeyChord(keyCode: UInt32(kVK_ANSI_7), modifiers: HotkeyChord.command)
        case .start: return HotkeyChord(keyCode: UInt32(kVK_ANSI_7), modifiers: HotkeyChord.command | HotkeyChord.option)
        case .stop: return HotkeyChord(keyCode: UInt32(kVK_ANSI_8), modifiers: HotkeyChord.command | HotkeyChord.option)
        case .pause: return HotkeyChord(keyCode: UInt32(kVK_ANSI_9), modifiers: HotkeyChord.command | HotkeyChord.option)
        case .mark: return HotkeyChord(keyCode: UInt32(kVK_ANSI_0), modifiers: HotkeyChord.command | HotkeyChord.option)
        }
    }

    /// Stop, pause and mark act on a running recording only, so by default they hold their keys only while one runs.
    var needsLiveRecording: Bool { [.stop, .pause, .mark].contains(self) }

    /// The Carbon hot key id; the signature ("GNRC") keeps them apart from Flow's and the companion's keys.
    var hotKeyId: UInt32 { UInt32(Self.allCases.firstIndex(of: self)! + 1) }
    static let signature: OSType = 0x474E_5243

    var key: String { "recorder.shortcut.\(rawValue)" }
}

/// One saved binding: a chord, or off.
struct RecorderShortcutBinding: Equatable {
    var chord: HotkeyChord
    var enabled: Bool

    var storageValue: String { enabled ? "\(chord.keyCode):\(chord.modifiers)" : "off:\(chord.keyCode):\(chord.modifiers)" }

    init(chord: HotkeyChord, enabled: Bool = true) {
        self.chord = chord
        self.enabled = enabled
    }

    /// A value `storageValue` wrote; anything else (a missing key, a damaged value) is nil, so the default applies.
    init?(storageValue: String?) {
        guard var parts = storageValue?.split(separator: ":").map(String.init) else { return nil }
        let enabled = parts.first != "off"
        if !enabled { parts.removeFirst() }
        guard parts.count == 2, let key = UInt32(parts[0]), let modifiers = UInt32(parts[1]) else { return nil }
        self.init(chord: HotkeyChord(keyCode: key, modifiers: modifiers), enabled: enabled)
    }

    static func load(_ action: RecorderShortcutAction, defaults: UserDefaults = .standard) -> RecorderShortcutBinding {
        RecorderShortcutBinding(storageValue: defaults.string(forKey: action.key)) ?? RecorderShortcutBinding(chord: action.defaultChord)
    }

    func save(_ action: RecorderShortcutAction, defaults: UserDefaults = .standard) {
        defaults.set(storageValue, forKey: action.key)
    }
}

/// Registers the shortcuts with Carbon and runs their actions. The live-only ones (stop, pause, mark) are registered
/// while a recording runs, unless `recorder.shortcuts.alwaysHeld` is on, so ⌥⌘8 still reaches other apps otherwise.
@MainActor
final class RecorderShortcuts {
    static let shared = RecorderShortcuts()
    static let alwaysHeldKey = "recorder.shortcuts.alwaysHeld"

    var onAction: ((RecorderShortcutAction) -> Void)?
    private var keys: [RecorderShortcutAction: CompanionHotKey] = [:]
    private var recording = false
    /// The action whose chord the settings are recording; it lets go of its key meanwhile.
    private var listening: RecorderShortcutAction?

    static var alwaysHeld: Bool { UserDefaults.standard.bool(forKey: alwaysHeldKey) }

    func install() {
        apply()
    }

    /// A recording started or ended: the live-only shortcuts follow.
    func setRecording(_ running: Bool) {
        guard running != recording else { return }
        recording = running
        apply()
    }

    func setListening(_ action: RecorderShortcutAction?) {
        listening = action
        apply()
    }

    /// Registers what should be held now and lets go of the rest. Logs a chord Carbon refused (another app holds it).
    func apply() {
        for action in RecorderShortcutAction.allCases {
            let binding = RecorderShortcutBinding.load(action)
            let wanted = binding.enabled && listening != action
                && (!action.needsLiveRecording || recording || Self.alwaysHeld)
            guard wanted else {
                keys[action]?.stop()
                keys[action] = nil
                continue
            }
            if let key = keys[action], key.keyCode == binding.chord.keyCode, key.modifiers == binding.chord.modifiers { continue }
            keys[action]?.stop()
            let key = CompanionHotKey(keyCode: binding.chord.keyCode, modifiers: binding.chord.modifiers,
                                      signature: RecorderShortcutAction.signature, hotKeyId: action.hotKeyId)
            key.onKeyDown = { [weak self] _ in
                MainActor.assumeIsolated { self?.onAction?(action) }
            }
            if key.start() {
                keys[action] = key
            } else {
                HubPerf.log("recorder: shortcut \(action.rawValue) \(binding.chord.label) was refused (another app holds it)")
            }
        }
    }
}
