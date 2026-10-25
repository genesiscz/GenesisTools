import CoreAudio
import Foundation

/// "When the system plays on `whenUID`, Clicky plays on `playOnUID`." The names are kept for the settings list while a
/// device is not connected.
public struct ClickyOutputRule: Codable, Hashable, Identifiable, Sendable {
    public var id = UUID()
    public var whenUID: String
    public var whenName: String
    public var playOnUID: String
    public var playOnName: String

    public init(whenUID: String, whenName: String, playOnUID: String, playOnName: String) {
        self.whenUID = whenUID
        self.whenName = whenName
        self.playOnUID = playOnUID
        self.playOnName = playOnName
    }
}

/// Where Clicky plays and why. `device` nil means the system output.
public struct ClickyOutputResolution: Equatable, Sendable {
    public let device: AudioOutputDevice?
    public let system: AudioOutputDevice?
    public let reason: String

    /// The output the sound really comes out of.
    public var effective: AudioOutputDevice? { device ?? system }
}

public enum ClickyOutputRouting {
    /// Which device Clicky plays on. A device picked by hand wins; otherwise the first rule for the current system output;
    /// otherwise the system output. A picked or ruled device that is not connected falls back to the system output.
    public static func resolve(preferences: ClickyPreferences, outputs: [AudioOutputDevice],
                               systemID: AudioDeviceID?) -> ClickyOutputResolution {
        let system = outputs.first { $0.id == systemID }
        if let uid = preferences.outputDeviceUID {
            if let picked = outputs.first(where: { $0.uid == uid }) {
                return ClickyOutputResolution(device: picked, system: system, reason: "You picked \(picked.name).")
            }
            return ClickyOutputResolution(
                device: nil, system: system,
                reason: "\(preferences.outputDeviceName ?? "The picked output") is not connected, so Clicky plays on the system output.")
        }
        if let system, let rule = preferences.outputRules.first(where: { $0.whenUID == system.uid }) {
            if let target = outputs.first(where: { $0.uid == rule.playOnUID }) {
                return ClickyOutputResolution(
                    device: target, system: system,
                    reason: "A rule plays Clicky on \(target.name) while the system plays on \(system.name).")
            }
            return ClickyOutputResolution(
                device: nil, system: system,
                reason: "The rule for \(system.name) names \(rule.playOnName), which is not connected.")
        }
        return ClickyOutputResolution(device: nil, system: system, reason: "Clicky follows the system output.")
    }

}
