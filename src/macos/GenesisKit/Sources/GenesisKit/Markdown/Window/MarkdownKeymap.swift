//
//  MarkdownKeymap.swift
//  GenesisKit
//
//  Every key of the markdown viewer in one library (Keymap/), Martin 2026-10-15: the keys used to live on hidden
//  buttons, a window override, the menu and the source editor, matched four different ways. The window's commands
//  run through `KeymapDispatcher` (`registerWindowCommands`), the find bar's and the toolbar's through
//  `.keymapAction`, the source editor's through `sourceCommand(for:)`; the menu, the tooltips and Help › Keyboard
//  Shortcuts read the same library, and the user changes any configurable key there.
//

import AppKit
import SwiftUI

@MainActor
public enum MarkdownKeymap {
    /// The keys in force: the library plus the user's own keys (`<keymap folder>/markdown.json`).
    public static let shared = Keymap(library: library)

    /// The source editor's scope: its keys work only while the source text has the focus.
    static let sourceScope: KeymapScope = "markdown.source"
    /// The find bar's: its keys work while the bar is open, ahead of the window's (⇧⌘G).
    static let findScope: KeymapScope = "markdown.find"

    public static let library = KeymapLibrary(id: "markdown", title: "Markdown Viewer", commands: [
        // Tabs
        KeymapCommand("markdown.tab.close", "Close Tab", group: "Tabs",
                      detail: "With no tab left, ⌘W closes the window.", keys: [.character("w", .command)]),
        KeymapCommand("markdown.tab.reopen", "Reopen Closed Tab", group: "Tabs", keys: [.character("t", [.shift, .command])]),
        KeymapCommand("markdown.tab.next", "Next Tab", group: "Tabs", keys: [.code(30, [.shift, .command])]),
        KeymapCommand("markdown.tab.previous", "Previous Tab", group: "Tabs", keys: [.code(33, [.shift, .command])]),
        KeymapCommand("markdown.tab.closeOthers", "Close Other Tabs", group: "Tabs",
                      detail: "Every tab but the one on screen. Reopen Closed Tab brings them all back.", keys: []),
    ] + tabNumberCommands + [
        // History
        KeymapCommand("markdown.history.back", "Back", group: "History",
                      detail: "The note you read before this one; a closed tab opens again.",
                      keys: [.code(33, .command)]),
        KeymapCommand("markdown.history.forward", "Forward", group: "History", keys: [.code(30, .command)]),
        // Files
        KeymapCommand("markdown.file.open", "Open…", group: "Files", detail: "Markdown and text files, several at once.",
                      keys: [.character("o", .command)]),
        KeymapCommand("markdown.file.save", "Save", group: "Files", keys: [.character("s", .command)]),
        KeymapCommand("markdown.file.reload", "Reload from Disk", group: "Files", keys: [.character("r", .command)]),
        KeymapCommand("markdown.file.reveal", "Reveal in Finder", group: "Files", keys: [.character("r", [.shift, .command])]),
        KeymapCommand("markdown.file.copyPath", "Copy Path", group: "Files", keys: [.character("c", [.control, .shift])]),
        KeymapCommand("markdown.file.goto", "Go to Location…", group: "Files", keys: [.character("g", [.shift, .command])]),
        KeymapCommand("markdown.file.pdf", "Save as PDF…", group: "Files", keys: [.character("s", [.shift, .command])]),
        KeymapCommand("markdown.file.print", "Print…", group: "Files", keys: [.character("p", .command)]),
        // View
        KeymapCommand("markdown.view.files", "Show or Hide Files", group: "View", keys: [.character("b", [.shift, .command])]),
        KeymapCommand("markdown.view.outline", "Show or Hide Outline", group: "View", keys: [.character("o", [.shift, .command])]),
        KeymapCommand("markdown.view.source", "Reading View or Source", group: "View", keys: [.character("e", .command)]),
        KeymapCommand("markdown.view.split", "Editor and Preview Side by Side", group: "View",
                      detail: "Pressed again, it goes back to the reading view.", keys: [.character("e", [.shift, .command])]),
        KeymapCommand("markdown.view.bigger", "Bigger Text", group: "View",
                      keys: [.character("+", .command), .character("=", .command)]),
        KeymapCommand("markdown.view.smaller", "Smaller Text", group: "View", keys: [.character("-", .command)]),
        KeymapCommand("markdown.view.actualSize", "Actual Size", group: "View", keys: [.character("0", .command)]),
        // Find
        KeymapCommand("markdown.find.open", "Find", group: "Find", keys: [.character("f", .command)]),
        KeymapCommand("markdown.find.files", "Find in Files", group: "Find",
                      detail: "File names, or text inside the files.", keys: [.character("f", [.shift, .command])]),
        KeymapCommand("markdown.find.next", "Next Match", group: "Find", detail: "Return in the find field does the same.",
                      keys: [.character("g", .command)], scope: findScope),
        KeymapCommand("markdown.find.previous", "Previous Match", group: "Find",
                      detail: "⇧Return in the find field does the same.",
                      keys: [.character("g", [.shift, .command])], scope: findScope),
        KeymapCommand("markdown.find.replace", "Show or Hide Replace", group: "Find", detail: "Source view only.",
                      keys: [.character("f", [.option, .command])], scope: findScope),
        KeymapCommand("markdown.find.inSelection", "Find in Selection", group: "Find",
                      keys: [.character("l", [.option, .command])], scope: findScope),
        KeymapCommand("markdown.find.matchCase", "Match Case", group: "Find",
                      keys: [.character("c", [.option, .command])], scope: findScope),
        KeymapCommand("markdown.find.wholeWord", "Whole Word", group: "Find",
                      keys: [.character("w", [.option, .command])], scope: findScope),
        KeymapCommand("markdown.find.regex", "Regular Expression", group: "Find",
                      keys: [.character("r", [.option, .command])], scope: findScope),
        KeymapCommand("markdown.find.allTabs", "Matches in All Tabs", group: "Find", detail: "With two or more tabs open.",
                      keys: [.character("a", [.option, .command])], scope: findScope),
        KeymapCommand("markdown.find.close", "Close Find", group: "Find", keys: [.code(53)], scope: findScope,
                      configurable: false),
        // Source editing
        KeymapCommand("markdown.edit.bold", "Bold", group: "Source Editing", keys: [.character("b", .command)],
                      scope: sourceScope),
        KeymapCommand("markdown.edit.italic", "Italic", group: "Source Editing", keys: [.character("i", .command)],
                      scope: sourceScope),
        KeymapCommand("markdown.edit.link", "Link", group: "Source Editing", keys: [.character("k", .command)],
                      scope: sourceScope),
        KeymapCommand("markdown.edit.task", "Task On or Off", group: "Source Editing",
                      keys: [.character("x", [.shift, .command])], scope: sourceScope),
        KeymapCommand("markdown.edit.indent", "Indent Lines", group: "Source Editing", keys: [.code(48)],
                      scope: sourceScope, configurable: false),
        KeymapCommand("markdown.edit.outdent", "Outdent Lines", group: "Source Editing", keys: [.code(48, .shift)],
                      scope: sourceScope, configurable: false),
        KeymapCommand("markdown.edit.followLink", "Open the Link Under the Pointer", group: "Source Editing",
                      detail: "⌘-click a wikilink, a Markdown link or a URL.", keys: [], scope: sourceScope,
                      configurable: false),
        // Window and app
        KeymapCommand("markdown.window.close", "Close Window", group: "Window", keys: [.character("w", [.shift, .command])]),
        KeymapCommand("markdown.help.shortcuts", "Keyboard Shortcuts", group: "Window",
                      detail: "This list. Change Keys… in it changes any key above.", keys: [.character("k", [.shift, .command])]),
        KeymapCommand("markdown.window.minimize", "Minimize", group: "Window", keys: [.character("m", .command)],
                      scope: .app, configurable: false),
        KeymapCommand("markdown.app.hide", "Hide", group: "Window", keys: [.character("h", .command)], scope: .app,
                      configurable: false),
        KeymapCommand("markdown.app.hideOthers", "Hide Others", group: "Window",
                      keys: [.character("h", [.option, .command])], scope: .app, configurable: false),
        KeymapCommand("markdown.app.quit", "Quit", group: "Window", detail: "Each unsaved tab is asked about first.",
                      keys: [.character("q", .command)], scope: .app, configurable: false),
        KeymapCommand("markdown.edit.undo", "Undo", group: "Text", keys: [.character("z", .command)], scope: .app,
                      configurable: false),
        KeymapCommand("markdown.edit.redo", "Redo", group: "Text", keys: [.character("z", [.shift, .command])],
                      scope: .app, configurable: false),
        KeymapCommand("markdown.edit.cut", "Cut", group: "Text", keys: [.character("x", .command)], scope: .app,
                      configurable: false),
        KeymapCommand("markdown.edit.copy", "Copy", group: "Text", keys: [.character("c", .command)], scope: .app,
                      configurable: false),
        KeymapCommand("markdown.edit.paste", "Paste", group: "Text", keys: [.character("v", .command)], scope: .app,
                      configurable: false),
        KeymapCommand("markdown.edit.selectAll", "Select All", group: "Text", keys: [.character("a", .command)],
                      scope: .app, configurable: false),
    ])

