import AppKit

/// The Dock tile of the window faces (hub, review, settings). Every face is its own process of the
/// same bundle, and the Dock shows ONE GenesisTools tile for all of them: a click on it reaches one
/// process only, often an older review window, never necessarily the hub. With five faces running,
/// the hub was unreachable from the Dock once hidden or behind other apps (2026-09-30). So each face
/// sends a Dock click on to the hub when one runs, and every face's Dock menu offers the hub.
@MainActor
enum AppDock {
    /// For a face that is not the hub: bring the running hub forward too. Returns what
    /// `applicationShouldHandleReopen` returns, true: AppKit then restores this face's own window
    /// when none is visible.
    static func reopenFromOtherFace() -> Bool {
        if HubSingleInstance.isRunningElsewhere {
            HubPerf.log("dock: reopen, handing it to the running hub")
            // Answered through the run loop, so after this callback returns.
            DispatchQueue.main.async { _ = HubSingleInstance.forwardToRunningHub([]) }
        }
        return true
    }

    /// The hub's own Dock click: its window back from the Dock, a hidden app or behind other windows.
    static func reopenHub(_ window: NSWindow?) -> Bool {
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
    static func menu(hubWindow: NSWindow? = nil) -> NSMenu {
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
    static func showHub(_ hubWindow: NSWindow?) -> Bool {
        if let hubWindow {
            _ = reopenHub(hubWindow)
        } else if HubSingleInstance.isRunningElsewhere {
            DispatchQueue.main.async { _ = HubSingleInstance.forwardToRunningHub([]) }
        } else if let executable = Bundle.main.executablePath {
            HubPerf.log("dock: no hub runs, starting one")
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
        AppDock.showHub(hubWindow)
    }
}
