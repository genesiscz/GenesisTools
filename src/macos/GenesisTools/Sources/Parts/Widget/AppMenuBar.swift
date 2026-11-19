import AppKit
import GenesisKit

/// Owned by the widget delegate, including while the widget panels are hidden.
@MainActor
package final class AppMenuBar {
    /// The executable supplies the linked recorder part's menu before it starts the widget.
    package static var recorderMenu: (() -> NSMenu)?
    package static var keepRecorder: ((Bool) -> Void)?
    private let install: () -> (() -> Void)
    private var remove: (() -> Void)?

    init(install: @escaping () -> (() -> Void)) { self.install = install }

    convenience init() {
        self.init {
            let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
            item.autosaveName = "genesistools.app"
            item.button?.image = NSImage(systemSymbolName: "square.grid.2x2", accessibilityDescription: "GenesisTools")
            item.button?.toolTip = "GenesisTools"
            item.button?.setAccessibilityIdentifier("genesistools-status-item")
            item.menu = Self.makeMenu(installed: Set(AppParts.linked), recorderMenu: Self.recorderMenu) {
                WidgetLaunch.start($0)
            }
            if UserDefaults.standard.object(forKey: "NSStatusItem VisibleCC genesistools.app") == nil {
                item.isVisible = true
            }
            HubPerf.log("app: menu bar item installed (visible \(item.isVisible))")
            return { NSStatusBar.system.removeStatusItem(item) }
        }
    }

    func update(shown: Bool) {
        if shown {
            if remove == nil { remove = install() }
        } else {
            remove?()
            remove = nil
        }
    }

    static func makeMenu(installed: Set<String>, recorderMenu: (() -> NSMenu)?,
                         launch: @escaping ([String]) -> Void) -> NSMenu {
        var rows: [MenuButtonItem] = []
        func add(_ title: String, _ arguments: [String], part: String? = nil) {
            if let part, !installed.contains(part) { return }
            rows.append(.action(title, run: { launch(arguments) }))
        }
        add("Open Hub", ["--hub"], part: "hub")
        add("Settings…", ["--features", "--page", "general"], part: "features")
        add("Permissions…", ["--window"])
        add("Meetings", ["--meetings"], part: "meetings")
        add("Work", ["--hub", "--mode", "work"], part: "hub")
        let recorderIndex = rows.count
        add("Clicky", ["--features", "--page", "clicky.sound"], part: "clicky")
        add("Markdown", ["--markdown"], part: "markdown")
        add("Features", ["--features"], part: "features")
        let menu = MenuButtonPresenter.menu(rows)
        if installed.contains("recorder"), let recorderMenu {
            let row = NSMenuItem(title: "Recorder", action: nil, keyEquivalent: "")
            row.submenu = recorderMenu()
            menu.insertItem(row, at: recorderIndex)
        }
        return menu
    }
}
