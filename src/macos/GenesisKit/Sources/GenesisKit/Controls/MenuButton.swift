import AppKit
import SwiftUI

/// One entry of a `MenuButton`'s menu.
public enum MenuButtonItem {
    case action(String, checked: Bool = false, enabled: Bool = true, run: () -> Void)
    case submenu(String, [MenuButtonItem])
    /// A line of text that cannot be picked ("No commits ahead of the base").
    case note(String)
    case divider
}

/// A menu button that SwiftUI draws itself; the AppKit menu exists only while it is open.
///
/// SwiftUI's `Menu` is an NSPopUpButton, and `ViewThatFits` builds every option's views again for each
/// measurement, platform views included. The review header's options held about a dozen pop-up
/// buttons, so each step of a pane divider drag or a window resize created them anew: 870 ms of the
/// 14 s of main thread in the `window` and `split` bench (2026-09-26). This label is plain SwiftUI,
/// and the text in it truncates like any other, so it also shrinks in a crowded row, which a `Menu`
/// needed a `ViewThatFits` of its own for.
///
/// `items` runs at the click, so the menu shows the state of that moment. Shared by GenesisTools and
/// Genesis (both had a copy; Genesis's still sent `perform:`, so its picks did nothing).
public struct MenuButton<Label: View, Style: ButtonStyle>: View {
    /// A drawn style always: a button without one is an NSButton, a platform view again.
    let style: Style
    let items: () -> [MenuButtonItem]
    let label: () -> Label

    public init(style: Style, items: @escaping () -> [MenuButtonItem], @ViewBuilder label: @escaping () -> Label) {
        self.style = style
        self.items = items
        self.label = label
    }

    public var body: some View {
        Button {
            MenuButtonPresenter.pop(items())
        } label: {
            label().contentShape(Rectangle())
        }
        .buttonStyle(style)
    }
}

public extension MenuButton where Style == GenHoverButtonStyle {
    /// The plain hover style (`.genHoverPlain()`).
    init(items: @escaping () -> [MenuButtonItem], @ViewBuilder label: @escaping () -> Label) {
        self.init(style: .genHoverPlain(), items: items, label: label)
    }
}

@MainActor
public enum MenuButtonPresenter {
    /// The AppKit menu for `items`; each item keeps its action alive in `representedObject`.
    public static func menu(_ items: [MenuButtonItem]) -> NSMenu {
        let menu = NSMenu()
        menu.autoenablesItems = false
        for item in items {
            switch item {
            case .action(let title, let checked, let enabled, let run):
                let entry = NSMenuItem(title: title, action: #selector(MenuButtonTarget.runItem(_:)), keyEquivalent: "")
                entry.target = MenuButtonTarget.shared
                entry.representedObject = MenuButtonTarget.Action(run: run)
                entry.state = checked ? .on : .off
                entry.isEnabled = enabled
                menu.addItem(entry)
            case .submenu(let title, let children):
                let entry = NSMenuItem(title: title, action: nil, keyEquivalent: "")
                entry.submenu = Self.menu(children)
                menu.addItem(entry)
            case .note(let title):
                let entry = NSMenuItem(title: title, action: nil, keyEquivalent: "")
                entry.isEnabled = false
                menu.addItem(entry)
            case .divider:
                menu.addItem(.separator())
            }
        }
        return menu
    }

    /// Opens the menu where the click was (from the keyboard or VoiceOver: at the pointer).
    public static func pop(_ items: [MenuButtonItem]) {
        let event = NSApp.currentEvent
        guard let window = event?.window ?? NSApp.keyWindow, let content = window.contentView else { return }
        let clicked = event.map { [.leftMouseUp, .leftMouseDown].contains($0.type) } ?? false
        let location = clicked ? event?.locationInWindow ?? .zero : window.mouseLocationOutsideOfEventStream
        menu(items).popUp(positioning: nil, at: content.convert(location, from: nil), in: content)
    }
}

/// The one target of every `MenuButton` item (an NSMenuItem holds its target weakly).
public final class MenuButtonTarget: NSObject {
    public static let shared = MenuButtonTarget()

    final class Action: NSObject {
        let run: () -> Void

        init(run: @escaping () -> Void) {
            self.run = run
        }
    }

    /// Not `perform(_:)`: `#selector` resolved that name to NSObject's `performSelector:`, which took the
    /// menu item for a selector and raised, so no pick ever ran (`HubMenuButtonTests`).
    @objc public func runItem(_ sender: NSMenuItem) {
        (sender.representedObject as? Action)?.run()
    }
}
