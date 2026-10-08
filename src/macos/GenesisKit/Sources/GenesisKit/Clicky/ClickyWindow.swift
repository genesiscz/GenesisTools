import AppKit
import SwiftUI

@MainActor
public final class ClickyWindowController {
    public let model: ClickyModel
    public private(set) var window: NSWindow?
    public init(model: ClickyModel) { self.model = model }

    @discardableResult
    public func prepare(page: ClickyPage = .sound) -> NSWindow {
        if let window { return window }
        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 960, height: 760),
            styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
            backing: .buffered, defer: false)
        window.title = "Clicky settings"
        window.titlebarAppearsTransparent = true
        window.titleVisibility = .hidden
        window.isOpaque = false
        window.backgroundColor = .clear
        window.isReleasedWhenClosed = false
        window.contentMinSize = NSSize(width: 860, height: 650)
        window.contentView = NSHostingView(rootView: ClickySettingsView(model: model, page: page))
        window.appearance = NSAppearance(named: .darkAqua)
        window.setFrameAutosaveName("Clicky.settings.window")
        window.center()
        self.window = window
        return window
    }

    public func show() {
        prepare().makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    public func close() { window?.close() }
}
