import AppKit
import GenesisKit
import SwiftUI

@MainActor
final class ClickyHost: NSObject {
    static let shared = ClickyHost()
    /// The settings window's own appearance instance (`NativeSettingsAppearance.shared`), so a change on General and
    /// Clicky's copy of it never disagree.
    let model = ClickyModel(appearance: .shared)
    /// Opens the settings window this process shows (ClickyPlugin.swift sets it).
    var openSettings: @MainActor (String?) -> Void = { _ in }
    private var item: NSStatusItem?
    private var popover: NSPopover?
    private var standalone = false

    func start(standalone: Bool = false) {
        self.standalone = standalone
        guard item == nil else { return }
        let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
        item.button?.image = NSImage(systemSymbolName: "keyboard", accessibilityDescription: "Clicky")
        item.button?.toolTip = "Clicky · off"
        item.button?.target = self
        item.button?.action = #selector(togglePopover)
        self.item = item
        model.stateDidChange = { [weak self] in
            guard let self else { return }
            self.item?.button?.toolTip = "Clicky · \(self.model.status)"
            self.item?.button?.appearsDisabled = !self.model.enabled
        }
        model.restoreEnabled()
    }

    func showSettings(pageID: String? = nil) {
        popover?.close()
        openSettings(pageID)
    }

    func stop() {
        popover?.close()
        popover = nil
        model.deactivate(remember: false)
        model.stateDidChange = nil
        if let item { NSStatusBar.system.removeStatusItem(item) }
        item = nil
    }

    @objc private func togglePopover() {
        if popover?.isShown == true {
            popover?.close()
            return
        }
        guard let button = item?.button else { return }
        let popover = NSPopover()
        popover.behavior = .transient
        popover.contentViewController = NSHostingController(
            rootView: ClickyPopoverView(
                model: model,
                showSettings: { [weak self] in
                    self?.showSettings()
                },
                quit: { [weak self] in
                    guard let self else { return }
                    let shouldQuit = self.standalone
                    self.stop()
                    if shouldQuit { NSApp.terminate(nil) }
                }))
        self.popover = popover
        popover.show(relativeTo: button.bounds, of: button, preferredEdge: .minY)
    }
}
