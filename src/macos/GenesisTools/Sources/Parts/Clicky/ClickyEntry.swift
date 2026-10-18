import AppKit
import Darwin
import GenesisKit

private let clickySettingsNotification = Notification.Name(NativePreview.namespace + ".clicky.show-settings")

@MainActor
private final class ClickyAppDelegate: NSObject, NSApplicationDelegate {
    private var observer: NSObjectProtocol?
    private let descriptor: Int32
    private let initialPageID: String?
    private var widgetModel: WidgetModel?
    private var flowRuntime: FlowFocusRuntime?
    private var transforms: FlowTransformTools?
    private var runtimeStart: Task<Void, Never>?
    private var terminating = false
    private var terminationReplied = false

    private let snapshotPath: String?
    private let headless: Bool
    /// A `--snapshot` or `--headless` run: no Flow/Focus services, no status item, no Clicky, never on screen.
    private var offscreen: Bool { snapshotPath != nil || headless }

    init(descriptor: Int32, pageID: String?, snapshotPath: String? = nil, headless: Bool = false) {
        self.descriptor = descriptor
        self.initialPageID = pageID
        self.snapshotPath = snapshotPath
        self.headless = headless
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        if !offscreen { observeSettingsRequests() }
        launch()
    }

    private func observeSettingsRequests() {
        observer = DistributedNotificationCenter.default().addObserver(
            forName: clickySettingsNotification, object: nil, queue: .main
        ) { [weak self] notification in
            MainActor.assumeIsolated {
                self?.widgetModel?.refreshSettings()
                ClickyHost.shared.showSettings(pageID: notification.userInfo?["page"] as? String)
            }
        }
    }

