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

    init(descriptor: Int32, pageID: String?, snapshotPath: String? = nil) {
        self.descriptor = descriptor
        self.initialPageID = pageID
        self.snapshotPath = snapshotPath
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        if snapshotPath == nil { observeSettingsRequests() }
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
        // A snapshot run only draws the pages: no Flow/Focus services, no status item, no Clicky.
        if snapshotPath == nil { runtimeStart = Task { await runtime.start() } }
        for section in WidgetFeatureSettings.sections(
            model: model, modules: WidgetModuleChoice.builtins, flowRuntime: runtime, transforms: transforms,
            openSession: { session in
                WidgetLaunch.start(["--widget", "--session-key", session.key])
            })
        {
            ClickyHost.shared.registerSettingsSection(section)
        }
        // This face only edits the settings. Turning "Show the widget" on must also start the widget face that
        // owns the panels, once the switch is stored, so the face reads it as on.
        model.preferencesSaved = { patch in
            if patch["showWidget"] == .bool(true) { WidgetLaunch.ensureRunning() }
        }
        model.startSettings()
        if let snapshotPath {
            let delay = Double(snapshotArgument("--snapshot-delay") ?? "") ?? 2
            ClickyHost.shared.snapshotSettings(pageID: initialPageID, to: snapshotPath, delay: delay)
            return
        }

        let menu = NSMenu()
        let root = NSMenuItem()
        let application = NSMenu()
        application.addItem(withTitle: "Feature settings…", action: #selector(showSettings), keyEquivalent: ",")
            .target = self
        application.addItem(
            withTitle: "Quit Clicky", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        root.submenu = application
        menu.addItem(root)
        NSApp.mainMenu = menu
        ClickyHost.shared.start(standalone: true)
        ClickyHost.shared.showSettings(pageID: initialPageID)
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
        flock(descriptor, LOCK_UN)
        close(descriptor)
    }
}

func runClicky(_ args: [String] = []) -> Never {
    MainActor.assumeIsolated {
        let pageID = args.firstIndex(of: "--page").flatMap { index in
            args.indices.contains(index + 1) ? args[index + 1] : nil
        }
        let snapshotPath = args.firstIndex(of: "--snapshot").flatMap { index in
            args.indices.contains(index + 1) ? args[index + 1] : nil
        }
        if let snapshotPath {
            let app = NSApplication.shared
            let delegate = ClickyAppDelegate(descriptor: -1, pageID: pageID, snapshotPath: snapshotPath)
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

@MainActor
enum ClickyLaunch {
    static func openSettings(pageID: String? = nil) {
        guard let executable = Bundle.main.executableURL else { return }
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
