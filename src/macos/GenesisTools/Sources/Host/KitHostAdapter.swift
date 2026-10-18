@_exported import GenesisKitBase
import Foundation

// GenesisKitBase (../../GenesisKit, its small base library) is visible in every file of the host, and in every part
// that imports the host, through the import above. A part imports the full GenesisKit itself. Never declare a copy of
// one of the kit's modifiers here: two public extension members of one name make every call "ambiguous".

/// What the kit borrows from this app. The kit finds it by the Objective-C name `GenesisKitHostAdapter`, which the
/// executable gives to the adapter its build links (Sources/GenesisTools/Parts.swift): this one in a host-only build,
/// a subclass that is also a full `GenesisKitHost` when a part links the full kit.
///
/// Every member is implemented here, even the ones that only return the kit's default: a subclass can override a
/// class member, but not a default that comes from a protocol extension.
open class HostKitAdapter: NSObject, GenesisKitBaseHost {
    override public init() {
        super.init()
    }

    open func log(_ line: String) {
        HubPerf.log(line)
    }

    open var opensTerminal: Bool { false }

    open func openTerminal(folder: String) {}

    /// On by default: the app always ships as a release build (`bun run app`), and the hub's loads
    /// must be measured on every run. `scripts/perf-report.ts` reads `app-perf.log`.
    open var perf: PerfConfiguration {
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

    /// A new `GenesisTools --permission-status` process (PermissionFaces.swift) reads TCC without this one's cache.
    open func freshPermissionStatus(_ kind: PermissionKind) async -> PermissionStatus? {
        await probeFreshPermissionStatus(kind)
    }

    /// `OBSIDIAN_VAULT_PATH`, else the vault the plugins config names (`obsidian.vaultRoot` in
    /// ~/.genesis-tools/plugins/config.json, the one the wrap-up skill writes to). A full `GenesisKitHost` subclass
    /// hands it to the markdown viewer.
    open var markdownVaultRoot: String? {
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

    /// The user's own keys, one file per library (`hub.json`, `markdown.json`); read by a full `GenesisKitHost`.
    open var keymapDirectory: URL? {
        FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".genesis-tools/keymaps", isDirectory: true)
    }
}
