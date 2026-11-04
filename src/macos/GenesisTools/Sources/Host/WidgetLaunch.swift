import AppKit

/// The folder of the widget face's single-instance lock: this bundle's Application Support folder. In the host, so a
/// window face can tell whether the widget runs without starting a process (`WidgetLaunch.isRunning`).
package func widgetInstanceDirectory() -> URL {
    FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        .appendingPathComponent(Bundle.main.bundleIdentifier ?? "GenesisTools", isDirectory: true)
}

/// The widget face's single-instance lock. Close-on-exec, so a face it launches (Hub, Clicky) never inherits the
/// descriptor and keeps the lock held after the widget dies, which would make every later --widget exit at once.
package func openWidgetInstanceLock(in base: URL) -> Int32 {
    open(base.appendingPathComponent("widget-instance.lock").path, O_CREAT | O_RDWR | O_CLOEXEC, 0o600)
}

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
              showWidget(stateFile: stateFile()),
              !isRunning()
        else { return }
        PerfLog.mark("widget.boot: \"Show the widget\" is on and the widget is not running, starting it")
        FaceLifecycle.note("widget-boot", detail: "the widget was not running and Show the widget is on")
        ensureRunning()
    }

    /// True while a widget face holds its instance lock. The probe takes the lock for a moment: a widget starting in
    /// that moment exits as a second copy, and this face then starts one itself, so one widget runs either way.
    static func isRunning(in base: URL = widgetInstanceDirectory()) -> Bool {
        let descriptor = openWidgetInstanceLock(in: base)
        guard descriptor >= 0 else { return false }
        defer { close(descriptor) }
        guard flock(descriptor, LOCK_EX | LOCK_NB) == 0 else { return true }
        flock(descriptor, LOCK_UN)
        return false
    }

    nonisolated(unsafe) private static var activationObserver: NSObjectProtocol?
    nonisolated(unsafe) private static var lastActivationCheck = Date.distantPast

    /// A hub or settings window that already runs starts no new process when it is opened again (a click on its Dock
    /// icon or window), so the start check alone would miss it. Coming to the front checks again, at most every 10 s.
    package static func bootOnActivation() {
        guard activationObserver == nil else { return }
        activationObserver = NotificationCenter.default.addObserver(
            forName: NSApplication.didBecomeActiveNotification, object: nil, queue: .main
        ) { _ in
            MainActor.assumeIsolated {
                guard Date().timeIntervalSince(lastActivationCheck) >= 10 else { return }
                lastActivationCheck = Date()
                ensureRunningIfShown()
            }
        }
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
