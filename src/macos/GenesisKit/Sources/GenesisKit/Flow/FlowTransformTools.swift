import Foundation

public struct FlowTransformChoices: Decodable, Sendable {
    public struct Account: Decodable, Identifiable, Sendable {
        public let id: String
        public let name: String
    }
    public struct Model: Decodable, Identifiable, Sendable {
        public let id: String
        public let title: String
    }
    public struct Provider: Decodable, Identifiable, Sendable {
        public let id: String
        public let title: String
        public let accounts: [Account]
        public let models: [Model]
    }
    public let providers: [Provider]
}

/// The native host passes only a canonical account/model reference to the shared AI command.
/// Secrets stay in the existing resolver; transcript text never becomes process arguments.
@MainActor
public final class FlowTransformTools {
    public let configuration: FlowFocusConfiguration
    private let bridge: ToolsBridge
    var runCommand: (([String], Int) async throws -> ToolsRunResult)?

    public init(bridge: ToolsBridge, configuration: FlowFocusConfiguration) {
        self.bridge = bridge
        self.configuration = configuration
    }

    public var modelRef: String {
        (configuration.app["flowTransforms"] as? [String: Any])?["modelRef"] as? String ?? ""
    }

    public func save(accountID: String, model: String) {
        configuration.setAppValue(["modelRef": "@account/\(accountID):\(model.trimmingCharacters(in: .whitespacesAndNewlines))"],
                                  forKey: "flowTransforms")
    }

    public func choices() async throws -> FlowTransformChoices {
        let result = try await invoke(["transforms", "configuration", "--json"], timeout: 20)
        guard result.exitCode == 0 else { throw ToolsBridgeError.refused(result.stderr) }
        return try JSONDecoder().decode(FlowTransformChoices.self, from: Data(result.stdout.utf8))
    }

    public func run(_ request: FlowTransformRequest) async throws -> String {
        guard !modelRef.isEmpty else {
            throw ToolsBridgeError.refused("Choose an AI account and model in Settings → Dictation → Text transforms.")
        }
        guard request.timeout.isFinite, request.timeout > 0 else {
            throw ToolsBridgeError.refused("Transform timeout must be a positive finite duration.")
        }
        try Task.checkCancellation()
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent("flow-transform-\(UUID())", isDirectory: true)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: false,
                                                attributes: [.posixPermissions: 0o700])
        defer {
            do { try FileManager.default.removeItem(at: folder) }
            catch { FlowFocusLog.flow.error("Transform scratch cleanup failed: \(error.localizedDescription)") }
        }
        let input = folder.appendingPathComponent("input.json")
        try JSONEncoder().encode(request).write(to: input, options: .atomic)
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: input.path)
        let timeoutMs = Int(min(120, max(1, request.timeout)) * 1_000)
        let result = try await invoke(["transforms", "run", "--input", input.path,
                                       "--model-ref", modelRef, "--timeout-ms", String(timeoutMs), "--json"],
                                      timeout: timeoutMs / 1_000 + 5)
        guard result.exitCode == 0 else { throw ToolsBridgeError.refused(result.stderr) }
        struct Response: Decodable { let text: String }
        return try JSONDecoder().decode(Response.self, from: Data(result.stdout.utf8)).text
    }

    private func invoke(_ args: [String], timeout: Int) async throws -> ToolsRunResult {
        if let runCommand { return try await runCommand(args, timeout) }
        return try await bridge.run(subcommand: "voice", args: args, timeoutSeconds: timeout)
    }
}
