import AppKit

// Starting the widget and Clicky faces in their own process. Built with the flow runtime, not with those parts: the
// hub, the widget and Clicky start each other, and a build without the started part answers its face with the command
// that adds it (App/MissingParts.swift).

@MainActor
enum WidgetLaunch {
    /// A launch that only makes sure the widget face runs: a running face ignores it instead of opening settings.
    static let ensureRunningFlag = "--ensure-running"
    static func ensureRunning() { start(["--widget", ensureRunningFlag]) }
    static func start(_ arguments: [String] = ["--widget", "--settings"]) {
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
    static func pin(session: String, provider: String) {
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

@MainActor
enum ClickyLaunch {
    static func openSettings(pageID: String? = nil) {
        guard AppParts.canLaunch(face: "--clicky"), let executable = Bundle.main.executableURL else { return }
        do {
            let child = Process()
            child.executableURL = executable
            child.arguments = ["--clicky"] + (pageID.map { ["--page", $0] } ?? [])
            child.standardInput = FileHandle.nullDevice
            child.standardOutput = FileHandle.nullDevice
            child.standardError = FileHandle.nullDevice
            try child.run()
        } catch {
            NSLog("Clicky launch failed: %@", error.localizedDescription)
            let alert = NSAlert()
            alert.messageText = "Could not open Clicky"
            alert.informativeText = error.localizedDescription
            alert.runModal()
        }
    }
}
