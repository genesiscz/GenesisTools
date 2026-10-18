@_exported import GenesisToolsHost
@_exported import GenesisToolsFlow
@_exported import GenesisKit
import SwiftUI

/// The hub's additions to the host's kit adapter (Host/KitHostAdapter.swift): cmux for "Open in a new cmux
/// workspace", `FindText` so a panel find marks path labels, the transcript's markdown, and the hub's `tools`
/// server for git data. The executable names this class `GenesisKitHostAdapter` when the hub is linked.
open class HubKitAdapter: HostKitAdapter, GenesisKitHost {
    override open var opensTerminal: Bool { true }

    override open func openTerminal(folder: String) {
        Task.detached(priority: .userInitiated) {
            let error = AgentLauncher.openInTerminal(name: (folder as NSString).lastPathComponent, cwd: folder, command: ["zsh"])
            if let error {
                await MainActor.run { HubPerf.log("cmux open \(folder) failed: \(error)") }
            }
        }
    }

    open func findText(_ text: String, field: String) -> AnyView? {
        AnyView(FindText(text, field: field))
    }

    @MainActor open func registerNativeFind(_ view: NSView, scope: String, onFind: @escaping () -> Void) {
        PanelFindRouter.shared.registerNative(view, scope: scope, onFind: onFind)
    }

    /// The transcript's replies and prompt parts in GenesisKit's `MarkdownContentView`. `[[x]]` stays
    /// text: this app has no vault to route a wikilink to.
    open func transcriptMarkdown(_ text: String, style: TranscriptMarkdownStyle) -> AnyView? {
        AnyView(MarkdownContentView(markdown: text, style: MarkdownStyle(style).with { $0.wikilinks = false }))
    }

    open var gtProvider: GenesisKitGTProvider? { HubGTProvider() }
}

/// GenesisKit's git and agent data through the hub's resident `tools` server (`ToolsCLIRunner`), which answers
/// an agents query without starting bun again.
package final class HubGTProvider: GenesisKitGTCLIProvider {
    package override func tools(_ arguments: [String]) throws -> Data {
        try ToolsCLIRunner.run(arguments)
    }
}
