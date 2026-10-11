import AppKit
import GenesisKit
import SwiftUI

@MainActor
private final class ClickyPreviewDelegate: NSObject, NSApplicationDelegate {
    private var controller: ClickyWindowController?
    private var model: ClickyModel?

    func applicationDidFinishLaunching(_ notification: Notification) {
        let args = CommandLine.arguments
        let snapshotIndex = args.firstIndex(of: "--snapshot")
        let defaults = UserDefaults(suiteName: "dev.genesis.clicky.preview.settings")!
        let model = ClickyModel(defaults: defaults, previewOnly: snapshotIndex != nil)
        self.model = model
        if args.contains("--opaque") { model.preferences.reduceTransparency = true }
        if args.contains("--reduce-motion") { model.preferences.reduceMotion = true }
        // `--theme glass|solid|gradient`: General → Theme in the preview's own defaults suite.
        if let theme = NativeSettingsTheme(stored: value(after: "--theme", in: args)) {
            model.appearance.theme = theme
        }
        let requestedPage = value(after: "--page", in: args)
        let page = ClickyPage.allCases.first { $0.rawValue.lowercased() == requestedPage?.lowercased() } ?? .sound
        let controller = ClickyWindowController(model: model)
        self.controller = controller
        // The Hub section on the preview's suite; `--hub-style native` and `--hub-glass on` set it first. It tells
        // no other process (`broadcasts: false`), so a preview never moves a running hub.
        let hub = HubPreferences(
            defaults: defaults, notificationNamespace: "dev.genesis.clicky.preview", broadcasts: false,
            observeExternalChanges: false)
        hub.style = value(after: "--hub-style", in: args).flatMap(HubWindowStyle.init(rawValue:)) ?? .hub
        hub.glass = value(after: "--hub-glass", in: args) == "on"
        controller.register(section: HubSettingsPages.section(preferences: hub))
        // `--page <Clicky page>` or any registered page id (`--page hub.appearance`).
        let window = ClickyPage.allCases.contains(where: { $0.rawValue.lowercased() == requestedPage?.lowercased() })
            || requestedPage == nil
            ? controller.prepare(page: page)
            : controller.prepare(pageID: requestedPage)
        if let snapshotIndex, args.indices.contains(snapshotIndex + 1) {
            let output = URL(fileURLWithPath: args[snapshotIndex + 1])
            window.alphaValue = 0
            window.orderFrontRegardless()
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.8) {
                MainActor.assumeIsolated {
                    guard let view = window.contentView,
                        let bitmap = view.bitmapImageRepForCachingDisplay(in: view.bounds)
                    else {
                        fputs("Clicky snapshot could not allocate a bitmap\n", stderr)
                        NSApp.terminate(nil)
                        return
                    }
                    print("Clicky titlebar: \(WindowTitlebar.audit(window).line)")
                    view.cacheDisplay(in: view.bounds, to: bitmap)
                    do {
                        guard let data = bitmap.representation(using: .png, properties: [:]) else {
                            throw CocoaError(.fileWriteUnknown)
                        }
                        try data.write(to: output)
                        print("Clicky snapshot: \(output.path)")
                    } catch { fputs("Clicky snapshot failed: \(error)\n", stderr) }
                    NSApp.terminate(nil)
                }
            }
        } else {
            let menu = NSMenu()
            let appItem = NSMenuItem()
            let appMenu = NSMenu()
            appMenu.addItem(
                withTitle: "Quit Clicky Preview", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
            appItem.submenu = appMenu
            menu.addItem(appItem)
            NSApp.mainMenu = menu
            controller.show()
        }
    }

    func applicationWillTerminate(_ notification: Notification) { model?.shutdown() }

    private func value(after flag: String, in args: [String]) -> String? {
        guard let index = args.firstIndex(of: flag), args.indices.contains(index + 1) else { return nil }
        return args[index + 1]
    }
}

@main
private enum ClickyPreviewMain {
    @MainActor static func main() {
        if SettingsAppearanceFixture.runIfRequested(CommandLine.arguments) { return }
        let app = NSApplication.shared
        let delegate = ClickyPreviewDelegate()
        app.delegate = delegate
        app.setActivationPolicy(CommandLine.arguments.contains("--snapshot") ? .prohibited : .regular)
        app.run()
        withExtendedLifetime(delegate) {}
    }
}