    private func launch() {
        let stateRoot = Bundle.main.object(forInfoDictionaryKey: "GenesisToolsWidgetStateRoot") as? String
        let runtime: FlowFocusRuntime
        do { runtime = try NativeFlowRuntime.resolve(stateRoot: stateRoot) }
        catch {
            NSLog("Feature runtime setup failed: %@", error.localizedDescription)
            NSApp.terminate(nil)
            return
        }
        flowRuntime = runtime
        let model = WidgetModel(
            binaryPath: ToolsBridge.defaultBinaryPath(),
            stateRoot: stateRoot)
        widgetModel = model
        let transforms = FlowTransformTools(bridge: model.bridge, configuration: runtime.configuration)
        self.transforms = transforms
        FlowFocusHost.shared.openSettings = { ClickyHost.shared.showSettings(pageID: "focus.general") }
        FlowFocusHost.shared.runTransform = { [weak transforms] request in
            guard let transforms else { throw CancellationError() }
            return try await transforms.run(request)
        }
        // A snapshot only draws the pages. Headless Settings presses switches and reopens pages
        // (scripts/native/settings-v2.ts), so it joins the running owner as a settings-only client: its writes land
        // like the normal Settings' do, and it never owns, so it starts no capture, hotkeys or sounds.
        if headless { runtime.settingsOnly = true }
        if snapshotPath == nil { runtimeStart = Task { await runtime.start() } }
        for section in WidgetFeatureSettings.sections(
            model: model, modules: WidgetModuleChoice.builtins, flowRuntime: runtime, transforms: transforms,
            openSession: { session in
                WidgetLaunch.start(["--widget", "--session-key", session.key])
            })
        {
            ClickyHost.shared.registerSettingsSection(section)
        }
        // The hub window's preferences, after Widgets; a running hub follows a change at once.
        ClickyHost.shared.registerSettingsSection(HubSettingsPages.section())
        // What the daemon's tasks do: PR activity banners, and every task's schedule, runs and output.
        ClickyHost.shared.registerSettingsSection(PRActivitySettingsPages.section())
        ClickyHost.shared.registerSettingsSection(DaemonSettingsPages.section())
        // This face only edits the settings. Turning "Show the widget" on must also start the widget face that
        // owns the panels, once the switch is stored, so the face reads it as on.
        model.preferencesSaved = { patch in
            if patch["showWidget"] == .bool(true) { WidgetLaunch.ensureRunning() }
        }
        model.startSettings()
        if let snapshotPath {
            let delay = Double(snapshotArgument("--snapshot-delay") ?? "") ?? 2
            ClickyHost.shared.snapshotSettings(
                pageID: initialPageID, to: snapshotPath, delay: delay, ready: { model.settingsLoaded })
            return
        }
        if headless {
            ClickyHost.shared.showSettingsHeadless(pageID: initialPageID)
            return
        }

        let menu = NSMenu()
        let root = NSMenuItem()
        let application = NSMenu()
        let settings = application.addItem(withTitle: "Feature settings…", action: #selector(showSettings), keyEquivalent: "")
        settings.target = self
        ClickyKeymap.shared.bind(settings, to: ClickyKeymap.settings)
        let quit = application.addItem(
            withTitle: "Quit Clicky", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "")
        ClickyKeymap.shared.bind(quit, to: ClickyKeymap.quit)
        root.submenu = application
        menu.addItem(root)
        NSApp.mainMenu = menu
        ClickyHost.shared.start(standalone: true)
        // `--no-activate` is a rebuild's relaunch (relaunch.ts): Clicky comes back without the settings window,
        // which would take the keyboard from the app in front.
        if !CommandLine.arguments.contains("--no-activate") {
            ClickyHost.shared.showSettings(pageID: initialPageID)
        }
    }

    private func snapshotArgument(_ flag: String) -> String? {
        let args = CommandLine.arguments
        guard let index = args.firstIndex(of: flag), args.indices.contains(index + 1) else { return nil }
        return args[index + 1]
    }

    @objc private func showSettings() { ClickyHost.shared.showSettings() }

    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        guard !terminating else { return .terminateLater }
        terminating = true
        Task { [self] in
            runtimeStart?.cancel()
            await runtimeStart?.value
            widgetModel?.stop()
            await flowRuntime?.stop()
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
        widgetModel?.stop()
        ClickyHost.shared.stop()
        if let observer { DistributedNotificationCenter.default().removeObserver(observer) }
        // A snapshot or headless run holds no instance lock (its descriptor is -1).
        guard descriptor >= 0 else { return }
        flock(descriptor, LOCK_UN)
        close(descriptor)
    }
}

package func runClicky(_ args: [String] = []) -> Never {
    MainActor.assumeIsolated {
        let pageID = args.firstIndex(of: "--page").flatMap { index in
            args.indices.contains(index + 1) ? args[index + 1] : nil
        }
        // The staging gate's own reading, so `--snapshot --page general` never writes a file named "--page".
        let snapshotPath = NativeStaging.snapshotPath(args)
        let headless = args.contains("--headless")
        if snapshotPath != nil || headless {
            let app = NSApplication.shared
            let delegate = ClickyAppDelegate(
                descriptor: -1, pageID: pageID, snapshotPath: snapshotPath, headless: headless)
            app.delegate = delegate
            app.setActivationPolicy(.prohibited)
            app.run()
            withExtendedLifetime(delegate) {}
            exit(0)
        }
        let root = NativePreview.root
        do {
            try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        } catch {
            NSLog("Clicky instance directory failed: %@", error.localizedDescription)
            exit(1)
        }
        let descriptor = open(
            root.appendingPathComponent("clicky-instance.lock").path, O_CREAT | O_RDWR | O_CLOEXEC, 0o600)
        guard descriptor >= 0 else {
            NSLog("Clicky instance lock failed")
            exit(1)
        }
        guard flock(descriptor, LOCK_EX | LOCK_NB) == 0 else {
            close(descriptor)
            // A background relaunch that finds Clicky already running leaves it alone.
            if args.contains("--no-activate") { exit(0) }
            DistributedNotificationCenter.default().postNotificationName(
                clickySettingsNotification, object: nil, userInfo: pageID.map { ["page": $0] },
                deliverImmediately: true)
            exit(0)
        }
        let app = NSApplication.shared
        let delegate = ClickyAppDelegate(descriptor: descriptor, pageID: pageID)
        app.delegate = delegate
        // A notification click that runs something hands focus back to the app it was clicked over.
        BrowserURLForwarder.shared.trackOtherApps()
        installNotificationClicksForWindowFace()
        app.setActivationPolicy(.accessory)
        app.run()
        withExtendedLifetime(delegate) {}
        exit(0)
    }
}
