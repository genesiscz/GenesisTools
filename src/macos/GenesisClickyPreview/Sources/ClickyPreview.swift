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
        let page: ClickyPage
        if let index = args.firstIndex(of: "--page"), args.indices.contains(index + 1),
            let requested = ClickyPage.allCases.first(where: {
                $0.rawValue.lowercased() == args[index + 1].lowercased()
            })
        {
            page = requested
        } else {
            page = .sound
        }
        let controller = ClickyWindowController(model: model)
        self.controller = controller
        let window = controller.prepare(page: page)
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
