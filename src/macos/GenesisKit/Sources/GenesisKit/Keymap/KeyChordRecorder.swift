import AppKit
import SwiftUI

/// Click, then press the new key for one command. Escape cancels. A key that cannot work in an app is refused with the
/// reason, and the recorder keeps listening. While it listens, `KeymapDispatcher` runs nothing, so pressing the
/// command's current key records it instead of running it.
public struct KeyChordRecorder: View {
    private let label: String?
    private let identifier: String
    private let onRecord: (KeyChord) -> Void
    @StateObject private var recorder = KeyChordRecorderModel()

    /// `label` is the key in force ("⇧⌘Ú"), nil when the command has none.
    public init(label: String?, identifier: String, onRecord: @escaping (KeyChord) -> Void) {
        self.label = label
        self.identifier = identifier
        self.onRecord = onRecord
    }

    public var body: some View {
        VStack(alignment: .trailing, spacing: 4) {
            Button {
                if recorder.recording { recorder.stop() } else { recorder.start(onRecord: onRecord) }
            } label: {
                Text(recorder.recording ? "Press keys…" : label ?? "None")
                    .font(.system(size: 12, weight: .medium, design: .rounded))
                    .foregroundStyle(label == nil && !recorder.recording ? .secondary : .primary)
                    .frame(minWidth: 96)
                    .padding(.horizontal, 8).padding(.vertical, 4)
                    .background(recorder.recording ? Color.accentColor.opacity(0.18) : Color.white.opacity(0.06),
                                in: RoundedRectangle(cornerRadius: 6))
                    .overlay(RoundedRectangle(cornerRadius: 6)
                        .stroke(recorder.recording ? Color.accentColor : Color.white.opacity(0.10), lineWidth: 1))
                    .contentShape(RoundedRectangle(cornerRadius: 6))
            }
            .buttonStyle(.genHoverPlain())
            .nativeSettingsPointer()
            .instantTooltip(recorder.recording ? "Press the new keys, or Escape to cancel" : "Click to record new keys")
            .accessibilityLabel("Shortcut")
            .accessibilityValue(recorder.recording ? "Recording" : label ?? "None")
            .accessibilityIdentifier(identifier)
            if let problem = recorder.problem {
                Text(problem).font(.system(size: 11)).foregroundStyle(.orange)
                    .fixedSize(horizontal: false, vertical: true)
                    .multilineTextAlignment(.trailing)
            }
        }
        .onDisappear { recorder.stop() }
    }
}

/// Holds the key monitor while a recorder listens. The monitor swallows every key press it sees.
@MainActor
final class KeyChordRecorderModel: ObservableObject {
    @Published private(set) var recording = false
    @Published private(set) var problem: String?
    private var monitor: Any?

    func start(onRecord: @escaping (KeyChord) -> Void) {
        stop()
        problem = nil
        recording = true
        KeymapDispatcher.shared.suspend()
        monitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [weak self] event in
            MainActor.assumeIsolated {
                if let press = KeyStroke(event) { self?.receive(press, onRecord: onRecord) }
            }
            return nil
        }
    }

    /// One key press while recording. Escape with no modifier cancels.
    func receive(_ press: KeyStroke, onRecord: (KeyChord) -> Void) {
        if press.keyCode == 53, press.modifiers.isEmpty {
            stop()
            return
        }
        let chord = KeyChord.recorded(press)
        if let problem = Self.problem(chord) {
            self.problem = problem
            return
        }
        problem = nil
        onRecord(chord)
        stop()
    }

    func stop() {
        if let monitor { NSEvent.removeMonitor(monitor) }
        if recording { KeymapDispatcher.shared.resume() }
        monitor = nil
        recording = false
        problem = nil
    }

    /// Keys macOS keeps for itself: ⌘Tab, ⌘Space, ⌃Space, ⌃⌘Space, ⌘` and the screenshot keys ⇧⌘3, ⇧⌘4, ⇧⌘5.
    static let reserved: [KeyChord] = [
        .code(48, .command), .code(49, .command), .code(49, .control), .code(49, [.control, .command]),
        .code(50, .command), .code(20, [.shift, .command]), .code(21, [.shift, .command]),
        .code(23, [.shift, .command]),
    ]

    /// Why the chord cannot be an app's shortcut, or nil. It needs ⌘, ⌃ or ⌥, unless it is a function key: a key
    /// with Shift alone or nothing would only type.
    static func problem(_ chord: KeyChord) -> String? {
        let label = chord.label(layout: SystemKeyLayout.shared)
        if chord.modifiers.isDisjoint(with: [.command, .control, .option]) && !chord.isFunctionKey {
            return "Add ⌘, ⌃ or ⌥. \(label) alone would type."
        }
        if reserved.contains(where: { $0.key == chord.key && $0.modifiers == chord.modifiers }) {
            return "\(label) belongs to macOS. Choose other keys."
        }
        return nil
    }
}
