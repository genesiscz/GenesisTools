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
        coordinator?.settingsPresenter = { FeatureSettingsLaunch.open(pageID: $0) }
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
        let sessions = application.addItem(withTitle: "Widget sessions…", action: #selector(showWidgetSettings), keyEquivalent: "")
        sessions.target = self
        WidgetKeymap.shared.bind(sessions, to: WidgetKeymap.settings)
        let hub = application.addItem(withTitle: "Open Hub", action: #selector(showHub), keyEquivalent: "")
        hub.target = self
        WidgetKeymap.shared.bind(hub, to: WidgetKeymap.hub)
        let quit = application.addItem(
            withTitle: "Quit Widget", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "")
        WidgetKeymap.shared.bind(quit, to: WidgetKeymap.quit)
        root.submenu = application
        menu.addItem(root)
        NSApp.mainMenu = menu
        // `--no-activate` is a rebuild's relaunch (relaunch.ts): a widget that is off then stays quiet instead of
        // opening the settings over the app in front.
        coordinator?.start(showSettings: args.contains("--settings"), settingsWhenOff: !args.contains("--no-activate"))
        if let key = value("--session-key") { openSession(key) }
    }
    /// While "Show the widget" is off, the coordinator opens the settings instead of a panel.
    private func openSession(_ key: String) { coordinator?.openSession(key) }

    /// `expand <edge> [group]`, `module <id> <edge> [group]`, `hover <edge> [group]`, `unhover <edge> [group]`,
    /// `collapse`, `select <session key>`, `state`, `settings [page]`, `passive on|off` (expanded panels leave the keyboard with
    /// the app in front, for motion checks on the user's screen), `video` and `recorder …` (the screen recording). Staging only (NativeStaging); logged for the recording.
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
        // What the inbox button and a rail session button do: open, or hide when already open.
        case "inbox": if let target = surface(1) { model.toggleInboxOverview(on: target) }
        case "session": if parts.count > 1, let target = surface(2) { model.toggleSession(parts[1], on: target) }
        case "collapse": model.collapse()
        case "select": if parts.count > 1 { model.select(parts[1]) }
        // `state`: one app-perf.log line with the selection, whether it loads, its cards, the cache and the warm keys.
        case "state": PerfLog.mark("widget.state " + model.selectionDescription)
        case "settings": coordinator.showSettings(pageID: parts.count > 1 ? parts[1] : "widgets.general")
        case "passive": coordinator.passivePanels = parts.count < 2 || parts[1] != "off"
        // `hittest <x> <y>` in CoreGraphics screen points: which view AppKit hands a click there to.
        case "hittest":
            if parts.count > 2, let x = Double(parts[1]), let y = Double(parts[2]) {
                PerfLog.mark("widget.hittest \(x),\(y): " + coordinator.hitTestDescription(cgPoint: CGPoint(x: x, y: y)))
            }
        // What the video button does: open the recording picker, or stop and paste a running recording.
        case "video": model.toggleVideoCapture()
        // `recorder window <id>`, `recorder display <index>`, `recorder stop|discard|state`: the picker and controls
        // without a click, so a check never takes the user's focus. `state` logs one line to app-perf.log.
        case "recorder":
            let recorder = model.screenRecorder
            switch parts.dropFirst().first {
            case "window":
                let id = parts.count > 2 ? UInt32(parts[2]) : nil
                recorder.choose { targets in targets.windows.first { $0.id == id }?.target }
            case "display":
                let index = parts.count > 2 ? Int(parts[2]) : nil
                recorder.choose { targets in targets.displays.first { $0.index == index }?.target }
            case "stop": recorder.stopAndUse()
            case "discard": recorder.discard()
            default: break
            }
            PerfLog.mark("widget.recorder \(command): \(recorder.stateDescription)")
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

package func runAgentWidget(_ args: [String]) -> Never {
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
        // Stalls and main-thread spins land in app-perf.log and logs/hangs/. The widget is where the 2026-10-23
        // spins happened, and only the hub, review and relay faces watched for them.
        HangWatch.start()
        let delegate = AgentWidgetDelegate(args: args, descriptor: descriptor)
        app.delegate = delegate
        app.setActivationPolicy(.accessory)
        app.run()
        withExtendedLifetime(delegate) {}
        exit(0)
    }
}
