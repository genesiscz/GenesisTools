@_exported import GenesisKit
import SwiftUI


// GenesisKit (../../GenesisKit, shared with Genesis.app) is visible in every file of this app through
// the import above. Never declare a copy of one of its modifiers here: two public extension members
// of one name make every call "ambiguous".

/// What the kit borrows from this app: the perf log, cmux for "Open in a new cmux workspace", and
/// `FindText` so a panel find marks path labels. The kit finds this class by its Objective-C name.
@objc(GenesisKitHostAdapter)
final class GenesisKitHostAdapter: NSObject, GenesisKitHost {
    func log(_ line: String) {
        HubPerf.log(line)
    }

    var opensTerminal: Bool { true }

    func openTerminal(folder: String) {
        Task.detached(priority: .userInitiated) {
            let error = AgentLauncher.openInTerminal(name: (folder as NSString).lastPathComponent, cwd: folder, command: ["zsh"])
            if let error {
                await MainActor.run { HubPerf.log("cmux open \(folder) failed: \(error)") }
            }
        }
    }

    func findText(_ text: String, field: String) -> AnyView? {
        AnyView(FindText(text, field: field))
    }

    /// The transcript's replies and prompt parts in Hub/MarkdownShim.swift, which marks panel-find hits.
    func transcriptMarkdown(_ text: String, style: TranscriptMarkdownStyle) -> AnyView? {
        AnyView(MarkdownContentView(markdown: text, style: MarkdownStyle(style)))
    }

    /// A new `GenesisTools --permission-status` process (PermissionFaces.swift) reads TCC without this one's cache.
    func freshPermissionStatus(_ kind: PermissionKind) async -> PermissionStatus? {
        await probeFreshPermissionStatus(kind)
    }

    /// On by default: the app always ships as a release build (`bun run app`), and the hub's loads
    /// must be measured on every run. `scripts/perf-report.ts` reads `app-perf.log`.
    var perf: PerfConfiguration {
        PerfConfiguration(
            environmentKey: "GENESIS_TOOLS_PERF",
            enabledByDefault: true,
            subsystem: "com.genesiscz.genesistools",
            logDirectory: FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".genesis-tools/logs"),
            fileName: "app-perf.log",
            appName: "GenesisTools",
            alertBundlePrefix: "com.genesiscz.genesistools"
        )
    }
}
