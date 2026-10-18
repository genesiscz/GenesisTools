import Foundation

package enum NativePreview {
    package static var enabled: Bool { Bundle.main.object(forInfoDictionaryKey: "GenesisToolsPreview") as? Bool == true }
    package static var namespace: String {
        enabled ? (Bundle.main.bundleIdentifier ?? "native-preview") : "com.genesiscz.genesistools"
    }
    package static var root: URL {
        FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent(namespace, isDirectory: true)
    }
    package static func hubFile(_ name: String) -> URL {
        if enabled { return root.appendingPathComponent("hub", isDirectory: true).appendingPathComponent(name) }
        // Under genesisHome() (GENESIS_TOOLS_HOME), as the face records a rebuild reads beside it.
        return URL(fileURLWithPath: genesisHome()).appendingPathComponent(".genesis-tools/hub")
            .appendingPathComponent(name)
    }
}

/// The widget and the feature settings face (Clicky, dictation and Focus run in it) are in staging. They run in the Preview bundles, and in the normal app only on a machine whose
/// owner turned them on with `bun scripts/native/staging.ts on` (the defaults key below). A normal install never has it.
package enum NativeStaging {
    static let defaultsKey = "GenesisToolsStagingFaces"
    package static var facesEnabled: Bool { NativePreview.enabled || UserDefaults.standard.bool(forKey: defaultsKey) }

    /// The feature settings face under both its names (`--clicky` is the old one).
    static let settingsFaces: Set<String> = ["--features", "--clicky"]

    /// Whether these arguments start a staged face this app may not run. The exceptions are the off-screen Settings
    /// runs, a snapshot (`--features --page <id> --snapshot <png>`, one page drawn, then exit) and a headless run
    /// (`--features --page <id> --headless`): neither starts Clicky nor Flow. The widget has no such mode, so
    /// `--widget --snapshot` is refused like any widget launch.
    /// `--snapshot` with no path after it is refused too: the face would read no snapshot path and start for real.
    static func refuses(_ arguments: [String], facesEnabled: Bool) -> Bool {
        guard !facesEnabled, let face = arguments.first, face == "--widget" || settingsFaces.contains(face) else {
            return false
        }
        // `--features --headless` (scripts/native/settings-v2.ts) is the same off-screen Settings without a picture.
        return !(settingsFaces.contains(face) && (snapshotPath(arguments) != nil || arguments.contains("--headless")))
    }

    /// The value after `--snapshot`, when there is one and it is not the next flag.
    package static func snapshotPath(_ arguments: [String]) -> String? {
        guard let flag = arguments.firstIndex(of: "--snapshot"), arguments.indices.contains(flag + 1) else { return nil }
        let path = arguments[flag + 1]
        return path.isEmpty || path.hasPrefix("-") ? nil : path
    }
}
