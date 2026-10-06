import AppKit
import GenesisKit
import SwiftUI

@MainActor
private final class BugToTestDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate {
    var model: BugToTestModel!
    var window: NSWindow!
    var openURL: URL?
    var snapshotPath: String?
    var closing = false
    var captured = false
    func installMenu() {
        AppMainMenu.install()
        let file = NSMenu(title: "File")
        for (title, action, key) in [
            ("Open recording…", #selector(openRecording(_:)), "o"),
            ("Save recording…", #selector(saveRecording(_:)), "s"),
            ("Recover local recording…", #selector(recoverRecording(_:)), ""),
            ("Export Playwright repro…", #selector(exportRepro(_:)), "e")
        ] {
            let item = file.addItem(withTitle: title, action: action, keyEquivalent: key); item.target = self
        }
        file.addItem(.separator())
        file.addItem(withTitle: "Close", action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w")
        let item = NSMenuItem(title: "File", action: nil, keyEquivalent: ""); item.submenu = file
        NSApp.mainMenu?.insertItem(item, at: 1)
    }
    @objc func openRecording(_ sender: Any?) { model.open() }
    @objc func saveRecording(_ sender: Any?) { model.saveAs() }
    @objc func recoverRecording(_ sender: Any?) { model.recover() }
    @objc func exportRepro(_ sender: Any?) { model.export() }
    func applicationDidFinishLaunching(_ notification: Notification) {
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1320, height: 880),
            styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView], backing: .buffered, defer: false)
        window.title = "Bug to Test"; window.titleVisibility = .hidden; window.titlebarAppearsTransparent = true
        window.appearance = NSAppearance(named: .darkAqua); window.backgroundColor = ReviewPalette.background; window.minSize = NSSize(width: 900, height: 680)
        let host = NSHostingView(rootView: BugToTestView(model: model).defaultAppStorage(HubDefaults.store).titlebarZone()); host.sizingOptions = []
        window.contentView = host; window.delegate = self; window.center()
        model.onReady = { [weak self] in self?.capture() }
        if snapshotPath != nil { window.orderInForSnapshot() } else { window.makeKeyAndOrderFront(nil) }
        if let openURL { model.open(openURL) } else if snapshotPath != nil { capture() } else { model.refreshTabs() }
    }
    func windowShouldClose(_ sender: NSWindow) -> Bool {
        if closing { return true }
        closing = true
        Task { await model.shutdown(); sender.close(); NSApp.terminate(nil) }
        return false
    }
    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        if closing { return .terminateNow }
        closing = true
        Task { await model.shutdown(); sender.reply(toApplicationShouldTerminate: true) }
        return .terminateLater
    }
    func capture() {
        guard !captured, let path = snapshotPath, let content = window?.contentView else { return }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) {
            guard !self.captured else { return }; self.captured = true
            do {
                guard let bitmap = content.bitmapImageRepForCachingDisplay(in: content.bounds) else { throw bugToTestError("Native rendering failed.") }
                content.cacheDisplay(in: content.bounds, to: bitmap)
                guard let png = bitmap.representation(using: .png, properties: [:]) else { throw bugToTestError("Native PNG encoding failed.") }
                try png.write(to: URL(fileURLWithPath: path), options: .atomic)
                NSApp.terminate(nil)
            } catch { FileHandle.standardError.write(Data((error.localizedDescription + "\n").utf8)); exit(1) }
        }
    }
}
func runBugToTest(_ args: [String]) -> Never {
    MainActor.assumeIsolated {
        func value(_ flag: String) -> String? { guard let index = args.firstIndex(of: flag), index + 1 < args.count else { return nil }; return args[index + 1] }
        let delegate = BugToTestDelegate()
        do { delegate.model = BugToTestModel(toolsPath: try value("--tools") ?? AppToolsOrigin.binaryPath()) }
        catch { FileHandle.standardError.write(Data((error.localizedDescription + "\n").utf8)); exit(1) }
        delegate.openURL = value("--open").map { URL(fileURLWithPath: $0) }; delegate.snapshotPath = value("--snapshot")
        if let page = value("--pane") { delegate.model.reviewPage = page }
        if delegate.snapshotPath != nil { HubDefaults.isolate() }
        let app = NSApplication.shared; app.setActivationPolicy(delegate.snapshotPath == nil ? .regular : .prohibited); app.delegate = delegate
        delegate.installMenu(); installBrowserURLForwarder()
        if delegate.snapshotPath == nil { installNotificationClicksForWindowFace(); if !args.contains("--no-activate") { app.activate(ignoringOtherApps: true) } }
        if delegate.snapshotPath != nil { DispatchQueue.main.asyncAfter(deadline: .now() + 60) { FileHandle.standardError.write(Data("Bug to Test snapshot timed out\n".utf8)); exit(1) } }
        HangWatch.start(); withExtendedLifetime(delegate) { app.run() }
    }
    exit(0)
}
