import AppKit
import Foundation

struct LaunchdJob: Identifiable, Equatable {
    let id: String
    let plistPath: String
    /// ProgramArguments go through this bundle's launcher
    let underApp: Bool
    /// `launchctl print` found it loaded in the user domain
    let loaded: Bool
    let program: String
}

/// The com.genesis-tools.* launchd jobs and whether they run under this bundle's identity.
final class ServicesModel: ObservableObject {
    @Published private(set) var jobs: [LaunchdJob] = []
    @Published private(set) var scannedAt: Date?

    private static let launchAgents = NSString(string: "~/Library/LaunchAgents").expandingTildeInPath
    private static let labelPrefix = "com.genesis-tools."

    /// The scan waits on `launchctl print` per job, so it runs off the main thread and publishes once.
    func refresh() {
        let launcher = Bundle.main.executablePath ?? ""
        DispatchQueue.global(qos: .userInitiated).async {
            let scanned = Self.scan(launcher: launcher)
            DispatchQueue.main.async {
                self.jobs = scanned
                self.scannedAt = Date()
            }
        }
    }

    private static func scan(launcher: String) -> [LaunchdJob] {
        let names = (try? FileManager.default.contentsOfDirectory(atPath: launchAgents)) ?? []
        return names
            .filter { $0.hasPrefix(labelPrefix) && $0.hasSuffix(".plist") }
            .sorted()
            .map { name in
                let path = "\(launchAgents)/\(name)"
                let label = String(name.dropLast(".plist".count))
                let arguments = programArguments(atPath: path)
                return LaunchdJob(
                    id: label,
                    plistPath: path,
                    underApp: !launcher.isEmpty && arguments.contains(launcher),
                    loaded: isLoaded(label),
                    program: arguments.prefix(3).joined(separator: " ")
                )
            }
    }

    func reveal(_ job: LaunchdJob) {
        NSWorkspace.shared.activateFileViewerSelecting([URL(fileURLWithPath: job.plistPath)])
    }

    private static func isLoaded(_ label: String) -> Bool {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/bin/launchctl")
        process.arguments = ["print", "gui/\(getuid())/\(label)"]
        process.standardOutput = FileHandle.nullDevice
        process.standardError = FileHandle.nullDevice
        do {
            try process.run()
            process.waitUntilExit()
            return process.terminationStatus == 0
        } catch {
            return false
        }
    }

    /// XML or binary plist alike; a job converted with `plutil -convert binary1` still parses.
    private static func programArguments(atPath path: String) -> [String] {
        guard let data = FileManager.default.contents(atPath: path),
              let plist = try? PropertyListSerialization.propertyList(from: data, format: nil),
              let dictionary = plist as? [String: Any],
              let arguments = dictionary["ProgramArguments"] as? [String] else {
            return []
        }

        return arguments
    }
}
