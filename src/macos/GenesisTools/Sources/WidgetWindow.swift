import AppKit
import Darwin
import GenesisKit

private let widgetSettingsNotification = Notification.Name(
    NativePreview.namespace + ".widget.show-settings")
/// Scripted UI steps (scripts/native/widget-drive.ts) so recordings and tests never move the user's pointer.
private let widgetTestNotification = Notification.Name(NativePreview.namespace + ".widget.test")

@MainActor
private final class AgentWidgetDelegate: NSObject, NSApplicationDelegate {
    var coordinator: WidgetCoordinator?
    var observer: NSObjectProtocol?
    var testObserver: NSObjectProtocol?
    let args: [String]
    let descriptor: Int32
    private var terminating = false
    private var terminationReplied = false
    init(args: [String], descriptor: Int32) {
        self.args = args
        self.descriptor = descriptor
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        func value(_ flag: String) -> String? {
            guard let index = args.firstIndex(of: flag), args.indices.contains(index + 1) else {
                return nil
            }
            return args[index + 1]
        }
        let tools = URL(fileURLWithPath: ToolsBridge.defaultBinaryPath()).resolvingSymlinksInPath()
        let wrapper = tools.deletingLastPathComponent().appendingPathComponent("widget-tools").path
        let stateRoot = value("--state-root") ?? Bundle.main.object(forInfoDictionaryKey: "GenesisToolsWidgetStateRoot") as? String
        let runtime: FlowFocusRuntime
        do { runtime = try NativeFlowRuntime.resolve(stateRoot: stateRoot) }
        catch {
            NSLog("Widget runtime setup failed: %@", error.localizedDescription)
            NSApp.terminate(nil)
            return
        }
        coordinator = WidgetCoordinator(
            binaryPath: value("--tools")
                ?? (ToolsBridge.isExecutableFile(wrapper) ? wrapper : tools.path),
            stateRoot: stateRoot, flowRuntime: runtime, micLauncher: Bundle.main.executableURL?.path,
            openHub: { session in
                var args = ["--hub", "--mode", "agents"]
                if let session {
                    args += ["--session", session.parentSessionId ?? session.target.sessionId]
                    if let agent = session.agentId { args += ["--agent", agent] }
                }
                WidgetLaunch.start(args)
            })
        coordinator?.settingsPresenter = { ClickyLaunch.openSettings(pageID: $0) }
        coordinator?.model.openDestination = { session, mode, file in
            var args = [
                "--hub", "--mode", "sessions", "--session", session.target.sessionId,
                "--widget-destination", mode, "--widget-cwd", session.target.cwd,
                "--widget-provider", session.target.provider,
            ]
            if let file { args += ["--widget-context", file] }
            WidgetLaunch.start(args)
        }
        observer = DistributedNotificationCenter.default().addObserver(
            forName: widgetSettingsNotification, object: nil, queue: .main
        ) { [weak self] notification in
            MainActor.assumeIsolated {
                if let key = notification.userInfo?["sessionKey"] as? String {
                    self?.openSession(key)
                } else {
                    self?.coordinator?.showSettings()
                }
            }
        }
        if NativeStaging.facesEnabled {
            testObserver = DistributedNotificationCenter.default().addObserver(
                forName: widgetTestNotification, object: nil, queue: .main
            ) { [weak self] notification in
                let command = notification.userInfo?["command"] as? String ?? ""
                MainActor.assumeIsolated { self?.runTestCommand(command) }
            }
        }
        let menu = NSMenu()
        let root = NSMenuItem()
        let application = NSMenu()
        application.addItem(withTitle: "Widget sessions…", action: #selector(showWidgetSettings), keyEquivalent: ",")
            .target = self
        application.addItem(withTitle: "Open Hub", action: #selector(showHub), keyEquivalent: "h").target = self
        application.addItem(
            withTitle: "Quit Widget", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        root.submenu = application
        menu.addItem(root)
        NSApp.mainMenu = menu
        coordinator?.start(showSettings: args.contains("--settings"))
        if let key = value("--session-key") { openSession(key) }
    }
    /// While "Show the widget" is off, the coordinator opens the settings instead of a panel.
    private func openSession(_ key: String) { coordinator?.openSession(key) }

    /// `expand <edge> [group]`, `module <id> <edge> [group]`, `hover <edge> [group]`, `unhover <edge> [group]`,
    /// `collapse`, `select <session key>`, `settings [page]`. Staging only (NativeStaging); logged for the recording.
    private func runTestCommand(_ command: String) {
        guard let coordinator else { return }
        let model = coordinator.model
        let parts = command.split(separator: " ").map(String.init)
        func surface(_ index: Int) -> WidgetSurfaceID? {
            guard parts.indices.contains(index), let edge = EdgePanelPlacement(rawValue: parts[index]) else { return nil }
            let group = parts.indices.contains(index + 1) ? Int(parts[index + 1]) ?? 0 : 0
            return WidgetSurfaceID(edge: edge, group: group)
        }
        NSLog("widget.test %@", command)
        switch parts.first {
        case "expand":
            if let target = surface(1) {
                model.activeSideGroup = target.group
                model.open(target.edge)
            }
        case "module":
            if parts.count > 1, let target = surface(2) { model.openModule(parts[1], on: target) }
        case "hover", "unhover":
            if let target = surface(1) { model.hover(target, inside: parts.first == "hover") }
        case "collapse": model.collapse()
        case "select": if parts.count > 1 { model.select(parts[1]) }
        case "settings": coordinator.showSettings(pageID: parts.count > 1 ? parts[1] : "widgets.general")
        default: NSLog("widget.test: unknown command %@", command)
        }
    }

    @objc private func showWidgetSettings() { coordinator?.showSettings() }
    @objc private func showHub() { WidgetLaunch.start(["--hub", "--mode", "agents"]) }

    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        guard !terminating else { return .terminateLater }
        terminating = true
        Task { [self] in
            await coordinator?.shutdown()
            replyToTermination(sender)
        }
        Task { [self] in
            try? await Task.sleep(for: .seconds(5))
            replyToTermination(sender, timedOut: true)
        }
        return .terminateLater
    }

    /// Shutdown awaits child processes and runtimes; a hung one must not leave the app unable to quit.
    private func replyToTermination(_ sender: NSApplication, timedOut: Bool = false) {
        guard !terminationReplied else { return }
        terminationReplied = true
        if timedOut { NSLog("Shutdown did not finish within 5 seconds; quitting anyway") }
        sender.reply(toApplicationShouldTerminate: true)
    }

    func applicationWillTerminate(_ notification: Notification) {
        coordinator?.stop()
        if let observer { DistributedNotificationCenter.default().removeObserver(observer) }
        if let testObserver { DistributedNotificationCenter.default().removeObserver(testObserver) }
        flock(descriptor, LOCK_UN)
        close(descriptor)
    }
}

/// The widget face's single-instance lock. Close-on-exec, so a face it launches (Hub, Clicky) never inherits the
/// descriptor and keeps the lock held after the widget dies, which would make every later --widget exit at once.
func openWidgetInstanceLock(in base: URL) -> Int32 {
    open(base.appendingPathComponent("widget-instance.lock").path, O_CREAT | O_RDWR | O_CLOEXEC, 0o600)
}

func runAgentWidget(_ args: [String]) -> Never {
    MainActor.assumeIsolated {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent(Bundle.main.bundleIdentifier ?? "GenesisTools", isDirectory: true)
        do {
            try FileManager.default.createDirectory(at: base, withIntermediateDirectories: true)
        } catch {
            NSLog("Widget could not create its instance directory: %@", error.localizedDescription)
            exit(1)
        }
        let descriptor = openWidgetInstanceLock(in: base)
        guard descriptor >= 0 else {
            NSLog("Widget instance lock failed")
            exit(1)
        }
        guard flock(descriptor, LOCK_EX | LOCK_NB) == 0 else {
            close(descriptor)
            if args.contains(WidgetLaunch.ensureRunningFlag) { exit(0) }
            let key = args.firstIndex(of: "--session-key").flatMap { index in
                args.indices.contains(index + 1) ? args[index + 1] : nil
            }
            DistributedNotificationCenter.default().postNotificationName(
                widgetSettingsNotification, object: nil, userInfo: key.map { ["sessionKey": $0] },
                deliverImmediately: true)
            exit(0)
        }
        let app = NSApplication.shared
        let delegate = AgentWidgetDelegate(args: args, descriptor: descriptor)
        app.delegate = delegate
        app.setActivationPolicy(.accessory)
        app.run()
        withExtendedLifetime(delegate) {}
        exit(0)
    }
}

@MainActor
enum WidgetLaunch {
    /// A launch that only makes sure the widget face runs: a running face ignores it instead of opening settings.
    static let ensureRunningFlag = "--ensure-running"
    static func ensureRunning() { start(["--widget", ensureRunningFlag]) }
    static func start(_ arguments: [String] = ["--widget", "--settings"]) {
        guard let executable = Bundle.main.executableURL else { return }
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
