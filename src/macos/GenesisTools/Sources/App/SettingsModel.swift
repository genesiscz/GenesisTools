import AppKit
import Foundation

/// Bundle facts and the one switch the launcher honours: the `disabled` marker file, which makes
/// `tools` run without the launcher (same effect as GENESIS_TOOLS_NO_APP=1, but persistent).
final class SettingsModel: ObservableObject {
    @Published var launcherEnabled = true {
        didSet {
            guard launcherEnabled != oldValue, !isRevertingSwitch else {
                return
            }

            if !writeMarker(enabled: launcherEnabled) {
                // The marker is the truth the launcher reads; a switch that disagrees with it
                // would tell the user routing changed when it did not.
                isRevertingSwitch = true
                launcherEnabled = oldValue
                isRevertingSwitch = false
            }
        }
    }

    /// Guards the revert assignment above from re-entering `didSet`.
    private var isRevertingSwitch = false
    @Published private(set) var version = ""
    @Published private(set) var build = ""
    @Published private(set) var bundleId = ""
    @Published private(set) var bundlePath = ""
    @Published private(set) var signature = "unknown"
    @Published private(set) var teamId = ""
    @Published private(set) var manifest = ""
    @Published private(set) var error: String?

    /// Same contract as `env.tools.getHome()` on the TypeScript side: GENESIS_TOOLS_HOME, else the home directory.
    static let toolsHome: String = {
        if let custom = ProcessInfo.processInfo.environment["GENESIS_TOOLS_HOME"]?.trimmingCharacters(in: .whitespacesAndNewlines),
           !custom.isEmpty {
            return custom
        }

        return NSHomeDirectory()
    }()
    static let appDir = "\(toolsHome)/.genesis-tools/app"
    static let disabledMarker = "\(appDir)/disabled"

    func refresh() {
        let info = Bundle.main.infoDictionary ?? [:]
        version = info["CFBundleShortVersionString"] as? String ?? "dev"
        build = info["CFBundleVersion"] as? String ?? "?"
        bundleId = Bundle.main.bundleIdentifier ?? "?"
        bundlePath = Bundle.main.bundlePath
        launcherEnabled = !FileManager.default.fileExists(atPath: Self.disabledMarker)
        manifest = (try? String(contentsOfFile: "\(Self.appDir)/manifest.json", encoding: .utf8)) ?? "no manifest (built by hand?)"
        readSignature()
    }

    func revealApp() {
        NSWorkspace.shared.activateFileViewerSelecting([Bundle.main.bundleURL])
    }

    func openAppDir() {
        report(NSWorkspace.shared.open(URL(fileURLWithPath: Self.appDir)), what: "open \(Self.appDir)")
    }

    func openPrivacySettings() {
        guard let url = URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy") else {
            return
        }

        report(NSWorkspace.shared.open(url), what: "open System Settings > Privacy & Security")
    }

    private func report(_ ok: Bool, what: String) {
        error = ok ? nil : "Could not \(what)."
    }

    /// Returns false when the marker could not be updated, so the caller can put the switch back.
    private func writeMarker(enabled: Bool) -> Bool {
        do {
            if enabled {
                if FileManager.default.fileExists(atPath: Self.disabledMarker) {
                    try FileManager.default.removeItem(atPath: Self.disabledMarker)
                }
            } else {
                try FileManager.default.createDirectory(atPath: Self.appDir, withIntermediateDirectories: true)
                try "disabled from the GenesisTools window\n".write(toFile: Self.disabledMarker, atomically: true, encoding: .utf8)
            }
            error = nil
            return true
        } catch {
            self.error = "Could not update \(Self.disabledMarker): \(error.localizedDescription)"
            return false
        }
    }

    private func readSignature() {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/codesign")
        process.arguments = ["-dvv", Bundle.main.bundlePath]
        let pipe = Pipe()
        process.standardError = pipe
        process.standardOutput = FileHandle.nullDevice
        do {
            try process.run()
            let data = pipe.fileHandleForReading.readDataToEndOfFile()
            process.waitUntilExit()
            let text = String(decoding: data, as: UTF8.self)
            let authority = text.split(separator: "\n").first { $0.hasPrefix("Authority=") }.map { String($0.dropFirst("Authority=".count)) }
            let team = text.split(separator: "\n").first { $0.hasPrefix("TeamIdentifier=") }.map { String($0.dropFirst("TeamIdentifier=".count)) }
            signature = authority ?? (text.contains("Signature=adhoc") ? "ad-hoc (grants die on rebuild)" : "unsigned")
            teamId = team == "not set" ? "" : (team ?? "")
        } catch {
            signature = "codesign failed: \(error.localizedDescription)"
        }
    }
}
