import AppKit
import SwiftUI

/// One entry of a `MenuButton`'s menu.
enum MenuButtonItem {
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
/// `items` runs at the click, so the menu shows the state of that moment.
struct MenuButton<Label: View>: View {
    /// A drawn style always: a button without one is an NSButton, a platform view again.
    var style: GenHoverButtonStyle = .genHoverPlain()
    let items: () -> [MenuButtonItem]
    @ViewBuilder let label: () -> Label

    var body: some View {
        Button {
            MenuButtonPresenter.pop(items())
        } label: {
            label().contentShape(Rectangle())
        }
        .buttonStyle(style)
    }
}

@MainActor
enum MenuButtonPresenter {
    /// The AppKit menu for `items`; each item keeps its action alive in `representedObject`.
    static func menu(_ items: [MenuButtonItem]) -> NSMenu {
        let menu = NSMenu()
        menu.autoenablesItems = false
        for item in items {
            switch item {
            case .action(let title, let checked, let enabled, let run):
                let entry = NSMenuItem(title: title, action: #selector(MenuButtonTarget.perform(_:)), keyEquivalent: "")
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
    static func pop(_ items: [MenuButtonItem]) {
        let event = NSApp.currentEvent
        guard let window = event?.window ?? NSApp.keyWindow, let content = window.contentView else { return }
        let clicked = event.map { [.leftMouseUp, .leftMouseDown].contains($0.type) } ?? false
        let location = clicked ? event?.locationInWindow ?? .zero : window.mouseLocationOutsideOfEventStream
        menu(items).popUp(positioning: nil, at: content.convert(location, from: nil), in: content)
    }
}

/// The one target of every `MenuButton` item (an NSMenuItem holds its target weakly).
final class MenuButtonTarget: NSObject {
    static let shared = MenuButtonTarget()

    final class Action: NSObject {
        let run: () -> Void

        init(run: @escaping () -> Void) {
            self.run = run
        }
    }

    @objc func perform(_ sender: NSMenuItem) {
        (sender.representedObject as? Action)?.run()
    }
}
