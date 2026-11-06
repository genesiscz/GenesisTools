import AppKit

/// The Meetings face's menu bar. Without one the window had no Close (⌘W), Minimize (⌘M) or Quit (⌘Q), and its text
/// fields (the filter, a rename, a label, a typed answer) took no ⌘C, ⌘V, ⌘A or ⌘Z: AppKit sends those keys to the
/// field only through an Edit menu.
@MainActor
enum MeetingsMenu {
    /// Every item of the bar with its key, so a test can check the bar without installing it.
    static func build(appName: String = "GenesisTools") -> NSMenu {
        let bar = NSMenu()
        let target = MeetingsMenuTarget.shared

        let app = NSMenu(title: appName)
        app.addItem(withTitle: "About \(appName)", action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)), keyEquivalent: "")
        app.addItem(.separator())
        let settings = app.addItem(withTitle: "Meetings Settings…", action: #selector(MeetingsMenuTarget.openSettings(_:)), keyEquivalent: ",")
        settings.target = target
        app.addItem(.separator())
        app.addItem(withTitle: "Hide \(appName)", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
        app.addItem(withTitle: "Quit Meetings", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        bar.addItem(withTitle: appName, action: nil, keyEquivalent: "").submenu = app

        let file = NSMenu(title: "File")
        file.addItem(withTitle: "Close Window", action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w")
        bar.addItem(withTitle: "File", action: nil, keyEquivalent: "").submenu = file

        bar.addItem(StandardEditing.menuItem())

        let view = NSMenu(title: "View")
        let needs = view.addItem(withTitle: "Needs You", action: #selector(MeetingsMenuTarget.showNeeds(_:)), keyEquivalent: "1")
        needs.target = target
        let all = view.addItem(withTitle: "All Meetings", action: #selector(MeetingsMenuTarget.showAll(_:)), keyEquivalent: "2")
        all.target = target
        view.addItem(.separator())
        let reload = view.addItem(withTitle: "Reload", action: #selector(MeetingsMenuTarget.reload(_:)), keyEquivalent: "r")
        reload.target = target
        bar.addItem(withTitle: "View", action: nil, keyEquivalent: "").submenu = view

        let window = NSMenu(title: "Window")
        window.addItem(withTitle: "Minimize", action: #selector(NSWindow.performMiniaturize(_:)), keyEquivalent: "m")
        window.addItem(withTitle: "Zoom", action: #selector(NSWindow.performZoom(_:)), keyEquivalent: "")
        bar.addItem(withTitle: "Window", action: nil, keyEquivalent: "").submenu = window
        return bar
    }

    static func install() {
        let bar = build()
        NSApp.mainMenu = bar
        NSApp.windowsMenu = bar.item(withTitle: "Window")?.submenu
    }
}

/// The menu's actions on the one Meetings window.
@MainActor
final class MeetingsMenuTarget: NSObject {
    static let shared = MeetingsMenuTarget()
    /// The window's model; the face sets it before the menu is used, a test sets its own.
    var model: MeetingsWindowModel?

    @objc func showNeeds(_ sender: Any?) { model?.go(.needs) }
    @objc func showAll(_ sender: Any?) { model?.go(.all) }
    @objc func reload(_ sender: Any?) {
        model?.load()
        model?.detail?.refreshLoaded()
    }
    @objc func openSettings(_ sender: Any?) { FeatureSettingsLaunch.open(pageID: MeetingsSettingsPages.windowPage) }
}
