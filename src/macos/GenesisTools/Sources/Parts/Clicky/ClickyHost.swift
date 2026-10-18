import AppKit
import GenesisKit
import SwiftUI

@MainActor
package final class ClickyHost: NSObject {
    package static let shared = ClickyHost()
    package let model = ClickyModel()
    private lazy var settings = ClickyWindowController(model: model)
    private var item: NSStatusItem?
    private var popover: NSPopover?
    private var standalone = false

    package func start(standalone: Bool = false) {
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

    @discardableResult
    package func registerSettingsSection(_ section: NativeSettingsSection) -> Bool {
        settings.register(section: section)
    }

    /// `--clicky --page <id> --snapshot <png>`: draws the Settings page in a window that never reaches the screen
    /// or the keyboard (alpha 0, `.prohibited` app), waits for its data, writes the PNG and quits.
    ///
    /// `ready` says the pages have their data (`WidgetModel.settingsLoaded`). The data comes from an asynchronous
    /// `hub widget snapshot`, and a fixed delay alone drew the loading state whenever that took longer. `delay` is the
    /// time the page then gets to lay out. The PNG is the window server's own composite (`WindowSnapshot`), because
    /// `cacheDisplay` leaves Liquid Glass and everything it covers transparent.
    package func snapshotSettings(pageID: String?, to path: String, delay: Double, ready: @escaping @MainActor () -> Bool) {
        let window = settings.prepare(pageID: pageID)
        window.orderInForSnapshot()
        Task { @MainActor in
            let deadline = ContinuousClock.now + .seconds(45)
            while !ready(), ContinuousClock.now < deadline {
                try? await Task.sleep(for: .milliseconds(100))
            }
            guard ready() else {
                FileHandle.standardError.write(Data("snapshot: the settings data did not load within 45 s\n".utf8))
                exit(1)
            }
            try? await Task.sleep(for: .seconds(delay))
            guard let capture = await WindowSnapshot.capture(window) else {
                FileHandle.standardError.write(Data("snapshot: no content view\n".utf8))
                exit(1)
            }
            let rep = capture.image
            guard let png = rep.representation(using: .png, properties: [:]) else { exit(1) }
            do {
                try png.write(to: URL(fileURLWithPath: path))
                FileHandle.standardError.write(
                    Data("snapshot: \(path) \(rep.pixelsWide)x\(rep.pixelsHigh) by \(capture.method)\n".utf8))
                exit(0)
            } catch {
                FileHandle.standardError.write(Data("snapshot: \(error.localizedDescription)\n".utf8))
                exit(1)
            }
        }
    }

    /// `--clicky --page <id> --headless`: the live Settings window, drawn but never on screen or key, so its controls
    /// can be driven through accessibility (`tools control act --by-identifier`) without taking the user's focus.
    package func showSettingsHeadless(pageID: String?) {
        settings.prepare(pageID: pageID).orderInForSnapshot()
    }

    package func showSettings(pageID: String? = nil) {
        start(standalone: standalone)
        popover?.close()
        settings.show(pageID: pageID)
    }

    package func stop() {
        popover?.close()
        popover = nil
        settings.close()
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
