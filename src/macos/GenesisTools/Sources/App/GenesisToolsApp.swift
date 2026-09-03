import AppKit
import SwiftUI

/// Window face of the bundle: `open -a GenesisTools`, a Finder double-click, or
/// `tools macos permissions ui`. Requests made from here are attributed to GenesisTools
/// itself, so every prompt lands on the same identity the CLI uses.
func runWindowApp() -> Never {
    let app = NSApplication.shared
    app.setActivationPolicy(.regular)
    GenesisToolsApp.main()
    exit(0)
}

final class AppDelegate: NSObject, NSApplicationDelegate {
    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.activate(ignoringOtherApps: true)
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        true
    }
}

struct GenesisToolsApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var delegate

    var body: some Scene {
        WindowGroup("GenesisTools") {
            RootView()
                .frame(minWidth: 760, minHeight: 540)
        }
        .windowResizability(.contentSize)
        .commands {
            CommandGroup(replacing: .newItem) {}
        }
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
        .onAppear {
            permissions.refresh()
            services.refresh()
            settings.refresh()
        }
    }
}
