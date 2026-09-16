import AppKit
import SwiftUI
import UserNotifications

/// Window face of the bundle. Two ways in:
///   `--window`      show the settings window at once (`tools macos permissions ui`)
///   no arguments    a Finder double-click, `open -a GenesisTools`, OR a notification click
///
/// Those last two are indistinguishable at launch: macOS relaunches this bundle with no arguments
/// when the user clicks a banner, and passes no flag to say so. So the no-argument path starts as
/// an accessory with no window, registers the notification delegate, and waits briefly. A click
/// response lands in that window, the action runs and the process quits without ever showing a
/// window. If nothing arrives the launch was a real one and the settings window opens.
///
/// Requests made from here are attributed to GenesisTools itself, so every prompt lands on the same
/// identity the CLI uses.
func runWindowApp(showWindowImmediately: Bool) -> Never {
    let app = NSApplication.shared
    let delegate = GenesisAppDelegate(showWindowImmediately: showWindowImmediately)
    app.delegate = delegate
    app.setActivationPolicy(showWindowImmediately ? .regular : .accessory)
    app.run()
    exit(0)
}

/// How long a no-argument launch waits for a click response before deciding it was a real launch.
/// The response arrives within a few hundred milliseconds in practice; the rest is headroom.
private let notificationClickGraceSeconds = 1.2

final class GenesisAppDelegate: NSObject, NSApplicationDelegate {
    private let showWindowImmediately: Bool
    private var window: NSWindow?

    init(showWindowImmediately: Bool) {
        self.showWindowImmediately = showWindowImmediately
        super.init()
    }

    /// Registering here rather than in `applicationDidFinishLaunching` is what makes a click work:
    /// a response that caused this launch is dropped if the delegate is not in place by the time
    /// launching finishes. Without it, clicking a banner only opened the settings window.
    func applicationWillFinishLaunching(_ notification: Notification) {
        UNUserNotificationCenter.current().delegate = sharedNotificationDelegate
        logClick("launch argv=\(Array(CommandLine.arguments.dropFirst())) window=\(showWindowImmediately)")
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        if showWindowImmediately {
            showWindow()
            return
        }

        DispatchQueue.main.asyncAfter(deadline: .now() + notificationClickGraceSeconds) { [weak self] in
            // A click-launched process performs its action and exits on its own, so there is
            // nothing to show.
            if notificationClickReceived {
                return
            }

            logClick("no click within \(notificationClickGraceSeconds)s, opening the settings window")
            self?.showWindow()
        }
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        true
    }

    private func showWindow() {
        quitAfterNotificationClick = false
        NSApp.setActivationPolicy(.regular)

        let controller = NSHostingController(rootView: RootView())
        let window = NSWindow(contentViewController: controller)
        window.title = "GenesisTools"
        window.styleMask = [.titled, .closable, .miniaturizable, .resizable]
        window.setContentSize(NSSize(width: 860, height: 620))
        window.center()
        window.makeKeyAndOrderFront(nil)
        self.window = window

        NSApp.activate(ignoringOtherApps: true)
    }
}

struct RootView: View {
    @StateObject private var permissions = PermissionsModel()
    @StateObject private var services = ServicesModel()
    @StateObject private var settings = SettingsModel()

    var body: some View {
        TabView {
            PermissionsView(model: permissions)
                .tabItem { Label("Permissions", systemImage: "lock.shield") }
            ServicesView(model: services)
                .tabItem { Label("Services", systemImage: "gearshape.2") }
            SettingsView(model: settings)
                .tabItem { Label("Settings", systemImage: "slider.horizontal.3") }
        }
        .padding(12)
        .frame(minWidth: 760, minHeight: 540)
        .onAppear {
            permissions.refresh()
            services.refresh()
            settings.refresh()
        }
    }
}
