import AppKit

/// The Dock tile of the window faces (hub, review, settings). Every face is its own process of the
/// same bundle, and the Dock shows one tile per `.regular` process (nine faces showed nine tiles,
/// measured 2026-10-08). So only one face is `.regular` at a time: the hub when it runs, else one
/// window face (App/DockTile.swift has the rule). A Dock click reaches that one process only. When it
/// is not the hub, it sends the click on to the hub if one runs, and every face's Dock menu offers the hub.
@MainActor
package enum AppDock {
    /// For a face that is not the hub: bring the running hub forward too. Returns what
    /// `applicationShouldHandleReopen` returns, true: AppKit then restores this face's own window
    /// when none is visible.
    package static func reopenFromOtherFace() -> Bool {
        if HubSingleInstance.isRunningElsewhere {
            HubPerf.log("dock: reopen, handing it to the running hub")
            // Answered through the run loop, so after this callback returns.
            DispatchQueue.main.async { HubSingleInstance.handOff([]) }
        }
        return true
    }

    /// The hub's own Dock click: its window back from the Dock, a hidden app or behind other windows.
    package static func reopenHub(_ window: NSWindow?) -> Bool {
        guard let window else { return true }
        HubPerf.log("dock: reopen, showing the hub window")
        if window.isMiniaturized {
            window.deminiaturize(nil)
        }
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        return false
    }

    /// The tile's right-click menu: "Agents" on every face. AppKit adds this process's windows above it.
    package static func menu(hubWindow: NSWindow? = nil) -> NSMenu {
        let menu = NSMenu()
        let item = NSMenuItem(title: "Agents", action: #selector(AppDockTarget.showHub(_:)), keyEquivalent: "")
        item.target = AppDockTarget.shared
        AppDockTarget.shared.hubWindow = hubWindow
        menu.addItem(item)
        return menu
    }

    /// The hub, wherever it runs: this window, the running hub, or a new one. False when none runs and
    /// no new one could be started, so a caller that would quit can show something else instead.
    @discardableResult
    static func showHub(_ hubWindow: NSWindow?, onFailure: @escaping @MainActor () -> Void = {}) -> Bool {
        // A build without the hub part (Host/AppParts.swift): the caller shows its own window instead.
        guard AppParts.has(face: "--hub") else {
            HubPerf.log("dock: this build has no hub part")
            return false
        }
        if let hubWindow {
            _ = reopenHub(hubWindow)
        } else if HubSingleInstance.isRunningElsewhere {
            DispatchQueue.main.async { HubSingleInstance.handOff([]) }
        } else if Bundle.main.bundlePath.hasSuffix(".app") {
            HubPerf.log("dock: no hub runs, starting one")
            // Through Launch Services, then the focus handed over: since macOS 14 an app the user is not in comes
            // forward only when the active app yields to it, and a plain child process opened the hub behind the
            // permissions window ("it did open, but didnt forward it", 2026-11-02).
            let configuration = NSWorkspace.OpenConfiguration()
            configuration.arguments = ["--hub"]
            configuration.environment = ProcessInfo.processInfo.environment
            configuration.createsNewApplicationInstance = true
            configuration.activates = true
            NSWorkspace.shared.openApplication(at: Bundle.main.bundleURL, configuration: configuration) { app, error in
                DispatchQueue.main.async {
                    if let error {
                        HubPerf.log("dock: the hub did not start: \(error.localizedDescription)")
                        onFailure()
                        return
                    }
                    guard let app else { onFailure(); return }
                    NSApp.yieldActivation(to: app)
                    app.activate()
                    HubPerf.log("dock: the hub started as pid \(app.processIdentifier), focus handed to it")
                }
            }
        } else if let executable = Bundle.main.executablePath {
            // A build run outside its bundle (`.build/debug/GenesisTools`): Launch Services cannot start it.
            HubPerf.log("dock: no hub runs, starting one outside a bundle")
            let process = Process()
            process.executableURL = URL(fileURLWithPath: executable)
            process.arguments = ["--hub"]
            do {
                try process.run()
            } catch {
                HubPerf.log("dock: the hub did not start: \(error)")
                return false
            }
        } else {
            HubPerf.log("dock: the hub did not start: no executable path")
            return false
        }
        return true
    }
}

@MainActor
final class AppDockTarget: NSObject {
    static let shared = AppDockTarget()
    weak var hubWindow: NSWindow?

    @objc func showHub(_ sender: Any?) {
        // A build without the hub part: the alert names the command that adds it (Host/AppParts.swift).
        guard AppParts.canLaunch(face: "--hub") else { return }
        AppDock.showHub(hubWindow)
    }
}
