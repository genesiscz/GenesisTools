import Foundation
import SwiftUI

/// Where the recording controls float when a recording starts or switches target. A drag moves them for the rest of
/// that recording.
public enum RecordingPanelPlacement: String, CaseIterable, Identifiable, Sendable {
    /// Under the recorded window (inside its bottom edge when the screen has no room below), or at the bottom of the
    /// recorded display.
    case nearTarget
    case topLeft
    case topRight
    case bottomLeft
    case bottomRight

    public var id: String { rawValue }

    public var title: String {
        switch self {
        case .nearTarget: return "Near what is recorded"
        case .topLeft: return "Top left corner"
        case .topRight: return "Top right corner"
        case .bottomLeft: return "Bottom left corner"
        case .bottomRight: return "Bottom right corner"
        }
    }
}

/// The screen recorder's preferences, shared by every host (the widget composer, the Capture shelf). Stored in the
/// app's defaults under `recording.*`; every value applies to the next recording.
@MainActor
public final class RecordingSettings: ObservableObject {
    public static let shared = RecordingSettings()

    public static let frameRates = [5, 10, 15, 24, 30]

    public enum Key {
        public static let placement = "recording.panelPlacement"
        public static let frameRate = "recording.frameRate"
        public static let showsBorder = "recording.showsBorder"
        public static let confirmsDiscard = "recording.confirmsDiscard"
    }

    /// Default: near what is recorded, so the controls sit where the person is looking.
    @Published public var placement: RecordingPanelPlacement {
        didSet { defaults.set(placement.rawValue, forKey: Key.placement) }
    }

    /// Frames per second while something moves (the recorder drops to 2 while the screen is still). Default 15.
    @Published public var frameRate: Int {
        didSet { defaults.set(frameRate, forKey: Key.frameRate) }
    }

    /// The pulsing red border around what is recorded. It never appears in the movie. Default on.
    @Published public var showsBorder: Bool {
        didSet { defaults.set(showsBorder, forKey: Key.showsBorder) }
    }

    /// "Discard" and "Restart" ask once inside the controls before they lose what was recorded. Default on.
    @Published public var confirmsDiscard: Bool {
        didSet { defaults.set(confirmsDiscard, forKey: Key.confirmsDiscard) }
    }

    private let defaults: UserDefaults

    public init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        placement = defaults.string(forKey: Key.placement).flatMap(RecordingPanelPlacement.init(rawValue:)) ?? .nearTarget
        let storedRate = defaults.integer(forKey: Key.frameRate)
        frameRate = Self.frameRates.contains(storedRate) ? storedRate : 15
        showsBorder = defaults.object(forKey: Key.showsBorder) as? Bool ?? true
        confirmsDiscard = defaults.object(forKey: Key.confirmsDiscard) as? Bool ?? true
    }
}

/// The settings page for screen recording: placement, frame rate, the border and the discard question.
public struct RecordingSettingsView: View {
    @ObservedObject private var settings: RecordingSettings

    public init(settings: RecordingSettings? = nil) {
        self.settings = settings ?? .shared
    }

    public var body: some View {
        VStack(spacing: 18) {
            NativeSettingsCard("Controls", subtitle: "The small panel that floats beside a recording.") {
                NativeSettingsRow("Placement", detail: "Where the controls appear when a recording starts. Drag them anywhere.") {
                    Picker("Placement", selection: $settings.placement) {
                        ForEach(RecordingPanelPlacement.allCases) { placement in
                            Text(placement.title).tag(placement)
                        }
                    }.labelsHidden().frame(width: 220, alignment: .trailing)
                        .accessibilityIdentifier("recording.placement")
                }
                Divider()
                NativeSettingsToggle(
                    "Ask before discarding", detail: "Discard and Restart ask once inside the controls.",
                    identifier: "recording.confirmsDiscard", isOn: $settings.confirmsDiscard)
            }
            NativeSettingsCard("Recording") {
                NativeSettingsRow("Frame rate", detail: "While something moves. A still screen records at 2 per second.") {
                    Picker("Frame rate", selection: $settings.frameRate) {
                        ForEach(RecordingSettings.frameRates, id: \.self) { rate in
                            Text("\(rate) fps").tag(rate)
                        }
                    }.labelsHidden().frame(width: 120, alignment: .trailing)
                        .accessibilityIdentifier("recording.frameRate")
                }
                Divider()
                NativeSettingsToggle(
                    "Red border around the recording", detail: "Marks what is recorded. It never appears in the movie.",
                    identifier: "recording.showsBorder", isOn: $settings.showsBorder)
            }
        }
    }
}
