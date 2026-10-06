import AppKit
import GenesisKit
import SwiftUI

@MainActor
private final class ShowOnceAppDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate {
    var window: NSWindow?
    var model: ShowOnceModel?
    let arguments: [String]
    init(arguments: [String]) { self.arguments = arguments }
    private func value(_ flag: String) -> String? {
        guard let index = arguments.firstIndex(of: flag), arguments.indices.contains(index + 1) else { return nil }
        return arguments[index + 1]
    }
    func applicationDidFinishLaunching(_ notification: Notification) {
        do {
            let model = try ShowOnceModel(toolsPath: value("--tools") ?? ToolsBridge.defaultBinaryPath())
            self.model = model
            let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1440, height: 940),
                styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView], backing: .buffered, defer: false)
            window.title = "Show Once"; window.titleVisibility = .hidden; window.titlebarAppearsTransparent = true
            window.appearance = NSAppearance(named: .darkAqua); window.backgroundColor = ReviewPalette.background
            window.minSize = NSSize(width: 900, height: 620); window.delegate = self
            let host = NSHostingView(rootView: ShowOnceView(model: model).defaultAppStorage(HubDefaults.store).titlebarZone())
            host.sizingOptions = []; window.contentView = host; window.center(); self.window = window
            installMenu()
            if let file = value("--open") { model.open(URL(fileURLWithPath: file)) }
            if let port = value("--port") { model.port = port; model.refreshTabs() }
            if let target = value("--target") { model.targetId = target }
            if let folder = value("--downloads") { model.downloads = folder }
            if let folder = value("--destination") { model.destination = folder }
            if let snapshot = value("--snapshot") {
                window.alphaValue = 0; window.orderFront(nil)
                DispatchQueue.main.asyncAfter(deadline: .now() + 2) { [weak self] in
                    guard let self, let window = self.window else { return }
                    ReviewSnapshot.write(window: window, webView: nil, to: snapshot) { self.model?.stop(); NSApp.terminate(nil) }
                }
            } else { window.makeKeyAndOrderFront(nil); NSApp.activate(ignoringOtherApps: true) }
        } catch {
            let alert = NSAlert(error: error); alert.runModal(); NSApp.terminate(nil)
        }
    }
    func windowShouldClose(_ sender: NSWindow) -> Bool { model?.confirmDiscard() ?? true }
    func windowWillClose(_ notification: Notification) { model?.stop(); NSApp.terminate(nil) }
    func applicationWillTerminate(_ notification: Notification) { model?.stop() }
    private func installMenu() {
        let menu = NSMenu()
        let app = NSMenuItem(); let appMenu = NSMenu(); app.submenu = appMenu
        appMenu.addItem(withTitle: "Quit Show Once", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        menu.addItem(app)
        let file = NSMenuItem(); file.title = "File"; let fileMenu = NSMenu(title: "File"); file.submenu = fileMenu
        for (title, action, key) in [("Open workflow…", #selector(openWorkflow), "o"), ("Save workflow", #selector(saveWorkflow), "s"), ("Export recipe…", #selector(exportWorkflow), "")] {
            let item = NSMenuItem(title: title, action: action, keyEquivalent: key); item.target = self; fileMenu.addItem(item)
        }
        menu.addItem(file)
        let edit = NSMenuItem(); edit.title = "Edit"; let editMenu = NSMenu(title: "Edit"); edit.submenu = editMenu
        editMenu.addItem(withTitle: "Undo", action: Selector(("undo:")), keyEquivalent: "z")
        editMenu.addItem(.separator())
        editMenu.addItem(withTitle: "Cut", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        editMenu.addItem(withTitle: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        editMenu.addItem(withTitle: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        editMenu.addItem(withTitle: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        menu.addItem(edit); NSApp.mainMenu = menu
    }
    @objc private func openWorkflow() { model?.chooseOpen() }
    @objc private func saveWorkflow() { model?.save() }
    @objc private func exportWorkflow() { model?.save(export: true) }
}
func runShowOnce(_ arguments: [String]) -> Never {
    MainActor.assumeIsolated {
        let app = NSApplication.shared
        app.setActivationPolicy(arguments.contains("--snapshot") ? .prohibited : .regular)
        let delegate = ShowOnceAppDelegate(arguments: arguments)
        app.delegate = delegate
        withExtendedLifetime(delegate) { app.run() }
    }
    exit(0)
}
