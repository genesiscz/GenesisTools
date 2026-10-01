@_exported import GenesisKit
import SwiftUI


// GenesisKit (../../GenesisKit, shared with Genesis.app) is visible in every file of this app through
// the import above. Its hover styles and `.instantTooltip` stay internal to the package until this
// app's copies in Hub/Stolen/UI are gone: two public extension members of one name are ambiguous.

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
}
