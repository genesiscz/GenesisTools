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

    // The settings every build shares (App/HostKitSettings.swift).
    var markdownVaultRoot: String? { HostKitSettings.markdownVaultRoot }

    var perf: PerfConfiguration { HostKitSettings.perf }

    var gtProvider: GenesisKitGTProvider? { HubGTProvider() }

    var keymapDirectory: URL? { HostKitSettings.keymapDirectory }
}

/// GenesisKit's git and agent data through the hub's resident `tools` server (`ToolsCLIRunner`), which answers
/// an agents query without starting bun again.
final class HubGTProvider: GenesisKitGTCLIProvider {
    override func tools(_ arguments: [String]) throws -> Data {
        try ToolsCLIRunner.run(arguments)
    }
}
