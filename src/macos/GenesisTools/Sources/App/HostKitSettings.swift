import Foundation
import GenesisKit

/// What this app lends GenesisKit in every build, whichever adapter it has (Hub/GenesisKitHost.swift with the hub,
/// App/MissingParts.swift without): the perf log, the notes vault and the keymap folder.
enum HostKitSettings {
    /// On by default: the app always ships as a release build (`bun run app`), and the hub's loads
    /// must be measured on every run. `scripts/perf-report.ts` reads `app-perf.log`.
    static var perf: PerfConfiguration {
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

    /// The notes vault the markdown viewer resolves vault links against: OBSIDIAN_VAULT_PATH, else the
    /// `obsidian.vaultRoot` of ~/.genesis-tools/plugins/config.json.
    static var markdownVaultRoot: String? {
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

    /// The user's own keys, one file per library (`hub.json`, `markdown.json`).
    static var keymapDirectory: URL {
        FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".genesis-tools/keymaps", isDirectory: true)
    }
}
