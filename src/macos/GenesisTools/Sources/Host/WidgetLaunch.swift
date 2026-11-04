import AppKit

/// Starts the widget face (`GenesisTools --widget`) in its own process, and pins a session to it. In the host, not the
/// widget part: the hub and the settings window start the widget too, and a build without it answers the face with the
/// command that adds it (AppParts.swift).
@MainActor
package enum WidgetLaunch {
    /// A launch that only makes sure the widget face runs: a running face ignores it instead of opening settings.
    package static let ensureRunningFlag = "--ensure-running"
    package static func ensureRunning() { start(["--widget", ensureRunningFlag]) }

    /// Starts the widget when this build has it, staging lets it run and "Show the widget" is on. Every window face but
    /// the widget calls it at its start (HostMain): "Quit All" in the hub quits the widget too, and the next hub or
    /// settings window brings it back (Martin, 2026-11-04, D44). Silent: no alert when the part or staging says no.
    package static func ensureRunningIfShown() {
        guard AppParts.has(face: "--widget"),
              AppParts.stagingRefusal(face: "--widget", facesEnabled: NativeStaging.facesEnabled) == nil,
              showWidget(stateFile: stateFile())
        else { return }
        PerfLog.mark("widget.boot: \"Show the widget\" is on, starting it if it is not running")
        ensureRunning()
    }

    /// `preferences.showWidget` of the widget's state file; false when the file is missing or unreadable.
    static func showWidget(stateFile: String) -> Bool {
        guard let data = FileManager.default.contents(atPath: stateFile),
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let preferences = object["preferences"] as? [String: Any]
        else { return false }
        return preferences["showWidget"] as? Bool ?? false
    }

    /// The widget's `state.json`: the bundle's state root, else `$GENESIS_TOOLS_HOME/.genesis-tools/hub/widget`. The same
    /// rule as GenesisKit's `WidgetModel.widgetStateFile`, which the host cannot import (it links only GenesisKitBase).
    static func stateFile(environment: [String: String] = ProcessInfo.processInfo.environment) -> String {
        if let root = Bundle.main.object(forInfoDictionaryKey: "GenesisToolsWidgetStateRoot") as? String {
            return URL(fileURLWithPath: root).standardizedFileURL.appendingPathComponent("state.json").path
        }
        let home = environment["GENESIS_TOOLS_HOME"].flatMap { $0.isEmpty ? nil : $0 } ?? NSHomeDirectory()
        return URL(fileURLWithPath: home).appendingPathComponent(".genesis-tools/hub/widget/state.json").path
    }
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
