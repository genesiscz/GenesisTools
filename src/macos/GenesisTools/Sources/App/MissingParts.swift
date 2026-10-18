// The kit for every file of the app. The hub's GenesisKitHost.swift re-exports it too, but a build without the hub
// part has only this file.
@_exported import GenesisKit
import AppKit
import Foundation

/// The optional parts this build has (Package.swift `allParts`; `GENESIS_PART_<ID>` is defined for each one built).
enum AppParts {
    static let linked: [String] = {
        var ids: [String] = []
        #if GENESIS_PART_HUB
        ids.append("hub")
        #endif
        #if GENESIS_PART_WIDGET
        ids.append("widget")
        #endif
        #if GENESIS_PART_CLICKY
        ids.append("clicky")
        #endif
        #if GENESIS_PART_MARKDOWN
        ids.append("markdown")
        #endif
        return ids
    }()

    static var hasHub: Bool { linked.contains("hub") }

    /// The part that serves a face flag (`--hub` → hub); nil for a host face.
    static func part(forFace face: String) -> String? {
        switch face {
        case "--hub", "--review": "hub"
        case "--widget": "widget"
        case "--clicky": "clicky"
        case "--markdown": "markdown"
        default: nil
        }
    }

    /// Before a window starts a part's face in a new process: true when this build has the part, else an alert with
    /// the command that adds it. A child that exits 69 on its own would be unseen, its stderr is discarded.
    @MainActor
    static func canLaunch(face: String) -> Bool {
        guard let part = part(forFace: face), !linked.contains(part) else { return true }
        HubPerf.log("launch \(face): this build has no \(part) part")
        let alert = NSAlert()
        alert.messageText = "This GenesisTools build has no \(part) part"
        alert.informativeText = "Add it with: tools macos permissions build --add-part \(part)"
        alert.runModal()
        return false
    }

    /// A part's face reached from a click (a `genesis-tools://hub` link), where nobody reads stderr: the same alert as
    /// `canLaunch`, then the stderr line and exit 69.
    @MainActor
    static func alertMissing(face: String) -> Never {
        NSApplication.shared.setActivationPolicy(.accessory)
        NSApp.activate(ignoringOtherApps: true)
        _ = canLaunch(face: face)
        missing(part(forFace: face) ?? face, face: face)
    }

    /// A face of a part this build does not have: says how to add it, exits 69 (EX_UNAVAILABLE).
    static func missing(_ part: String, face: String) -> Never {
        let line = "GenesisTools was built without the \(part) part, which serves \(face). Add it with: tools macos permissions build --add-part \(part)\n"
        FileHandle.standardError.write(Data(line.utf8))
        exit(69)
    }
}

// Stand-ins for the faces of the parts that are not built, so the host calls them the same way in every build.

#if !GENESIS_PART_HUB
func runHub(_ args: [String]) -> Never { AppParts.missing("hub", face: "--hub") }
func runReview(_ args: [String]) -> Never { AppParts.missing("hub", face: "--review") }

/// A `genesis-tools://hub?…` link is still recognized, so it gets the add-part message instead of the router.
enum HubRequest {
    static func arguments(fromLink raw: String) -> [String]? {
        guard let components = URLComponents(string: raw), components.scheme == "genesis-tools", components.host == "hub" else { return nil }
        return []
    }
}

/// What the host lends the kit when the hub (and its richer adapter, Hub/GenesisKitHost.swift) is not built.
@objc(GenesisKitHostAdapter)
final class GenesisKitHostAdapter: NSObject, GenesisKitHost {
    func log(_ line: String) {
        HubPerf.log(line)
    }

    func freshPermissionStatus(_ kind: PermissionKind) async -> PermissionStatus? {
        await probeFreshPermissionStatus(kind)
    }

    var perf: PerfConfiguration { HostKitSettings.perf }

    // A markdown-only build has this adapter too: the viewer keeps the vault and the saved shortcuts.
    var markdownVaultRoot: String? { HostKitSettings.markdownVaultRoot }

    var keymapDirectory: URL? { HostKitSettings.keymapDirectory }
}
#endif

#if !GENESIS_PART_WIDGET
func runAgentWidget(_ args: [String]) -> Never { AppParts.missing("widget", face: "--widget") }
#endif

#if !GENESIS_PART_CLICKY
func runClicky(_ args: [String] = []) -> Never { AppParts.missing("clicky", face: "--clicky") }
#endif

#if !GENESIS_PART_MARKDOWN
func runMarkdown(_ args: [String]) -> Never { AppParts.missing("markdown", face: "--markdown") }
#endif
