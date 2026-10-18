import AppKit

/// Starts the widget face (`GenesisTools --widget`) in its own process, and pins a session to it. In the host, not the
/// widget part: the hub and the settings window start the widget too, and a build without it answers the face with the
/// command that adds it (AppParts.swift).
@MainActor
package enum WidgetLaunch {
    /// A launch that only makes sure the widget face runs: a running face ignores it instead of opening settings.
    package static let ensureRunningFlag = "--ensure-running"
    package static func ensureRunning() { start(["--widget", ensureRunningFlag]) }
    package static func start(_ arguments: [String] = ["--widget", "--settings"]) {
        guard AppParts.canLaunch(face: arguments.first ?? ""), let executable = Bundle.main.executableURL else { return }
        do {
            let child = Process()
            child.executableURL = executable
            child.arguments = arguments
            child.standardInput = FileHandle.nullDevice
            child.standardOutput = FileHandle.nullDevice
            child.standardError = FileHandle.nullDevice
            try child.run()
        } catch {
            PerfLog.mark("widget.launch \(error.localizedDescription)")
            let alert = NSAlert()
            alert.messageText = "Could not open the widget"
            alert.informativeText = error.localizedDescription
            alert.runModal()
        }
    }
    package static func pin(session: String, provider: String) {
        guard AppParts.canLaunch(face: "--widget") else { return }
        Task {
            do {
                let root = Bundle.main.object(forInfoDictionaryKey: "GenesisToolsWidgetStateRoot") as? String
                let arguments =
                    ["widget"] + (root.map { ["--state-root", $0] } ?? [])
                    + ["pin", session, "--provider", provider]
                let result = try await ToolsBridge(binaryPath: ToolsBridge.defaultBinaryPath()).run(
                    subcommand: "hub",
                    args: arguments, timeoutSeconds: 30)
                guard result.exitCode == 0 else { throw ToolsBridgeError.refused(result.stderr) }
                start()
            } catch {
                PerfLog.mark("widget.pin \(error.localizedDescription)")
                let alert = NSAlert()
                alert.messageText = "Could not pin this session"
                alert.informativeText = error.localizedDescription
                alert.runModal()
            }
        }
    }
}