    /// ⌘1 to ⌘8 select the tab at that place in the bar's order, ⌘9 the last one (as in a browser).
    static let tabNumberCommands: [KeymapCommand] = (1...9).map { number in
        KeymapCommand(tabNumberCommand(number), number == 9 ? "Last Tab" : "Tab \(number)", group: "Tabs",
                      keys: [.character(String(number), .command)])
    }

    static func tabNumberCommand(_ number: Int) -> String { "markdown.tab.select\(number)" }

    /// The window's own commands, held for as long as the window lives. Everything the model can do alone runs here;
    /// the find bar adds its own keys while it is open.
    static func registerWindowCommands(
        model: MarkdownDocumentsModel, window: NSWindow, keymap: Keymap = shared,
        dispatcher: KeymapDispatcher = .shared, closeTab: @escaping () -> Void
    ) -> [KeymapRegistration] {
        windowActions(model: model, window: window, keymap: keymap, closeTab: closeTab)
            .map { id, run in dispatcher.register(id, in: keymap, window: window, perform: run) }
    }

    /// What each window command does: the keys (`registerWindowCommands`) and the menu bar
    /// (`MarkdownDocumentWindowController.performCommand`) run the same closure.
    static func windowActions(
        model: MarkdownDocumentsModel, window: NSWindow?, keymap: Keymap = shared, closeTab: @escaping () -> Void
    ) -> [(String, () -> Void)] {
        let tabs: [(String, () -> Void)] = (1...9).map { number in
            (tabNumberCommand(number), { model.selectTab(number: number) })
        }
        return tabs + [
            ("markdown.tab.close", closeTab),
            ("markdown.tab.closeOthers", { if let doc = model.selected { model.closeOthers(doc) } }),
            ("markdown.tab.reopen", { model.reopenLastClosed() }),
            ("markdown.tab.next", { model.selectTab(offset: 1) }),
            ("markdown.tab.previous", { model.selectTab(offset: -1) }),
            ("markdown.history.back", { model.goBack() }),
            ("markdown.history.forward", { model.goForward() }),
            ("markdown.file.open", { MarkdownDocumentsView.chooseFiles(into: model) }),
            ("markdown.file.save", { model.saveSelected() }),
            ("markdown.file.pdf", { model.exportPDF() }),
            ("markdown.file.print", { model.printDocument() }),
            ("markdown.file.reload", { model.selected?.reload() }),
            ("markdown.file.reveal", {
                if let url = model.selected?.url { NSWorkspace.shared.activateFileViewerSelecting([url]) }
            }),
            ("markdown.file.copyPath", { model.copySelectedPath() }),
            ("markdown.file.goto", { model.goToOpen = true }),
            ("markdown.view.files", { GenMotion.perform(expanding: !model.showFiles, reduceMotion: GenMotion.systemReduceMotion) { model.showFiles.toggle() } }),
            ("markdown.view.outline", { GenMotion.perform(expanding: !model.showOutline, reduceMotion: GenMotion.systemReduceMotion) { model.showOutline.toggle() } }),
            ("markdown.view.source", { model.toggleSource() }),
            ("markdown.view.split", { model.toggleSplit() }),
            ("markdown.view.bigger", { model.zoomStep(1) }),
            ("markdown.view.smaller", { model.zoomStep(-1) }),
            ("markdown.view.actualSize", { model.zoomReset() }),
            ("markdown.find.open", { model.openFind() }),
            ("markdown.find.files", { model.openTreeSearch() }),
            ("markdown.window.close", { [weak window] in window?.performClose(nil) }),
            ("markdown.help.shortcuts", { KeymapHelpWindow.show(keymap) }),
        ]
    }

