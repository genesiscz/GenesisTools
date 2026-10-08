import Foundation
import GenesisKit

@MainActor
enum NativeFlowRuntime {
    private static var preview: FlowFocusRuntime?

    static func resolve(stateRoot: String?) throws -> FlowFocusRuntime {
        guard NativePreview.enabled else { return .shared }
        guard let stateRoot, !stateRoot.isEmpty else {
            throw ToolsBridgeError.refused("Preview requires an isolated Widget state root before starting Flow.")
        }
        let root = URL(fileURLWithPath: stateRoot).appendingPathComponent("flow-focus", isDirectory: true)
        if let preview {
            guard preview.dataRoot == root else { throw ToolsBridgeError.refused("Preview Flow is already bound to another state root.") }
            return preview
        }
        let runtime = FlowFocusRuntime(dataRoot: root, hostID: Bundle.main.bundleIdentifier,
            liveServices: false, presentsWindows: true, sharedModels: false)
        preview = runtime
        return runtime
    }
}
