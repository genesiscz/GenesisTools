import Foundation

/// Every `~/.genesis-tools/…` path of the apps. `GENESIS_TOOLS_HOME` moves the whole tree (a sandbox, a test, a
/// `--snapshot` run), as `genesisToolsDir` does on the TypeScript side (`src/utils/storage/root.ts`), so the app and
/// the `tools` it starts read and write one tree. A path joined to the real home folder by hand broke that: a
/// sandboxed hub asked the real hub server's socket and drew the real sessions (2026-11-10). lint-rules
/// `swift-hand-joined-genesis-tools` fails such a join outside this file.
public enum GenesisToolsHome {
    public static let variable = "GENESIS_TOOLS_HOME"

    /// The folder that holds `.genesis-tools`: `GENESIS_TOOLS_HOME` when set and not empty, else the home folder.
    public static func home(environment: [String: String] = ProcessInfo.processInfo.environment) -> String {
        let override = environment[variable]?.trimmingCharacters(in: .whitespaces) ?? ""
        return override.isEmpty ? NSHomeDirectory() : override
    }

    /// `<home>/.genesis-tools/<relative>`; an empty `relative` is the tree's root. `home` nil resolves it from the
    /// environment; a caller that already holds a home (a test, a click that stamped one) passes it.
    public static func url(
        _ relative: String = "",
        isDirectory: Bool = false,
        in home: String? = nil,
        environment: [String: String] = ProcessInfo.processInfo.environment
    ) -> URL {
        let root = URL(fileURLWithPath: home ?? Self.home(environment: environment), isDirectory: true)
            .appendingPathComponent(".genesis-tools", isDirectory: true)
        return relative.isEmpty ? root : root.appendingPathComponent(relative, isDirectory: isDirectory)
    }

    /// `url(…).path`.
    public static func path(
        _ relative: String = "",
        in home: String? = nil,
        environment: [String: String] = ProcessInfo.processInfo.environment
    ) -> String {
        url(relative, in: home, environment: environment).path
    }
}