    /// The source editor's command for a key press, if it has one (`MarkdownSourceEditor`).
    static func sourceCommand(for event: NSEvent, keymap: Keymap = shared) -> String? {
        guard let stroke = KeyStroke(event) else { return nil }
        return keymap.commands(for: stroke, in: [sourceScope]).first { $0.configurable }?.id
    }

    /// Bold, italic, link and task, while `textView` is the window's first responder. Newer than the window's
    /// commands, so a window key the user binds onto one of these (Show Files on ⌘B) yields while the editor
    /// is focused and works again when it is not. Indent and outdent stay on the text view: they have no ⌘ or ⌃.
    static func registerSourceCommands(
        textView: NSTextView, window: NSWindow, keymap: Keymap = shared, dispatcher: KeymapDispatcher = .shared,
        perform: @escaping (String) -> Void
    ) -> [KeymapRegistration] {
        ["markdown.edit.bold", "markdown.edit.italic", "markdown.edit.link", "markdown.edit.task"].map { id in
            dispatcher.register(id, in: keymap, window: window, isEnabled: { [weak textView] in
                guard let textView, let window = textView.window else { return false }
                return window.firstResponder === textView
            }) {
                perform(id)
            }
        }
    }

    /// "Save (⌘S)" with the key in force.
    static func hint(_ title: String, _ id: String) -> String { shared.hint(title, id) }

    /// "⌘G", or "" when the command has no key.
    static func label(_ id: String) -> String { shared.label(for: id) ?? "" }
}
