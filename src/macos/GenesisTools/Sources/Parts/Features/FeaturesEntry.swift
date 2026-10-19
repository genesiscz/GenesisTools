import AppKit
import Darwin
import GenesisKit

// The feature settings face, `GenesisTools --features [--page <id>]`: one window with every part's pages, and the
// process the parts' background services run in (Clicky's key sounds, the widget's dictation and Focus). The window
// knows no part: each linked part adds a `FeatureSettingsPlugin` (GenesisKit) through `FeatureSettingsPlugins.add`,
// which the executable calls (Sources/GenesisTools/Parts.swift). `--clicky` is the old name of this face.

// The name it had as Clicky's face: a face started by the previous build still listens for it.
private let showSettingsNotification = Notification.Name(NativePreview.namespace + ".clicky.show-settings")

/// The plug-ins of the linked parts, added before the face starts.
@MainActor
package enum FeatureSettingsPlugins {
    private(set) static var makers: [@MainActor () -> FeatureSettingsPlugin] = []

    package static func add(_ make: @escaping @MainActor () -> FeatureSettingsPlugin) {
        makers.append(make)
    }
}

/// The window and its own pages (General, Background, About); the host the plug-ins install into.
@MainActor
final class FeatureSettingsShell: FeatureSettingsPluginHost {
    let mode: FeatureSettingsMode
    let defaults: UserDefaults
    /// The live window's shared instance; a snapshot's own, over `defaults`, so a plug-in that migrates appearance
    /// keys (Clicky, the widget) shows the result on every page and stores nothing.
    let appearance: NativeSettingsAppearance
    /// The Daemon page's data. The shell owns it, so a snapshot of that page can wait for it like a plug-in's.
    let daemon = DaemonSettingsStore()
    /// The page a snapshot draws (nil: the first page).
    var shownPageID: String?
    /// A snapshot keeps no window frame and no selected page either.
    private lazy var window = FeatureSettingsWindowController(
        sections: [FeatureSettingsPages.general, DaemonSettingsPages.section(store: daemon)], defaults: defaults,
        appearance: appearance, frameAutosaveName: mode == .snapshot ? "" : "FeatureSettings.window")
    private var aboutInfo: [String] = []
    private(set) var plugins: [FeatureSettingsPlugin] = []

    init(mode: FeatureSettingsMode) {
        self.mode = mode
        defaults = mode == .snapshot ? ReadOnlyDefaults() ?? .standard : .standard
        appearance =
            mode == .snapshot ? NativeSettingsAppearance(defaults: defaults, observeExternalChanges: false) : .shared
    }

    /// Builds every plug-in and installs it; About goes last, with the lines the plug-ins added.
    func installPlugins() {
        plugins = FeatureSettingsPlugins.makers.map { $0() }
        for plugin in plugins {
            plugin.install(in: self)
        }
        register(section: FeatureSettingsPages.about(additionalInfo: aboutInfo))
    }

    /// Every plug-in has its data, and so has the Daemon page when it is the one shown: in a build without plug-ins
    /// the snapshot drew its loading placeholder (eve on #549).
    var ready: Bool {
        plugins.allSatisfy { $0.settingsReady(page: shownPageID) }
            && (shownPageID != DaemonSettingsPages.pageID || daemon.settled)
    }

    @discardableResult
    func register(section: NativeSettingsSection) -> Bool { window.register(section: section) }

    func addAboutInfo(_ line: String) { aboutInfo.append(line) }

    func showSettings(pageID: String?) { window.show(pageID: pageID) }

    func close() { window.close() }

    /// Prepares the window and notes the page it really shows: with no `--page` that is the saved selection, which
    /// may be the Daemon or PR activity page (eve on #551).
    func prepareForSnapshot(pageID: String?) -> NSWindow {
        let prepared = window.prepare(pageID: pageID)
        shownPageID = window.store.selectedPageID ?? pageID
        return prepared
    }

    /// `--features --page <id> --headless`: the live window, drawn but never on screen or key, so its controls can be
    /// driven through accessibility (`tools control act --by-identifier`) without taking the user's focus.
    func showHeadless(pageID: String?) {
        window.prepare(pageID: pageID).orderInForSnapshot()
    }

    /// `--features --page <id> --snapshot <png>`: draws the page in a window that never reaches the screen or the
    /// keyboard (alpha 0, `.prohibited` app), waits until every plug-in has its data, writes the PNG and quits.
    ///
    /// The widget's data comes from an asynchronous `hub widget snapshot`, and a fixed delay alone drew the loading
    /// state whenever that took longer. `delay` is the time the page then gets to lay out. The PNG is the window
    /// server's own composite (`WindowSnapshot`), because `cacheDisplay` leaves Liquid Glass and everything it covers
    /// transparent.
    func snapshot(pageID: String?, to path: String, delay: Double) {
        let window = prepareForSnapshot(pageID: pageID)
        window.orderInForSnapshot()
        Task { @MainActor in
            let deadline = ContinuousClock.now + .seconds(45)
            while !ready, ContinuousClock.now < deadline {
                try? await Task.sleep(for: .milliseconds(100))
            }
            guard ready else {
                FileHandle.standardError.write(Data("snapshot: the settings data did not load within 45 s\n".utf8))
                exit(1)
            }
            try? await Task.sleep(for: .seconds(delay))
            guard let capture = await WindowSnapshot.capture(window) else {
                FileHandle.standardError.write(Data("snapshot: no content view\n".utf8))
                exit(1)
            }
            let rep = capture.image
            guard let png = rep.representation(using: .png, properties: [:]) else { exit(1) }
            do {
                try png.write(to: URL(fileURLWithPath: path))
                FileHandle.standardError.write(
                    Data("snapshot: \(path) \(rep.pixelsWide)x\(rep.pixelsHigh) by \(capture.method)\n".utf8))
                exit(0)
            } catch {
                FileHandle.standardError.write(Data("snapshot: \(error.localizedDescription)\n".utf8))
                exit(1)
            }
        }
    }
}

