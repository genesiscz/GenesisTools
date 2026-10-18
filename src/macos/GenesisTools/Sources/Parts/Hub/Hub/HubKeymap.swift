//
//  HubKeymap.swift
//  GenesisTools
//
//  Every key of the hub in one library (GenesisKit Keymap/), Martin 2026-10-15. The menu shows the key
//  (`bind`); the hub window's commands run through `KeymapDispatcher` (`registerWindowCommands`), so a
//  key is handled once. The palette's arrows, Tab and Escape stay on their own monitor: they have no ⌘,
//  and the palette field has the focus, which is a press the dispatcher leaves alone.
//

import AppKit
import SwiftUI

@MainActor
package enum HubKeymap {
    /// The keys in force: the library plus the user's own keys (`~/.genesis-tools/keymaps/hub.json`).
    package static let shared = Keymap(library: library)

    /// The command palette's scope: its keys work while the palette is open.
    package static let paletteScope: KeymapScope = "hub.palette"
    /// Panel find, shared by the hub and the review window. Narrower than the window, so ⇧⌘G can also be Glass.
    package static let findScope: KeymapScope = "hub.find"

    package static let commandPalette = "hub.find.palette"
    package static let promptLibrary = "hub.file.prompts"
    package static let glass = "hub.view.glass"
    package static let promptSend = "hub.prompts.send"
    package static let paletteUp = "hub.palette.up"
    package static let paletteDown = "hub.palette.down"
    package static let paletteComplete = "hub.palette.complete"
    package static let paletteClose = "hub.palette.close"
    package static let findOpen = "hub.find.open"
    package static let findNext = "hub.find.next"
    package static let findPrevious = "hub.find.previous"
    package static let findClose = "hub.find.close"

    /// Hidden buttons used to take these even when the menu item was greyed out. The key still does.
    private static let liveWhenGreyed: Set<String> = [
        glass, promptLibrary, "hub.find.files", "hub.find.transcripts", "hub.view.digest", "hub.go.back", "hub.go.forward",
    ]

    package static let library = KeymapLibrary(id: "hub", title: "GenesisTools Hub", commands: appCommands + windowCommands)

    /// Quit, Hide, Close and the edit keys: the menu bar has them, and the conflict check has to know.
    private static let appCommands: [KeymapCommand] = [
        KeymapCommand("hub.app.settings", "Settings", group: "App", keys: [.character(",", .command)], scope: .app),
        KeymapCommand("hub.app.hide", "Hide", group: "App", keys: [.character("h", .command)], scope: .app,
                      configurable: false),
        KeymapCommand("hub.app.hideOthers", "Hide Others", group: "App", keys: [.character("h", [.option, .command])],
                      scope: .app, configurable: false),
        KeymapCommand("hub.app.quit", "Quit", group: "App", keys: [.character("q", .command)], scope: .app,
                      configurable: false),
        KeymapCommand("hub.edit.undo", "Undo", group: "Text", keys: [.character("z", .command)], scope: .app,
                      configurable: false),
        KeymapCommand("hub.edit.redo", "Redo", group: "Text", keys: [.character("z", [.shift, .command])], scope: .app,
                      configurable: false),
        KeymapCommand("hub.edit.cut", "Cut", group: "Text", keys: [.character("x", .command)], scope: .app,
                      configurable: false),
        KeymapCommand("hub.edit.copy", "Copy", group: "Text", keys: [.character("c", .command)], scope: .app,
                      configurable: false),
        KeymapCommand("hub.edit.paste", "Paste", group: "Text", keys: [.character("v", .command)], scope: .app,
                      configurable: false),
        KeymapCommand("hub.edit.pastePlain", "Paste and Match Style", group: "Text",
                      keys: [.character("v", [.option, .shift, .command])], scope: .app, configurable: false),
        KeymapCommand("hub.edit.selectAll", "Select All", group: "Text", keys: [.character("a", .command)], scope: .app,
                      configurable: false),
        KeymapCommand("hub.window.close", "Close Window", group: "Window", keys: [.character("w", .command)], scope: .app,
                      configurable: false),
        KeymapCommand("hub.window.minimize", "Minimize", group: "Window", keys: [.character("m", .command)], scope: .app,
                      configurable: false),
        KeymapCommand("hub.window.fullScreen", "Enter Full Screen", group: "Window",
                      keys: [.character("f", [.control, .command])], scope: .app, configurable: false),
    ]

    private static let windowCommands: [KeymapCommand] = fileCommands + findCommands + viewCommands + goCommands
        + helpCommands + paletteCommands + promptCommands

    private static let fileCommands: [KeymapCommand] = [
        KeymapCommand("hub.file.newSession", "New Agent Session", group: "File", keys: [.character("n", .command)]),
        KeymapCommand("hub.file.handoff", "New Handoff", group: "File", keys: [.character("h", [.shift, .command])]),
        KeymapCommand(promptLibrary, "Prompt Library", group: "File", keys: [.character("p", [.shift, .command])]),
        KeymapCommand("hub.file.cursor", "Open Project in Cursor", group: "File", keys: []),
        KeymapCommand("hub.file.terminal", "Open Project in cmux", group: "File", keys: []),
    ]

    private static let findCommands: [KeymapCommand] = [
        KeymapCommand(commandPalette, "Command Palette", group: "Find", keys: [.character("k", .command)]),
        KeymapCommand("hub.find.files", "Find in Files", group: "Find", keys: [.character("f", [.shift, .command])]),
        KeymapCommand("hub.find.transcripts", "Search All Transcripts", group: "Find",
                      keys: [.character("f", [.option, .command])]),
        KeymapCommand("hub.find.history", "Search Session History", group: "Find", keys: []),
        // The find bar in a hub panel and in the review diff. ⇧⌘G is Previous Match only while the bar is open.
        KeymapCommand(findOpen, "Find", group: "Find", keys: [.character("f", .command)], scope: findScope),
        KeymapCommand(findNext, "Next Match", group: "Find", detail: "Return in the find field does the same.",
                      keys: [.character("g", .command)], scope: findScope),
        KeymapCommand(findPrevious, "Previous Match", group: "Find", detail: "⇧Return in the find field does the same.",
                      keys: [.character("g", [.shift, .command])], scope: findScope),
        KeymapCommand(findClose, "Close Find", group: "Find", keys: [.code(53)], scope: findScope, configurable: false),
    ]

    /// ⌘1 to ⌘6 and ⌥⌘1 to ⌥⌘4. A digit is a character, so ⌘ with the Czech ě key still reaches ⌘2.
    private static let viewCommands: [KeymapCommand] = HubMode.allCases.enumerated().map { index, mode in
        KeymapCommand("hub.view.mode.\(mode.rawValue)", mode.title, group: "View",
                      keys: [.character("\(index + 1)", .command)])
    } + HubTab.allCases.enumerated().map { index, pane in
        KeymapCommand("hub.view.pane.\(pane.rawValue)", "\(pane.title) Pane", group: "View",
                      keys: [.character("\(index + 1)", [.option, .command])])
    } + [
        KeymapCommand(glass, "Glass", group: "View", keys: [.character("g", [.shift, .command])]),
        KeymapCommand("hub.view.settings", "Hub Settings", group: "View", keys: []),
        KeymapCommand("hub.view.diff.split", "Split Diff", group: "View", keys: []),
        KeymapCommand("hub.view.diff.unified", "Unified Diff", group: "View", keys: []),
        KeymapCommand("hub.view.diff.wrap", "Wrap Diff Lines", group: "View", keys: []),
        // "+" needs Shift on a US keyboard and no Shift on a Czech one. "=" is the same US key without Shift.
        KeymapCommand("hub.view.diff.bigger", "Bigger Diff Text", group: "View",
                      keys: [.character("+", .command), .character("=", .command)]),
        KeymapCommand("hub.view.diff.smaller", "Smaller Diff Text", group: "View", keys: [.character("-", .command)]),
        KeymapCommand("hub.view.diff.actual", "Actual Diff Text Size", group: "View", keys: [.character("0", .command)]),
        KeymapCommand("hub.view.digest", "Today Digest", group: "View", keys: [.character("d", [.option, .command])]),
        KeymapCommand("hub.view.rules", "Rules", group: "View", keys: []),
        KeymapCommand("hub.view.reload", "Reload", group: "View", keys: [.character("r", .command)]),
    ]

    private static let goCommands: [KeymapCommand] = [
        // The two keys right of P: "[" and "]" on US, "ú" and ")" on Czech. The position is the shortcut.
        KeymapCommand("hub.go.back", "Back", group: "Go", keys: [.code(33, .command)]),
        KeymapCommand("hub.go.forward", "Forward", group: "Go", keys: [.code(30, .command)]),
        KeymapCommand("hub.go.session", "Session", group: "Go", keys: []),
        KeymapCommand("hub.go.worktree", "Worktree", group: "Go", keys: []),
        KeymapCommand("hub.go.pr", "Pull Request", group: "Go", keys: []),
        KeymapCommand("hub.go.file", "Changed File", group: "Go", keys: []),
        KeymapCommand("hub.go.review", "Review Selected PR with Agent", group: "Go", keys: []),
    ]

    private static let helpCommands: [KeymapCommand] = [
        KeymapCommand("hub.help.shortcuts", "Keyboard Shortcuts", group: "Help",
                      detail: "This list. Change Keys… in it changes any key above.", keys: []),
        KeymapCommand("hub.help.commands", "Command Palette Commands", group: "Help", keys: []),
        KeymapCommand("hub.help.logs", "Open Logs Folder", group: "Help", keys: []),
        KeymapCommand("hub.help.perf", "Open Performance Log", group: "Help", keys: []),
    ]

    /// Listed so the help window shows them. The palette monitor is what runs them (see `paletteMove`).
    private static let paletteCommands: [KeymapCommand] = [
        KeymapCommand(paletteUp, "Move Up", group: "Palette", keys: [.code(126)], scope: paletteScope, configurable: false),
        KeymapCommand(paletteDown, "Move Down", group: "Palette", keys: [.code(125)], scope: paletteScope, configurable: false),
        KeymapCommand(paletteComplete, "Complete", group: "Palette", keys: [.code(48)], scope: paletteScope, configurable: false),
        KeymapCommand(paletteClose, "Close the Palette", group: "Palette", keys: [.code(53)], scope: paletteScope,
                      configurable: false),
        KeymapCommand("hub.palette.run", "Run the Command", group: "Palette", detail: "Return in the palette field.",
                      keys: [.code(36)], scope: paletteScope, configurable: false),
    ]

    private static let promptCommands: [KeymapCommand] = [
        KeymapCommand(promptSend, "Send Prompt", group: "Prompts", keys: [.code(36, .command)]),
    ]

    /// The palette move for a key position, if it is one of the four the field monitor handles.
    package static func paletteMove(forKeyCode code: UInt16) -> String? {
        let moves: Set<String> = [paletteUp, paletteDown, paletteComplete, paletteClose]
        return library.commands.first { command in
            moves.contains(command.id) && command.defaults.contains { chord in
                guard case .code(let key) = chord.key else { return false }
                return key == code
            }
        }?.id
    }

    /// The hub window's commands, held for as long as the window lives. The command palette toggles from the
    /// root view (its open flag is view state); Send Prompt is on the Send button, only while that button is up.
    package static func registerWindowCommands(
        model: HubModel, window: NSWindow, keymap: Keymap = shared, dispatcher: KeymapDispatcher = .shared
    ) -> [KeymapRegistration] {
        HubMenuCommands.windowCommands.compactMap { command in
            // A command with no default key is still registered: the user may bind one later, and a press
            // with no chord matches nothing.
            guard let id = command.id, id != commandPalette, library.command(id)?.scope == .window
            else { return nil }
            return dispatcher.register(id, in: keymap, window: window, isEnabled: {
                liveWhenGreyed.contains(id) || (command.enabled?(model) ?? true)
            }) { press in
                // Glass and Previous Match share ⇧⌘G. Only that chord steps an open find bar.
                if id == glass, glassPressStepsFind(press, in: keymap, window: window) { return }
                // The menu opens the picker. The key toggles it, which is what the hidden button did.
                if id == promptLibrary {
                    PromptLibraryStore.shared.pickerOpen.toggle()
                    return
                }
                command.run(model)
            }
        }
    }

    /// ⌘W for one window. The review window holds this; an app-wide registration would also close that window
    /// while the Keyboard Shortcuts panel or Settings is key.
    package static func registerCloseWindow(
        _ window: NSWindow, keymap: Keymap = shared, dispatcher: KeymapDispatcher = .shared
    ) -> KeymapRegistration {
        dispatcher.register("hub.window.close", in: keymap, window: window) { [weak window] in
            window?.performClose(nil)
        }
    }

    /// Gives the item the command's key and keeps it current. The item's identifier is the command id.
    package static func bind(_ item: NSMenuItem, to id: String, keymap: Keymap = shared) {
        item.identifier = NSUserInterfaceItemIdentifier(id)
        keymap.bind(item, to: id)
    }

    /// "Back (⌘[)" with the key in force, or "Back (⌘Ú)" on a Czech keyboard.
    package static func hint(_ title: String, _ id: String) -> String { shared.hint(title, id) }

    /// "⌘K", or "" when the command has no key.
    package static func label(_ id: String) -> String { shared.label(for: id) ?? "" }

    /// Tests replace this. Production steps an open find bar.
    package static var redirectGlassToPreviousMatch: (NSWindow?) -> Bool = { window in
        PanelFindRouter.shared.takesPreviousMatch(in: window)
    }

    /// True when this press is Previous Match and an open find bar took it. A Glass chord the user moved
    /// off that key returns false, so Glass still runs.
    package static func glassPressStepsFind(_ press: KeyStroke, in keymap: Keymap, window: NSWindow?) -> Bool {
        guard keymap.commands(for: press, in: [findScope]).contains(where: { $0.id == findPrevious }) else { return false }
        return redirectGlassToPreviousMatch(window)
    }

    /// Close Window and the panel find keys: what the review window's shortcut list shows of this library.
    package static var reviewCommandIDs: Set<String> {
        var ids: Set<String> = ["hub.window.close"]
        for command in library.commands where command.scope == findScope { ids.insert(command.id) }
        return ids
    }

    /// The hub lists its own keys and the session keys that window actually runs. The review window lists only
    /// the keys it runs: Close Window, panel find, and the session keys with Command on the prompts.
    package static func shortcutPages(review: Bool) -> [KeymapPage] {
        if review {
            return [
                KeymapPage(shared, commandIDs: reviewCommandIDs),
                KeymapPage(SessionsKeymap.shared, commandIDs: SessionsKeymap.shownCommandIDs(hostOwns: false)),
            ]
        }
        return [
            KeymapPage(shared),
            KeymapPage(SessionsKeymap.shared, commandIDs: SessionsKeymap.shownCommandIDs(hostOwns: true)),
        ]
    }
}
