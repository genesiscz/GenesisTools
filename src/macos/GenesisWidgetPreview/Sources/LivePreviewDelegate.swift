import AppKit
import GenesisKit

@MainActor
final class LivePreviewDelegate: NSObject, NSApplicationDelegate {
    private var widget: WidgetCoordinator?
    private var terminating = false
    private var terminationReplied = false
    func applicationDidFinishLaunching(_ notification: Notification) {
        guard let binary = Bundle.main.object(forInfoDictionaryKey: "GenesisToolsWidgetCLI") as? String
        else {
            NSLog("Preview has no source CLI configured")
            NSApp.terminate(nil)
            return
        }
        let stateRoot =
            Bundle.main.object(forInfoDictionaryKey: "GenesisToolsWidgetStateRoot") as? String
        guard let stateRoot else {
            NSLog("Preview requires an isolated state root")
            NSApp.terminate(nil)
            return
        }
        let runtime = FlowFocusRuntime(dataRoot: URL(fileURLWithPath: stateRoot).appendingPathComponent("flow-focus"),
            hostID: Bundle.main.bundleIdentifier, liveServices: false, presentsWindows: true, sharedModels: false)
        widget = WidgetCoordinator(binaryPath: binary, stateRoot: stateRoot, flowRuntime: runtime,
            micLauncher: nil) { session in
            var components = URLComponents(string: "genesis-tools://hub")!
            components.queryItems = [URLQueryItem(name: "mode", value: "agents")]
            if let session {
                components.queryItems?.append(
                    URLQueryItem(name: "session", value: session.parentSessionId ?? session.target.sessionId))
                if let agent = session.agentId {
                    components.queryItems?.append(URLQueryItem(name: "agent", value: agent))
                }
            }
            if let url = components.url { NSWorkspace.shared.open(url) }
        }
        let menu = NSMenu()
        let item = NSMenuItem()
        let app = NSMenu()
        app.addItem(withTitle: "Widget sessions…", action: #selector(showSettings), keyEquivalent: ",")
            .target = self
        app.addItem(
            withTitle: "Quit GenesisTools Preview", action: #selector(NSApplication.terminate(_:)),
            keyEquivalent: "q")
        item.submenu = app
        menu.addItem(item)
        NSApp.mainMenu = menu
        widget?.start(showSettings: true)
    }
    @objc private func showSettings() { widget?.showSettings() }
    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        guard !terminating else { return .terminateLater }
        terminating = true
        Task { [self] in
            await widget?.shutdown()
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
    func applicationWillTerminate(_ notification: Notification) { widget?.stop() }
}
