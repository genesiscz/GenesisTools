import AppKit

/// The standard text editing shortcuts (⌘A, ⌘C, ⌘X, ⌘V, ⌘Z, ⇧⌘Z) for windows of a process whose main menu has no Edit
/// menu. A text field gets them from the menu bar's Edit menu, and without one AppKit beeps and does nothing (Martin,
/// 2026-10-27: "cmd + a, cmd + c ... it just 'pings' the sound"). `EditingPanel` sends them to the first responder
/// itself, and `menuItem()` is the Edit menu for a face's own main menu, so its other windows get them as well.
public enum StandardEditing {
    /// The action of a standard editing chord, or nil for any other key.
    public static func action(for event: NSEvent) -> Selector? {
        guard event.type == .keyDown else { return nil }
        let modifiers = event.modifierFlags.intersection([.command, .shift, .option, .control])
        let shifted = modifiers == [.command, .shift]
        guard modifiers == .command || shifted else { return nil }
        // The layout's letter first, as the menu bar matches it; the key's place when the layout has no Latin letter.
        let letter = event.charactersIgnoringModifiers?.lowercased() ?? ""
        let key: String
        if ["a", "c", "x", "v", "z"].contains(letter) {
            key = letter
        } else if letter.unicodeScalars.allSatisfy({ !$0.isASCII }) {
            key = [0: "a", 8: "c", 7: "x", 9: "v", 6: "z"][event.keyCode] ?? ""
        } else {
            key = ""
        }
        switch (key, shifted) {
        case ("a", false): return #selector(NSText.selectAll(_:))
        case ("c", false): return #selector(NSText.copy(_:))
        case ("x", false): return #selector(NSText.cut(_:))
        case ("v", false): return #selector(NSText.paste(_:))
        case ("z", false): return Selector(("undo:"))
        case ("z", true): return Selector(("redo:"))
        default: return nil
        }
    }

    /// Sends a standard editing chord to `window`'s first responder and up its responder chain (the field editor, then
    /// the window, which owns undo). False for any other key, or when no responder takes the action.
    @MainActor
    public static func perform(_ event: NSEvent, in window: NSWindow) -> Bool {
        guard let action = action(for: event), let responder = window.firstResponder else { return false }
        return responder.tryToPerform(action, with: window)
    }

    /// An Edit menu with Undo, Redo, Cut, Copy, Paste and Select All, each sent to the first responder.
    @MainActor
    public static func menuItem() -> NSMenuItem {
        let edit = NSMenu(title: "Edit")
        edit.addItem(withTitle: "Undo", action: Selector(("undo:")), keyEquivalent: "z")
        let redo = edit.addItem(withTitle: "Redo", action: Selector(("redo:")), keyEquivalent: "z")
        redo.keyEquivalentModifierMask = [.command, .shift]
        edit.addItem(.separator())
        edit.addItem(withTitle: "Cut", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        edit.addItem(withTitle: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        edit.addItem(withTitle: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        edit.addItem(withTitle: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        let item = NSMenuItem(title: "Edit", action: nil, keyEquivalent: "")
        item.submenu = edit
        return item
    }
}

/// A panel whose text fields take the standard editing shortcuts with no Edit menu in the process (`StandardEditing`).
/// The widget's edge panels are one: borderless and non-activating, they never had the menu bar's Edit menu.
open class EditingPanel: NSPanel {
    open override func performKeyEquivalent(with event: NSEvent) -> Bool {
        // A control in the panel bound to the chord keeps it; otherwise the first responder edits.
        if super.performKeyEquivalent(with: event) { return true }
        return StandardEditing.perform(event, in: self)
    }
}
