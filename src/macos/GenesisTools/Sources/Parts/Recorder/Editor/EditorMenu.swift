import AppKit

/// One editor command: its menu title, the key that runs it (shown in the menu and the shortcuts sheet), and what it
/// does to the front editor. The editor's key monitor (`EditorKeys`) handles the keys; a menu click runs `run`.
struct EditorCommand {
    let title: String
    /// The key equivalent AppKit shows; empty for a command with no key.
    let key: String
    var modifiers: NSEvent.ModifierFlags = []
    /// How the shortcuts sheet names the key ("Space", "⌫").
    let label: String
    let run: @MainActor (EditorModel) -> Void
}

/// The editor's menu bar: File, Edit, Timeline, Window and Help, with every key the editor takes, so a command can be
/// found in Help's search and its key is visible (the keys used to be known only from a few hints).
@MainActor
enum EditorMenu {
    static let file: [EditorCommand] = [
        EditorCommand(title: "Export…", key: "e", modifiers: .command, label: "⌘E") { $0.tab = .export; $0.export() },
        EditorCommand(title: "Save", key: "s", modifiers: .command, label: "⌘S") { $0.saveNow() },
    ]

    static let edit: [EditorCommand] = [
        EditorCommand(title: "Undo", key: "z", modifiers: .command, label: "⌘Z") { $0.undo() },
        EditorCommand(title: "Redo", key: "z", modifiers: [.command, .shift], label: "⇧⌘Z") { $0.redo() },
        EditorCommand(title: "Delete Selection", key: "\u{8}", label: "⌫") { $0.deleteSelection() },
        EditorCommand(title: "Deselect", key: "\u{1b}", label: "Esc") { $0.selection = .none },
    ]

    static let timeline: [EditorCommand] = [
        EditorCommand(title: "Play or Pause", key: " ", label: "Space") { $0.togglePlay() },
        EditorCommand(title: "Split at Playhead", key: "s", label: "S") { $0.splitAtPlayhead() },
        EditorCommand(title: "Add Zoom at Playhead", key: "z", label: "Z") { $0.addZoom() },
        EditorCommand(title: "Set Part In", key: "i", label: "I") { $0.markIn() },
        EditorCommand(title: "Set Part Out", key: "o", label: "O") { $0.markOut() },
        EditorCommand(title: "Clear Part", key: "", label: "") { $0.clearPart() },
        EditorCommand(title: "Back One Frame", key: String(UnicodeScalar(NSLeftArrowFunctionKey)!), label: "←") { $0.step(frames: -1) },
        EditorCommand(title: "Forward One Frame", key: String(UnicodeScalar(NSRightArrowFunctionKey)!), label: "→") { $0.step(frames: 1) },
        EditorCommand(title: "Back One Second", key: String(UnicodeScalar(NSLeftArrowFunctionKey)!), modifiers: .shift, label: "⇧←") { $0.step(frames: -60) },
        EditorCommand(title: "Forward One Second", key: String(UnicodeScalar(NSRightArrowFunctionKey)!), modifiers: .shift, label: "⇧→") { $0.step(frames: 60) },
        EditorCommand(title: "To the Start", key: String(UnicodeScalar(NSHomeFunctionKey)!), label: "Home") { $0.seek(0) },
        EditorCommand(title: "To the End", key: String(UnicodeScalar(NSEndFunctionKey)!), label: "End") { $0.seek($0.durationUs) },
    ]

