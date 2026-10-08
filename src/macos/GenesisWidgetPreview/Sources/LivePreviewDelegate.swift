import AppKit
import GenesisKit

@MainActor
final class LivePreviewDelegate: NSObject, NSApplicationDelegate {
    private var widget: WidgetCoordinator?
    func applicationDidFinishLaunching(_ notification: Notification) {
        guard let binary = Bundle.main.object(forInfoDictionaryKey: "GenesisToolsWidgetCLI") as? String
        else {
            NSLog("Preview has no source CLI configured")
            NSApp.terminate(nil)
            return
        }
        let stateRoot =
            Bundle.main.object(forInfoDictionaryKey: "GenesisToolsWidgetStateRoot") as? String
        widget = WidgetCoordinator(binaryPath: binary, stateRoot: stateRoot) { session in
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
    func applicationWillTerminate(_ notification: Notification) { widget?.stop() }
}
