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
        EditorCommand(title: "Save Frame as Picture…", key: "s", modifiers: [.command, .option], label: "⌥⌘S") { $0.saveFrame() },
    ]

    static let edit: [EditorCommand] = [
        EditorCommand(title: "Undo", key: "z", modifiers: .command, label: "⌘Z") { $0.undo() },
        EditorCommand(title: "Redo", key: "z", modifiers: [.command, .shift], label: "⇧⌘Z") { $0.redo() },
        EditorCommand(title: "Delete Selection", key: "\u{8}", label: "⌫") { $0.deleteSelection() },
        EditorCommand(title: "Deselect", key: "\u{1b}", label: "Esc") { $0.selection = .none; $0.timelineRange = nil },
        EditorCommand(title: "Duplicate", key: "d", modifiers: .command, label: "⌘D") { $0.duplicateSelection() },
        EditorCommand(title: "Find on Screen…", key: "f", modifiers: .command, label: "⌘F") { $0.tab = .find },
    ]

    static let timeline: [EditorCommand] = [
        EditorCommand(title: "Play or Pause", key: " ", label: "Space") { $0.togglePlay() },
        EditorCommand(title: "Play Backwards (Again: Faster)", key: "j", label: "J") { $0.shuttle("j") },
        EditorCommand(title: "Pause", key: "k", label: "K") { $0.shuttle("k") },
        EditorCommand(title: "Play (Again: Faster)", key: "l", label: "L") { $0.shuttle("l") },
        EditorCommand(title: "Split at Playhead", key: "s", label: "S") { $0.splitAtPlayhead() },
        EditorCommand(title: "Trim Start to Playhead (Clip or Selection)", key: "[", label: "[") { $0.trimToPlayhead(.start) },
        EditorCommand(title: "Trim End to Playhead (Clip or Selection)", key: "]", label: "]") { $0.trimToPlayhead(.end) },
        EditorCommand(title: "Add Zoom at Playhead", key: "z", label: "Z") { $0.addZoom() },
        EditorCommand(title: "Add Text at Playhead", key: "t", label: "T") { $0.addText() },
        EditorCommand(title: "Add Arrow at Playhead", key: "a", label: "A") { $0.addShape(.arrow) },
        EditorCommand(title: "Add Box at Playhead", key: "b", label: "B") { $0.addShape(.box) },
        EditorCommand(title: "Add Circle at Playhead", key: "c", label: "C") { $0.addShape(.circle) },
        EditorCommand(title: "Add Comment at Playhead…", key: "m", label: "M") { $0.commentPrompt() },
        EditorCommand(title: "Set Part In", key: "i", label: "I") { $0.markIn() },
        EditorCommand(title: "Set Part Out", key: "o", label: "O") { $0.markOut() },
        EditorCommand(title: "Clear Part", key: "", label: "") { $0.clearPart() },
        EditorCommand(title: "Delete In to Out", key: "\u{8}", modifiers: .shift, label: "⇧⌫") { $0.cutPart() },
        EditorCommand(title: "Keep Only In to Out", key: "", label: "") { $0.keepPart() },
        EditorCommand(title: "Back One Frame (Shape: Nudge Left)", key: String(UnicodeScalar(NSLeftArrowFunctionKey)!), label: "←") {
            $0.arrowKey(dx: -1, dy: 0, shift: false)
        },
        EditorCommand(title: "Forward One Frame (Shape: Nudge Right)", key: String(UnicodeScalar(NSRightArrowFunctionKey)!), label: "→") {
            $0.arrowKey(dx: 1, dy: 0, shift: false)
        },
        EditorCommand(title: "Back One Second (Shape: Nudge More)", key: String(UnicodeScalar(NSLeftArrowFunctionKey)!), modifiers: .shift, label: "⇧←") {
            $0.arrowKey(dx: -1, dy: 0, shift: true)
        },
        EditorCommand(title: "Forward One Second (Shape: Nudge More)", key: String(UnicodeScalar(NSRightArrowFunctionKey)!), modifiers: .shift, label: "⇧→") {
            $0.arrowKey(dx: 1, dy: 0, shift: true)
        },
        EditorCommand(title: "Move Selection Earlier", key: String(UnicodeScalar(NSLeftArrowFunctionKey)!), modifiers: .option, label: "⌥←") {
            $0.moveSelectionInTime(byUs: -100_000)
        },
        EditorCommand(title: "Move Selection Later", key: String(UnicodeScalar(NSRightArrowFunctionKey)!), modifiers: .option, label: "⌥→") {
            $0.moveSelectionInTime(byUs: 100_000)
        },
        EditorCommand(title: "Move Selection a Second Earlier", key: String(UnicodeScalar(NSLeftArrowFunctionKey)!), modifiers: [.option, .shift], label: "⌥⇧←") {
            $0.moveSelectionInTime(byUs: -1_000_000)
        },
        EditorCommand(title: "Move Selection a Second Later", key: String(UnicodeScalar(NSRightArrowFunctionKey)!), modifiers: [.option, .shift], label: "⌥⇧→") {
            $0.moveSelectionInTime(byUs: 1_000_000)
        },
        EditorCommand(title: "Select Next Item", key: String(UnicodeScalar(NSDownArrowFunctionKey)!), modifiers: .option, label: "⌥↓") {
            $0.selectAdjacentItem(forward: true)
        },
        EditorCommand(title: "Select Previous Item", key: String(UnicodeScalar(NSUpArrowFunctionKey)!), modifiers: .option, label: "⌥↑") {
            $0.selectAdjacentItem(forward: false)
        },
        EditorCommand(title: "Nudge Shape Up", key: String(UnicodeScalar(NSUpArrowFunctionKey)!), label: "↑") { $0.arrowKey(dx: 0, dy: -1, shift: false) },
        EditorCommand(title: "Nudge Shape Down", key: String(UnicodeScalar(NSDownArrowFunctionKey)!), label: "↓") { $0.arrowKey(dx: 0, dy: 1, shift: false) },
        EditorCommand(title: "Nudge Shape Up More", key: String(UnicodeScalar(NSUpArrowFunctionKey)!), modifiers: .shift, label: "⇧↑") {
            $0.arrowKey(dx: 0, dy: -1, shift: true)
        },
        EditorCommand(title: "Nudge Shape Down More", key: String(UnicodeScalar(NSDownArrowFunctionKey)!), modifiers: .shift, label: "⇧↓") {
            $0.arrowKey(dx: 0, dy: 1, shift: true)
        },
        EditorCommand(title: "To the Start", key: String(UnicodeScalar(NSHomeFunctionKey)!), label: "Home") { $0.seek(0) },
        EditorCommand(title: "To the End", key: String(UnicodeScalar(NSEndFunctionKey)!), label: "End") { $0.seek($0.durationUs) },
        EditorCommand(title: "Zoom Timeline In", key: "=", modifiers: .command, label: "⌘=") { $0.zoomTimeline(by: 1.4) },
        EditorCommand(title: "Zoom Timeline Out", key: "-", modifiers: .command, label: "⌘−") { $0.zoomTimeline(by: 0.7) },
        EditorCommand(title: "Fit Timeline", key: "0", modifiers: .command, label: "⌘0") { $0.pointsPerSecond = 0 },
    ]

    /// ⌘1 to ⌘9 open the inspector tabs in the rail's order.
    static var tabs: [EditorCommand] {
        InspectorTab.allCases.compactMap { tab in
            tab.shortcutIndex.map { index in
                EditorCommand(title: "Show \(tab.title)", key: "\(index)", modifiers: .command, label: "⌘\(index)") { $0.tab = tab }
            }
        }
    }

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

        let timelineMenu = menu("Timeline", timeline)
        timelineMenu.addItem(.separator())
        let addLane = NSMenu(title: "Add Lane")
        for (index, choice) in EditorModel.laneChoices.enumerated() {
            let item = addLane.addItem(withTitle: choice.title, action: #selector(EditorMenuTarget.addLane(_:)), keyEquivalent: "")
            item.target = EditorMenuTarget.shared
            item.tag = index
        }
        timelineMenu.addItem(withTitle: "Add Lane", action: nil, keyEquivalent: "").submenu = addLane
        bar.addItem(withTitle: "Timeline", action: nil, keyEquivalent: "").submenu = timelineMenu

        let view = menu("View", tabs)
        view.addItem(.separator())
        let scrub = view.addItem(withTitle: "Scrub Library Cards on Hover", action: #selector(EditorMenuTarget.toggleHoverScrub(_:)), keyEquivalent: "")
        scrub.target = EditorMenuTarget.shared
        let snap = view.addItem(withTitle: "Snap While Dragging", action: #selector(EditorMenuTarget.toggleSnap(_:)), keyEquivalent: "")
        snap.target = EditorMenuTarget.shared
        snap.toolTip = "Hold ⌘ while dragging to place an edge freely"
        let range = view.addItem(withTitle: "Ask What to Do With a Dragged Range", action: #selector(EditorMenuTarget.toggleRangePopover(_:)), keyEquivalent: "")
        range.target = EditorMenuTarget.shared
        range.toolTip = "A drag on the frames lane opens a popover (cut, speed, zoom, hide, text, export); off, the drag marks the export part"
        let tap = view.addItem(withTitle: "Tap When Snapping", action: #selector(EditorMenuTarget.toggleSnapHaptic(_:)), keyEquivalent: "")
        tap.target = EditorMenuTarget.shared
        let single = view.addItem(withTitle: "Single-Key Shortcuts", action: #selector(EditorMenuTarget.toggleSingleKeys(_:)), keyEquivalent: "")
        single.target = EditorMenuTarget.shared
        single.toolTip = "S, Z, T, A, B, C, I, O, J, K, L and Space without ⌘; off, only the ⌘ keys work"
        view.addItem(.separator())
        let outside = NSMenu(title: "Edits From Outside the Window")
        for (title, key, tip) in [
            ("Show a Banner of What Changed", EditorModel.agentEditBannerKey, "The time, who wrote it, and one line per change, on the preview"),
            ("Flash the Changed Items", EditorModel.agentEditFlashKey, "The timeline segments it touched; the preview for the frame, cursor, captions or clicks"),
            ("Move the Playhead to the Change", EditorModel.agentEditSeekKey, "Not while the movie plays"),
        ] {
            let item = outside.addItem(withTitle: title, action: #selector(EditorMenuTarget.toggleAgentEditSetting(_:)), keyEquivalent: "")
            item.target = EditorMenuTarget.shared
            item.representedObject = key
            item.toolTip = tip
        }
        outside.addItem(.separator())
        for seconds in EditorModel.agentEditSecondsChoices {
            let item = outside.addItem(withTitle: "Keep the Banner \(Int(seconds)) s", action: #selector(EditorMenuTarget.setAgentEditSeconds(_:)), keyEquivalent: "")
            item.target = EditorMenuTarget.shared
            item.representedObject = seconds
        }
        view.addItem(withTitle: "Edits From Outside the Window", action: nil, keyEquivalent: "").submenu = outside
        let shown = NSMenu(title: "Effect Lanes Before Scrolling")
        for count in EditorModel.lanesShownChoices {
            let item = shown.addItem(withTitle: count == 0 ? "All (Never Scroll)" : Plural.count(count, "Lane"),
                                     action: #selector(EditorMenuTarget.setLanesShown(_:)), keyEquivalent: "")
            item.target = EditorMenuTarget.shared
            item.tag = count
            item.toolTip = "Past this many effect lanes the lanes area scrolls, with a fade at the cut edge"
        }
        view.addItem(withTitle: "Effect Lanes Before Scrolling", action: nil, keyEquivalent: "").submenu = shown
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
        [("File", file), ("Edit", edit), ("Timeline", timeline), ("View", tabs)].map { ($0.0, $0.1.filter { !$0.label.isEmpty }) }
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
            Text("Hold ⌘ while you drag on the timeline to place an edge without snapping.")
                .font(.system(size: 12)).foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
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

    /// On by default: the keys without ⌘ (S splits, Z zooms…). Off for a user who presses them by mistake.
    static let singleKeysKey = "recorder.editor.singleKeys"

    @objc func toggleSingleKeys(_ sender: Any?) {
        let on = UserDefaults.standard.object(forKey: Self.singleKeysKey) as? Bool ?? true
        UserDefaults.standard.set(!on, forKey: Self.singleKeysKey)
    }

    @objc func toggleSnapHaptic(_ sender: Any?) {
        let on = UserDefaults.standard.object(forKey: EditorModel.snapHapticKey) as? Bool ?? true
        UserDefaults.standard.set(!on, forKey: EditorModel.snapHapticKey)
    }

    /// One of the "Edits From Outside the Window" toggles; the item carries its defaults key.
    @objc func toggleAgentEditSetting(_ sender: NSMenuItem) {
        guard let key = sender.representedObject as? String else { return }
        UserDefaults.standard.set(!EditorModel.agentEditSetting(key), forKey: key)
    }

    @objc func setAgentEditSeconds(_ sender: NSMenuItem) {
        guard let seconds = sender.representedObject as? Double else { return }
        UserDefaults.standard.set(seconds, forKey: EditorModel.agentEditSecondsKey)
    }

    @objc func toggleRangePopover(_ sender: Any?) {
        UserDefaults.standard.set(!EditorModel.rangePopover, forKey: EditorModel.rangePopoverKey)
    }

    @objc func addLane(_ sender: NSMenuItem) {
        guard EditorModel.laneChoices.indices.contains(sender.tag), let model = EditorWindows.shared.frontModel() else { return }
        model.addLane(kinds: EditorModel.laneChoices[sender.tag].kinds)
    }

    @objc func setLanesShown(_ sender: NSMenuItem) {
        UserDefaults.standard.set(sender.tag, forKey: EditorModel.lanesShownKey)
    }

    @objc func showLibrary(_ sender: Any?) {
        LibraryWindow.shared.show(focus: true)
    }

    @objc func showShortcuts(_ sender: Any?) {
        ShortcutsPresenter.show(on: NSApp.keyWindow)
    }

    func validateMenuItem(_ item: NSMenuItem) -> Bool {
        if item.action == #selector(toggleAgentEditSetting(_:)), let key = item.representedObject as? String {
            item.state = EditorModel.agentEditSetting(key) ? .on : .off
            return true
        }
        if item.action == #selector(setAgentEditSeconds(_:)), let seconds = item.representedObject as? Double {
            item.state = seconds == EditorModel.agentEditSeconds ? .on : .off
            return true
        }
        if item.action == #selector(toggleRangePopover(_:)) {
            item.state = EditorModel.rangePopover ? .on : .off
            return true
        }
        if item.action == #selector(setLanesShown(_:)) {
            item.state = item.tag == EditorModel.lanesShown ? .on : .off
            return true
        }
        if item.action == #selector(addLane(_:)) { return EditorWindows.shared.frontModel() != nil }
        if item.action == #selector(toggleSnap(_:)) {
            item.state = (UserDefaults.standard.object(forKey: EditorModel.snapKey) as? Bool ?? true) ? .on : .off
            return true
        }
        if item.action == #selector(toggleSingleKeys(_:)) {
            item.state = (UserDefaults.standard.object(forKey: Self.singleKeysKey) as? Bool ?? true) ? .on : .off
            return true
        }
        if item.action == #selector(toggleSnapHaptic(_:)) {
            item.state = (UserDefaults.standard.object(forKey: EditorModel.snapHapticKey) as? Bool ?? true) ? .on : .off
            return true
        }
        if item.action == #selector(toggleHoverScrub(_:)) {
            item.state = (UserDefaults.standard.object(forKey: LibraryModel.hoverScrubKey) as? Bool ?? true) ? .on : .off
            return true
        }
        guard let box = item.representedObject as? CommandBox else { return true }
        // A key with no ⌘ (Space, S, ←) belongs to a text field while one edits; a disabled item lets it through.
        if box.command.modifiers.isDisjoint(with: [.command, .control]), NSApp.keyWindow?.firstResponder is NSText { return false }
        // A key with no modifier at all (S, Z, Space) only while Single-Key Shortcuts is on; ⇧← and Esc stay.
        if box.command.modifiers.isEmpty, box.command.key.count == 1, box.command.key.first?.isLetter == true || box.command.key == " ",
           !(UserDefaults.standard.object(forKey: Self.singleKeysKey) as? Bool ?? true) {
            return false
        }
        guard let model = EditorWindows.shared.frontModel() else { return false }
        switch box.command.title {
        case "Undo":
            item.title = model.undoName.map { "Undo \($0)" } ?? "Undo"
            return model.canUndo
        case "Redo":
            item.title = model.redoName.map { "Redo \($0)" } ?? "Redo"
            return model.canRedo
        case "Delete Selection": return model.selection != .none
        case "Deselect": return model.selection != .none || model.timelineRange != nil
        case "Duplicate": return model.selection != .none
        case "Clear Part", "Delete In to Out", "Keep Only In to Out": return model.exportPart != nil
        default: return true
        }
    }
}
