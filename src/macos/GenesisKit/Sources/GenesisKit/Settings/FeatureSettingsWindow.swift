import AppKit
import SwiftUI

@MainActor
public final class FeatureSettingsWindowController {
    public let store: NativeSettingsStore
    public private(set) var window: NSWindow?
    private let title: String
    private let frameAutosaveName: String

    public init(
        title: String = "Settings", sections: [NativeSettingsSection], defaults: UserDefaults = .standard,
        selectionKey: String = "featureSettings.selectedPage", initialPageID: String? = nil,
        appearance: NativeSettingsAppearance? = nil, frameAutosaveName: String = "FeatureSettings.window"
    ) {
        self.title = title
        self.frameAutosaveName = frameAutosaveName
        store = NativeSettingsStore(
            sections: sections, defaults: defaults, selectionKey: selectionKey,
            initialPageID: initialPageID, appearance: appearance)
    }

    @discardableResult
    public func register(section: NativeSettingsSection) -> Bool { store.register(section: section) }

    @discardableResult
    public func prepare(pageID: String? = nil) -> NSWindow {
        if let pageID { store.select(pageID: pageID) }
        if let window { return window }
        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 960, height: 760),
            styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
            backing: .buffered, defer: false)
        window.title = title
        window.titleVisibility = .hidden
        window.titlebarAppearsTransparent = true
        window.isOpaque = false
        window.backgroundColor = .clear
        window.isReleasedWhenClosed = false
        window.contentMinSize = NSSize(width: 860, height: 650)
        window.contentView = NSHostingView(rootView: FeatureSettingsView(store: store, title: title))
        window.appearance = NSAppearance(named: .darkAqua)
        let restored = window.setFrameUsingName(frameAutosaveName, force: true)
        if !restored || !NativeSettingsWindowGeometry.hasReachableTitlebar(
            frame: window.frame, visibleScreens: NSScreen.screens.map(\.visibleFrame))
        {
            window.center()
        }
        window.setFrameAutosaveName(frameAutosaveName)
        self.window = window
        return window
    }

    public func show(pageID: String? = nil) {
        prepare(pageID: pageID).makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    public func close() { window?.close() }
}

enum NativeSettingsWindowGeometry {
    static func hasReachableTitlebar(frame: NSRect, visibleScreens: [NSRect]) -> Bool {
        guard !frame.isEmpty, frame.origin.x.isFinite, frame.origin.y.isFinite,
            frame.width.isFinite, frame.height.isFinite else { return false }
        let titlebar = NSRect(x: frame.minX, y: frame.maxY - 28, width: frame.width, height: 28)
        return visibleScreens.contains { screen in
            let reachable = screen.intersection(titlebar)
            return reachable.width >= 80 && reachable.height >= 20
        }
    }
}
