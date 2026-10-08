import AppKit
import Darwin

private let clickySettingsNotification = Notification.Name(NativePreview.namespace + ".clicky.show-settings")

@MainActor
private final class ClickyAppDelegate: NSObject, NSApplicationDelegate {
    private var observer: NSObjectProtocol?
    private let descriptor: Int32

    init(descriptor: Int32) { self.descriptor = descriptor }

    func applicationDidFinishLaunching(_ notification: Notification) {
        observer = DistributedNotificationCenter.default().addObserver(
            forName: clickySettingsNotification, object: nil, queue: .main
        ) { _ in MainActor.assumeIsolated { ClickyHost.shared.showSettings() } }

        let menu = NSMenu()
        let root = NSMenuItem()
        let application = NSMenu()
        application.addItem(withTitle: "Clicky settings…", action: #selector(showSettings), keyEquivalent: ",")
            .target = self
        application.addItem(
            withTitle: "Quit Clicky", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        root.submenu = application
        menu.addItem(root)
        NSApp.mainMenu = menu
        ClickyHost.shared.start(standalone: true)
        ClickyHost.shared.showSettings()
    }

    @objc private func showSettings() { ClickyHost.shared.showSettings() }

    func applicationWillTerminate(_ notification: Notification) {
        ClickyHost.shared.stop()
        if let observer { DistributedNotificationCenter.default().removeObserver(observer) }
        flock(descriptor, LOCK_UN)
        close(descriptor)
    }
}

func runClicky() -> Never {
    MainActor.assumeIsolated {
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
            DistributedNotificationCenter.default().post(name: clickySettingsNotification, object: nil)
            exit(0)
        }
        let app = NSApplication.shared
        let delegate = ClickyAppDelegate(descriptor: descriptor)
        app.delegate = delegate
        app.setActivationPolicy(.accessory)
        app.run()
        withExtendedLifetime(delegate) {}
        exit(0)
    }
}

@MainActor
enum ClickyLaunch {
    static func openSettings() {
        guard let executable = Bundle.main.executableURL else { return }
        do {
            let child = Process()
            child.executableURL = executable
            child.arguments = ["--clicky"]
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
