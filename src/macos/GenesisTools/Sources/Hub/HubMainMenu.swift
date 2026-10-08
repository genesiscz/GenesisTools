import AppKit

/// The menu bar of the hub and review windows. They had none, so ⌘C, ⌘V, ⌘X, ⌘A and ⌘Z had no
/// key equivalent: a WKWebView (the diff) or a selectable SwiftUI `Text` never got `copy:`, and
/// AppKit played the alert sound instead (2026-09-25). The first item is the app menu, as macOS
/// requires; Copy goes through `CopyWithFeedback`, which confirms a copy with the copy toast.
///
/// The hub adds File, View, Go, Window and Help with every hub command (`HubMenuCommands`). Their
/// actions run through the palette's executor (`HubModel.runPalette`) or the `--hub` flags a later
/// launch hands over (`HubModel.applyOverlays`), so a menu item, a palette row and `tools hub --…`
/// do the same thing. A key the hub's views already handle (⌘K, ⌘⇧F, ⌘[) reaches the view first;
/// the menu shows it and runs the same action on a click.
@MainActor
enum AppMainMenu {
    static func install(hub: HubModel? = nil) {
        let name = Bundle.main.object(forInfoDictionaryKey: "CFBundleName") as? String ?? ProcessInfo.processInfo.processName
        let bar = NSMenu()

        let app = NSMenu(title: name)
        app.addItem(withTitle: "About \(name)", action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)), keyEquivalent: "")
        app.addItem(.separator())
        let settings = app.addItem(withTitle: "Settings…", action: #selector(AppMenuTarget.openSettings(_:)), keyEquivalent: ",")
        settings.target = AppMenuTarget.shared
        app.addItem(.separator())
        app.addItem(withTitle: "Hide \(name)", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
        app.addItem(withTitle: "Hide Others", action: #selector(NSApplication.hideOtherApplications(_:)), keyEquivalent: "h")
            .keyEquivalentModifierMask = [.command, .option]
        app.addItem(withTitle: "Show All", action: #selector(NSApplication.unhideAllApplications(_:)), keyEquivalent: "")
        app.addItem(.separator())
        app.addItem(withTitle: "Quit \(name)", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        bar.addItem(withTitle: name, action: nil, keyEquivalent: "").submenu = app

        if let hub {
            bar.addItem(withTitle: "File", action: nil, keyEquivalent: "").submenu = HubMenuCommands.menu("File", HubMenuCommands.file, hub: hub, tail: [
                NSMenuItem.separator(),
                NSMenuItem(title: "Close Window", action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w"),
            ])
        }

        let edit = NSMenu(title: "Edit")
        edit.addItem(withTitle: "Undo", action: Selector(("undo:")), keyEquivalent: "z")
        edit.addItem(withTitle: "Redo", action: Selector(("redo:")), keyEquivalent: "z")
            .keyEquivalentModifierMask = [.command, .shift]
        edit.addItem(.separator())
        edit.addItem(withTitle: "Cut", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        let copy = edit.addItem(withTitle: "Copy", action: #selector(CopyWithFeedback.copyWithFeedback(_:)), keyEquivalent: "c")
        copy.target = CopyWithFeedback.shared
        edit.addItem(withTitle: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        edit.addItem(withTitle: "Paste and Match Style", action: #selector(NSTextView.pasteAsPlainText(_:)), keyEquivalent: "v")
            .keyEquivalentModifierMask = [.command, .option, .shift]
        edit.addItem(withTitle: "Delete", action: #selector(NSText.delete(_:)), keyEquivalent: "")
        edit.addItem(withTitle: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        if let hub {
            edit.addItem(.separator())
            for item in HubMenuCommands.items(HubMenuCommands.find, hub: hub) {
                edit.addItem(item)
            }
        }
        bar.addItem(withTitle: "Edit", action: nil, keyEquivalent: "").submenu = edit

        if let hub {
            bar.addItem(withTitle: "View", action: nil, keyEquivalent: "").submenu = HubMenuCommands.menu("View", HubMenuCommands.view, hub: hub, tail: [
                NSMenuItem.separator(),
                NSMenuItem(title: "Enter Full Screen", action: #selector(NSWindow.toggleFullScreen(_:)), keyEquivalent: "f").withModifiers([.command, .control]),
            ])
            bar.addItem(withTitle: "Go", action: nil, keyEquivalent: "").submenu = HubMenuCommands.menu("Go", HubMenuCommands.go, hub: hub, tail: [
                NSMenuItem.separator(),
                HubMenuCommands.paletteCommandsItem(hub: hub),
            ])
        }

        let window = NSMenu(title: "Window")
        window.addItem(withTitle: "Minimize", action: #selector(NSWindow.performMiniaturize(_:)), keyEquivalent: "m")
        window.addItem(withTitle: "Zoom", action: #selector(NSWindow.performZoom(_:)), keyEquivalent: "")
        window.addItem(.separator())
        window.addItem(withTitle: "Bring All to Front", action: #selector(NSApplication.arrangeInFront(_:)), keyEquivalent: "")
        bar.addItem(withTitle: "Window", action: nil, keyEquivalent: "").submenu = window
        // AppKit lists this process's windows under it.
        NSApp.windowsMenu = window

        if let hub {
            let help = HubMenuCommands.menu("Help", HubMenuCommands.help, hub: hub)
            bar.addItem(withTitle: "Help", action: nil, keyEquivalent: "").submenu = help
            // The Help menu's search field finds any menu item by name.
            NSApp.helpMenu = help
        }

        NSApp.mainMenu = bar
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

    func openModelRoom(directory: String?) {
        guard let executable = Bundle.main.executablePath else { return }
        let process = Process()
        process.executableURL = URL(fileURLWithPath: executable)
        do {
            var arguments = ["--model-room", "--tools", try AppToolsOrigin.binaryPath()]
            if let directory { arguments += ["--directory", directory] }
            process.arguments = arguments
            try process.run()
        } catch {
            HubPerf.log("menu: Model Room did not start: \(error)")
            NSApp.presentError(error)
        }
    }

    /// The settings window is its own face (`GenesisTools --window`, App/GenesisToolsApp.swift).
    @objc func openSettings(_ sender: Any?) {
        guard let executable = Bundle.main.executablePath else { return }
        let process = Process()
        process.executableURL = URL(fileURLWithPath: executable)
        process.arguments = ["--window"]
        do {
            try process.run()
        } catch {
            HubPerf.log("menu: the settings window did not start: \(error)")
        }
    }
}

private extension NSMenuItem {
    func withModifiers(_ modifiers: NSEvent.ModifierFlags) -> NSMenuItem {
        keyEquivalentModifierMask = modifiers
        return self
    }
}

// MARK: - Hub commands

/// One hub command in the menu bar: its title, key, what it runs, and when it shows a check mark or
/// is greyed out. Read when the menu opens (`validateMenuItem`), never on a timer.
@MainActor
struct HubMenuCommand {
    var title: String
    var key: String = ""
    var modifiers: NSEvent.ModifierFlags = [.command]
    var run: (HubModel) -> Void
    var checked: ((HubModel) -> Bool)?
    var enabled: ((HubModel) -> Bool)?
    /// A separator before this command.
    var separated = false
}

@MainActor
enum HubMenuCommands {
    static let file: [HubMenuCommand] = [
        HubMenuCommand(title: "New Agent Session", key: "n", run: { hub in
            if let path = hub.paletteContext.currentPath { hub.runPalette(.newSession(path), toggleGlass: toggleGlass) }
        }, enabled: { $0.paletteContext.currentPath != nil }),
        HubMenuCommand(title: "New Handoff…", key: "h", modifiers: [.command, .shift], run: { overlay($0, "--handoff") },
                       enabled: { $0.selectedID != nil }),
        HubMenuCommand(title: "Prompt Library…", key: "p", modifiers: [.command, .shift], run: { overlay($0, "--prompts") }),
        HubMenuCommand(title: "Model Room…", run: { hub in
            AppMenuTarget.shared.openModelRoom(directory: hub.paletteContext.currentPath)
        }),
        HubMenuCommand(title: "Open Project in Cursor", run: { hub in
            if let path = hub.paletteContext.currentPath { hub.runPalette(.openCursor(path), toggleGlass: toggleGlass) }
        }, enabled: { $0.paletteContext.currentPath != nil }, separated: true),
        HubMenuCommand(title: "Open Project in cmux", run: { hub in
            if let path = hub.paletteContext.currentPath { hub.runPalette(.openTerminal(path), toggleGlass: toggleGlass) }
        }, enabled: { $0.paletteContext.currentPath != nil }),
    ]

    static let find: [HubMenuCommand] = [
        HubMenuCommand(title: "Command Palette…", key: "k", run: { overlay($0, "--palette") }),
        HubMenuCommand(title: "Find in Files…", key: "f", modifiers: [.command, .shift], run: { $0.findQuery = $0.findQuery == nil ? "" : nil }),
        HubMenuCommand(title: "Search All Transcripts…", key: "f", modifiers: [.command, .option], run: { _ in HubDailyModel.shared.toggleSearch() }),
        HubMenuCommand(title: "Search Session History…", run: { palette($0, "history ") }),
    ]

    static let view: [HubMenuCommand] = HubMode.allCases.enumerated().map { index, mode in
        HubMenuCommand(title: mode.title, key: "\(index + 1)", run: { $0.runPalette(.setMode(mode), toggleGlass: toggleGlass) },
                       checked: { $0.mode == mode })
    } + HubTab.allCases.enumerated().map { index, pane in
        HubMenuCommand(title: "\(pane.title) Pane", key: "\(index + 1)", modifiers: [.command, .option],
                       run: { $0.runPalette(.togglePane(pane), toggleGlass: toggleGlass) },
                       checked: { $0.panes.contains(pane) }, separated: index == 0)
    } + [
        HubMenuCommand(title: "Glass", key: "g", modifiers: [.command, .shift], run: { $0.runPalette(.toggleGlass, toggleGlass: toggleGlass) },
                       checked: { _ in HubDefaults.store.bool(forKey: HubGlass.key) }, separated: true),
        HubMenuCommand(title: "Split Diff", run: { review(of: $0)?.setStyle(.split) },
                       checked: { review(of: $0)?.options.diffStyle == .split }, enabled: { review(of: $0) != nil }, separated: true),
        HubMenuCommand(title: "Unified Diff", run: { review(of: $0)?.setStyle(.unified) },
                       checked: { review(of: $0)?.options.diffStyle == .unified }, enabled: { review(of: $0) != nil }),
        HubMenuCommand(title: "Wrap Diff Lines", run: { review(of: $0)?.toggleWrap() },
                       checked: { review(of: $0)?.options.wrap == true }, enabled: { review(of: $0) != nil }),
        HubMenuCommand(title: "Bigger Diff Text", key: "+", run: { review(of: $0)?.stepFont(1) }, enabled: { review(of: $0) != nil }),
        HubMenuCommand(title: "Smaller Diff Text", key: "-", run: { review(of: $0)?.stepFont(-1) }, enabled: { review(of: $0) != nil }),
        HubMenuCommand(title: "Actual Diff Text Size", key: "0", run: { hub in
            if let review = review(of: hub) { review.stepFont(DiffViewOptions().fontSize - review.options.fontSize) }
        }, enabled: { review(of: $0) != nil }),
        HubMenuCommand(title: "Today Digest", key: "d", modifiers: [.command, .option], run: { _ in HubDailyModel.shared.toggleDigest() },
                       separated: true),
        HubMenuCommand(title: "Rules", run: { overlay($0, "--rules") }),
        HubMenuCommand(title: "Reload", key: "r", run: reload, enabled: { $0.mode != .worktrees }, separated: true),
    ]

    static let go: [HubMenuCommand] = [
        HubMenuCommand(title: "Back", key: "[", run: { $0.goBack() }, enabled: { $0.history.canGoBack }),
        HubMenuCommand(title: "Forward", key: "]", run: { $0.goForward() }, enabled: { $0.history.canGoForward }),
        HubMenuCommand(title: "Session…", run: { palette($0, "session ") }, separated: true),
        HubMenuCommand(title: "Worktree…", run: { palette($0, "worktree ") }),
        HubMenuCommand(title: "Pull Request…", run: { palette($0, "pr ") }),
        HubMenuCommand(title: "Changed File…", run: { palette($0, "file ") }),
        HubMenuCommand(title: "Review Selected PR with Agent", run: { $0.runPalette(.reviewWithAgent, toggleGlass: toggleGlass) },
                       enabled: { $0.prs.selected != nil }, separated: true),
    ]

    static let help: [HubMenuCommand] = [
        HubMenuCommand(title: "Command Palette Commands", run: { palette($0, "") }),
        HubMenuCommand(title: "Open Logs Folder", run: { _ in reveal(".genesis-tools/logs") }, separated: true),
        HubMenuCommand(title: "Open Performance Log", run: { _ in reveal(".genesis-tools/logs/app-perf.log") }),
    ]

    static func menu(_ title: String, _ commands: [HubMenuCommand], hub: HubModel, tail: [NSMenuItem] = []) -> NSMenu {
        let menu = NSMenu(title: title)
        for item in items(commands, hub: hub) + tail {
            menu.addItem(item)
        }
        return menu
    }

    static func items(_ commands: [HubMenuCommand], hub: HubModel) -> [NSMenuItem] {
        HubMenuTarget.shared.hub = hub
        return commands.flatMap { command -> [NSMenuItem] in
            let item = NSMenuItem(title: command.title, action: #selector(HubMenuTarget.runCommand(_:)), keyEquivalent: command.key)
            item.keyEquivalentModifierMask = command.modifiers
            item.target = HubMenuTarget.shared
            item.representedObject = HubMenuCommandBox(command)
            return command.separated ? [.separator(), item] : [item]
        }
    }

    /// Every palette keyword as a menu item: it opens the palette with the keyword typed, so this
    /// list is the palette's own (`HubPaletteEngine.keywords`) and cannot drift from it.
    static func paletteCommandsItem(hub: HubModel) -> NSMenuItem {
        let item = NSMenuItem(title: "Palette Command", action: nil, keyEquivalent: "")
        let submenu = NSMenu(title: "Palette Command")
        for keyword in HubPaletteEngine.keywords {
            let command = HubMenuCommand(title: keyword.summary, run: { palette($0, "\(keyword.word) ") })
            items([command], hub: hub).forEach(submenu.addItem)
        }
        item.submenu = submenu
        return item
    }

    /// The main view's review: the PR's in PRs mode, the session's otherwise.
    static func review(of hub: HubModel) -> ReviewModel? {
        hub.mode == .prs ? hub.prs.review : hub.review
    }

    private static func toggleGlass() {
        HubDefaults.store.set(!HubDefaults.store.bool(forKey: HubGlass.key), forKey: HubGlass.key)
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
