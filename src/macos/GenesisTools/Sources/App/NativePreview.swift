import Foundation

enum NativePreview {
    static var enabled: Bool { Bundle.main.object(forInfoDictionaryKey: "GenesisToolsPreview") as? Bool == true }
    static var namespace: String {
        enabled ? (Bundle.main.bundleIdentifier ?? "native-preview") : "com.genesiscz.genesistools"
    }
    static var root: URL {
        FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent(namespace, isDirectory: true)
    }
    static func hubFile(_ name: String) -> URL {
        if enabled { return root.appendingPathComponent("hub", isDirectory: true).appendingPathComponent(name) }
        // Under genesisHome() (GENESIS_TOOLS_HOME), as the face records a rebuild reads beside it.
        return URL(fileURLWithPath: genesisHome()).appendingPathComponent(".genesis-tools/hub")
            .appendingPathComponent(name)
    }
}

/// The widget and Clicky are in staging. They run in the Preview bundles, and in the normal app only on a machine whose
/// owner turned them on with `bun scripts/native/staging.ts on` (the defaults key below). A normal install never has it.
enum NativeStaging {
    static let defaultsKey = "GenesisToolsStagingFaces"
    static var facesEnabled: Bool { NativePreview.enabled || UserDefaults.standard.bool(forKey: defaultsKey) }
}
