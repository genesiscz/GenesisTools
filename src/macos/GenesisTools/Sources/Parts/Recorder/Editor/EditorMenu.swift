import AppKit
import SwiftUI

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
        EditorCommand(title: "Duplicate", key: "d", modifiers: .command, label: "⌘D") { $0.duplicateSelection() },
    ]

    static let timeline: [EditorCommand] = [
        EditorCommand(title: "Play or Pause", key: " ", label: "Space") { $0.togglePlay() },
        EditorCommand(title: "Play Backwards (Again: Faster)", key: "j", label: "J") { $0.shuttle("j") },
        EditorCommand(title: "Pause", key: "k", label: "K") { $0.shuttle("k") },
        EditorCommand(title: "Play (Again: Faster)", key: "l", label: "L") { $0.shuttle("l") },
        EditorCommand(title: "Split at Playhead", key: "s", label: "S") { $0.splitAtPlayhead() },
        EditorCommand(title: "Trim Start to Playhead", key: "[", label: "[") { $0.trimToPlayhead(.start) },
        EditorCommand(title: "Trim End to Playhead", key: "]", label: "]") { $0.trimToPlayhead(.end) },
        EditorCommand(title: "Add Zoom at Playhead", key: "z", label: "Z") { $0.addZoom() },
        EditorCommand(title: "Add Text at Playhead", key: "t", label: "T") { $0.addText() },
        EditorCommand(title: "Add Arrow at Playhead", key: "a", label: "A") { $0.addShape(.arrow) },
        EditorCommand(title: "Set Part In", key: "i", label: "I") { $0.markIn() },
        EditorCommand(title: "Set Part Out", key: "o", label: "O") { $0.markOut() },
        EditorCommand(title: "Clear Part", key: "", label: "") { $0.clearPart() },
        EditorCommand(title: "Cut the Part", key: "\u{8}", modifiers: .shift, label: "⇧⌫") { $0.cutPart() },
        EditorCommand(title: "Keep Only the Part", key: "", label: "") { $0.keepPart() },
        EditorCommand(title: "Back One Frame", key: String(UnicodeScalar(NSLeftArrowFunctionKey)!), label: "←") { $0.step(frames: -1) },
        EditorCommand(title: "Forward One Frame", key: String(UnicodeScalar(NSRightArrowFunctionKey)!), label: "→") { $0.step(frames: 1) },
        EditorCommand(title: "Back One Second", key: String(UnicodeScalar(NSLeftArrowFunctionKey)!), modifiers: .shift, label: "⇧←") { $0.step(frames: -60) },
        EditorCommand(title: "Forward One Second", key: String(UnicodeScalar(NSRightArrowFunctionKey)!), modifiers: .shift, label: "⇧→") { $0.step(frames: 60) },
        EditorCommand(title: "To the Start", key: String(UnicodeScalar(NSHomeFunctionKey)!), label: "Home") { $0.seek(0) },
        EditorCommand(title: "To the End", key: String(UnicodeScalar(NSEndFunctionKey)!), label: "End") { $0.seek($0.durationUs) },
        EditorCommand(title: "Zoom Timeline In", key: "=", modifiers: .command, label: "⌘=") { $0.zoomTimeline(by: 1.4) },
        EditorCommand(title: "Zoom Timeline Out", key: "-", modifiers: .command, label: "⌘−") { $0.zoomTimeline(by: 0.7) },
        EditorCommand(title: "Fit Timeline", key: "0", modifiers: .command, label: "⌘0") { $0.pointsPerSecond = 0 },
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

        let view = NSMenu(title: "View")
        let scrub = view.addItem(withTitle: "Scrub Library Cards on Hover", action: #selector(EditorMenuTarget.toggleHoverScrub(_:)), keyEquivalent: "")
        scrub.target = EditorMenuTarget.shared
        let snap = view.addItem(withTitle: "Snap While Dragging", action: #selector(EditorMenuTarget.toggleSnap(_:)), keyEquivalent: "")
        snap.target = EditorMenuTarget.shared
        bar.addItem(withTitle: "View", action: nil, keyEquivalent: "").submenu = view

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

    /// Every command with a key, by menu, for the shortcuts sheet.
    static var sections: [(title: String, commands: [EditorCommand])] {
        [("File", file), ("Edit", edit), ("Timeline", timeline)].map { ($0.0, $0.1.filter { !$0.label.isEmpty }) }
    }
}

/// The editor's keys in two aligned columns per menu, as a sheet on the editor window.
private struct ShortcutsSheet: View {
    let done: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("Keyboard Shortcuts").font(.system(size: 15, weight: .semibold))
            ScrollView {
                Grid(alignment: .leading, horizontalSpacing: 18, verticalSpacing: 6) {
                    ForEach(EditorMenu.sections, id: \.title) { section in
                        GridRow {
                            Text(section.title).font(.system(size: 12, weight: .semibold)).foregroundStyle(.secondary)
                                .gridCellColumns(2)
                                .padding(.top, 6)
                        }
                        ForEach(section.commands, id: \.title) { command in
                            GridRow {
                                Text(verbatim: command.label)
                                    .font(.system(size: 12.5, weight: .medium).monospaced())
                                    .gridColumnAlignment(.trailing)
                                Text(command.title).font(.system(size: 12.5))
                            }
                        }
                    }
                }
            }
            .frame(maxHeight: 420)
            HStack {
                Spacer()
                Button("Done", action: done).keyboardShortcut(.defaultAction)
            }
        }
        .padding(20)
        .frame(width: 360)
    }
}

