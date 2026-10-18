import AppKit

/// The menu bar of the hub and review windows. They had none, so ⌘C, ⌘V, ⌘X, ⌘A and ⌘Z had no
/// key equivalent: a WKWebView (the diff) or a selectable SwiftUI `Text` never got `copy:`, and
/// AppKit played the alert sound instead (2026-09-25). The first item is the app menu, as macOS
/// requires; Copy goes through `CopyWithFeedback`, which confirms a copy with the copy toast.
///
/// The hub adds File, View, Go, Window and Help with every hub command (`HubMenuCommands`). Their
/// actions run through the palette's executor (`HubModel.runPalette`) or the `--hub` flags a later
/// launch hands over (`HubModel.applyOverlays`), so a menu item, a palette row and `tools hub --…`
/// do the same thing. The keys come from `HubKeymap`: the hub window's handler takes the key, and
/// the menu item shows it and runs the action on a click.
@MainActor
enum AppMainMenu {
    /// True after this process installed the hub menu. The review process installs with no hub, so a session
    /// hosted there keeps Command-R and Command on the keys right of P. Set only here: the session view is
    /// built from call sites this package does not own.
    package private(set) static var installedWithHub = false

    static func install(hub: HubModel? = nil, keymap: Keymap = HubKeymap.shared) {
        installedWithHub = hub != nil
        let name = Bundle.main.object(forInfoDictionaryKey: "CFBundleName") as? String ?? ProcessInfo.processInfo.processName
        let bar = NSMenu()

        let app = NSMenu(title: name)
        app.addItem(withTitle: "About \(name)", action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)), keyEquivalent: "")
        app.addItem(.separator())
        let settings = app.addItem(withTitle: "Settings…", action: #selector(AppMenuTarget.openSettings(_:)), keyEquivalent: "")
        settings.target = AppMenuTarget.shared
        HubKeymap.bind(settings, to: "hub.app.settings", keymap: keymap)
        let permissions = app.addItem(withTitle: "Permissions…", action: #selector(AppMenuTarget.openPermissions(_:)), keyEquivalent: "")
        permissions.target = AppMenuTarget.shared
        app.addItem(.separator())
        bind(app, "Hide \(name)", #selector(NSApplication.hide(_:)), "hub.app.hide", keymap: keymap)
        bind(app, "Hide Others", #selector(NSApplication.hideOtherApplications(_:)), "hub.app.hideOthers", keymap: keymap)
        app.addItem(withTitle: "Show All", action: #selector(NSApplication.unhideAllApplications(_:)), keyEquivalent: "")
        app.addItem(.separator())
        bind(app, "Quit \(name)", #selector(NSApplication.terminate(_:)), "hub.app.quit", keymap: keymap)
        bar.addItem(withTitle: name, action: nil, keyEquivalent: "").submenu = app

        let close = NSMenuItem(title: "Close Window", action: #selector(NSWindow.performClose(_:)), keyEquivalent: "")
        HubKeymap.bind(close, to: "hub.window.close", keymap: keymap)
        if let hub {
            bar.addItem(withTitle: "File", action: nil, keyEquivalent: "").submenu = HubMenuCommands.menu("File", HubMenuCommands.file, hub: hub, keymap: keymap, tail: [
                NSMenuItem.separator(),
                close,
            ])
        } else {
            // The review window has no hub commands. It still closes with ⌘W.
            let file = NSMenu(title: "File")
            file.addItem(close)
            bar.addItem(withTitle: "File", action: nil, keyEquivalent: "").submenu = file
        }

        let edit = NSMenu(title: "Edit")
        bind(edit, "Undo", Selector(("undo:")), "hub.edit.undo", keymap: keymap)
        bind(edit, "Redo", Selector(("redo:")), "hub.edit.redo", keymap: keymap)
        edit.addItem(.separator())
        bind(edit, "Cut", #selector(NSText.cut(_:)), "hub.edit.cut", keymap: keymap)
        let copy = bind(edit, "Copy", #selector(CopyWithFeedback.copyWithFeedback(_:)), "hub.edit.copy", keymap: keymap)
        copy.target = CopyWithFeedback.shared
        bind(edit, "Paste", #selector(NSText.paste(_:)), "hub.edit.paste", keymap: keymap)
        bind(edit, "Paste and Match Style", #selector(NSTextView.pasteAsPlainText(_:)), "hub.edit.pastePlain", keymap: keymap)
        edit.addItem(withTitle: "Delete", action: #selector(NSText.delete(_:)), keyEquivalent: "")
        bind(edit, "Select All", #selector(NSText.selectAll(_:)), "hub.edit.selectAll", keymap: keymap)
        if let hub {
            edit.addItem(.separator())
            for item in HubMenuCommands.items(HubMenuCommands.find, hub: hub, keymap: keymap) {
                edit.addItem(item)
            }
        }
        bar.addItem(withTitle: "Edit", action: nil, keyEquivalent: "").submenu = edit

        if let hub {
            let fullScreen = NSMenuItem(title: "Enter Full Screen", action: #selector(NSWindow.toggleFullScreen(_:)), keyEquivalent: "")
            HubKeymap.bind(fullScreen, to: "hub.window.fullScreen", keymap: keymap)
            let view = HubMenuCommands.menu("View", HubMenuCommands.view, hub: hub, keymap: keymap, tail: [
                NSMenuItem.separator(),
                fullScreen,
            ])
            // View → Look sits under Glass, the other half of how the hub looks.
            let look = view.items.firstIndex { $0.title == "Glass" }.map { $0 + 1 } ?? view.items.count
            view.insertItem(HubMenuCommands.lookItem(hub: hub, keymap: keymap), at: look)
            bar.addItem(withTitle: "View", action: nil, keyEquivalent: "").submenu = view
            bar.addItem(withTitle: "Go", action: nil, keyEquivalent: "").submenu = HubMenuCommands.menu("Go", HubMenuCommands.go, hub: hub, keymap: keymap, tail: [
                NSMenuItem.separator(),
                HubMenuCommands.paletteCommandsItem(hub: hub, keymap: keymap),
            ])
        }

        let window = NSMenu(title: "Window")
        bind(window, "Minimize", #selector(NSWindow.performMiniaturize(_:)), "hub.window.minimize", keymap: keymap)
        window.addItem(withTitle: "Zoom", action: #selector(NSWindow.performZoom(_:)), keyEquivalent: "")
        window.addItem(.separator())
        window.addItem(withTitle: "Bring All to Front", action: #selector(NSApplication.arrangeInFront(_:)), keyEquivalent: "")
        bar.addItem(withTitle: "Window", action: nil, keyEquivalent: "").submenu = window
        // AppKit lists this process's windows under it.
        NSApp.windowsMenu = window

        if let hub {
            let help = HubMenuCommands.menu("Help", HubMenuCommands.help, hub: hub, keymap: keymap)
            bar.addItem(withTitle: "Help", action: nil, keyEquivalent: "").submenu = help
            // The Help menu's search field finds any menu item by name.
            NSApp.helpMenu = help
        } else {
            let help = NSMenu(title: "Help")
            let shortcuts = help.addItem(
                withTitle: "Keyboard Shortcuts", action: #selector(AppMenuTarget.showKeyboardShortcuts(_:)), keyEquivalent: ""
            )
            shortcuts.target = AppMenuTarget.shared
            HubKeymap.bind(shortcuts, to: "hub.help.shortcuts", keymap: keymap)
            bar.addItem(withTitle: "Help", action: nil, keyEquivalent: "").submenu = help
            NSApp.helpMenu = help
        }

        NSApp.mainMenu = bar
    }

    @discardableResult
    private static func bind(_ menu: NSMenu, _ title: String, _ action: Selector, _ id: String, keymap: Keymap) -> NSMenuItem {
        let item = menu.addItem(withTitle: title, action: action, keyEquivalent: "")
        HubKeymap.bind(item, to: id, keymap: keymap)
        return item
    }

    /// Runs the item at `"<Menu>/<Item>"` (a submenu adds a level: "Go/Palette Command/…") as a click
    /// does (`GenesisTools --hub --menu …`). It runs even when the item is greyed out.
    static func perform(_ path: String) {
        var menu = NSApp.mainMenu
        let parts = path.split(separator: "/").map(String.init)
        for (index, title) in parts.enumerated() {
            guard let current = menu, let position = current.items.firstIndex(where: { $0.title == title }) else {
                HubPerf.log("menu: no item “\(title)” in \(path)")
                return
            }
            if index == parts.count - 1 {
                current.update()
                current.performActionForItem(at: position)
            } else {
                menu = current.items[position].submenu
            }
        }
    }
}

/// App-menu actions that are not the hub's.
@MainActor
final class AppMenuTarget: NSObject {
    static let shared = AppMenuTarget()

    /// The settings window with the pages of every part this build links (`GenesisTools --features`,
    /// Parts/Features/FeaturesEntry.swift).
    @objc func openSettings(_ sender: Any?) {
        FeatureSettingsLaunch.open()
    }

    /// The review window's keys live in the hub library: the shared menu, Close Window, and panel find.
    @objc func showKeyboardShortcuts(_ sender: Any?) {
        KeymapHelpWindow.show(HubKeymap.shortcutPages(review: true))
    }

    /// The privacy grants window is its own face (`GenesisTools --window`, App/GenesisToolsApp.swift).
    @objc func openPermissions(_ sender: Any?) {
        guard let executable = Bundle.main.executablePath else { return }
        let process = Process()
        process.executableURL = URL(fileURLWithPath: executable)
        process.arguments = ["--window"]
        do {
            try process.run()
        } catch {
            HubPerf.log("menu: the permissions window did not start: \(error)")
        }
    }
}

// MARK: - Hub commands

/// One hub command in the menu bar: its title, the keymap command it shows, what it runs, and when
/// it shows a check mark or is greyed out. Read when the menu opens (`validateMenuItem`), never on a timer.
@MainActor
struct HubMenuCommand {
    var title: String
    /// A `HubKeymap` command id. Nil for a row that is not in the library (a look, a palette keyword).
    var id: String?
    var run: (HubModel) -> Void
    var checked: ((HubModel) -> Bool)?
    var enabled: ((HubModel) -> Bool)?
    /// A separator before this command.
    var separated = false
}

@MainActor
enum HubMenuCommands {
    static let file: [HubMenuCommand] = [
        HubMenuCommand(title: "New Agent Session", id: "hub.file.newSession", run: { hub in
            if let path = hub.paletteContext.currentPath { hub.runPalette(.newSession(path), toggleGlass: toggleGlass) }
        }, enabled: { $0.paletteContext.currentPath != nil }),
        HubMenuCommand(title: "New Handoff…", id: "hub.file.handoff", run: { overlay($0, "--handoff") },
                       enabled: { $0.selectedID != nil }),
        HubMenuCommand(title: "Prompt Library…", id: HubKeymap.promptLibrary, run: { overlay($0, "--prompts") }),
        HubMenuCommand(title: "Open Project in Cursor", id: "hub.file.cursor", run: { hub in
            if let path = hub.paletteContext.currentPath { hub.runPalette(.openCursor(path), toggleGlass: toggleGlass) }
        }, enabled: { $0.paletteContext.currentPath != nil }, separated: true),
        HubMenuCommand(title: "Open Project in cmux", id: "hub.file.terminal", run: { hub in
            if let path = hub.paletteContext.currentPath { hub.runPalette(.openTerminal(path), toggleGlass: toggleGlass) }
        }, enabled: { $0.paletteContext.currentPath != nil }),
    ]

    static let find: [HubMenuCommand] = [
        HubMenuCommand(title: "Command Palette…", id: HubKeymap.commandPalette, run: { overlay($0, "--palette") }),
        HubMenuCommand(title: "Find in Files…", id: "hub.find.files", run: { $0.findQuery = $0.findQuery == nil ? "" : nil }),
        HubMenuCommand(title: "Search All Transcripts…", id: "hub.find.transcripts", run: { _ in HubDailyModel.shared.toggleSearch() }),
        HubMenuCommand(title: "Search Session History…", id: "hub.find.history", run: { palette($0, "history ") }),
    ]

    static let view: [HubMenuCommand] = HubMode.allCases.map { mode in
        HubMenuCommand(title: mode.title, id: "hub.view.mode.\(mode.rawValue)", run: { $0.runPalette(.setMode(mode), toggleGlass: toggleGlass) },
                       checked: { $0.mode == mode })
    } + HubTab.allCases.enumerated().map { index, pane in
        HubMenuCommand(title: "\(pane.title) Pane", id: "hub.view.pane.\(pane.rawValue)",
                       run: { $0.runPalette(.togglePane(pane), toggleGlass: toggleGlass) },
                       checked: { $0.panes.contains(pane) }, separated: index == 0)
    } + [
        HubMenuCommand(title: "Glass", id: HubKeymap.glass, run: { $0.runPalette(.toggleGlass, toggleGlass: toggleGlass) },
                       checked: { _ in HubDefaults.preferences.glass && HubGlassSwitch.available },
                       enabled: { _ in HubGlassSwitch.available }, separated: true),
        HubMenuCommand(title: "Hub Settings…", id: "hub.view.settings", run: { _ in FeatureSettingsLaunch.open(pageID: HubSettingsPages.appearancePageID) }),
        HubMenuCommand(title: "Split Diff", id: "hub.view.diff.split", run: { review(of: $0)?.setStyle(.split) },
                       checked: { review(of: $0)?.options.diffStyle == .split }, enabled: { review(of: $0) != nil }, separated: true),
        HubMenuCommand(title: "Unified Diff", id: "hub.view.diff.unified", run: { review(of: $0)?.setStyle(.unified) },
                       checked: { review(of: $0)?.options.diffStyle == .unified }, enabled: { review(of: $0) != nil }),
        HubMenuCommand(title: "Wrap Diff Lines", id: "hub.view.diff.wrap", run: { review(of: $0)?.toggleWrap() },
                       checked: { review(of: $0)?.options.wrap == true }, enabled: { review(of: $0) != nil }),
        HubMenuCommand(title: "Bigger Diff Text", id: "hub.view.diff.bigger", run: { review(of: $0)?.stepFont(1) }, enabled: { review(of: $0) != nil }),
        HubMenuCommand(title: "Smaller Diff Text", id: "hub.view.diff.smaller", run: { review(of: $0)?.stepFont(-1) }, enabled: { review(of: $0) != nil }),
        HubMenuCommand(title: "Actual Diff Text Size", id: "hub.view.diff.actual", run: { hub in
            if let review = review(of: hub) { review.stepFont(DiffViewOptions().fontSize - review.options.fontSize) }
        }, enabled: { review(of: $0) != nil }),
        HubMenuCommand(title: "Today Digest", id: "hub.view.digest", run: { _ in HubDailyModel.shared.toggleDigest() },
                       separated: true),
        HubMenuCommand(title: "Rules", id: "hub.view.rules", run: { overlay($0, "--rules") }),
        HubMenuCommand(title: "Reload", id: "hub.view.reload", run: reload, enabled: { $0.mode != .worktrees }, separated: true),
    ]

    static let go: [HubMenuCommand] = [
        HubMenuCommand(title: "Back", id: "hub.go.back", run: { $0.goBack() }, enabled: { $0.history.canGoBack }),
        HubMenuCommand(title: "Forward", id: "hub.go.forward", run: { $0.goForward() }, enabled: { $0.history.canGoForward }),
        HubMenuCommand(title: "Session…", id: "hub.go.session", run: { palette($0, "session ") }, separated: true),
        HubMenuCommand(title: "Worktree…", id: "hub.go.worktree", run: { palette($0, "worktree ") }),
        HubMenuCommand(title: "Pull Request…", id: "hub.go.pr", run: { palette($0, "pr ") }),
        HubMenuCommand(title: "Changed File…", id: "hub.go.file", run: { palette($0, "file ") }),
        HubMenuCommand(title: "Review Selected PR with Agent", id: "hub.go.review", run: { $0.runPalette(.reviewWithAgent, toggleGlass: toggleGlass) },
                       enabled: { $0.prs.selected != nil }, separated: true),
    ]

    static let help: [HubMenuCommand] = [
        HubMenuCommand(title: "Keyboard Shortcuts", id: "hub.help.shortcuts", run: { _ in
            KeymapHelpWindow.show(HubKeymap.shortcutPages(review: false))
        }),
        HubMenuCommand(title: "Command Palette Commands", id: "hub.help.commands", run: { palette($0, "") }),
        HubMenuCommand(title: "Open Logs Folder", id: "hub.help.logs", run: { _ in reveal(".genesis-tools/logs") }, separated: true),
        HubMenuCommand(title: "Open Performance Log", id: "hub.help.perf", run: { _ in reveal(".genesis-tools/logs/app-perf.log") }),
    ]

    /// File, Find, View, Go and Help: the commands the hub window registers, besides the app menu.
    static var windowCommands: [HubMenuCommand] { file + find + view + go + help }

    static func menu(_ title: String, _ commands: [HubMenuCommand], hub: HubModel, keymap: Keymap = HubKeymap.shared, tail: [NSMenuItem] = []) -> NSMenu {
        let menu = NSMenu(title: title)
        for item in items(commands, hub: hub, keymap: keymap) + tail {
            menu.addItem(item)
        }
        return menu
    }

    static func items(_ commands: [HubMenuCommand], hub: HubModel, keymap: Keymap = HubKeymap.shared) -> [NSMenuItem] {
        HubMenuTarget.shared.hub = hub
        return commands.flatMap { command -> [NSMenuItem] in
            let item = NSMenuItem(title: command.title, action: #selector(HubMenuTarget.runCommand(_:)), keyEquivalent: "")
            if let id = command.id { HubKeymap.bind(item, to: id, keymap: keymap) }
            item.target = HubMenuTarget.shared
            item.representedObject = HubMenuCommandBox(command)
            return command.separated ? [.separator(), item] : [item]
        }
    }

    /// View → Look: the Hub look and one Native look per General theme, the current one checked. A Native look
    /// also sets General → Theme, and its item's tooltip says so.
    static func lookItem(hub: HubModel, keymap: Keymap = HubKeymap.shared) -> NSMenuItem {
        let item = NSMenuItem(title: "Look", action: nil, keyEquivalent: "")
        let submenu = NSMenu(title: "Look")
        for choice in HubLookChoice.allCases {
            let command = HubMenuCommand(title: choice.title, run: { $0.runPalette(.setLook(choice), toggleGlass: toggleGlass) },
                                         checked: { _ in HubLookChoice.currentInHub == choice },
                                         separated: choice == HubLookChoice.allCases.dropFirst().first)
            for entry in items([command], hub: hub, keymap: keymap) {
                if choice.theme != nil, !entry.isSeparatorItem { entry.toolTip = HubLookChoice.generalNote + "." }
                submenu.addItem(entry)
            }
        }
        item.submenu = submenu
        return item
    }

    /// Every palette keyword as a menu item: it opens the palette with the keyword typed, so this
    /// list is the palette's own (`HubPaletteEngine.keywords`) and cannot drift from it.
    static func paletteCommandsItem(hub: HubModel, keymap: Keymap = HubKeymap.shared) -> NSMenuItem {
        let item = NSMenuItem(title: "Palette Command", action: nil, keyEquivalent: "")
        let submenu = NSMenu(title: "Palette Command")
        for keyword in HubPaletteEngine.keywords {
            let command = HubMenuCommand(title: keyword.liveSummary, run: { palette($0, "\(keyword.word) ") })
            items([command], hub: hub, keymap: keymap).forEach(submenu.addItem)
        }
        item.submenu = submenu
        return item
    }

    /// The main view's review: the PR's in PRs mode, the session's otherwise.
    static func review(of hub: HubModel) -> ReviewModel? {
        hub.mode == .prs ? hub.prs.review : hub.review
    }

    private static func toggleGlass() {
        HubGlassSwitch.toggle()
    }

    /// The same path as `tools hub --<flag>` handed to a running hub.
    private static func overlay(_ hub: HubModel, _ flag: String) {
        hub.applyOverlays(HubRequest([flag]))
    }

    private static func palette(_ hub: HubModel, _ seed: String) {
        hub.paletteRequest = seed
    }

    private static func reload(_ hub: HubModel) {
        switch hub.mode {
        case .sessions: hub.loadSessions()
        case .prs: hub.prs.reload()
        case .inbox: hub.inbox.load()
        case .timeline: hub.timeline.load(fresh: true)
        case .agents: hub.agents.reload()
        case .worktrees: break
        }
    }

    private static func reveal(_ relative: String) {
        let url = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(relative)
        NSWorkspace.shared.activateFileViewerSelecting([url])
    }
}

private final class HubMenuCommandBox: NSObject {
    let command: HubMenuCommand

    init(_ command: HubMenuCommand) {
        self.command = command
    }
}

/// Runs a hub menu item and sets its check mark and enabled state as the menu opens.
@MainActor
final class HubMenuTarget: NSObject, NSMenuItemValidation {
    static let shared = HubMenuTarget()
    weak var hub: HubModel?

    /// Not `perform(_:)`: that is NSObject's `performSelector:`, and AppKit then sent the menu item
    /// as a selector (unrecognized-selector crash on the first click).
    @objc func runCommand(_ sender: NSMenuItem) {
        guard let hub, let box = sender.representedObject as? HubMenuCommandBox else { return }
        HubPerf.log("menu: \(box.command.title)")
        box.command.run(hub)
    }

    func validateMenuItem(_ item: NSMenuItem) -> Bool {
        guard let hub, let box = item.representedObject as? HubMenuCommandBox else { return true }
        item.state = box.command.checked?(hub) == true ? .on : .off
        return box.command.enabled?(hub) ?? true
    }
}

/// Edit ▸ Copy: sends `copy:` to whatever has the keyboard (a text view, a selectable `Text`, the
/// diff's web view), then shows the copy toast once the pasteboard changed. A WKWebView writes the
/// pasteboard when its web process answers, a moment later, so it looks three times, 0.1 s apart.
/// Nothing to copy sends nothing and stays silent, where the missing menu used to beep.
@MainActor
final class CopyWithFeedback: NSObject {
    static let shared = CopyWithFeedback()

    @objc func copyWithFeedback(_ sender: Any?) {
        let before = NSPasteboard.general.changeCount
        guard NSApp.sendAction(#selector(NSText.copy(_:)), to: nil, from: sender) else {
            HubPerf.log("copy ⌘C: nothing has the keyboard to copy from")
            return
        }

        confirm(since: before, attempt: 0)
    }

    private func confirm(since before: Int, attempt: Int) {
        let pasteboard = NSPasteboard.general
        if pasteboard.changeCount != before {
            CopyToast.post(title: "Copied", detail: CopyToast.preview(pasteboard.string(forType: .string) ?? ""), style: .copied)
            return
        }

        guard attempt < 3 else {
            HubPerf.log("copy ⌘C: the pasteboard did not change (nothing selected)")
            return
        }

        DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) { [weak self] in
            MainActor.assumeIsolated { self?.confirm(since: before, attempt: attempt + 1) }
        }
    }
}
