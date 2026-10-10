import AppKit
import SwiftUI

/// A global shortcut as Carbon registers it: a virtual key code and a Carbon modifier mask
/// (`cmdKey` 0x0100, `shiftKey` 0x0200, `optionKey` 0x0800, `controlKey` 0x1000).
public struct HotkeyChord: Equatable, Sendable {
    public var keyCode: UInt32
    public var modifiers: UInt32

    public static let command: UInt32 = 0x0100
    public static let shift: UInt32 = 0x0200
    public static let option: UInt32 = 0x0800
    public static let control: UInt32 = 0x1000

    public init(keyCode: UInt32, modifiers: UInt32) {
        self.keyCode = keyCode
        self.modifiers = modifiers
    }

    /// The Carbon mask for a key event's modifier flags. Caps Lock, Fn and the keypad flag are not part of a chord.
    public static func carbonModifiers(_ flags: NSEvent.ModifierFlags) -> UInt32 {
        var mask: UInt32 = 0
        if flags.contains(.command) { mask |= command }
        if flags.contains(.shift) { mask |= shift }
        if flags.contains(.option) { mask |= option }
        if flags.contains(.control) { mask |= control }
        return mask
    }

    /// "⌃⌥⌘D".
    public var label: String { FlowKeyNames.describe(keyCode: keyCode, modifiers: modifiers) }

    private static let functionKeys: Set<UInt32> = [
        0x7A, 0x78, 0x63, 0x76, 0x60, 0x61, 0x62, 0x64, 0x65, 0x6D, 0x67, 0x6F, 0x69, 0x6B, 0x71, 0x6A, 0x40, 0x4F, 0x50, 0x5A,
    ]

    /// Shortcuts macOS or every app already uses: ⌘Q, ⌘W, ⌘H, ⌘M, ⌘Tab, ⌘Space, ⌃Space, ⌃⌘Space and the
    /// screenshot chords ⇧⌘3, ⇧⌘4, ⇧⌘5.
    private static let reserved: [HotkeyChord] = [
        .init(keyCode: 0x0C, modifiers: command), .init(keyCode: 0x0D, modifiers: command),
        .init(keyCode: 0x04, modifiers: command), .init(keyCode: 0x2E, modifiers: command),
        .init(keyCode: 0x30, modifiers: command), .init(keyCode: 0x31, modifiers: command),
        .init(keyCode: 0x31, modifiers: control), .init(keyCode: 0x31, modifiers: control | command),
        .init(keyCode: 0x14, modifiers: shift | command), .init(keyCode: 0x15, modifiers: shift | command),
        .init(keyCode: 0x17, modifiers: shift | command),
    ]

    /// Why this chord cannot be a global shortcut, or nil when it can. A chord needs ⌃, ⌥ or ⌘ (a letter with no
    /// modifier or with ⇧ alone would type text in every app); a function key may stand alone.
    public var problem: String? {
        let required = Self.command | Self.option | Self.control
        if modifiers & required == 0 && !Self.functionKeys.contains(keyCode) {
            return "Add ⌃, ⌥ or ⌘. \(label) on its own would type in every app."
        }
        if Self.reserved.contains(self) {
            return "\(label) belongs to macOS. Choose another shortcut."
        }
        return nil
    }
}

/// Click, then press a shortcut. Escape cancels; a shortcut that cannot work is refused with the reason, and the
/// recorder keeps listening. Shows a reset button while the chord differs from `defaultChord`.
public struct HotkeyRecorder: View {
    @Binding private var chord: HotkeyChord
    private let defaultChord: HotkeyChord?
    private let identifier: String
    @StateObject private var recorder = HotkeyRecorderModel()

    public init(chord: Binding<HotkeyChord>, defaultChord: HotkeyChord? = nil, identifier: String = "hotkey-recorder") {
        _chord = chord
        self.defaultChord = defaultChord
        self.identifier = identifier
    }

    public var body: some View {
        VStack(alignment: .trailing, spacing: 6) {
            HStack(spacing: 8) {
                Button {
                    if recorder.recording { recorder.stop() } else { recorder.start { chord = $0 } }
                } label: {
                    Text(recorder.recording ? "Press a shortcut…" : chord.label)
                        .font(.system(size: 13, weight: .medium, design: .rounded))
                        .monospacedDigit()
                        .frame(minWidth: 132)
                        .padding(.horizontal, 10).padding(.vertical, 5)
                        .background(recorder.recording ? Color.accentColor.opacity(0.18) : Color.white.opacity(0.06),
                                    in: RoundedRectangle(cornerRadius: 7))
                        .overlay(RoundedRectangle(cornerRadius: 7)
                            .stroke(recorder.recording ? Color.accentColor : Color.white.opacity(0.10), lineWidth: 1))
                        .contentShape(RoundedRectangle(cornerRadius: 7))
                }
                .buttonStyle(.genHoverPlain())
                .nativeSettingsPointer()
                .instantTooltip(recorder.recording ? "Press the new shortcut, or Escape to cancel" : "Click to record a new shortcut")
                .accessibilityLabel("Shortcut")
                .accessibilityValue(recorder.recording ? "Recording" : chord.label)
                .accessibilityIdentifier(identifier)
                if let defaultChord, chord != defaultChord, !recorder.recording {
                    IconButton(systemName: "arrow.counterclockwise", tooltip: "Restore \(defaultChord.label)") {
                        chord = defaultChord
                    }
                }
            }
            if let problem = recorder.problem {
                Text(problem).font(.system(size: 11)).foregroundStyle(.orange)
                    .fixedSize(horizontal: false, vertical: true)
                    .multilineTextAlignment(.trailing)
            }
        }
        .onDisappear { recorder.stop() }
    }
}

/// Holds the key monitor while a recorder listens. The monitor swallows every key press it sees, so typing a
/// shortcut never reaches a text field behind it.
@MainActor
final class HotkeyRecorderModel: ObservableObject {
    @Published private(set) var recording = false
    @Published private(set) var problem: String?
    private var monitor: Any?

    func start(onRecord: @escaping (HotkeyChord) -> Void) {
        stop()
        problem = nil
        recording = true
        monitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [weak self] event in
            MainActor.assumeIsolated {
                self?.receive(keyCode: UInt32(event.keyCode), flags: event.modifierFlags, onRecord: onRecord)
            }
            return nil
        }
    }

    /// One key press while recording. Escape with no modifier cancels.
    func receive(keyCode: UInt32, flags: NSEvent.ModifierFlags, onRecord: (HotkeyChord) -> Void) {
        let candidate = HotkeyChord(keyCode: keyCode, modifiers: HotkeyChord.carbonModifiers(flags))
        if keyCode == 0x35, candidate.modifiers == 0 {
            stop()
            return
        }
        if let problem = candidate.problem {
            self.problem = problem
            return
        }
        problem = nil
        onRecord(candidate)
        stop()
    }

    func stop() {
        if let monitor { NSEvent.removeMonitor(monitor) }
        monitor = nil
        recording = false
        problem = nil
    }
}