@MainActor
private final class FeaturesAppDelegate: NSObject, NSApplicationDelegate {
    private var observer: NSObjectProtocol?
    private let descriptor: Int32
    private let initialPageID: String?
    private let snapshotPath: String?
    private let shell: FeatureSettingsShell
    private var terminating = false
    private var terminationReplied = false

    init(descriptor: Int32, pageID: String?, snapshotPath: String? = nil, headless: Bool = false) {
        self.descriptor = descriptor
        self.initialPageID = pageID
        self.snapshotPath = snapshotPath
        shell = FeatureSettingsShell(mode: snapshotPath != nil ? .snapshot : headless ? .headless : .live)
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        if shell.mode == .live { observeSettingsRequests() }
        launch()
    }

    private func observeSettingsRequests() {
        observer = DistributedNotificationCenter.default().addObserver(
            forName: showSettingsNotification, object: nil, queue: .main
        ) { [weak self] notification in
            MainActor.assumeIsolated {
                guard let shell = self?.shell else { return }
                for plugin in shell.plugins {
                    plugin.settingsReopened()
                }
                shell.showSettings(pageID: notification.userInfo?["page"] as? String)
            }
        }
    }

    private func launch() {
        shell.installPlugins()
        switch shell.mode {
        case .snapshot:
            let delay = Double(snapshotArgument("--snapshot-delay") ?? "") ?? 2
            shell.snapshot(pageID: initialPageID, to: snapshotPath ?? "", delay: delay)
        case .headless:
            shell.showHeadless(pageID: initialPageID)
        case .live:
            installMenu()
            // `--no-activate` is a rebuild's relaunch (relaunch.ts): the services come back without the window,
            // which would take the keyboard from the app in front.
            if !CommandLine.arguments.contains("--no-activate") {
                shell.showSettings(pageID: initialPageID)
            }
        }
    }

    private func installMenu() {
        let menu = NSMenu()
        let root = NSMenuItem()
        let application = NSMenu()
        let settings = application.addItem(withTitle: "Feature settings…", action: #selector(showSettings), keyEquivalent: "")
        settings.target = self
        ClickyKeymap.shared.bind(settings, to: ClickyKeymap.settings)
        let quit = application.addItem(
            withTitle: "Quit Settings", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "")
        ClickyKeymap.shared.bind(quit, to: ClickyKeymap.quit)
        root.submenu = application
        menu.addItem(root)
        NSApp.mainMenu = menu
    }

    private func snapshotArgument(_ flag: String) -> String? {
        let args = CommandLine.arguments
        guard let index = args.firstIndex(of: flag), args.indices.contains(index + 1) else { return nil }
        return args[index + 1]
    }

    @objc private func showSettings() { shell.showSettings(pageID: nil) }

    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        guard !terminating else { return .terminateLater }
        terminating = true
        Task { [self] in
            for plugin in shell.plugins {
                await plugin.stop()
            }
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
        shell.close()
        if let observer { DistributedNotificationCenter.default().removeObserver(observer) }
        // A snapshot or headless run holds no instance lock (its descriptor is -1).
        guard descriptor >= 0 else { return }
        flock(descriptor, LOCK_UN)
        close(descriptor)
    }
}

package func runFeatures(_ args: [String] = []) -> Never {
    MainActor.assumeIsolated {
        let pageID = args.firstIndex(of: "--page").flatMap { index in
            args.indices.contains(index + 1) ? args[index + 1] : nil
        }
        // The staging gate's own reading, so `--snapshot --page general` never writes a file named "--page".
        let snapshotPath = NativeStaging.snapshotPath(args)
        let headless = args.contains("--headless")
        if snapshotPath != nil || headless {
            let app = NSApplication.shared
            let delegate = FeaturesAppDelegate(
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
            NSLog("Settings instance directory failed: %@", error.localizedDescription)
            exit(1)
        }
        // The lock file keeps Clicky's name, so a face started by the previous build and one started by this build
        // never both run.
        let descriptor = open(
            root.appendingPathComponent("clicky-instance.lock").path, O_CREAT | O_RDWR | O_CLOEXEC, 0o600)
        guard descriptor >= 0 else {
            NSLog("Settings instance lock failed")
            exit(1)
        }
        guard flock(descriptor, LOCK_EX | LOCK_NB) == 0 else {
            close(descriptor)
            // A background relaunch that finds the face already running leaves it alone.
            if args.contains("--no-activate") { exit(0) }
            DistributedNotificationCenter.default().postNotificationName(
                showSettingsNotification, object: nil, userInfo: pageID.map { ["page": $0] },
                deliverImmediately: true)
            exit(0)
        }
        let app = NSApplication.shared
        let delegate = FeaturesAppDelegate(descriptor: descriptor, pageID: pageID)
        app.delegate = delegate
        // A notification click that runs something hands focus back to the app it was clicked over.
        BrowserURLForwarder.shared.trackOtherApps()
        installNotificationClicksForWindowFace()
        MainActor.assumeIsolated { WindowCycle.install() }
        app.setActivationPolicy(.accessory)
        app.run()
        withExtendedLifetime(delegate) {}
        exit(0)
    }
}
