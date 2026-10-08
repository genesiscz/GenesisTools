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
