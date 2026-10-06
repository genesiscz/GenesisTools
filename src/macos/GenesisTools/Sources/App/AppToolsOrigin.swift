import Foundation
import GenesisKit

enum AppToolsOrigin {
    static func binaryPath() throws -> String {
        try resolve(configured: Bundle.main.object(forInfoDictionaryKey: "GenesisToolsSourceToolsPath") as? String)
    }

    static func resolve(configured: String?, isExecutable: (String) -> Bool = ToolsBridge.isExecutableFile,
                        fallback: () -> String = { ToolsBridge.defaultBinaryPath() }) throws -> String {
        guard let configured else { return fallback() }
        guard configured.hasPrefix("/"), isExecutable(configured) else {
            throw NSError(domain: "AppToolsOrigin", code: 1, userInfo: [NSLocalizedDescriptionKey: "This app's original tools checkout is no longer available. Rebuild GenesisTools.app from an existing checkout."])
        }
        return configured
    }
}