    static func install() {
        let name = Bundle.main.object(forInfoDictionaryKey: "CFBundleName") as? String ?? ProcessInfo.processInfo.processName
        let bar = NSMenu()
        let app = NSMenu(title: name)
        app.addItem(withTitle: "About \(name)", action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)), keyEquivalent: "")
        app.addItem(.separator())
        app.addItem(withTitle: "Hide \(name)", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
        app.addItem(withTitle: "Quit \(name)", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        bar.addItem(withTitle: name, action: nil, keyEquivalent: "").submenu = app

        let file = menu("File", file)
        file.addItem(.separator())
        file.addItem(withTitle: "Close Window", action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w")
        bar.addItem(withTitle: "File", action: nil, keyEquivalent: "").submenu = file

        // Cut, Copy and Paste first, so ⌘C and ⌘V still reach a text field (the background's image path, a filter).
        let edit = NSMenu(title: "Edit")
        edit.addItem(withTitle: "Cut", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        edit.addItem(withTitle: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        edit.addItem(withTitle: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        edit.addItem(withTitle: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        edit.addItem(.separator())
        add(self.edit, to: edit)
        bar.addItem(withTitle: "Edit", action: nil, keyEquivalent: "").submenu = edit

        bar.addItem(withTitle: "Timeline", action: nil, keyEquivalent: "").submenu = menu("Timeline", timeline)

        let window = NSMenu(title: "Window")
        window.addItem(withTitle: "Minimize", action: #selector(NSWindow.performMiniaturize(_:)), keyEquivalent: "m")
        window.addItem(withTitle: "Zoom", action: #selector(NSWindow.performZoom(_:)), keyEquivalent: "")
        window.addItem(.separator())
        let library = window.addItem(withTitle: "Recordings Library", action: #selector(EditorMenuTarget.showLibrary(_:)), keyEquivalent: "l")
        library.keyEquivalentModifierMask = [.command, .shift]
        library.target = EditorMenuTarget.shared
        bar.addItem(withTitle: "Window", action: nil, keyEquivalent: "").submenu = window
        NSApp.windowsMenu = window

        let help = NSMenu(title: "Help")
        let shortcuts = help.addItem(withTitle: "Keyboard Shortcuts", action: #selector(EditorMenuTarget.showShortcuts(_:)), keyEquivalent: "/")
        shortcuts.target = EditorMenuTarget.shared
        bar.addItem(withTitle: "Help", action: nil, keyEquivalent: "").submenu = help
        NSApp.helpMenu = help

        NSApp.mainMenu = bar
    }

    private static func menu(_ title: String, _ commands: [EditorCommand]) -> NSMenu {
        let menu = NSMenu(title: title)
        add(commands, to: menu)
        return menu
    }

    private static func add(_ commands: [EditorCommand], to menu: NSMenu) {
        for command in commands {
            let item = menu.addItem(withTitle: command.title, action: #selector(EditorMenuTarget.run(_:)), keyEquivalent: command.key)
            item.keyEquivalentModifierMask = command.modifiers
            item.target = EditorMenuTarget.shared
            item.representedObject = CommandBox(command)
        }
    }

    /// Every command with its key, for the shortcuts sheet.
    static var shortcutsText: String {
        [("File", file), ("Edit", edit), ("Timeline", timeline)].map { section, commands in
            "\(section)\n" + commands.filter { !$0.label.isEmpty }.map { "\($0.label)\t\($0.title)" }.joined(separator: "\n")
        }.joined(separator: "\n\n")
    }
}

/// An `EditorCommand` as a menu item's object (an `NSMenuItem` keeps an `Any`, but a class box keeps it simple).
final class CommandBox: NSObject {
    let command: EditorCommand
    init(_ command: EditorCommand) { self.command = command }
}

@MainActor
final class EditorMenuTarget: NSObject, NSMenuItemValidation {
    static let shared = EditorMenuTarget()

    @objc func run(_ sender: NSMenuItem) {
        guard let box = sender.representedObject as? CommandBox, let model = EditorWindows.shared.frontModel() else { return }
        box.command.run(model)
    }

    @objc func showLibrary(_ sender: Any?) {
        LibraryWindow.shared.show(focus: true)
    }

    @objc func showShortcuts(_ sender: Any?) {
        let alert = NSAlert()
        alert.messageText = "Keyboard Shortcuts"
        alert.informativeText = EditorMenu.shortcutsText
        alert.addButton(withTitle: "Done")
        if let window = NSApp.keyWindow {
            alert.beginSheetModal(for: window)
        } else {
            alert.runModal()
        }
    }

    func validateMenuItem(_ item: NSMenuItem) -> Bool {
        guard let box = item.representedObject as? CommandBox else { return true }
        // A key with no ⌘ (Space, S, ←) belongs to a text field while one edits; a disabled item lets it through.
        if box.command.modifiers.isDisjoint(with: [.command, .control]), NSApp.keyWindow?.firstResponder is NSText { return false }
        return EditorWindows.shared.frontModel() != nil
    }
}