@MainActor
enum ShortcutsPresenter {
    static func show(on window: NSWindow?) {
        let panel = NSPanel(contentRect: NSRect(x: 0, y: 0, width: 360, height: 500), styleMask: [.titled], backing: .buffered, defer: false)
        let close: () -> Void = { [weak panel] in
            guard let panel else { return }
            if let parent = panel.sheetParent { parent.endSheet(panel) } else { panel.close() }
        }
        panel.contentView = NSHostingView(rootView: ShortcutsSheet(done: close))
        panel.setContentSize(panel.contentView?.fittingSize ?? NSSize(width: 360, height: 500))
        if let window {
            window.beginSheet(panel)
        } else {
            panel.center()
            panel.makeKeyAndOrderFront(nil)
        }
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

    /// The library's hover scrub (on by default), a View menu item with a check mark.
    @objc func toggleHoverScrub(_ sender: Any?) {
        let on = UserDefaults.standard.object(forKey: LibraryModel.hoverScrubKey) as? Bool ?? true
        UserDefaults.standard.set(!on, forKey: LibraryModel.hoverScrubKey)
    }

    /// Snapping on the timeline (on by default), a View menu item with a check mark.
    @objc func toggleSnap(_ sender: Any?) {
        let on = UserDefaults.standard.object(forKey: EditorModel.snapKey) as? Bool ?? true
        UserDefaults.standard.set(!on, forKey: EditorModel.snapKey)
    }

    @objc func showLibrary(_ sender: Any?) {
        LibraryWindow.shared.show(focus: true)
    }

    @objc func showShortcuts(_ sender: Any?) {
        ShortcutsPresenter.show(on: NSApp.keyWindow)
    }

    func validateMenuItem(_ item: NSMenuItem) -> Bool {
        if item.action == #selector(toggleSnap(_:)) {
            item.state = (UserDefaults.standard.object(forKey: EditorModel.snapKey) as? Bool ?? true) ? .on : .off
            return true
        }
        if item.action == #selector(toggleHoverScrub(_:)) {
            item.state = (UserDefaults.standard.object(forKey: LibraryModel.hoverScrubKey) as? Bool ?? true) ? .on : .off
            return true
        }
        guard let box = item.representedObject as? CommandBox else { return true }
        // A key with no ⌘ (Space, S, ←) belongs to a text field while one edits; a disabled item lets it through.
        if box.command.modifiers.isDisjoint(with: [.command, .control]), NSApp.keyWindow?.firstResponder is NSText { return false }
        guard let model = EditorWindows.shared.frontModel() else { return false }
        switch box.command.title {
        case "Undo": return model.canUndo
        case "Redo": return model.canRedo
        case "Delete Selection", "Deselect": return model.selection != .none
        case "Duplicate": return model.selection != .none
        case "Clear Part", "Cut the Part", "Keep Only the Part": return model.exportPart != nil
        default: return true
        }
    }
}
