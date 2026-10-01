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
        PathOpener.reveal(Bundle.main.bundlePath)
    }

    /// Finder by name (Hub/HubPathActions.swift): opening the folder with its default app can land in
    /// QuickTime Player when LaunchServices maps folders to it.
    func openAppDir() {
        let opened = PathOpener.perform(.finder, Self.appDir)
        report(opened != .missing(PathOpener.fileURL(Self.appDir).path), what: "open \(Self.appDir)")
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

    /// The bundle's signature, read once per bundle build: `codesign` runs off the main thread (its
    /// `waitUntilExit` spun the main run loop from `onAppear`), and the answer is kept for the bundle's
    /// executable as it is on disk now, since only a rebuild changes it.
    private static var signatureCache: (stamp: String, signature: String, teamId: String)?
    private static let signatureLock = NSLock()

    private func readSignature() {
        let bundle = Bundle.main.bundlePath
        let executable = Bundle.main.executablePath ?? bundle
        DispatchQueue.global(qos: .userInitiated).async {
            let modified = (try? FileManager.default.attributesOfItem(atPath: executable))?[.modificationDate] as? Date
            let stamp = "\(executable)|\(modified?.timeIntervalSince1970 ?? 0)"
            Self.signatureLock.lock()
            let known = Self.signatureCache.flatMap { $0.stamp == stamp ? $0 : nil }
            Self.signatureLock.unlock()
            let read = known.map { ($0.signature, $0.teamId) } ?? HubPerf.measure("settings.codesign") { Self.codesign(bundle) }
            if known == nil {
                Self.signatureLock.lock()
                Self.signatureCache = (stamp, read.0, read.1)
                Self.signatureLock.unlock()
            }
            DispatchQueue.main.async {
                self.signature = read.0
                self.teamId = read.1
            }
        }
    }

    /// Blocking: call it off the main thread only.
    private static func codesign(_ bundle: String) -> (signature: String, teamId: String) {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/codesign")
        process.arguments = ["-dvv", bundle]
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
            return (authority ?? (text.contains("Signature=adhoc") ? "ad-hoc (grants die on rebuild)" : "unsigned"), team == "not set" ? "" : (team ?? ""))
        } catch {
            return ("codesign failed: \(error.localizedDescription)", "")
        }
    }
}
