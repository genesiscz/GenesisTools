@_exported import GenesisKit
import SwiftUI


// GenesisKit (../../GenesisKit, shared with Genesis.app) is visible in every file of this app through
// the import above. Never declare a copy of one of its modifiers here: two public extension members
// of one name make every call "ambiguous".

/// What the kit borrows from this app: the perf log, cmux for "Open in a new cmux workspace",
/// `FindText` so a panel find marks path labels, and the notes vault the markdown viewer links into.
/// The kit finds this class by its Objective-C name.
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

    @MainActor func registerNativeFind(_ view: NSView, scope: String, onFind: @escaping () -> Void) {
        PanelFindRouter.shared.registerNative(view, scope: scope, onFind: onFind)
    }

    /// The transcript's replies and prompt parts in GenesisKit's `MarkdownContentView`. `[[x]]` stays
    /// text: this app has no vault to route a wikilink to.
    func transcriptMarkdown(_ text: String, style: TranscriptMarkdownStyle) -> AnyView? {
        AnyView(MarkdownContentView(markdown: text, style: MarkdownStyle(style).with { $0.wikilinks = false }))
    }

    /// A new `GenesisTools --permission-status` process (PermissionFaces.swift) reads TCC without this one's cache.
    func freshPermissionStatus(_ kind: PermissionKind) async -> PermissionStatus? {
        await probeFreshPermissionStatus(kind)
    }

    /// `OBSIDIAN_VAULT_PATH`, else the vault the plugins config names (`obsidian.vaultRoot` in
    /// ~/.genesis-tools/plugins/config.json, the one the wrap-up skill writes to).
    var markdownVaultRoot: String? {
        if let path = ProcessInfo.processInfo.environment["OBSIDIAN_VAULT_PATH"], !path.isEmpty {
            return path
        }
        let config = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".genesis-tools/plugins/config.json")
        guard let data = try? Data(contentsOf: config),
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let root = (object["obsidian"] as? [String: Any])?["vaultRoot"] as? String, !root.isEmpty
        else { return nil }
        return (root as NSString).expandingTildeInPath
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
            alertBundlePrefix: "com.genesiscz.genesistools",
            spanPrefix: "hub"
        )
    }

    var gtProvider: GenesisKitGTProvider? { HubGTProvider() }
}

/// GenesisKit's git and agent data through the hub's resident `tools` server (`ToolsCLIRunner`), which answers
/// an agents query without starting bun again.
final class HubGTProvider: GenesisKitGTCLIProvider {
    override func tools(_ arguments: [String]) throws -> Data {
        try ToolsCLIRunner.run(arguments)
    }
}
