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

    init(descriptor: Int32, pageID: String?) {
        self.descriptor = descriptor
        self.initialPageID = pageID
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        observer = DistributedNotificationCenter.default().addObserver(
            forName: clickySettingsNotification, object: nil, queue: .main
        ) { [weak self] notification in
            MainActor.assumeIsolated {
                self?.widgetModel?.refreshSettings()
                ClickyHost.shared.showSettings(pageID: notification.userInfo?["page"] as? String)
            }
        }
        let model = WidgetModel(
            binaryPath: ToolsBridge.defaultBinaryPath(),
            stateRoot: Bundle.main.object(forInfoDictionaryKey: "GenesisToolsWidgetStateRoot") as? String)
        widgetModel = model
        for section in WidgetFeatureSettings.sections(
            model: model, modules: WidgetModuleChoice.builtins,
            openSession: { session in
                WidgetLaunch.start(["--widget", "--session-key", session.key])
            })
        {
            ClickyHost.shared.registerSettingsSection(section)
        }
        model.startSettings()

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

    @objc private func showSettings() { ClickyHost.shared.showSettings() }

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
